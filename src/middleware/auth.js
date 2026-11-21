const { OAuth2Client } = require('google-auth-library');
const config = require('../config');

const client = new OAuth2Client(
  config.GOOGLE_CLIENT_ID,
  config.GOOGLE_CLIENT_SECRET,
  config.GOOGLE_REDIRECT_URI
);

/**
 * Verifies a Google ID token (from Firebase Auth or Google Sign-In).
 *
 * Reads: Authorization: Bearer <id_token>
 * On success: attaches req.user = { uid, email, name, token } and calls next().
 * On failure: destroys the socket (for WS upgrades) or returns 401 (for REST).
 *
 * Usage for REST routes:   router.get('/...', verifyGoogleToken, handler)
 * Usage for WS upgrades:   call verifyGoogleTokenForUpgrade(request) → resolves user or throws
 */

const GOOGLE_CLIENT_IDS = config.GOOGLE_CLIENT_IDS;

/**
 * Extracts the Bearer token from an Authorization header string.
 * Works on both Express req.headers and raw http.IncomingMessage headers.
 */
function extractBearerToken(headers) {
  const authHeader = headers['authorization'] || headers['Authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7).trim() || null;
}

/**
 * Core verification logic — shared by both REST and WS paths.
 * Returns a normalized user object on success, throws on failure.
 *
 * @param {string} token  Raw Google ID token
 * @returns {Promise<{ uid: string, email: string, name: string, token: string }>}
 */
async function verifyToken(token) {
  // Verify against all configured audience client IDs.
  // If no GOOGLE_CLIENT_IDS are configured (dev mode), skip audience check.
  const audience = GOOGLE_CLIENT_IDS.length > 0 ? GOOGLE_CLIENT_IDS : undefined;

  const ticket = await client.verifyIdToken({ idToken: token, audience });
  const payload = ticket.getPayload();

  if (!payload) {
    throw new Error('Empty token payload');
  }

  return {
    uid: payload.sub,                       // Google user ID (stable, unique per user)
    email: payload.email || '',
    name: payload.name || '',
    emailVerified: payload.email_verified ?? false,
    token,                                  // forward the original token to FastAPI
  };
}

// ─── Express Middleware (REST routes) ────────────────────────────────────────

/**
 * Express middleware. Attaches req.user on success, responds 401 on failure.
 */
async function verifyGoogleToken(req, res, next) {
  const token = extractBearerToken(req.headers);

  if (!token) {
    return res.status(401).json({
      error: 'UNAUTHENTICATED',
      message: 'Missing Authorization: Bearer <token> header',
    });
  }

  try {
    req.user = await verifyToken(token);
    next();
  } catch (err) {
    console.warn('[Auth] Token verification failed:', err.message);
    return res.status(401).json({
      error: 'UNAUTHENTICATED',
      message: 'Invalid or expired Google token',
    });
  }
}

/**
 * Extracts the auth token from a WebSocket upgrade request.
 * Browsers cannot send Authorization headers on WS upgrades, so the token
 * is passed as a ?token= query parameter. Falls back to Bearer header.
 *
 * @param {http.IncomingMessage} request
 * @returns {string|null}
 */
function extractUpgradeToken(request) {
  // 1. Try Authorization: Bearer header (non-browser clients)
  const fromHeader = extractBearerToken(request.headers);
  if (fromHeader) return fromHeader;

  // 2. Try ?token= query parameter (browser WebSocket — standard path)
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  return url.searchParams.get('token') || null;
}

// ─── WebSocket Upgrade Guard ──────────────────────────────────────────────────

/**
 * Verifies the Google token on a raw HTTP upgrade request.
 * Returns the user object on success.
 * Writes a 401 HTTP response and destroys the socket on failure.
 *
 * @param {http.IncomingMessage} request
 * @param {net.Socket} socket
 * @returns {Promise<{ uid, email, name, token } | null>}
 *   Resolves with user on success, null if the socket was already rejected.
 */
async function verifyGoogleTokenForUpgrade(request, socket) {
  const token = extractUpgradeToken(request);

  if (!token) {
    console.warn('[Auth] WS upgrade rejected: no Bearer token');
    socket.write(
      'HTTP/1.1 401 Unauthorized\r\n' +
      'Content-Type: text/plain\r\n\r\n' +
      'Missing Authorization: Bearer <token> header'
    );
    socket.destroy();
    return null;
  }

  try {
    const user = await verifyToken(token);
    return user;
  } catch (err) {
    console.warn('[Auth] WS upgrade rejected: invalid token —', err.message);
    socket.write(
      'HTTP/1.1 401 Unauthorized\r\n' +
      'Content-Type: text/plain\r\n\r\n' +
      'Invalid or expired Google token'
    );
    socket.destroy();
    return null;
  }
}

module.exports = {
  client,
  verifyToken,
  verifyGoogleToken,
  verifyGoogleTokenForUpgrade,
};
