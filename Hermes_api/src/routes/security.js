// src/routes/security.js
const express = require('express');
const router = express.Router();
const { prisma, logger } = require('../config');
const { getSecurityStatus, adminSecurity } = require('../middleware/advancedSecurity');

// Admin authentication middleware (requires HYPERADMIN role)
const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'HYPERADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// Apply admin middleware to all routes
router.use(requireAdmin);

// GET /security/status - Get current user's security status
router.get('/status', ...adminSecurity('security-status'), getSecurityStatus);

// GET /security/dashboard - Get overall security dashboard (admin only)
router.get('/dashboard', ...adminSecurity('security-dashboard'), async (req, res) => {
  try {
    const { getSecurityAnalytics } = require('../services/securityService');
    const timeframe = req.query.timeframe || '24h';
    
    const analytics = await getSecurityAnalytics(timeframe);
    
    if (!analytics) {
      return res.status(500).json({ error: 'Failed to fetch security analytics' });
    }
    
    res.json({
      ...analytics,
      timestamp: new Date().toISOString(),
      generatedBy: req.user.email
    });
  } catch (error) {
    logger.error('Security dashboard error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /security/flagged - Get list of flagged users (admin only)
router.get('/flagged', ...adminSecurity('security-flagged'), async (req, res) => {
  try {
    const lockedUsers = await prisma.user.findMany({
      where: {
        isLocked: true,
        lockedUntil: { gt: new Date() }
      },
      select: {
        id: true,
        email: true,
        phone: true,
        isLocked: true,
        lockedUntil: true,
        violationCount: true,
        lastViolation: true,
        riskLevel: true,
        securityFlags: true,
        securityViolations: {
          orderBy: { createdAt: 'desc' },
          take: 3,
          select: {
            violationType: true,
            severity: true,
            description: true,
            createdAt: true
          }
        }
      }
    });
    
    const flaggedUsers = lockedUsers.map(user => ({
      userId: user.id.slice(0, 8) + '...',
      email: user.email,
      phone: user.phone?.slice(0, 6) + '***',
      isLocked: user.isLocked,
      lockedUntil: user.lockedUntil,
      violationCount: user.violationCount,
      lastViolation: user.lastViolation,
      riskLevel: user.riskLevel,
      securityFlags: user.securityFlags ? JSON.parse(user.securityFlags) : {},
      recentViolations: user.securityViolations
    }));
    
    res.json({
      flaggedUsers,
      total: flaggedUsers.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error fetching flagged users:', error);
    res.status(500).json({ error: 'Failed to fetch flagged users' });
  }
});

// POST /security/unflag - Unflag a user (admin only)
router.post('/unflag', ...adminSecurity('security-unflag'), async (req, res) => {
  const { userId, email } = req.body;
  
  if (!userId && !email) {
    return res.status(400).json({ error: 'userId or email is required' });
  }
  
  try {
    const { unlockUser } = require('../services/securityService');
    
    // Find user by ID or email
    const user = await prisma.user.findFirst({
      where: userId ? { id: userId } : { email },
      select: { id: true, email: true, isLocked: true }
    });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (!user.isLocked) {
      return res.status(400).json({ error: 'User is not currently locked' });
    }
    
    // Unlock the user
    const result = await unlockUser(user.id, req.user.userId, `Admin unlock by ${req.user.email}`);
    
    if (result.success) {
      logger.info(`Admin ${req.user.email} unlocked user ${user.email}`);
      
      res.json({ 
        success: true, 
        message: 'User unlocked successfully',
        userId: user.id.slice(0, 8) + '...',
        email: user.email
      });
    } else {
      res.status(500).json({ error: result.error || 'Failed to unlock user' });
    }
  } catch (error) {
    logger.error('Error unlocking user:', error);
    res.status(500).json({ error: 'Failed to unlock user' });
  }
});

module.exports = router;
