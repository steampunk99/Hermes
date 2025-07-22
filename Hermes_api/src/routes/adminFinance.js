// File: src/routes/adminFinance.js
// Admin routes for manual payment confirmation
const express = require('express');
const router = express.Router();
const adminFinance = require('../controllers/adminFinance');


// Admin authentication middleware (requires HYPERADMIN role)
const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'HYPERADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

const { 
  adminSecurity, 
  requireAuth, 
  requireRole 
} = require('../middleware/advancedSecurity');

// Apply authentication and admin role check to all routes
router.use(requireAuth);
router.use(requireRole(['ADMIN', 'HYPERADMIN']));




// Apply admin middleware to all routes
router.use(requireAdmin);

// GET /admin/payments/pending - List pending mobile money deposits
router.get('/pending', ...adminSecurity('admin-payments-pending'), adminFinance.getPendingPayments);

// POST /admin/payments/confirm - Manually confirm a payment and mint UGDX
router.post('/confirm', ...adminSecurity('admin-payments-confirm'), adminFinance.confirmPayment);

// POST /admin/payments/reject - Manually reject a payment
router.post('/reject', ...adminSecurity('admin-payments-reject'), adminFinance.rejectPayment);

// GET /admin/payments/history - Get payment history with filters
router.get('/history', ...adminSecurity('admin-payments-history'), adminFinance.getPaymentHistory);

// GET /admin/payments/treasury - Get onchain treasury overview and fee collections
router.get('/treasury', 
  ...adminSecurity('admin-payments-treasury'), 
  adminFinance.getTreasuryOverview
);

// GET /admin/payments/balance/:userId - Get user's on-chain UGDX balance
router.get('/balance/:userId',
  ...adminSecurity('admin-payments-balance'),
  adminFinance.getUserBalance
);
module.exports = router;
