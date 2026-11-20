const connectionManager = require('../connection/ConnectionManager');
const { checkConnectivity } = require('../grpc/grpcClient');

/**
 * GET /healthz
 * Full liveness probe with diagnostics.
 */
function getHealthz(req, res) {
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
}

/**
 * GET /ready
 * Readiness probe (fails with 503 while gateway is draining).
 */
function getReady(req, res) {
  if (connectionManager.isDraining) {
    return res.status(503).json({ status: 'draining' });
  }
  res.status(200).json({ status: 'ready' });
}

module.exports = {
  getHealthz,
  getReady,
};
