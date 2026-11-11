const jwt = require('jsonwebtoken');
const prisma = require('../utils/prisma');

async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: payload.id },
      select: { id: true, username: true, role: true, isActive: true, tokenVersion: true, mustChangePassword: true, passwordResetExpiresAt: true },
    });
    if (!user || !user.isActive || Number(payload.tokenVersion ?? 0) !== user.tokenVersion) return res.status(403).json({ error: 'Invalid or expired token' });
    if (user.mustChangePassword && user.passwordResetExpiresAt && user.passwordResetExpiresAt <= new Date()) return res.status(403).json({ error: 'Temporary password expired. Contact an administrator for a new reset.' });
    if (user.mustChangePassword) return res.status(403).json({ error: 'Password change required' });
    req.user = { ...payload, id: user.id, username: user.username, role: user.role, tokenVersion: user.tokenVersion, mustChangePassword: false };
    return next();
  } catch (error) {
    console.error('Authentication lookup failed:', error.code || error.name);
    return res.status(503).json({ error: 'Authentication is temporarily unavailable.' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

async function requireTerritoryAccess(req, res, next) {
  if (['ADMIN', 'MANAGER'].includes(req.user.role)) return next();
  if (req.user.role === 'TC') {
    const assignments = await prisma.tcTerritoryAssignment.findMany({
      where: { tcId: req.user.id, isActive: true }
    });
    req.user.assignedTerritories = assignments.map(a => a.territoryId);
    return next();
  }
  if (req.user.role === 'CHAMPION') return next();
  return res.status(403).json({ error: 'Access denied' });
}

module.exports = { authenticateToken, requireRole, requireTerritoryAccess };
