// src/routes/transactionRoutes.js
const express = require('express');
const router = express.Router();
const transactionController = require('../controllers/transactions');
const { financeSecurity, standardSecurity } = require('../middleware/advancedSecurity');

// Mint UGDX (deposit UGX via mobile money) - HIGH SECURITY
router.post('/mint', ...financeSecurity('transactions-mint'), transactionController.mintUGDX);

// Redeem UGDX (withdraw UGX via mobile money) - HIGH SECURITY
router.post('/redeem', ...financeSecurity('transactions-redeem'), transactionController.redeemUGDX);

// Send UGDX (either to another address or to a phone via mobile money) - HIGH SECURITY
router.post('/send', ...financeSecurity('transactions-send'), transactionController.sendUGDX);

// Get transaction history for user - STANDARD SECURITY
router.get('/history', ...standardSecurity('transactions-history'), transactionController.getHistory);

// Get current exchange rates (public route) - STANDARD SECURITY
router.get('/rates/current', ...standardSecurity('transactions-rates'), transactionController.getCurrentRates);

module.exports = router;
