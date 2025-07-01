// File: src/routes/monitor.js (new routes for monitoring endpoints)
const router = require('express').Router();
const monitor = require('../controllers/monitor');

router.get('/bridge/status', monitor.getBridgeStatus);
router.get('/reserves/status', monitor.getReservesStatus);
router.post('/oracle/update-rate', monitor.triggerUpdateRate);
router.get('/oracle/health', monitor.getOracleHealth);

module.exports = router;
