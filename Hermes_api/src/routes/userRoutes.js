// src/routes/userRoutes.js
const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');

// Get user profile
router.get('/profile', userController.getProfile);
// Get user balances (UGDX on-chain, UGX credit, gas credit)
router.get('/balance', userController.getBalance);

module.exports = router;
