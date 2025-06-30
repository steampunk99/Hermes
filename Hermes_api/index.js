// src/index.js
const express = require('express');
const { logger, prisma, JWT_SECRET } = require('./config');  // import shared config
const jwt = require('jsonwebtoken');

const authRoutes = require('./src/routes/authRoutes');
const userRoutes = require('./src/routes/userRoutes');
const transactionRoutes = require('./routes/transactionRoutes');
const webhookRoutes = require('./src/routes/webhookRoutes');

const app = express();
app.use(express.json());  // parse JSON request bodies

// Simple request logger middleware (using Winston)
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.url}`);
  next();
});

// JWT Authentication middleware for protected routes
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'No token provided, authorization denied.' });
  }
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      logger.warn("JWT verification failed:", err);
      return res.status(403).json({ error: 'Invalid or expired token.' });
    }
    // decoded payload contains e.g. { userId, role, iat, exp }
    req.user = decoded;
    next();
  });
}

// Mount public routes
app.use('/auth', authRoutes);
app.use('/webhook', webhookRoutes);
app.get('/rates/current', transactionRoutes);  // allow public access to current rates

// Protected routes (use authenticateToken middleware)
app.use('/user', authenticateToken, userRoutes);
app.use('/transactions', authenticateToken, transactionRoutes);

// A basic health check endpoint
app.get('/health', (req, res) => res.status(200).send('OK'));

// Global error handler (catch-all)
app.use((err, req, res, next) => {
  logger.error("Unhandled error:", err);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Hermes v2 backend running on port ${PORT}`);
});
