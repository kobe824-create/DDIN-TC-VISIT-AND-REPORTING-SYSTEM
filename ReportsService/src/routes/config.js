const express = require('express');
const { randomUUID } = require('crypto');
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
    res.json({ schema: config ? JSON.parse(config.value) : [] });
  } catch (error) {
    console.error('Checklist error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/checklist', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  try {
    const { schema } = req.body;
    const questions = Array.isArray(schema) ? schema : schema?.questions;
    if (!Array.isArray(questions) || questions.length > 50) {
      return res.status(400).json({ error: 'Checklist must contain up to 50 valid questions.' });
    }
    const ids = new Set();
    const normalizedQuestions = [];
    for (const [index, item] of questions.entries()) {
      if (!item || typeof item.text !== 'string' || !item.text.trim() || item.text.trim().length > 500
        || !['TEXT', 'YES_NO', 'MULTIPLE_CHOICE', 'NUMBER'].includes(item.type)) {
        return res.status(400).json({ error: 'Each question needs text (up to 500 characters) and a supported answer type.' });
      }
      const id = typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(item.id) ? item.id : randomUUID();
      if (ids.has(id)) return res.status(400).json({ error: 'Question IDs must be unique.' });
      ids.add(id);
      const section = String(item.section || 'DDIN').toUpperCase();
      if (!['IREMBO', 'DDIN'].includes(section)) return res.status(400).json({ error: 'Choose either the IREMBO or DDIN report section.' });
      let options = [];
      if (item.type === 'MULTIPLE_CHOICE') {
        options = Array.isArray(item.options) ? item.options.map((option) => String(option).trim()).filter(Boolean) : [];
        if (options.length < 2 || options.length > 20 || options.some((option) => option.length > 100)
          || new Set(options.map((option) => option.toLocaleLowerCase())).size !== options.length) {
          return res.status(400).json({ error: 'Multiple-choice questions need 2–20 unique options of up to 100 characters each.' });
        }
      }
      normalizedQuestions.push({
        id,
        text: item.text.trim(),
        type: item.type,
        section,
        required: section === 'IREMBO',
        options,
        order: Number.isInteger(item.order) && item.order > 0 ? item.order : index + 1,
      });
    }
    const config = await prisma.systemConfig.upsert({
      where: { key: 'VISIT_CHECKLIST_SCHEMA' },
      update: { value: JSON.stringify(normalizedQuestions), updatedAt: new Date() },
      create: { key: 'VISIT_CHECKLIST_SCHEMA', value: JSON.stringify(normalizedQuestions) }
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
