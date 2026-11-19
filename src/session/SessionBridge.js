const { createSessionStream } = require('../grpc/grpcClient');
const config = require('../config');

class SessionBridge {
  constructor(ws, { sessionId, userId, authToken, metadata, responseModalities }) {
    this.ws = ws;
    this.sessionId = sessionId;
    this.userId = userId;
    this.authToken = authToken;
    this.metadata = metadata || {};
    this.responseModalities = responseModalities || ['AUDIO'];
    this.grpcStream = null;
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
    this.isDestroyed = false;

    // Buffer audio during brief gRPC failovers so user speech isn't lost
    this.pendingAudioBuffer = [];
    this.MAX_BUFFERED_CHUNKS = 100; // ~3-5 seconds of PCM chunks

    this.setupWebSocketListeners();
    this.connectGrpcStream();
  }

  /**
   * Sets up listeners on the incoming browser WebSocket.
   */
  setupWebSocketListeners() {
    this.ws.on('message', (data, isBinary) => {
      this.handleClientMessage(data, isBinary);
    });

    this.ws.on('close', (code, reason) => {
      console.log(`[SessionBridge] WebSocket closed for session ${this.sessionId}: ${code} - ${reason}`);
      this.destroy();
    });

    this.ws.on('error', (err) => {
      console.error(`[SessionBridge] WebSocket error on session ${this.sessionId}:`, err.message);
      this.destroy();
    });
  }

  /**
   * Establishes a bidirectional gRPC stream to FastAPI.
   */
  connectGrpcStream() {
    if (this.isDestroyed) return;

    try {
      this.grpcStream = createSessionStream();

      // Send SessionInit with client-configured modalities (voice and instructions resolved by FastAPI backend config)
      const initEvent = {
        session_init: {
          session_id: this.sessionId,
          user_id: this.userId,
          auth_token: this.authToken,
          response_modalities: this.responseModalities,
          metadata: this.metadata,
        },
      };

      this.grpcStream.write(initEvent);

      // Handle server events coming from FastAPI / Gemini Live
      this.grpcStream.on('data', (serverEvent) => {
        this.handleServerEvent(serverEvent);
      });

      this.grpcStream.on('error', (err) => {
        console.warn(`[SessionBridge] gRPC stream error on session ${this.sessionId}: ${err.message} (code: ${err.code})`);
        this.handleGrpcFailover(err);
      });

      this.grpcStream.on('end', () => {
        console.log(`[SessionBridge] gRPC stream ended for session ${this.sessionId}`);
        if (!this.isDestroyed && !this.isReconnecting) {
          this.handleGrpcFailover(new Error('gRPC stream unexpectedly ended by server'));
        }
      });
    } catch (err) {
      console.error(`[SessionBridge] Failed to create gRPC stream:`, err.message);
      this.handleGrpcFailover(err);
    }
  }

  /**
   * Processes events received from FastAPI over gRPC.
   */
  handleServerEvent(serverEvent) {
    if (this.isDestroyed || this.ws.readyState !== 1) return; // 1 = OPEN

    const payload = serverEvent.payload;
    if (!payload) return;

    if (serverEvent.session_ready) {
      const ready = serverEvent.session_ready;
      console.log(`[SessionBridge] Session ${this.sessionId} READY (rehydrated: ${ready.rehydrated}, prior turns: ${ready.prior_turn_count})`);

      this.isReconnecting = false;
      this.reconnectAttempts = 0;

      this.sendToWs({
        type: 'session_ready',
        sessionId: ready.session_id,
        rehydrated: ready.rehydrated,
        priorTurnCount: ready.prior_turn_count,
        message: ready.message,
      });

      // Flush any client audio buffered during reconnect
      this.flushPendingAudioBuffer();
      return;
    }

    if (serverEvent.audio_chunk) {
      // Audio backpressure control:
      // If WebSocket buffer is overloaded (> 64KB), drop or throttle chunk to prevent lag
      if (this.ws.bufferedAmount > config.MAX_WS_BUFFER_BYTES) {
        console.warn(`[SessionBridge] Client WS backpressure saturated (${this.ws.bufferedAmount} bytes). Dropping audio frame.`);
        return;
      }

      const audio = serverEvent.audio_chunk;
      // Send binary audio directly or with lightweight JSON header
      this.sendToWs({
        type: 'audio_chunk',
        mimeType: audio.mime_type,
        data: Buffer.isBuffer(audio.data) ? audio.data.toString('base64') : Buffer.from(audio.data).toString('base64'),
      });
      return;
    }

    if (serverEvent.transcript) {
      const t = serverEvent.transcript;
      this.sendToWs({
        type: 'transcript',
        speaker: t.speaker,
        text: t.text,
        isFinal: t.is_final,
        timestampMs: t.timestamp_ms,
      });
      return;
    }

    if (serverEvent.stop_playback) {
      // Immediate barge-in instruction to client
      console.log(`[SessionBridge] STOP_PLAYBACK received for session ${this.sessionId}`);
      this.sendToWs({
        type: 'stop_playback',
        timestampMs: serverEvent.stop_playback.timestamp_ms,
        reason: serverEvent.stop_playback.reason,
      });
      return;
    }

    if (serverEvent.pong) {
      this.sendToWs({
        type: 'pong',
        timestampMs: serverEvent.pong.timestamp_ms,
      });
      return;
    }

    if (serverEvent.distress_update) {
      const d = serverEvent.distress_update;
      this.sendToWs({
        type: 'distress_update',
        score: d.score,
        emotion: d.emotion,
        timestampMs: d.timestamp_ms,
      });
      return;
    }

    if (serverEvent.error) {
      const err = serverEvent.error;
      console.error(`[SessionBridge] gRPC Server Error (${err.code}): ${err.message}`);
      this.sendToWs({
        type: 'error',
        code: err.code,
        message: err.message,
        recoverable: err.recoverable,
      });
    }
  }

  /**
   * Handles incoming frames from the client WebSocket.
   */
  handleClientMessage(data, isBinary) {
    if (this.isDestroyed) return;

    if (isBinary) {
      // Raw PCM audio chunk from browser mic
      const audioBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      this.forwardAudioChunk(audioBuffer);
      return;
    }

    // JSON control message
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.type) {
        case 'interrupt':
          // Barge-in: user began speaking while model was replying
          this.forwardInterrupt(msg.reason || 'user_barge_in');
          break;

        case 'ping':
          this.forwardPing();
          break;

        default:
          console.warn(`[SessionBridge] Unrecognized client message type: ${msg.type}`);
      }
    } catch (e) {
      console.warn(`[SessionBridge] Malformed client JSON:`, e.message);
    }
  }

  /**
   * Forwards user audio chunk to gRPC or queues it if reconnecting.
   */
  forwardAudioChunk(buffer) {
    if (this.isReconnecting || !this.grpcStream || !this.grpcStream.writable) {
      if (this.pendingAudioBuffer.length < this.MAX_BUFFERED_CHUNKS) {
        this.pendingAudioBuffer.push(buffer);
      }
      return;
    }

    try {
      this.grpcStream.write({
        audio_chunk: {
          data: buffer,
          mime_type: 'audio/pcm;rate=16000',
        },
      });
    } catch (err) {
      console.warn(`[SessionBridge] Failed to write audio to gRPC:`, err.message);
      this.handleGrpcFailover(err);
    }
  }

  /**
   * Forwards client interrupt to trigger model barge-in.
   */
  forwardInterrupt(reason) {
    if (!this.grpcStream || !this.grpcStream.writable) return;

    try {
      this.grpcStream.write({
        interrupt: {
          timestamp_ms: Date.now(),
          reason,
        },
      });
    } catch (err) {
      console.warn(`[SessionBridge] Failed to send interrupt:`, err.message);
    }
  }

  /**
   * Forwards client keepalive probe.
   */
  forwardPing() {
    if (!this.grpcStream || !this.grpcStream.writable) return;

    try {
      this.grpcStream.write({
        ping: {
          timestamp_ms: Date.now(),
        },
      });
    } catch (err) {
      // Ignore ping write errors
    }
  }

  /**
   * Flushes buffered audio frames once gRPC connection is restored.
   */
  flushPendingAudioBuffer() {
    if (!this.grpcStream || !this.grpcStream.writable) return;

    while (this.pendingAudioBuffer.length > 0) {
      const chunk = this.pendingAudioBuffer.shift();
      try {
        this.grpcStream.write({
          audio_chunk: {
            data: chunk,
            mime_type: 'audio/pcm;rate=16000',
          },
        });
      } catch (e) {
        break;
      }
    }
  }

  /**
   * Transparent gRPC failover when FastAPI drops or restarts.
   */
  handleGrpcFailover(err) {
    if (this.isDestroyed || this.isReconnecting) return;

    this.isReconnecting = true;
    this.reconnectAttempts += 1;

    if (this.grpcStream) {
      try {
        this.grpcStream.destroy();
      } catch (e) { }
      this.grpcStream = null;
    }

    if (this.reconnectAttempts > config.GRPC_RECONNECT_MAX_ATTEMPTS) {
      console.error(`[SessionBridge] Exceeded max gRPC reconnect attempts for ${this.sessionId}`);
      this.sendToWs({
        type: 'error',
        code: 'AI_SERVICE_UNAVAILABLE',
        message: 'AI backend unavailable. Please retry in a moment.',
        recoverable: false,
      });
      this.destroy();
      return;
    }

    const delayMs = Math.min(
      config.GRPC_RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
      5000
    );

    console.log(`[SessionBridge] Reconnecting gRPC stream for ${this.sessionId} in ${delayMs}ms (attempt ${this.reconnectAttempts})...`);

    this.sendToWs({
      type: 'status',
      status: 'reconnecting',
      message: 'Reconnecting to AI engine...',
      attempt: this.reconnectAttempts,
    });

    setTimeout(() => {
      if (!this.isDestroyed) {
        this.connectGrpcStream();
      }
    }, delayMs);
  }

  /**
   * Helper to safely send JSON stringified message to WebSocket.
   */
  sendToWs(payload) {
    if (this.ws.readyState === 1) { // WebSocket.OPEN
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        console.error(`[SessionBridge] Failed to send WS message:`, err.message);
      }
    }
  }

  /**
   * Cleans up all resources.
   */
  destroy() {
    if (this.isDestroyed) return;
    this.isDestroyed = true;

    if (this.grpcStream) {
      try {
        this.grpcStream.end();
      } catch (e) { }
      this.grpcStream = null;
    }

    this.pendingAudioBuffer = [];

    if (this.ws.readyState === 1 || this.ws.readyState === 0) {
      try {
        this.ws.close();
      } catch (e) { }
    }
  }
}

module.exports = SessionBridge;
