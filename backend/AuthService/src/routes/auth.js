const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const prisma = require('../utils/prisma');
const { logAction } = require('../utils/auditLog');
const { authenticateToken, requireRole } = require('../middleware/auth');

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const identifier = String(username || '').trim();
    const user = await prisma.user.findFirst({ where: { OR: [{ username: identifier }, { email: identifier }] } });
    
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    if (!user.isActive) {
      return res.status(403).json({ error: 'Account deactivated' });
    }
    if (user.mustChangePassword && user.passwordResetExpiresAt && user.passwordResetExpiresAt <= new Date()) {
      return res.status(403).json({ error: 'Temporary password expired. Contact an administrator for a new reset.' });
    }

    const assignments = await prisma.tcTerritoryAssignment.findMany({
      where: { tcId: user.id, isActive: true },
      include: { territory: true }
    });

    const tokenPayload = {
      id: user.id,
      username: user.username,
      role: user.role,
      tokenVersion: user.tokenVersion,
      mustChangePassword: user.mustChangePassword,
    };
    const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, { expiresIn: '1d' });
    const refreshToken = jwt.sign({ id: user.id, tokenVersion: user.tokenVersion }, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' });

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() }
    });

    await logAction(user.id, 'LOGIN', 'User', user.id, null, req);

    res.json({
      token,
      refreshToken,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        phoneNumber: user.phoneNumber,
        role: user.role,
        firstName: user.firstName,
        lastName: user.lastName,
        mustChangePassword: user.mustChangePassword,
        passwordResetExpiresAt: user.passwordResetExpiresAt,
        assignedTerritories: assignments.map(a => ({
          id: a.territory.id,
          name: a.territory.name
        }))
      }
    });
  } catch (error) {
    console.error('Login error:', error.code || error.name);
    res.status(500).json({ error: 'Could not sign in right now. Please try again.', stack: error.stack });
  }
});

router.post('/register', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  const { username, password, email, role, firstName, lastName, phoneNumber } = req.body;
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { username, email, passwordHash, role, firstName, lastName, phoneNumber }
    });
    await logAction(req.user.id, 'CREATE_USER', 'User', user.id, { username, role }, req);
    res.status(201).json({ id: user.id, username: user.username, role: user.role });
  } catch (error) {
    res.status(400).json({ error: 'Registration failed, possibly duplicate username or email' });
  }
});

router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.sendStatus(401);
  
  jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET, async (err, payload) => {
    if (err) return res.sendStatus(403);
    try {
      const user = await prisma.user.findUnique({ where: { id: payload.id } });
      if (!user || !user.isActive || Number(payload.tokenVersion ?? 0) !== user.tokenVersion) return res.sendStatus(403);
      if (user.mustChangePassword && user.passwordResetExpiresAt && user.passwordResetExpiresAt <= new Date()) return res.sendStatus(403);
      const token = jwt.sign({
        id: user.id,
        username: user.username,
        role: user.role,
        tokenVersion: user.tokenVersion,
        mustChangePassword: user.mustChangePassword,
      }, process.env.JWT_SECRET, { expiresIn: '1d' });
      res.json({ token, mustChangePassword: user.mustChangePassword });
    } catch (error) {
      console.error('Token refresh error:', error.code || error.name);
      res.status(503).json({ error: 'Authentication is temporarily unavailable.' });
    }
  });
});

router.post('/logout', (req, res) => {
  res.json({ message: 'Logged out successfully' });
});

router.post('/change-password', authenticateToken, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: 'Provide your current password and a new password with at least 8 characters.' });
  }
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
      return res.status(400).json({ error: 'Your current password is incorrect.' });
    }
    if (await bcrypt.compare(newPassword, user.passwordHash)) {
      return res.status(400).json({ error: 'Choose a new password that differs from your current or temporary password.' });
    }
    const passwordHash = await bcrypt.hash(newPassword, 10);
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        mustChangePassword: false,
        passwordResetExpiresAt: null,
        tokenVersion: { increment: 1 },
      },
    });
    const tokenPayload = { id: updatedUser.id, username: updatedUser.username, role: updatedUser.role, tokenVersion: updatedUser.tokenVersion, mustChangePassword: false };
    const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, { expiresIn: '1d' });
    const refreshToken = jwt.sign({ id: updatedUser.id, tokenVersion: updatedUser.tokenVersion }, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' });
    await logAction(user.id, 'CHANGE_PASSWORD', 'User', user.id, { forcedReset: Boolean(user.mustChangePassword) }, req);
    res.json({ message: 'Password updated successfully.', token, refreshToken, mustChangePassword: false });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Could not update your password.' });
  }
});

router.post('/internal/verify', authenticateToken, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user || !user.isActive) return res.sendStatus(403);
  res.json({ user: { id: user.id, username: user.username, role: user.role } });
});

module.exports = router;
