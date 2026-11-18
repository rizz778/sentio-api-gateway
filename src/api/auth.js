const express = require('express');
const router = express.Router();

const { client, verifyToken, verifyGoogleToken } = require('../middleware/auth');
const registry = require('../registry/ServiceRegistry');

/**
 * Helper to optionally notify node-backend when a user authenticates,
 * allowing it to create/sync the user record in its database.
 */
async function syncUserWithNodeBackend(user) {
  const nodeTarget = registry.resolve('node-backend');
  if (!nodeTarget) return;

  try {
    const fetch = globalThis.fetch || require('node-fetch');
    await fetch(`${nodeTarget}/internal/users/sync`, {
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
  } catch (err) {
    // Non-blocking: node-backend might be offline during dev
    console.warn('[Auth] Optional node-backend user sync skipped:', err.message);
  }
}

/**
 * POST /auth/google
 *
 * Authenticates user via Google.
 * Accepts either:
 *   - { idToken } or { credential } (Google Identity Services ID token)
 *   - { code } (Google OAuth2 Authorization Code to exchange for tokens)
 *
 * Verifies with Google, extracts user identity, and returns the verified token.
 */
router.post('/auth/google', async (req, res) => {
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

    // Optional background sync with node-backend
    syncUserWithNodeBackend(user).catch(() => {});

    console.log(`[Auth] User authenticated successfully: ${user.email} (${user.uid})`);

    return res.status(200).json({
      success: true,
      token: rawIdToken,
      user: {
        uid: user.uid,
        email: user.email,
        name: user.name,
        picture: user.picture || '',
        emailVerified: user.emailVerified,
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
});

/**
 * GET /auth/me
 * Returns the profile of the currently authenticated user.
 */
router.get('/auth/me', verifyGoogleToken, (req, res) => {
  return res.status(200).json({
    success: true,
    user: req.user,
  });
});

module.exports = router;
