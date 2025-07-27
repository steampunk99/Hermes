// src/routes/transactionRoutes.js
const express = require('express');
const router = express.Router();
const transactionController = require('../controllers/transactions');
const { financeSecurity, standardSecurity } = require('../middleware/advancedSecurity');
const p2pController = require('../controllers/p2p');

// Mint UGDX (deposit UGX via mobile money) - HIGH SECURITY
router.post('/mint', ...financeSecurity('transactions-mint'), transactionController.mintUGDX);

// Redeem UGDX (withdraw UGX via mobile money) - HIGH SECURITY
router.post('/redeem', ...financeSecurity('transactions-redeem'), transactionController.redeemUGDX);

// P2P transfer endpoints
router.post('/p2p/send-onchain', p2pController.sendOnChain);
router.post('/p2p/send-to-mobile', p2pController.sendToMobile);

// P2P history and analytics
router.get('/p2p/history', p2pController.getHistory);
router.get('/p2p/analytics', p2pController.getAnalytics);

// Get transaction history for user - STANDARD SECURITY
router.get('/user/history', ...standardSecurity('transactions-history'), transactionController.getHistory);

// Get current exchange rates (public route) - STANDARD SECURITY
router.get('/rates/current', ...standardSecurity('transactions-rates'), transactionController.getCurrentRates);

module.exports = router;
