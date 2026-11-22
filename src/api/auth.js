const express = require('express');
const router = express.Router();

const { verifyGoogleToken } = require('../middleware/auth');
const { authRateLimiter } = require('../middleware/rateLimiter');
const { googleAuth, getMe } = require('../controller/auth');

/**
 * Authentication Routes
 * Matches both /google and /auth/google regardless of whether mounted on / or /auth or /api/auth.
 */
router.post(['/google', '/auth/google'], authRateLimiter, googleAuth);
router.get(['/me', '/auth/me'], verifyGoogleToken, getMe);

module.exports = router;
