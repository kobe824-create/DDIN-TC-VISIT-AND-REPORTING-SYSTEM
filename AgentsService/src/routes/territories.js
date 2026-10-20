const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { logAction } = require('../utils/auditLog');

const parentTypeFor = { DISTRICT: 'PROVINCE', SECTOR: 'DISTRICT', CELL: 'SECTOR', VILLAGE: 'CELL' };
async function validateTerritoryParent(type, parentId) {
  const parentType = parentTypeFor[type];
  if (!parentType) return type === 'PROVINCE' && !parentId ? null : 'A province cannot have a parent territory.';
  if (!parentId) return `Select a ${parentType.toLowerCase()} for this territory.`;
  const parent = await prisma.territory.findUnique({ where: { id: parentId }, select: { type: true } });
  return parent?.type === parentType ? null : `The parent territory must be a ${parentType.toLowerCase()}.`;
}

router.get('/', authenticateToken, async (req, res) => {
  const { type, parentId } = req.query;
  const where = {};
  if (type) where.type = type;
  if (parentId) where.parentId = parentId;
  
  const territories = await prisma.territory.findMany({ where, include: { children: true } });
  res.json(territories);
});

router.post('/', authenticateToken, requireRole('ADMIN', 'MANAGER'), async (req, res) => {
  try {
    const parentError = await validateTerritoryParent(req.body.type, req.body.parentId || null);
    if (parentError) return res.status(400).json({ error: parentError });
    const territory = await prisma.territory.create({ data: req.body });
    await logAction(req.user.id, 'CREATE_TERRITORY', 'Territory', territory.id, req.body, req);
    res.status(201).json(territory);
  } catch (error) {
    res.status(400).json({ error: 'Failed to create territory' });
  }
});

router.get('/:id', authenticateToken, async (req, res) => {
  const territory = await prisma.territory.findUnique({
    where: { id: req.params.id },
    include: { children: true, parent: true }
  });
  if (!territory) return res.status(404).json({ error: 'Not found' });
  res.json(territory);
});

router.put('/:id', authenticateToken, requireRole('ADMIN', 'MANAGER'), async (req, res) => {
  try {
    const parentError = await validateTerritoryParent(req.body.type, req.body.parentId || null);
    if (parentError) return res.status(400).json({ error: parentError });
    const territory = await prisma.territory.update({
      where: { id: req.params.id },
      data: req.body
    });
    await logAction(req.user.id, 'UPDATE_TERRITORY', 'Territory', territory.id, req.body, req);
    res.json(territory);
  } catch (error) {
    res.status(400).json({ error: 'Update failed' });
  }
});

router.post('/assignments', authenticateToken, requireRole('ADMIN', 'MANAGER'), async (req, res) => {
  try {
    const { tcId, territoryId } = req.body;
    const [tc, district] = await Promise.all([
      prisma.user.findUnique({ where: { id: tcId }, select: { role: true, isActive: true } }),
      prisma.territory.findUnique({ where: { id: territoryId }, select: { type: true, isActive: true } }),
    ]);
    if (!tc || tc.role !== 'TC' || !tc.isActive) return res.status(400).json({ error: 'Choose an active TC account.' });
    if (!district || district.type !== 'DISTRICT' || !district.isActive) return res.status(400).json({ error: 'TC assignments must be active districts.' });
    const assignment = await prisma.tcTerritoryAssignment.create({
      data: { tcId, territoryId, assignedById: req.user.id }
    });
    await logAction(req.user.id, 'ASSIGN_TERRITORY', 'TcTerritoryAssignment', assignment.id, req.body, req);
    res.status(201).json(assignment);
  } catch (error) {
    res.status(400).json({ error: 'Assignment failed' });
  }
});

router.get('/assignments/all', authenticateToken, async (req, res) => {
  const { tcId } = req.query;
  const where = { isActive: true };
  if (tcId) where.tcId = tcId;
  const assignments = await prisma.tcTerritoryAssignment.findMany({
    where,
    include: { territory: true, tc: { select: { id: true, username: true } } }
  });
  res.json(assignments);
});

module.exports = router;
