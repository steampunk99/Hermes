// src/services/securityService.js
const { prisma, logger } = require('../config');

// Helper function to log security events with database persistence
const logSecurityEvent = (level, userKey, event, details = {}) => {
  const timestamp = new Date().toISOString().slice(11, 23);
  logger[level](`[${timestamp}] 🛡️ SECURITY [${userKey.slice(0, 8)}...]: ${event}`, details);
};

// Get user's current security status from database
const getUserSecurityStatus = async (userId) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        isLocked: true,
        lockedUntil: true,
        securityFlags: true,
        violationCount: true,
        lastViolation: true,
        riskLevel: true,
        securityViolations: {
          orderBy: { createdAt: 'desc' },
          take: 10 // Get last 10 violations
        }
      }
    });

    if (!user) return null;

    // Check if lock has expired
    if (user.isLocked && user.lockedUntil && new Date() > user.lockedUntil) {
      await unlockUser(userId, 'SYSTEM', 'Lock period expired');
      user.isLocked = false;
      user.lockedUntil = null;
    }

    return {
      ...user,
      securityFlags: user.securityFlags ? JSON.parse(user.securityFlags) : {},
      isCurrentlyLocked: user.isLocked && (!user.lockedUntil || new Date() < user.lockedUntil)
    };
  } catch (error) {
    logger.error('Error getting user security status:', error);
    return null;
  }
};

// Record a security violation in the database
const recordSecurityViolation = async (userId, violationType, endpoint, severity, description, req, actionTaken = null, lockDuration = null) => {
  try {
    const violation = await prisma.securityViolation.create({
      data: {
        userId,
        violationType,
        endpoint,
        severity,
        description,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
        metadata: JSON.stringify({
          headers: {
            'x-forwarded-for': req.get('x-forwarded-for'),
            'x-real-ip': req.get('x-real-ip'),
            'referer': req.get('referer')
          },
          timestamp: new Date().toISOString(),
          url: req.originalUrl,
          method: req.method
        }),
        actionTaken,
        lockDuration
      }
    });

    logSecurityEvent('warn', userId, `📝 VIOLATION RECORDED: ${violationType}`, {
      violationId: violation.id,
      severity,
      endpoint,
      description
    });

    return violation;
  } catch (error) {
    logger.error('Error recording security violation:', error);
    return null;
  }
};

// Lock user account with database persistence
const lockUser = async (userId, reason, durationHours = 48, violationType = 'SECURITY_VIOLATION', endpoint = 'unknown', req = {}) => {
  try {
    const lockUntil = new Date(Date.now() + (durationHours * 60 * 60 * 1000));
    
    // Update user security status
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        isLocked: true,
        lockedUntil: lockUntil,
        violationCount: { increment: 1 },
        lastViolation: new Date(),
        riskLevel: durationHours >= 48 ? 'HIGH' : durationHours >= 24 ? 'MEDIUM' : 'LOW',
        securityFlags: JSON.stringify({
          reason,
          lockedAt: new Date().toISOString(),
          lockDuration: durationHours,
          autoLocked: true
        })
      }
    });

    // Record the violation
    await recordSecurityViolation(
      userId,
      violationType,
      endpoint,
      durationHours >= 48 ? 'CRITICAL' : durationHours >= 24 ? 'HIGH' : 'MEDIUM',
      reason,
      req,
      'LOCKED',
      durationHours
    );

    logSecurityEvent('error', userId, `🔒 USER LOCKED: ${reason}`, {
      durationHours,
      lockUntil,
      violationCount: updatedUser.violationCount,
      riskLevel: updatedUser.riskLevel
    });

    return {
      success: true,
      lockUntil,
      violationCount: updatedUser.violationCount,
      riskLevel: updatedUser.riskLevel
    };
  } catch (error) {
    logger.error('Error locking user:', error);
    return { success: false, error: error.message };
  }
};

// Unlock user account (admin action)
const unlockUser = async (userId, adminId = 'SYSTEM', reason = 'Admin unlock') => {
  try {
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        isLocked: false,
        lockedUntil: null,
        riskLevel: 'LOW', // Reset risk level on unlock
        securityFlags: JSON.stringify({
          unlockedBy: adminId,
          unlockedAt: new Date().toISOString(),
          reason
        })
      }
    });

    // Update the most recent unresolved violation
    await prisma.securityViolation.updateMany({
      where: {
        userId,
        resolvedAt: null,
        actionTaken: 'LOCKED'
      },
      data: {
        resolvedBy: adminId,
        resolvedAt: new Date()
      }
    });

    logSecurityEvent('info', userId, `🔓 USER UNLOCKED: ${reason}`, {
      adminId,
      violationCount: updatedUser.violationCount
    });

    return { success: true };
  } catch (error) {
    logger.error('Error unlocking user:', error);
    return { success: false, error: error.message };
  }
};

// Escalate user risk level based on violations
const escalateUserRisk = async (userId, violationType, endpoint, req) => {
  try {
    const user = await getUserSecurityStatus(userId);
    if (!user) return { escalated: false };

    let newRiskLevel = user.riskLevel;
    let lockDuration = 0;
    let shouldLock = false;

    // Risk escalation logic
    switch (user.riskLevel) {
      case 'LOW':
        if (user.violationCount >= 3) {
          newRiskLevel = 'MEDIUM';
          lockDuration = 2; // 2 hours
          shouldLock = true;
        }
        break;
      case 'MEDIUM':
        if (user.violationCount >= 5) {
          newRiskLevel = 'HIGH';
          lockDuration = 24; // 24 hours
          shouldLock = true;
        }
        break;
      case 'HIGH':
        if (user.violationCount >= 7) {
          newRiskLevel = 'CRITICAL';
          lockDuration = 72; // 72 hours
          shouldLock = true;
        }
        break;
      case 'CRITICAL':
        // Always lock critical users for longer periods
        lockDuration = 168; // 1 week
        shouldLock = true;
        break;
    }

    if (shouldLock) {
      const lockResult = await lockUser(
        userId,
        `Risk escalation: ${user.violationCount} violations (${user.riskLevel} → ${newRiskLevel})`,
        lockDuration,
        violationType,
        endpoint,
        req
      );
      return { escalated: true, locked: true, ...lockResult };
    } else if (newRiskLevel !== user.riskLevel) {
      // Update risk level without locking
      await prisma.user.update({
        where: { id: userId },
        data: { riskLevel: newRiskLevel }
      });
      return { escalated: true, locked: false, newRiskLevel };
    }

    return { escalated: false };
  } catch (error) {
    logger.error('Error escalating user risk:', error);
    return { escalated: false, error: error.message };
  }
};

// Check if user should be blocked based on database status
const checkUserAccess = async (userId, endpoint, req) => {
  try {
    const securityStatus = await getUserSecurityStatus(userId);
    
    if (!securityStatus) {
      return { allowed: true, reason: 'User not found' };
    }

    // Check if user is currently locked
    if (securityStatus.isCurrentlyLocked) {
      await recordSecurityViolation(
        userId,
        'ACCESS_DENIED',
        endpoint,
        'HIGH',
        'Attempted access while account is locked',
        req,
        'BLOCKED'
      );

      return {
        allowed: false,
        reason: 'Account locked due to security violations',
        lockedUntil: securityStatus.lockedUntil,
        violationCount: securityStatus.violationCount,
        riskLevel: securityStatus.riskLevel
      };
    }

    // Check risk level restrictions
    if (securityStatus.riskLevel === 'CRITICAL' && endpoint.includes('admin')) {
      return {
        allowed: false,
        reason: 'Critical risk users cannot access admin functions',
        riskLevel: securityStatus.riskLevel
      };
    }

    return { allowed: true, securityStatus };
  } catch (error) {
    logger.error('Error checking user access:', error);
    return { allowed: true, reason: 'Security check failed' };
  }
};

// Get security analytics for admin dashboard
const getSecurityAnalytics = async (timeframe = '24h') => {
  try {
    const hoursBack = timeframe === '24h' ? 24 : timeframe === '7d' ? 168 : 1;
    const since = new Date(Date.now() - (hoursBack * 60 * 60 * 1000));

    const [
      totalViolations,
      lockedUsers,
      violationsByType,
      violationsBySeverity,
      riskDistribution
    ] = await Promise.all([
      // Total violations in timeframe
      prisma.securityViolation.count({
        where: { createdAt: { gte: since } }
      }),
      
      // Currently locked users
      prisma.user.count({
        where: { 
          isLocked: true,
          lockedUntil: { gt: new Date() }
        }
      }),
      
      // Violations by type
      prisma.securityViolation.groupBy({
        by: ['violationType'],
        where: { createdAt: { gte: since } },
        _count: { violationType: true }
      }),
      
      // Violations by severity
      prisma.securityViolation.groupBy({
        by: ['severity'],
        where: { createdAt: { gte: since } },
        _count: { severity: true }
      }),
      
      // Risk level distribution
      prisma.user.groupBy({
        by: ['riskLevel'],
        _count: { riskLevel: true }
      })
    ]);

    return {
      timeframe,
      totalViolations,
      lockedUsers,
      violationsByType: violationsByType.reduce((acc, item) => {
        acc[item.violationType] = item._count.violationType;
        return acc;
      }, {}),
      violationsBySeverity: violationsBySeverity.reduce((acc, item) => {
        acc[item.severity] = item._count.severity;
        return acc;
      }, {}),
      riskDistribution: riskDistribution.reduce((acc, item) => {
        acc[item.riskLevel] = item._count.riskLevel;
        return acc;
      }, {})
    };
  } catch (error) {
    logger.error('Error getting security analytics:', error);
    return null;
  }
};

module.exports = {
  getUserSecurityStatus,
  recordSecurityViolation,
  lockUser,
  unlockUser,
  escalateUserRisk,
  checkUserAccess,
  getSecurityAnalytics,
  logSecurityEvent
};
