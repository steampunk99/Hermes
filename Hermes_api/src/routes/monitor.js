// File: src/routes/monitor.js (new routes for monitoring endpoints)
const router = require('express').Router();
const monitor = require('../controllers/monitor');


router.get('/bridge/status', monitor.getBridgeStatus);
router.get('/reserves/status', monitor.getReservesStatus);
// manual-override to set exchange rate from external API
router.post('/oracle/update-rate', monitor.triggerUpdateRate);
router.get('/oracle/health', monitor.getOracleHealth);
// Enable or disable oracle pricing mode
router.post('/oracle/on', monitor.setOracleMode);
router.post('/oracle/off', monitor.disableOracleMode);

module.exports = router;
