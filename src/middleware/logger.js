/**
 * Structured request logger middleware.
 * Logs method, path, target service, status, duration, and user ID.
 */
function requestLogger(req, res, next) {
  const start = Date.now();
  const reqId = req.id || '-';

  res.on('finish', () => {
    const duration = Date.now() - start;
    const service = req.headers['x-sentio-service'] || 'gateway';
    const user = req.user?.uid ? `user:${req.user.uid}` : (req.ip || 'anon');
    const status = res.statusCode;

    // Use emoji indicator for quick status scanning
    const statusIcon = status >= 500 ? '🔴' : status >= 400 ? '🟡' : '🟢';

    console.log(
      `[HTTP] ${statusIcon} [${reqId}] ${req.method} ${req.originalUrl || req.url} → ${service} ` +
      `(${status}, ${duration}ms) [${user}]`
    );
  });

  next();
}

module.exports = requestLogger;
