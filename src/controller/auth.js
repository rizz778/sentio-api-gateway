const { client, verifyToken } = require('../middleware/auth');
const registry = require('../registry/ServiceRegistry');

/**
 * Synchronizes user with Node backend to create user in MongoDB if new.
 */
async function syncUserWithNodeBackend(user) {
  const nodeTarget = registry.resolve('node-backend');
  if (!nodeTarget) return null;

  try {
    const fetch = globalThis.fetch || require('node-fetch');
    const res = await fetch(`${nodeTarget}/internal/users/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': user.uid,
        'x-user-email': user.email,
      },
      body: JSON.stringify({
        uid: user.uid,
        email: user.email,
        name: user.name,
        picture: user.picture,
      }),
    });
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    // Non-blocking fallback if node-backend is temporarily unreachable
    console.warn('[Auth] Optional node-backend user sync skipped:', err.message);
  }
  return null;
}

/**
 * POST /auth/google
 * Authenticates user via Google ID token or OAuth authorization code,
 * syncs with Node backend (MongoDB), and returns the verified token and user info.
 */
async function googleAuth(req, res) {
  const { idToken, credential, code } = req.body || {};

  try {
    let rawIdToken = idToken || credential;

    // If an authorization code was passed, exchange it for tokens with Google
    if (code && !rawIdToken) {
      const { tokens } = await client.getToken(code);
      rawIdToken = tokens.id_token;
    }

    if (!rawIdToken) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'Request body must include idToken, credential, or code',
      });
    }

    // Verify token with Google
    const user = await verifyToken(rawIdToken);

    // Sync/create user in node-backend MongoDB and retrieve user & default session
    const syncData = await syncUserWithNodeBackend(user);
    const mongoUser = syncData?.user;

    console.log(
      `[Auth] User authenticated: ${user.email} (uid: ${user.uid}, mongoId: ${mongoUser?.id || 'pending'})`
    );

    return res.status(200).json({
      success: true,
      token: rawIdToken,
      user: {
        id: mongoUser?.id || mongoUser?._id || user.uid,
        uid: user.uid,
        email: user.email,
        name: user.name,
        picture: user.picture || '',
        emailVerified: user.emailVerified,
        initialSessionId: syncData?.initialSessionId || null,
      },
    });
  } catch (err) {
    console.error('[Auth] Google authentication failed:', err.message);
    return res.status(401).json({
      error: 'AUTHENTICATION_FAILED',
      message: 'Invalid or expired Google credentials',
      details: err.message,
    });
  }
}

/**
 * GET /auth/me
 * Returns the profile of the currently authenticated user.
 */
function getMe(req, res) {
  return res.status(200).json({
    success: true,
    user: req.user,
  });
}

module.exports = {
  googleAuth,
  getMe,
  syncUserWithNodeBackend,
};
