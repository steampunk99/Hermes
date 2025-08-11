// src/routes/transactionRoutes.js
const express = require('express');
const router = express.Router();
const transactionController = require('../controllers/transactions');
const { financeSecurity, standardSecurity } = require('../middleware/advancedSecurity');

// Mint UGDX (deposit UGX via mobile money) - HIGH SECURITY
router.post('/mint', ...financeSecurity('transactions-mint'), transactionController.mintUGDX);

// Redeem UGDX (withdraw UGX via mobile money) - HIGH SECURITY
router.post('/redeem', ...financeSecurity('transactions-redeem'), transactionController.redeemUGDX);

// Quote endpoints (read-only) - STANDARD SECURITY
router.get('/quote-deposit', ...standardSecurity('transactions-quote-deposit'), transactionController.quoteDeposit);
router.get('/quote-withdraw', ...standardSecurity('transactions-quote-withdraw'), transactionController.quoteWithdraw);

// Get transaction history for user - STANDARD SECURITY
router.get('/user/history', ...standardSecurity('transactions-history'), transactionController.getHistory);

module.exports = router;
