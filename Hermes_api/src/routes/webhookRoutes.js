// src/routes/webhookRoutes.js
const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhookController');

// Webhook endpoint for mobile money provider callbacks
router.post('/mm', webhookController.handleMMCallback);

module.exports = router;
