const express = require('express');
const router = express.Router();

const connectionManager = require('../connection/ConnectionManager');
const { checkConnectivity } = require('../grpc/grpcClient');

// GET /healthz — full liveness probe with diagnostics
router.get('/healthz', (req, res) => {
  const stats = connectionManager.getStats();
  let grpcState = 'UNKNOWN';
  try {
    grpcState = checkConnectivity();
  } catch (e) {
    grpcState = e.message;
  }

  res.status(200).json({
    status: 'ok',
    service: 'sentio-gateway',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    grpcConnectivityState: grpcState,
    connections: stats,
    memory: process.memoryUsage(),
  });
});

// GET /ready — readiness probe (fails while gateway is draining)
router.get('/ready', (req, res) => {
  if (connectionManager.isDraining) {
    return res.status(503).json({ status: 'draining' });
  }
  res.status(200).json({ status: 'ready' });
});

module.exports = router;
