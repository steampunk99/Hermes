
// src/routes/authRoutes.js
const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth');

// Registration: Create a new user account
// Body: { phone, email, password }
router.post('/register', authController.register);

// Email OTP verification: Verify email with OTP code
// Body: { email, code }
router.post('/verify', authController.verifyEmail);

// Login: Authenticate user and issue JWT
// Body: { email, password }
router.post('/login', authController.login);

// Request password reset: Send password reset token to email
// Body: { email }
router.post('/forgot-password', authController.forgotPassword);

// Confirm password reset: Set new password using reset token
// Body: { email, resetToken, newPassword }
router.post('/reset-password', authController.resetPassword);

// Resend OTP: Send a new OTP code to email for verification
// Body: { email }
router.post('/resend-otp', authController.resendOTP);

// Change password: Authenticated users change their password
// Body: { oldPassword, newPassword } (requires JWT auth)
router.post('/change-password', authController.changePassword);

// Logout: (JWT clients just delete token; for refresh/session, handle here)
router.post('/logout', authController.logout);

module.exports = router;
