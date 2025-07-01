// src/routes/authRoutes.js
const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth');

// User registration (sign up)
router.post('/register', authController.register);
// Email OTP verification
router.post('/verify', authController.verifyEmail);
// User login (JWT issuance)
router.post('/login', authController.login);

module.exports = router;
