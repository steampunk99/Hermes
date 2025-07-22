// src/middleware/advancedSecurity.js
const { prisma, logger } = require('../config');
const rateLimit = require('express-rate-limit');
const slowDown = require('express-slow-down');
const {
  getUserSecurityStatus,
  recordSecurityViolation,
  lockUser,
  escalateUserRisk,
  checkUserAccess,
  logSecurityEvent
} = require('../services/securityService');

// Authentication Middleware
const requireAuth = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
};

// Admin Role Checker
const requireRole = (roles = []) => {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user.userId },
        select: { role: true }
      });

      if (!user || !roles.includes(user.role)) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      next();
    } catch (error) {
      logger.error('Role check error:', error);
      res.status(500).json({ error: 'Server error during authorization' });
    }
  };
};

// Security tracking store (in production, use Redis)
const securityStore = new Map();

// Helper function to get user key for tracking
const getUserKey = (req) => {
  return req.user?.userId || req.ip || 'anonymous';
};

// Track suspicious activity patterns
const trackSuspiciousActivity = async (userKey, endpoint, req) => {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000; // 10 minutes
  
  if (!securityStore.has(userKey)) {
    securityStore.set(userKey, {
      requests: [],
      violations: 0,
      flaggedUntil: null,
      lastViolation: null,
      endpoints: new Map()
    });
  }
  
  const userData = securityStore.get(userKey);
  
  // Clean old requests (outside window)
  userData.requests = userData.requests.filter(req => now - req.timestamp < windowMs);
  
  // Add current request
  userData.requests.push({
    timestamp: now,
    endpoint,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });
  
  // Track endpoint-specific requests
  if (!userData.endpoints.has(endpoint)) {
    userData.endpoints.set(endpoint, []);
  }
  const endpointRequests = userData.endpoints.get(endpoint);
  endpointRequests.push(now);
  userData.endpoints.set(endpoint, endpointRequests.filter(t => now - t < windowMs));
  
  return userData;
};

// Check if user is flagged
const checkUserFlag = async (userKey) => {
  const userData = securityStore.get(userKey);
  if (!userData) return { flagged: false };
  
  if (userData.flaggedUntil && Date.now() < userData.flaggedUntil) {
    return {
      flagged: true,
      reason: 'Suspicious activity detected',
      flaggedUntil: new Date(userData.flaggedUntil),
      violations: userData.violations
    };
  }
  
  return { flagged: false };
};

// Flag user for suspicious activity
const flagUser = async (userKey, reason, durationHours = 48) => {
  const userData = securityStore.get(userKey) || {
    requests: [],
    violations: 0,
    flaggedUntil: null,
    lastViolation: null,
    endpoints: new Map()
  };
  
  userData.violations += 1;
  userData.flaggedUntil = Date.now() + (durationHours * 60 * 60 * 1000);
  userData.lastViolation = Date.now();
  
  securityStore.set(userKey, userData);
  
  logSecurityEvent('warn', userKey, `🚨 USER FLAGGED: ${reason}`, {
    violations: userData.violations,
    flaggedUntil: new Date(userData.flaggedUntil),
    durationHours
  });
  
  // Store in database for persistence
  try {
    if (userKey !== 'anonymous' && userKey.length > 10) {
      await prisma.user.update({
        where: { id: userKey },
        data: {
          // Add security flags to user model if needed
        }
      });
    }
  } catch (err) {
    logger.error('Failed to update user security flags:', err);
  }
};

// Advanced rate limiter with progressive penalties
const createAdvancedRateLimit = (options = {}) => {
  const {
    windowMs = 15 * 60 * 1000, // 15 minutes
    maxRequests = 10,
    endpoint = 'unknown',
    skipSuccessfulRequests = false,
    skipFailedRequests = false
  } = options;
  
  return rateLimit({
    windowMs,
    max: maxRequests,
    skipSuccessfulRequests,
    skipFailedRequests,
    keyGenerator: (req) => getUserKey(req),
    handler: async (req, res) => {
      const userKey = getUserKey(req);
      
      logSecurityEvent('warn', userKey, `⚠️ RATE LIMIT EXCEEDED: ${endpoint}`, {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        endpoint
      });
      
      // For authenticated users, record in database and escalate
      if (req.user && req.user.userId) {
        await recordSecurityViolation(
          req.user.userId,
          'RATE_LIMIT',
          endpoint,
          'MEDIUM',
          `Rate limit exceeded: ${maxRequests} requests in ${Math.ceil(windowMs / 60000)} minutes`,
          req
        );
        
        // Escalate user risk and potentially lock account
        const escalation = await escalateUserRisk(req.user.userId, 'RATE_LIMIT', endpoint, req);
        
        if (escalation.locked) {
          return res.status(429).json({
            error: 'Account locked for security violations',
            message: 'Your account has been locked due to repeated rate limit violations.',
            lockedUntil: escalation.lockUntil,
            violationCount: escalation.violationCount,
            riskLevel: escalation.riskLevel
          });
        }
        
        return res.status(429).json({
          error: 'Rate limit exceeded',
          message: `Rate limit exceeded for ${endpoint}. Please wait before trying again.`,
          retryAfter: Math.ceil(windowMs / 1000),
          violationCount: escalation.violationCount || 'N/A',
          riskLevel: escalation.newRiskLevel || 'N/A'
        });
      } else {
        // For unauthenticated users, use in-memory tracking
        const userData = await trackSuspiciousActivity(userKey, endpoint, req);
        
        // Progressive penalties for anonymous users
        if (userData.violations >= 3) {
          await flagUser(userKey, `Multiple rate limit violations on ${endpoint}`, 48);
          return res.status(429).json({
            error: 'IP flagged for suspicious activity',
            message: 'This IP has been flagged for review due to suspicious activity.',
            flaggedUntil: new Date(userData.flaggedUntil),
            violations: userData.violations
          });
        } else if (userData.violations >= 1) {
          await flagUser(userKey, `Rate limit violation on ${endpoint}`, 2);
        }
        
        return res.status(429).json({
          error: 'Too many requests',
          message: `Rate limit exceeded for ${endpoint}. Please wait before trying again.`,
          retryAfter: Math.ceil(windowMs / 1000),
          violations: userData.violations
        });
      }
    },
    onLimitReached: async (req, res) => {
      const userKey = getUserKey(req);
      logSecurityEvent('warn', userKey, `🚨 RATE LIMIT REACHED: ${endpoint}`);
    }
  });
};

// Cooldown middleware - forces delays between requests
const createCooldownMiddleware = (cooldownMs = 5000, endpoint = 'unknown') => {
  const lastRequestTimes = new Map();
  
  return async (req, res, next) => {
    const userKey = getUserKey(req);
    const now = Date.now();
    const lastRequest = lastRequestTimes.get(userKey);
    
    if (lastRequest && (now - lastRequest) < cooldownMs) {
      const remainingCooldown = cooldownMs - (now - lastRequest);
      
      logSecurityEvent('warn', userKey, `❄️ COOLDOWN VIOLATION: ${endpoint}`, {
        remainingMs: remainingCooldown,
        endpoint
      });
      
      // Track as suspicious activity
      await trackSuspiciousActivity(userKey, endpoint, req);
      
      return res.status(429).json({
        error: 'Cooldown period active',
        message: `Please wait ${Math.ceil(remainingCooldown / 1000)} seconds before making another request to ${endpoint}`,
        remainingCooldown: Math.ceil(remainingCooldown / 1000)
      });
    }
    
    lastRequestTimes.set(userKey, now);
    next();
  };
};

// Suspicious pattern detection middleware with database integration
const suspiciousPatternDetection = (endpoint = 'unknown') => {
  return async (req, res, next) => {
    const userKey = getUserKey(req);
    
    // For authenticated users, check database security status
    if (req.user && req.user.userId) {
      const accessCheck = await checkUserAccess(req.user.userId, endpoint, req);
      
      if (!accessCheck.allowed) {
        logSecurityEvent('error', userKey, `🚫 DATABASE BLOCKED: ${accessCheck.reason}`, {
          endpoint,
          riskLevel: accessCheck.riskLevel,
          lockedUntil: accessCheck.lockedUntil
        });
        
        return res.status(403).json({
          error: 'Account restricted',
          message: accessCheck.reason,
          lockedUntil: accessCheck.lockedUntil,
          violationCount: accessCheck.violationCount,
          riskLevel: accessCheck.riskLevel,
          contact: 'Please contact support if you believe this is an error.'
        });
      }
    }
    
    // Continue with in-memory pattern detection for additional security
    const flagCheck = await checkUserFlag(userKey);
    if (flagCheck.flagged) {
      logSecurityEvent('error', userKey, `🚫 MEMORY BLOCKED: User is flagged`, {
        reason: flagCheck.reason,
        violations: flagCheck.violations,
        flaggedUntil: flagCheck.flaggedUntil
      });
      
      return res.status(403).json({
        error: 'Account flagged',
        message: 'Your account has been flagged for suspicious activity and is under review.',
        flaggedUntil: flagCheck.flaggedUntil,
        violations: flagCheck.violations,
        contact: 'Please contact support if you believe this is an error.'
      });
    }
    
    // Track this request
    const userData = await trackSuspiciousActivity(userKey, endpoint, req);
    
    // Analyze patterns
    const recentRequests = userData.requests.filter(r => Date.now() - r.timestamp < 60000); // Last minute
    const endpointRequests = userData.endpoints.get(endpoint) || [];
    const recentEndpointRequests = endpointRequests.filter(t => Date.now() - t < 60000);
    
    // Pattern detection rules
    const patterns = {
      rapidFire: recentRequests.length > 20, // More than 20 requests in 1 minute
      endpointSpam: recentEndpointRequests.length > 10, // More than 10 requests to same endpoint in 1 minute
      multipleEndpoints: userData.endpoints.size > 5 && recentRequests.length > 15, // Hitting many endpoints rapidly
      suspiciousUserAgent: !req.get('User-Agent') || req.get('User-Agent').includes('bot') || req.get('User-Agent').length < 10
    };
    
    // Check for suspicious patterns
    const suspiciousPatterns = Object.entries(patterns).filter(([_, detected]) => detected);
    
    if (suspiciousPatterns.length > 0) {
      const patternNames = suspiciousPatterns.map(([name]) => name).join(', ');
      
      logSecurityEvent('error', userKey, `🚨 SUSPICIOUS PATTERNS DETECTED: ${patternNames}`, {
        patterns,
        recentRequests: recentRequests.length,
        endpointRequests: recentEndpointRequests.length,
        userAgent: req.get('User-Agent'),
        endpoint
      });
      
      // For authenticated users, record in database and potentially lock account
      if (req.user && req.user.userId) {
        await recordSecurityViolation(
          req.user.userId,
          'SUSPICIOUS_PATTERN',
          endpoint,
          'HIGH',
          `Suspicious patterns detected: ${patternNames}`,
          req
        );
        
        // Escalate user risk and potentially lock account
        const escalation = await escalateUserRisk(req.user.userId, 'SUSPICIOUS_PATTERN', endpoint, req);
        
        if (escalation.locked) {
          return res.status(403).json({
            error: 'Account locked for security violations',
            message: 'Your account has been locked due to suspicious activity patterns.',
            patterns: patternNames,
            lockedUntil: escalation.lockUntil,
            violationCount: escalation.violationCount,
            riskLevel: escalation.riskLevel
          });
        }
      } else {
        // For unauthenticated users, use in-memory flagging
        await flagUser(userKey, `Suspicious patterns detected: ${patternNames}`, 48);
      }
      
      return res.status(403).json({
        error: 'Suspicious activity detected',
        message: 'Your account has been flagged due to suspicious activity patterns.',
        patterns: patternNames,
        flaggedFor: req.user ? 'Account locked based on violation history' : '48 hours'
      });
    }
    
    next();
  };
};

// Progressive slow-down middleware
const createProgressiveSlowDown = (endpoint = 'unknown') => {
  return slowDown({
    windowMs: 15 * 60 * 1000, // 15 minutes
    delayAfter: 5, // Allow 5 requests per windowMs without delay
    delayMs: 1000, // Add 1 second delay per request after delayAfter
    maxDelayMs: 10000, // Maximum delay of 10 seconds
    keyGenerator: (req) => getUserKey(req),
    onLimitReached: (req, res) => {
      const userKey = getUserKey(req);
      logSecurityEvent('warn', userKey, `🐌 SLOW DOWN ACTIVATED: ${endpoint}`);
    }
  });
};

// Admin route security (maximum security)
const adminSecurity = (endpoint) => [
  suspiciousPatternDetection(endpoint),
  createCooldownMiddleware(10000, endpoint), // 10 second cooldown
  createProgressiveSlowDown(endpoint),
  createAdvancedRateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    maxRequests: 5, // Only 5 requests per 15 minutes
    endpoint,
    skipSuccessfulRequests: false
  })
];

// Finance route security (high security)
const financeSecurity = (endpoint) => [
  suspiciousPatternDetection(endpoint),
  createCooldownMiddleware(5000, endpoint), // 5 second cooldown
  createProgressiveSlowDown(endpoint),
  createAdvancedRateLimit({
    windowMs: 10 * 60 * 1000, // 10 minutes
    maxRequests: 10, // 10 requests per 10 minutes
    endpoint,
    skipSuccessfulRequests: true // Don't count successful requests
  })
];

// Standard security (moderate security)
const standardSecurity = (endpoint) => [
  suspiciousPatternDetection(endpoint),
  createCooldownMiddleware(2000, endpoint), // 2 second cooldown
  createAdvancedRateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    maxRequests: 30, // 30 requests per 5 minutes
    endpoint,
    skipSuccessfulRequests: true
  })
];

// Security status endpoint for monitoring
const getSecurityStatus = (req, res) => {
  const userKey = getUserKey(req);
  const userData = securityStore.get(userKey);
  
  if (!userData) {
    return res.json({
      status: 'clean',
      violations: 0,
      flagged: false
    });
  }
  
  const flagCheck = checkUserFlag(userKey);
  
  res.json({
    status: flagCheck.flagged ? 'flagged' : 'monitored',
    violations: userData.violations,
    flagged: flagCheck.flagged,
    flaggedUntil: userData.flaggedUntil ? new Date(userData.flaggedUntil) : null,
    recentRequests: userData.requests.length,
    endpointsAccessed: userData.endpoints.size
  });
};

module.exports = {
  // Authentication
  requireAuth,
  requireRole,
  
  // Security middleware
  adminSecurity,
  financeSecurity,
  standardSecurity,
  getSecurityStatus,
  trackSuspiciousActivity,
  flagUser,
  createAdvancedRateLimit,
  createCooldownMiddleware,
  suspiciousPatternDetection,
  createProgressiveSlowDown,
  
  // Utils
  securityStore
};
