const express = require('express');
const router = express.Router();

const { verifyGoogleToken } = require('../middleware/auth');
const { authRateLimiter } = require('../middleware/rateLimiter');
const { googleAuth, getMe } = require('../controller/auth');

/**
 * Authentication Routes
 */
router.post('/auth/google', authRateLimiter, googleAuth);
router.get('/auth/me', verifyGoogleToken, getMe);

module.exports = router;
