// File: src/routes/monitor.js (new routes for monitoring endpoints)
const router = require('express').Router();
const monitor = require('../controllers/monitor');


router.get('/bridge/status', monitor.getBridgeStatus);
router.get('/reserves/status', monitor.getReservesStatus);
// manual-override to set exchange rate from external API
router.post('/oracle/update-rate', monitor.triggerUpdateRate);
router.get('/oracle/health', monitor.getOracleHealth);
// Enable or disable oracle pricing mode
router.post('/oracle/enable', monitor.setOracleMode);

module.exports = router;
