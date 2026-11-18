const config = require('../config');

class ConnectionManager {
  constructor() {
    this.connections = new Map(); // connectionId -> ConnectionState
    this.userConnections = new Map(); // userId -> Set<connectionId>
    this.isDraining = false;
    this.heartbeatTimer = null;
    this.startHeartbeat();
  }

  /**
   * Validates if a new connection is allowed based on capacity & limits.
   */
  canAcceptConnection(userId) {
    if (this.isDraining) {
      return { allowed: false, reason: 'Gateway is shutting down / draining' };
    }

    if (this.connections.size >= config.MAX_CONNECTIONS) {
      return { allowed: false, reason: 'Gateway pod capacity reached' };
    }

    if (userId) {
      const currentActive = this.userConnections.get(userId)?.size || 0;
      if (currentActive >= config.MAX_CONNECTIONS_PER_USER) {
        return { allowed: false, reason: `Max concurrent sessions (${config.MAX_CONNECTIONS_PER_USER}) exceeded for user` };
      }
    }

    return { allowed: true };
  }

  /**
   * Registers a new client connection.
   */
  register(connectionId, userId, sessionId, ws, bridge = null) {
    const state = {
      connectionId,
      userId,
      sessionId,
      ws,
      bridge,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      isAlive: true,
    };

    this.connections.set(connectionId, state);

    if (userId) {
      if (!this.userConnections.has(userId)) {
        this.userConnections.set(userId, new Set());
      }
      this.userConnections.get(userId).add(connectionId);
    }

    ws.on('pong', () => {
      const conn = this.connections.get(connectionId);
      if (conn) {
        conn.isAlive = true;
        conn.lastSeen = Date.now();
      }
    });

    return state;
  }

  /**
   * Attaches session bridge to connection state.
   */
  setBridge(connectionId, bridge) {
    const conn = this.connections.get(connectionId);
    if (conn) {
      conn.bridge = bridge;
    }
  }

  /**
   * Unregisters a connection and cleans up mappings.
   */
  unregister(connectionId) {
    const conn = this.connections.get(connectionId);
    if (!conn) return;

    if (conn.userId && this.userConnections.has(conn.userId)) {
      const userSet = this.userConnections.get(conn.userId);
      userSet.delete(connectionId);
      if (userSet.size === 0) {
        this.userConnections.delete(conn.userId);
      }
    }

    if (conn.bridge) {
      conn.bridge.destroy();
    }

    this.connections.delete(connectionId);
  }

  /**
   * Periodic heartbeat to detect and sweep dead / disconnected sockets.
   */
  startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      for (const [connId, conn] of this.connections.entries()) {
        if (!conn.isAlive) {
          console.warn(`[ConnectionManager] Terminating unresponsive socket: ${connId}`);
          conn.ws.terminate();
          this.unregister(connId);
          continue;
        }

        conn.isAlive = false;
        try {
          conn.ws.ping();
        } catch (err) {
          console.error(`[ConnectionManager] Ping failed for ${connId}:`, err.message);
          conn.ws.terminate();
          this.unregister(connId);
        }
      }
    }, config.HEARTBEAT_INTERVAL_MS);

    // Prevent heartbeat from blocking process exit
    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref();
    }
  }

  /**
   * Graceful draining for rolling updates / zero downtime.
   */
  async gracefulDrain(timeoutMs = 10000) {
    this.isDraining = true;
    console.log(`[ConnectionManager] Draining ${this.connections.size} active connections...`);

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    for (const [, conn] of this.connections.entries()) {
      try {
        conn.ws.send(JSON.stringify({
          type: 'status',
          status: 'draining',
          message: 'Server is performing maintenance, reconnect shortly.',
        }));
        conn.ws.close(1001, 'Gateway draining');
      } catch (e) {
        // Ignore errors during drain
      }
    }

    const start = Date.now();
    while (this.connections.size > 0 && Date.now() - start < timeoutMs) {
      await new Promise((res) => setTimeout(res, 200));
    }

    // Force terminate any lingering sockets
    for (const [, conn] of this.connections.entries()) {
      conn.ws.terminate();
    }
    this.connections.clear();
    this.userConnections.clear();
    console.log('[ConnectionManager] Drain complete.');
  }

  getStats() {
    return {
      activeConnections: this.connections.size,
      activeUsers: this.userConnections.size,
      isDraining: this.isDraining,
    };
  }
}

module.exports = new ConnectionManager();
