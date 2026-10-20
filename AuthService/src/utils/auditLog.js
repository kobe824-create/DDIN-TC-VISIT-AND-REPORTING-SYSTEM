const prisma = require('./prisma');

async function logAction(userId, action, resourceType, resourceId, details, req) {
  try {
    await prisma.auditLog.create({
      data: {
        userId,
        action,
        resourceType,
        resourceId,
        details: details || {},
        ipAddress: req?.ip,
        userAgent: req?.get('user-agent')
      }
    });
  } catch (e) {
    console.error('Failed to write audit log', e);
  }
}

module.exports = { logAction };
