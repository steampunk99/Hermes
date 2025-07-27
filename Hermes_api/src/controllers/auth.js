// src/controllers/authController.js
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { prisma, logger, JWT_SECRET } = require('../config');
const jwt = require('jsonwebtoken');
const emailService = require('../services/emailService');
const {ethers} = require('ethers')
const { encryptPrivateKey } = require('../utils/encryption');
const OTP_EXPIRATION_MINUTES = 10;  // OTP valid for 10 minutes


class AuthController {
  // Helper: Generate OTP
  static generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  // Helper: Send OTP email
  async sendOTPEmail(email, otpCode) {
    try {
      await emailService.sendVerificationEmail(email, otpCode);
    } catch (emailErr) {
      logger.error("Failed to send verification email:", emailErr);
    }
  }

  // POST /auth/resend-otp
  async resendOTP(req, res, next) {
    try {
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: "Email is required." });
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) return res.status(404).json({ error: "User not found." });
      if (user.kycVerified) return res.status(400).json({ error: "User already verified." });
      const otpCode = AuthController.generateOTP();
      const otpExpiresAt = new Date(Date.now() + OTP_EXPIRATION_MINUTES * 60000);
      await prisma.user.update({ where: { id: user.id }, data: { otpCode, otpExpiresAt } });
      await this.sendOTPEmail(email, otpCode);
      logger.info(`Resent OTP to ${email}`);
      return res.json({ message: "Verification code resent. Please check your email." });
    } catch (err) {
      next(err);
    }
  }

  // POST /auth/forgot-password
  async forgotPassword(req, res, next) {
    try {
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: "Email is required." });
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) return res.status(404).json({ error: "User not found." });
      // Generate reset token (random string)
      const resetToken = crypto.randomBytes(32).toString('hex');
      const resetExpiresAt = new Date(Date.now() + 30 * 60000); // 30 min expiry
      await prisma.user.update({ where: { id: user.id }, data: { resetToken, resetExpiresAt } });
      // Send email (reuse OTP email for simplicity)
      await emailService.sendVerificationEmail(email, `Password reset code: ${resetToken}`);
      logger.info(`Password reset token sent to ${email}`);
      return res.json({ message: "Password reset instructions sent to your email." });
    } catch (err) {
      next(err);
    }
  }

  // POST /auth/reset-password
  async resetPassword(req, res, next) {
    try {
      const { email, resetToken, newPassword } = req.body;
      if (!email || !resetToken || !newPassword) {
        return res.status(400).json({ error: "Email, reset token, and new password are required." });
      }
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user || !user.resetToken || !user.resetExpiresAt) {
        return res.status(400).json({ error: "Invalid or expired reset token." });
      }
      if (user.resetToken !== resetToken || new Date() > user.resetExpiresAt) {
        return res.status(400).json({ error: "Invalid or expired reset token." });
      }
      const passwordHash = await bcrypt.hash(newPassword, 10);
      await prisma.user.update({ where: { id: user.id }, data: { passwordHash, resetToken: null, resetExpiresAt: null } });
      logger.info(`Password reset for ${email}`);
      return res.json({ message: "Password has been reset. You can now log in." });
    } catch (err) {
      next(err);
    }
  }

  // POST /auth/change-password
  async changePassword(req, res, next) {
    try {
      const userId = req.user.userId;
      const { oldPassword, newPassword } = req.body;
      if (!oldPassword || !newPassword) {
        return res.status(400).json({ error: "Old and new passwords are required." });
      }
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return res.status(404).json({ error: "User not found." });
      const validPass = await bcrypt.compare(oldPassword, user.passwordHash);
      if (!validPass) return res.status(401).json({ error: "Old password is incorrect." });
      const passwordHash = await bcrypt.hash(newPassword, 10);
      await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
      logger.info(`Password changed for user ${user.email}`);
      return res.json({ message: "Password changed successfully." });
    } catch (err) {
      next(err);
    }
  }

  // POST /auth/logout
  async logout(req, res, next) {
    try {
      // For JWT, logout is handled client-side by deleting the token.
      // If using refresh tokens or sessions, invalidate them here.
      // For demonstration, just respond with success.
      return res.json({ message: "Logged out successfully." });
    } catch (err) {
      next(err);
    }
  }


// POST /auth/register
 async register (req, res, next) {
  try {
    const { phone, email, password } = req.body;
    // Basic validation
    if (!phone || !email || !password) {
      return res.status(400).json({ error: "Phone, email, and password are required." });
    }
    // Check if user already exists (by email or phone)
    const existing = await prisma.user.findFirst({
      where: { OR: [{ email }, { phone }] }
    });
    if (existing) {
      return res.status(409).json({ error: "An account with this email or phone already exists." });
    }
    // Hash the password
    const passwordHash = await bcrypt.hash(password, 10);
    // Generate a random 6-digit OTP code for email verification
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();  // 6-digit random
    const otpExpiresAt = new Date(Date.now() + OTP_EXPIRATION_MINUTES * 60000);

    const wallet = ethers.Wallet.createRandom();

    // Encrypt the private key for secure storage
    const encryptedPrivateKey = encryptPrivateKey(wallet.privateKey);
    
    // Create new user in DB (kycVerified = false until email verified)
    const newUser = await prisma.user.create({
      data: {
           phone,
          email,
          passwordHash,
          kycVerified: false,
          otpCode: otpCode,
          otpExpiresAt: otpExpiresAt,
          walletAddress: wallet.address,
          sensei: encryptedPrivateKey, // Store encrypted private key
          role: 'USER',
          gasCredit: 0,      // initial gas credit in UGX (e.g., 5000 UGX welcome credit)
          ugxCredit: 0
      }
    });
  

    try {
      await emailService.sendVerificationEmail(newUser.email, otpCode);
    } catch (emailErr) {
      logger.error("Failed to send verification email:", emailErr);
      // Don't leak error details to user
    }
    logger.info(`New user registered: ${newUser.email}, OTP sent.`);
    return res.status(201).json({ 
      message: "Registration successful. Please check your email for verification code to complete signup.",
      wallet: {
        address: wallet.address,
        privateKey: wallet.privateKey
      },
      important: "SAVE YOUR PRIVATE KEY SECURELY! This is the only time it will be shown. You need it to sign transactions."
    });
  } catch (err) {
    next(err);
  }
};

// POST /auth/verify
async verifyEmail (req, res, next)  {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ error: "Email and verification code are required." });
    }
    // Find the user by email
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(400).json({ error: "Invalid email or code." });
    }
    // Check if OTP code and expiry exist
    if (!user.otpCode) {
      return res.status(400).json({ error: "No pending verification for this user." });
    }
    // Check OTP code and expiration
    if (code !== user.otpCode || new Date() > user.otpExpiresAt) {
      return res.status(400).json({ error: "Invalid or expired verification code." });
    }
    // Mark user as verified (kycVerified true)
    await prisma.user.update({
      where: { id: user.id },
      data: { kycVerified: true }
    });
    logger.info(`User ${user.email} verified successfully.`);
    return res.status(200).json({ message: "Email verified! You can now log in." });
  } catch (err) {
    next(err);
  }
};

// POST /auth/login
  async login(req, res, next) {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required." });
      }
      // Find user by email
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        return res.status(401).json({ error: "Invalid credentials." });
      }
      // Ensure email is verified (KYC done)
      if (!user.kycVerified) {
        return res.status(403).json({ error: "Email not verified. Please verify your account before login." });
      }
      // Verify password
      const validPass = await bcrypt.compare(password, user.passwordHash);
      if (!validPass) {
        return res.status(401).json({ error: "Invalid credentials." });
      }
      // Generate JWT token (include userId and role in payload)
      const token = jwt.sign(
        { userId: user.id, role: user.role },
        JWT_SECRET,
        { expiresIn: '1d' }
      );
      logger.info(`User ${user.email} logged in successfully.`);
      return res.json({
        token,
        user: { email: user.email, phone: user.phone, role: user.role }
      });
    } catch (err) {
      next(err);
    }
  };

}

module.exports = new AuthController()