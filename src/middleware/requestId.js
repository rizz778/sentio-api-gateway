const { v4: uuidv4 } = require('uuid');

/**
 * Request ID middleware.
 * Ensures every incoming request has a unique correlation ID.
 *
 * 1. Reads incoming 'x-request-id' or generates a new UUID v4.
 * 2. Attaches req.id for internal log correlation.
 * 3. Sets 'x-request-id' on the HTTP response.
 */
function requestIdMiddleware(req, res, next) {
  const reqId = req.headers['x-request-id'] || uuidv4();
  req.id = reqId;
  res.setHeader('x-request-id', reqId);
  next();
}

module.exports = requestIdMiddleware;
