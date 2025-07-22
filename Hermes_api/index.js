const express = require('express');
const { logger, prisma, JWT_SECRET } = require('./src/config'); 
const jwt = require('jsonwebtoken');
const { startOracleRateJob, updateExchangeRate } = require('./src/jobs/oracleRate');
const { initEventListeners } = require('./src/services/listeners');

const authRoutes = require('./src/routes/auth');
const userRoutes = require('./src/routes/users');
const transactionRoutes = require('./src/routes/transactions');
const webhookRoutes = require('./src/routes/webhook');
const monitorRoutes = require('./src/routes/monitor'); 
const securityRoutes = require('./src/routes/security');

const app = express();
app.use(express.json());  


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
app.use('/rates/current', transactionRoutes);  
app.use('/monitor', monitorRoutes);  

// Protected routes (use authenticateToken middleware)
app.use('/user', authenticateToken, userRoutes);
app.use('/transactions', authenticateToken, transactionRoutes);
// Admin routes
app.use('/admin/finance', authenticateToken, require('./src/routes/adminFinance'));
app.use('/security', authenticateToken, securityRoutes);

// A basic health check endpoint
app.get('/health', (req, res) => res.status(200).send('OK'));



// Global error handler (catch-all)
app.use((err, req, res, next) => {
  logger.error("Unhandled error:", err);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Hermes v2 backend running on port ${PORT}`);
  
  // Start the oracle rate update job
  startOracleRateJob();
  
  // Initialize blockchain event listeners
  initEventListeners();
});

//db connection check
prisma.$connect()
  .then(async () => {
    logger.info("Connected to database successfully.");
    
    // Only trigger initial oracle rate update if Bridge is using Oracle pricing
    try {
      const { bridgeContract } = require('./src/config');
      const useOracleForPricing = await bridgeContract.useOracleForPricing();
      
      if (useOracleForPricing) {
        logger.info('Bridge is in Oracle pricing mode, triggering initial rate update');
        updateExchangeRate().catch(err => logger.error("Initial oracle update failed:", err));
      } else {
        logger.info('Bridge is in manual pricing mode, skipping initial Oracle rate update');
      }
    } catch (err) {
      logger.error('Failed to check Bridge pricing mode:', err);
    }
  })
  .catch(err => logger.error("Database connection failed:", err));