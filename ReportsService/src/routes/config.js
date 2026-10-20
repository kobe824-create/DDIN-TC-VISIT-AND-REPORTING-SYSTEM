const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken, requireRole } = require('../middleware/auth');

router.get('/system', authenticateToken, async (req, res) => {
  try {
    const configs = await prisma.systemConfig.findMany();
    res.json(configs);
  } catch (error) {
    console.error('System config error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/checklist', authenticateToken, async (req, res) => {
  try {
    const config = await prisma.systemConfig.findUnique({
      where: { key: 'VISIT_CHECKLIST_SCHEMA' }
    });
    res.json({ schema: config ? JSON.parse(config.value) : {} });
  } catch (error) {
    console.error('Checklist error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/checklist', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  try {
    const { schema } = req.body;
    const questions = Array.isArray(schema) ? schema : schema?.questions;
    if (!Array.isArray(questions) || questions.length > 50 || questions.some((item) =>
      !item || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 500 ||
      !['TEXT', 'YES_NO', 'MULTIPLE_CHOICE'].includes(item.type) ||
      (item.type === 'MULTIPLE_CHOICE' && (!Array.isArray(item.options) || item.options.length < 2))
    )) {
      return res.status(400).json({ error: 'Checklist must contain up to 50 valid questions.' });
    }
    const config = await prisma.systemConfig.upsert({
      where: { key: 'VISIT_CHECKLIST_SCHEMA' },
      update: { value: JSON.stringify(schema), updatedAt: new Date() },
      create: { key: 'VISIT_CHECKLIST_SCHEMA', value: JSON.stringify(schema) }
    });
    
    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: 'UPDATE_CONFIG',
        resourceType: 'SystemConfig',
        details: { key: 'VISIT_CHECKLIST_SCHEMA' },
        ipAddress: req.ip,
        userAgent: req.get('user-agent')
      }
    });
    
    res.json({ schema: JSON.parse(config.value) });
  } catch (error) {
    console.error('Update checklist error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/geofence', authenticateToken, async (req, res) => {
  try {
    const config = await prisma.systemConfig.findUnique({
      where: { key: 'GEOFENCE_RADIUS_METERS' }
    });
    res.json({ radiusMeters: config ? parseInt(config.value) : 100 });
  } catch (error) {
    console.error('Geofence config error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/geofence', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  try {
    const { radiusMeters } = req.body;
    if (!Number.isInteger(radiusMeters) || radiusMeters < 10 || radiusMeters > 5000) {
      return res.status(400).json({ error: 'Radius must be a whole number between 10 and 5,000 metres.' });
    }
    const config = await prisma.systemConfig.upsert({
      where: { key: 'GEOFENCE_RADIUS_METERS' },
      update: { value: radiusMeters.toString(), updatedAt: new Date() },
      create: { key: 'GEOFENCE_RADIUS_METERS', value: radiusMeters.toString() }
    });
    
    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: 'UPDATE_CONFIG',
        resourceType: 'SystemConfig',
        details: { key: 'GEOFENCE_RADIUS_METERS', value: radiusMeters },
        ipAddress: req.ip,
        userAgent: req.get('user-agent')
      }
    });
    
    res.json({ radiusMeters: parseInt(config.value) });
  } catch (error) {
    console.error('Update geofence error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
