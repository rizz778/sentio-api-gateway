const express = require('express');
const router = express.Router();

const { getHealthz, getReady } = require('../controller/health');

/**
 * Health & Readiness Probes
 */
router.get('/healthz', getHealthz);
router.get('/ready', getReady);

module.exports = router;
