const { createProxyMiddleware, fixRequestBody } = require('http-proxy-middleware');
const registry = require('../registry/ServiceRegistry');

const SERVICE_HEADER = 'x-sentio-service';

/**
 * Dynamic HTTP reverse proxy.
 *
 * Every inbound REST request must carry:
 *   x-sentio-service: <service-name>   e.g. "node-backend" | "fastapi-backend"
 *
 * The gateway:
 *   1. Reads the header
 *   2. Resolves the target URL from ServiceRegistry
 *   3. Strips x-sentio-service so backends never see it
 *   4. Proxies the full request transparently (path, method, body, headers preserved)
 *
 * On unknown service → 502 Bad Gateway.
 * On missing header  → 400 Bad Request.
 */
const dynamicProxy = createProxyMiddleware({
  // Dynamically resolve target per-request
  router: (req) => {
    const serviceName = req.headers[SERVICE_HEADER];
    const target = registry.resolve(serviceName);
    return target; // returning undefined/null will trigger the error handler below
  },

  changeOrigin: true,

  // http-proxy-middleware v2 event handlers
  onProxyReq: (proxyReq, req, res) => {
    // If body was parsed by any upstream middleware, re-stream it with correct length
    if (req.body && Object.keys(req.body).length > 0) {
      fixRequestBody(proxyReq, req);
    }

    // Strip the routing header — backends must never see it
    proxyReq.removeHeader('x-sentio-service');

    // Inject verified identity headers so downstream services trust req.user
    // without re-verifying the Google token themselves
    if (req.user) {
      proxyReq.setHeader('x-user-id', req.user.uid);
      proxyReq.setHeader('x-user-email', req.user.email || '');
    }

    // Propagate correlation request ID
    if (req.id) {
      proxyReq.setHeader('x-request-id', req.id);
    }

    const target = registry.resolve(req.headers['x-sentio-service']);
    console.log(`[Proxy] ${req.method} ${req.path} → ${target || 'UNKNOWN'}${req.path}`);
  },

  onError: (err, req, res) => {
    console.error(`[Proxy] Error forwarding to service:`, err.message);
    if (!res.headersSent) {
      res.status(502).json({
        error: 'BAD_GATEWAY',
        message: `Failed to reach upstream service: ${err.message}`,
      });
    }
  },

  // v3 forward compatibility object
  on: {
    proxyReq: (proxyReq, req) => {
      if (req.body && Object.keys(req.body).length > 0) {
        fixRequestBody(proxyReq, req);
      }
      proxyReq.removeHeader('x-sentio-service');
      if (req.user) {
        proxyReq.setHeader('x-user-id', req.user.uid);
        proxyReq.setHeader('x-user-email', req.user.email || '');
      }
      if (req.id) {
        proxyReq.setHeader('x-request-id', req.id);
      }
    },
    error: (err, req, res) => {
      console.error(`[Proxy] Error forwarding to service:`, err.message);
      if (!res.headersSent) {
        res.status(502).json({
          error: 'BAD_GATEWAY',
          message: `Failed to reach upstream service: ${err.message}`,
        });
      }
    },
  },
});

/**
 * Pre-proxy guard middleware.
 * Validates the x-sentio-service header and short-circuits with appropriate
 * error responses before the proxy middleware even runs.
 */
function proxyGuard(req, res, next) {
  const serviceName = req.headers[SERVICE_HEADER];

  if (!serviceName) {
    return res.status(400).json({
      error: 'MISSING_SERVICE_HEADER',
      message: `Request must include the '${SERVICE_HEADER}' header`,
      availableServices: registry.list(),
    });
  }

  const target = registry.resolve(serviceName);
  if (!target) {
    return res.status(502).json({
      error: 'UNKNOWN_SERVICE',
      message: `No registered service named '${serviceName}'`,
      availableServices: registry.list(),
    });
  }

  next();
}

module.exports = { dynamicProxy, proxyGuard };
