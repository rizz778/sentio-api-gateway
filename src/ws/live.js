const url = require('url');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const connectionManager = require('../connection/ConnectionManager');
const SessionBridge = require('../session/SessionBridge');

const wss = new WebSocketServer({ noServer: true });

/**
 * Handles the HTTP → WebSocket upgrade for the /ws/live route.
 * Performs capacity checks, extracts session params, and boots a SessionBridge.
 *
 * @param {http.IncomingMessage} request
 * @param {net.Socket} socket
 * @param {Buffer} head
 */
function handleLiveUpgrade(request, socket, head, user) {
  const parsedUrl = url.parse(request.url, true);
  const query = parsedUrl.query || {};

  // userId comes from the verified auth token (injected by auth middleware).
  // voiceName and systemInstructions are intentionally NOT read here —
  // FastAPI owns those when it sets up the Gemini Live session.
  const userId = user?.uid || user?.sub || 'anonymous';
  const sessionId = query.sessionId || uuidv4();

  // Capacity & per-user concurrency guard
  const check = connectionManager.canAcceptConnection(userId);
  if (!check.allowed) {
    console.warn(`[ws/live] Rejected connection for user ${userId}: ${check.reason}`);
    socket.write(`HTTP/1.1 429 Too Many Requests\r\n\r\n${check.reason}`);
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    const connectionId = uuidv4();

    // Extract client configuration (modalities, voice, instructions)
    const rawModalities = query.modalities || query.responseModalities || query.modality;
    const responseModalities = rawModalities
      ? (Array.isArray(rawModalities) ? rawModalities : rawModalities.split(',').map(m => m.trim().toUpperCase()))
      : ['AUDIO'];
    const voiceName = query.voice || query.voiceName || 'Puck';
    const systemInstructions = query.instructions || query.systemInstructions || '';

    const bridge = new SessionBridge(ws, {
      sessionId,
      userId,
      authToken: user?.token || '',   // raw verified token forwarded to FastAPI for its own checks
      voiceName,
      systemInstructions,
      responseModalities,
      metadata: { email: user?.email || '', ...query },
    });

    connectionManager.register(connectionId, userId, sessionId, ws, bridge);

    ws.on('close', () => {
      connectionManager.unregister(connectionId);
    });

    console.log(`[ws/live] Session established: ${sessionId} (conn: ${connectionId}, user: ${userId})`);
  });
}

module.exports = { handleLiveUpgrade };
