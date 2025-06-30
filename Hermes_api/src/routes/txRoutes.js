// src/routes/transactionRoutes.js
const express = require('express');
const router = express.Router();
const transactionController = require('../controllers/transactionController');

// Mint UGDX (deposit UGX via mobile money)
router.post('/mint', transactionController.mintUGDX);
// Redeem UGDX (withdraw UGX via mobile money)
router.post('/redeem', transactionController.redeemUGDX);
// Send UGDX (either to another address or to a phone via mobile money)
router.post('/send', transactionController.sendUGDX);
// Get transaction history for user
router.get('/history', transactionController.getHistory);
// Get current exchange rates (public route as well)
router.get('/rates/current', transactionController.getCurrentRates);

module.exports = router;
