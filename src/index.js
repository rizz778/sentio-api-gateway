const http = require('http');
const url = require('url');
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const config = require('./config');
const connectionManager = require('./connection/ConnectionManager');
const healthRouter = require('./api/health');
const { handleLiveUpgrade } = require('./ws/live');
const { verifyGoogleTokenForUpgrade } = require('./middleware/auth');

// ── Express App ──────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// REST routes
app.use('/', healthRouter);

// ── HTTP Server ──────────────────────────────────────────────────────────────
const server = http.createServer(app);

// ── WebSocket Upgrade Routing ─────────────────────────────────────────────────
server.on('upgrade', async (request, socket, head) => {
  const { pathname } = url.parse(request.url);

  if (pathname === '/ws/live') {
    // 1. Verify Google token — rejects socket with 401 if invalid
    const user = await verifyGoogleTokenForUpgrade(request, socket);
    if (!user) return; // socket already destroyed by middleware

    // 2. Hand off to the live WS handler with the verified user attached
    handleLiveUpgrade(request, socket, head, user);
  } else {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }
});

// ── Boot ─────────────────────────────────────────────────────────────────────
server.listen(config.PORT, config.HOST, () => {
  console.log('===============================================');
  console.log(`🚀 Sentio API Gateway listening on http://${config.HOST}:${config.PORT}`);
  console.log(`📡 WebSocket endpoint: ws://${config.HOST}:${config.PORT}/ws/live`);
  console.log(`🔗 gRPC backend target: ${config.GRPC_TARGET}`);
  console.log(`📜 Proto path: ${config.PROTO_PATH}`);
  console.log('===============================================');
});

// ── Graceful Shutdown ─────────────────────────────────────────────────────────
const shutdown = async (signal) => {
  console.log(`\n[Gateway] Received ${signal}. Commencing graceful shutdown...`);

  server.close(() => {
    console.log('[Gateway] HTTP server closed.');
  });

  await connectionManager.gracefulDrain(8000);

  console.log('[Gateway] Shutdown complete.');
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
