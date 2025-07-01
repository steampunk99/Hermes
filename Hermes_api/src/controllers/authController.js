// src/controllers/authController.js
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { prisma, logger, JWT_SECRET } = require('../config');
const jwt = require('jsonwebtoken');
const emailService = require('../services/emailService');
const {ethers} = require('ethers')
const OTP_EXPIRATION_MINUTES = 10;  // OTP valid for 10 minutes


class AuthController {


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
          role: 'user',
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
    return res.status(201).json({ message: "Registration successful. Please check your email for verification code to complete signup." });
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
    // (In a real app, user._otpCode would not be stored in DB permanently. 
    // For this MVP, assume we somehow retrieved the OTP and expiry attached to user object after registration.)
    if (!user._otpCode) {
      return res.status(400).json({ error: "No pending verification for this user." });
    }
    // Check OTP code and expiration
    if (code !== user._otpCode || new Date() > user._otpExpiresAt) {
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