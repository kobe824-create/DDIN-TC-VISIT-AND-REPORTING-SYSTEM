const prisma = require('./prisma');

async function logAction(userId, action, resourceType, resourceId, details, req) {
  try {
    await prisma.auditLog.create({
      data: {
        userId,
        action,
        resourceType,
        resourceId: resourceId || null,
        details: details || {},
        ipAddress: req?.ip || null,
        userAgent: req?.get?.('user-agent') || null
      }
    });
  } catch (e) {
    console.error('Failed to write audit log:', e.message);
  }
}

module.exports = { logAction };
