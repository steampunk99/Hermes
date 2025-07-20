const express = require('express');
const { logger, prisma, JWT_SECRET } = require('./src/config'); 
const jwt = require('jsonwebtoken');

const authRoutes = require('./src/routes/auth');
const userRoutes = require('./src/routes/users');
const transactionRoutes = require('./src/routes/transactions');
const webhookRoutes = require('./src/routes/webhook');
const monitorRoutes = require('./src/routes/monitor'); 

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
app.get('/rates/current', transactionRoutes);  
app.get('/monitor', monitorRoutes);  

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


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Hermes v2 backend running on port ${PORT}`);
});

//db connection check
prisma.$connect()
  .then(() => logger.info("Connected to database successfully."))
  .catch(err => logger.error("Database connection failed:", err));