const http = require('http');
const url = require('url');
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const config = require('./config');
const connectionManager = require('./connection/ConnectionManager');
const healthRouter = require('./api/health');
const authRouter = require('./api/auth');
const { handleLiveUpgrade } = require('./ws/live');
const { verifyGoogleToken, verifyGoogleTokenForUpgrade } = require('./middleware/auth');
const { dynamicProxy, proxyGuard } = require('./proxy/httpProxy');
const requestIdMiddleware = require('./middleware/requestId');
const requestLogger = require('./middleware/logger');
const { serviceRateLimiter, redis } = require('./middleware/rateLimiter');

// ── Express App ──────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Global observability: request ID propagation & structured access logging
app.use(requestIdMiddleware);
app.use(requestLogger);

// Gateway-hosted endpoints (health probes & authentication)
app.use('/', healthRouter);
app.use('/', authRouter);
app.use('/api', authRouter);

// ── Dynamic Reverse Proxy ─────────────────────────────────────────────────────
// All other requests require valid Google Auth token & service discovery header:
// 1. verifyGoogleToken   — rejects with 401 if token missing/invalid; attaches req.user
// 2. proxyGuard          — rejects with 400/502 if x-sentio-service header is bad
// 3. serviceRateLimiter  — enforces per-service rate limits (e.g. 25/min AI, 120/min Node)
// 4. dynamicProxy        — resolves target, injects x-user-id, x-user-email, x-request-id, forwards
app.use(verifyGoogleToken, proxyGuard, serviceRateLimiter, dynamicProxy);

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

  try {
    await redis.quit();
  } catch (e) {}

  console.log('[Gateway] Shutdown complete.');
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
