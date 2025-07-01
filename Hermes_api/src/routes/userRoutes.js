// src/routes/userRoutes.js
const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');

// Middleware to restrict access to advanced users only
function requireAdvanced(req, res, next) {
  if (req.user.role !== 'advanced') {
    return res.status(403).json({ error: "Forbidden: advanced users only." });
  }
  next();
}

// Get user profile (requires JWT auth, handled in app)
router.get('/profile', userController.getProfile);
// Get user balances (UGDX on-chain, UGX credit, gas credit)
router.get('/balance', userController.getBalance);
// Add or update external wallet address (advanced users only)
router.put('/wallet', requireAdvanced, userController.updateWallet);
module.exports = router;
