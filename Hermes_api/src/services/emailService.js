// src/services/emailService.js
const nodemailer = require('nodemailer');

// Configure Nodemailer transporter for Gmail (using App Password for authentication)
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});
// Note: Using a Gmail App Password is recommended since Google no longer allows less secure app access:contentReference[oaicite:14]{index=14}.

exports.sendVerificationEmail = async (toEmail, otpCode) => {
  const mailOptions = {
    from: `"Hermes Support" <${process.env.GMAIL_USER}>`,
    to: toEmail,
    subject: "Your Hermes Verification Code",
    text: `Your verification code is: ${otpCode}\nThis code will expire in 10 minutes.`

  };
  // Send mail and return a promise
  await transporter.sendMail(mailOptions);
};
