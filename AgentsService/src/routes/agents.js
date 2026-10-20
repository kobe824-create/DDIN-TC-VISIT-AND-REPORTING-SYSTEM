const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken, requireRole, requireTerritoryAccess } = require('../middleware/auth');
const { logAction } = require('../utils/auditLog');
const { decryptPii, encryptPii } = require('../../../shared/pii');
const { cleanTerritoryName, findChildTerritory, findOrCreateChildTerritory } = require('../../../shared/territory-capture');

const queryIds = (value) => (Array.isArray(value) ? value : value ? [value] : []).map(String).filter(Boolean);

async function validateAgentHierarchy({ territoryId, sectorId, cellId, villageId }, requireCellVillage = true, client = prisma) {
  const db = client || prisma;
  const ids = [territoryId, sectorId, cellId, villageId].filter(Boolean);
  const territories = await db.territory.findMany({
    where: { id: { in: ids } },
    select: { id: true, type: true, parentId: true, isActive: true },
  });
  const byId = new Map(territories.map((territory) => [territory.id, territory]));
  const district = byId.get(territoryId);
  const sector = byId.get(sectorId);
  const cell = byId.get(cellId);
  const village = byId.get(villageId);
  if (!district || district.type !== 'DISTRICT' || !district.isActive) return 'Choose an active district.';
  if (!sector || sector.type !== 'SECTOR' || !sector.isActive || sector.parentId !== district.id) return 'Choose an active sector inside the selected district.';
  if (!requireCellVillage && !cellId && !villageId) return null;
  if (!cell || cell.type !== 'CELL' || !cell.isActive || cell.parentId !== sector.id) return 'Choose an active cell inside the selected sector.';
  if (!village || village.type !== 'VILLAGE' || !village.isActive || village.parentId !== cell.id) return 'Choose an active village inside the selected cell.';
  return null;
}

async function areaAddress({ villageId }, client = prisma) {
  const db = client || prisma;
  const village = await db.territory.findUnique({
    where: { id: villageId },
    select: {
      name: true,
      parent: {
        select: {
          name: true,
          parent: {
            select: {
              name: true,
              parent: {
                select: {
                  name: true,
                  parent: { select: { name: true } },
                },
              },
            },
          },
        },
      },
    },
  });
  const cell = village?.parent;
  const sector = cell?.parent;
  const district = sector?.parent;
  const province = district?.parent;
  return [province?.name, district?.name, sector?.name, cell?.name, village?.name].filter(Boolean).join(', ');
}

router.get('/', authenticateToken, requireTerritoryAccess, async (req, res) => {
  const requestedPage = Number.parseInt(req.query.page, 10);
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const safePage = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 100) : 25;
  const where = {};

  if (req.query.status) where.status = req.query.status;
  const requestedTerritoryId = String(req.query.territoryId || '').trim();
  const assignedTerritories = req.user.role === 'TC' ? (req.user.assignedTerritories || []) : [];
  const pendingTransferScope = req.user.role === 'TC'
    ? { transfers: { some: { recipientTcId: req.user.id, status: 'PENDING' } } }
    : null;
  if (requestedTerritoryId && req.user.role === 'TC' && !assignedTerritories.includes(requestedTerritoryId)) {
    return res.status(403).json({ error: 'Choose a district assigned to your account.' });
  }
  if (requestedTerritoryId && req.user.role !== 'TC') where.territoryId = requestedTerritoryId;
  const search = String(req.query.search || '').trim();
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { agentId: { contains: search, mode: 'insensitive' } },
      { businessName: { contains: search, mode: 'insensitive' } },
      { phoneNumber: { contains: search, mode: 'insensitive' } }
    ];
  }

  // Coordinators see their districts and transfer requests routed to them.
  if (req.user.role === 'TC') {
    const territoryScope = requestedTerritoryId
      ? [{ territoryId: requestedTerritoryId }, { transfers: { some: { recipientTcId: req.user.id, status: 'PENDING', toTerritoryId: requestedTerritoryId } } }]
      : [{ territoryId: { in: assignedTerritories } }, pendingTransferScope];
    where.AND = [...(where.AND || []), { OR: territoryScope }];
    where.NOT = { transfers: { some: { status: 'PENDING', requestedByTcId: req.user.id } } };
  }
  const sectorIds = queryIds(req.query.sectorIds);
  const cellIds = queryIds(req.query.cellIds);
  const villageIds = queryIds(req.query.villageIds);
  const areaMatches = [];
  if (sectorIds.length) areaMatches.push({ sectorId: { in: sectorIds } });
  if (cellIds.length) areaMatches.push({ cellId: { in: cellIds } });
  if (villageIds.length) areaMatches.push({ villageId: { in: villageIds } });
  if (areaMatches.length) {
    if (req.user.role === 'TC') areaMatches.push({ transfers: { some: { recipientTcId: req.user.id, status: 'PENDING', ...(requestedTerritoryId ? { toTerritoryId: requestedTerritoryId } : {}) } } });
    where.AND = [...(where.AND || []), { OR: areaMatches }];
  }
  if (req.user.role === 'CHAMPION') where.championId = req.user.id;

  const total = await prisma.agent.count({ where });
  const pages = Math.ceil(total / limit);
  const page = Math.min(safePage, Math.max(pages, 1));
  const skip = (page - 1) * limit;
  const [agents, activeCount, verifiedCount] = await Promise.all([
    prisma.agent.findMany({
      where,
      skip,
      take: limit,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      include: {
        territory: true, sector: true, cell: true, village: true, champion: true,
        transfers: {
          where: { status: 'PENDING', ...(req.user.role === 'TC' ? { recipientTcId: req.user.id } : {}) },
          include: { toTerritory: true, requestedByTc: { select: { id: true, firstName: true, lastName: true } } },
        },
      }
    }),
    prisma.agent.count({ where: { AND: [where, { status: 'ACTIVE' }] } }),
    prisma.agent.count({ where: { AND: [where, { locationVerified: true }] } }),
  ]);

  res.json({
    data: agents,
    total,
    page,
    limit,
    pages,
    summary: { active: activeCount, locationVerified: verifiedCount },
  });
});

router.get('/offline-pack', authenticateToken, requireTerritoryAccess, requireRole('TC'), async (req, res) => {
  try {
    const territoryIds = req.user.assignedTerritories || [];
    const [agents, geofence, checklist, territories] = await Promise.all([
      prisma.agent.findMany({
        where: {
          status: 'ACTIVE',
          OR: [
            { territoryId: { in: territoryIds } },
            { transfers: { some: { recipientTcId: req.user.id, status: 'PENDING', toTerritoryId: { in: territoryIds } } } },
          ],
        },
        orderBy: [{ name: 'asc' }, { agentId: 'asc' }],
        select: {
          id: true,
          agentId: true,
          name: true,
          phoneNumber: true,
          businessName: true,
          address: true,
          territoryId: true,
          sectorId: true,
          cellId: true,
          villageId: true,
          firstVisitLocationCapturedAt: true,
          firstVisitCompletedAt: true,
          registeredLatitude: true,
          registeredLongitude: true,
          gpsAccuracy: true,
          locationVerified: true,
          territory: { select: { id: true, name: true } },
          sector: { select: { id: true, name: true } },
          cell: { select: { id: true, name: true } },
          village: { select: { id: true, name: true } },
          transfers: { where: { recipientTcId: req.user.id, status: 'PENDING' }, select: { id: true, fromTerritoryId: true, toTerritoryId: true, status: true, requestedAt: true } },
        },
      }),
      prisma.systemConfig.findUnique({ where: { key: 'GEOFENCE_RADIUS_METERS' }, select: { value: true } }),
      prisma.systemConfig.findUnique({ where: { key: 'VISIT_CHECKLIST_SCHEMA' }, select: { value: true } }),
      prisma.territory.findMany({
        where: { id: { in: territoryIds }, isActive: true },
        orderBy: { name: 'asc' },
        include: { children: { where: { isActive: true }, orderBy: { name: 'asc' }, include: { children: { where: { isActive: true }, orderBy: { name: 'asc' }, include: { children: { where: { isActive: true }, orderBy: { name: 'asc' } } } } } } },
      }),
    ]);
    let checklistSchema = [];
    if (checklist?.value) {
      const parsed = JSON.parse(checklist.value);
      checklistSchema = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.questions) ? parsed.questions : [];
    }
    res.json({
      userId: req.user.id,
      downloadedAt: new Date().toISOString(),
      agents,
      territories,
      radiusMeters: geofence ? Number.parseInt(geofence.value, 10) || 100 : 100,
      checklistSchema,
    });
  } catch (error) {
    console.error('Offline agent pack failed:', error.code || error.name);
    res.status(500).json({ error: 'Could not prepare offline field data.' });
  }
});

router.post('/', authenticateToken, requireTerritoryAccess, requireRole('ADMIN', 'MANAGER', 'TC'), async (req, res) => {
  try {
    const sector = req.body.sectorId ? await prisma.territory.findUnique({ where: { id: req.body.sectorId }, select: { type: true, parentId: true } }) : null;
    if (!sector || sector.type !== 'SECTOR' || sector.parentId !== req.body.territoryId) return res.status(400).json({ error: 'Select a sector that belongs to the selected district.' });
    if (req.body.cellId || req.body.villageId) {
      const hierarchyError = await validateAgentHierarchy({ territoryId: req.body.territoryId, sectorId: req.body.sectorId, cellId: req.body.cellId, villageId: req.body.villageId });
      if (hierarchyError) return res.status(400).json({ error: hierarchyError });
    }
    if (req.user.role === 'TC' && !(req.user.assignedTerritories || []).includes(req.body.territoryId)) {
      return res.status(403).json({ error: 'You can only register agents in your assigned districts.' });
    }
    const hasLatitude = req.body.registeredLatitude != null && req.body.registeredLatitude !== '';
    const hasLongitude = req.body.registeredLongitude != null && req.body.registeredLongitude !== '';
    if (hasLatitude !== hasLongitude) return res.status(400).json({ error: 'Capture both GPS coordinates together.' });
    if (hasLatitude && (!Number.isFinite(Number(req.body.registeredLatitude)) || Number(req.body.registeredLatitude) < -90 || Number(req.body.registeredLatitude) > 90 || !Number.isFinite(Number(req.body.registeredLongitude)) || Number(req.body.registeredLongitude) < -180 || Number(req.body.registeredLongitude) > 180 || !Number.isFinite(Number(req.body.gpsAccuracy)) || Number(req.body.gpsAccuracy) > 20)) {
      return res.status(400).json({ error: 'Agent GPS must be captured with accuracy of 20 metres or better.' });
    }
    const { nationalId, nextOfKinName, nextOfKinPhone, nationalIdEncrypted, nextOfKinNameEncrypted, nextOfKinPhoneEncrypted, ...agentFields } = req.body;
    const agent = await prisma.agent.create({
      data: {
        ...agentFields,
        nationalIdEncrypted: encryptPii(nationalId),
        nextOfKinNameEncrypted: encryptPii(nextOfKinName),
        nextOfKinPhoneEncrypted: encryptPii(nextOfKinPhone),
        registeredLatitude: hasLatitude ? Number(req.body.registeredLatitude) : null,
        registeredLongitude: hasLongitude ? Number(req.body.registeredLongitude) : null,
        gpsAccuracy: hasLatitude ? Number(req.body.gpsAccuracy) : null,
        locationVerified: hasLatitude,
        createdById: req.user.id,
      }
    });
    
    // Only create a location history row when coordinates were supplied.
    if (Number.isFinite(agent.registeredLatitude) && Number.isFinite(agent.registeredLongitude)) await prisma.agentLocation.create({
      data: {
        agentId: agent.id,
        latitude: agent.registeredLatitude,
        longitude: agent.registeredLongitude,
        accuracy: agent.gpsAccuracy,
        recordedById: req.user.id,
        reason: 'INITIAL_REGISTRATION'
      }
    });
    
    await logAction(req.user.id, 'CREATE_AGENT', 'Agent', agent.id, null, req);
    res.status(201).json(agent);
  } catch (error) {
    res.status(400).json({ error: 'Failed to create agent' });
  }
});

router.get('/:id/transfer-targets', authenticateToken, requireTerritoryAccess, requireRole('TC'), async (req, res) => {
  const agent = await prisma.agent.findUnique({ where: { id: req.params.id }, select: { id: true, territoryId: true, firstVisitLocationCapturedAt: true, firstVisitCompletedAt: true } });
  if (!agent) return res.status(404).json({ error: 'Agent not found.' });
  if (!(req.user.assignedTerritories || []).includes(agent.territoryId)) return res.status(403).json({ error: 'This agent is outside your assigned district.' });
  if (agent.firstVisitCompletedAt || agent.firstVisitLocationCapturedAt) return res.status(409).json({ error: 'Transfers by a coordinator are allowed only before the first-visit location is captured.' });
  const assignments = await prisma.tcTerritoryAssignment.findMany({
    where: { isActive: true, territoryId: { notIn: req.user.assignedTerritories || [] }, territory: { is: { type: 'DISTRICT', isActive: true } }, tc: { is: { role: 'TC', isActive: true } } },
    include: { territory: { select: { id: true, name: true, parent: { select: { name: true } } } }, tc: { select: { id: true, firstName: true, lastName: true } } },
  });
  const targets = new Map();
  for (const assignment of assignments) {
    if (assignment.territoryId === agent.territoryId) continue;
    const target = targets.get(assignment.territoryId) || { id: assignment.territoryId, name: assignment.territory.name, province: assignment.territory.parent?.name || '', coordinators: [] };
    if (!target.coordinators.some((coordinator) => coordinator.id === assignment.tc.id)) target.coordinators.push(assignment.tc);
    targets.set(assignment.territoryId, target);
  }
  res.json([...targets.values()].sort((a, b) => a.name.localeCompare(b.name)));
});

router.post('/:id/transfer', authenticateToken, requireTerritoryAccess, requireRole('TC'), async (req, res) => {
  try {
    const agent = await prisma.agent.findUnique({ where: { id: req.params.id }, select: { id: true, territoryId: true, firstVisitCompletedAt: true, firstVisitLocationCapturedAt: true, name: true, agentId: true } });
    if (!agent) return res.status(404).json({ error: 'Agent not found.' });
    if (!(req.user.assignedTerritories || []).includes(agent.territoryId)) return res.status(403).json({ error: 'This agent is outside your assigned district.' });
    if (agent.firstVisitCompletedAt || agent.firstVisitLocationCapturedAt) return res.status(409).json({ error: 'Transfers by a coordinator are allowed only before the first-visit location is captured.' });
    const toTerritoryId = String(req.body.toTerritoryId || '');
    const recipientTcId = String(req.body.recipientTcId || '');
    const destination = toTerritoryId ? await prisma.territory.findUnique({ where: { id: toTerritoryId }, select: { id: true, type: true, isActive: true } }) : null;
    if (!destination || destination.type !== 'DISTRICT' || !destination.isActive || toTerritoryId === agent.territoryId || (req.user.assignedTerritories || []).includes(toTerritoryId)) {
      return res.status(400).json({ error: 'Choose a different active district outside your assigned territories.' });
    }
    const receiverAssignment = await prisma.tcTerritoryAssignment.findFirst({ where: { tcId: recipientTcId, territoryId: toTerritoryId, isActive: true, tc: { is: { role: 'TC', isActive: true } } } });
    if (!receiverAssignment) return res.status(400).json({ error: 'Choose an active coordinator assigned to the destination district.' });
    const existingTransfer = await prisma.agentTransfer.findFirst({ where: { agentId: agent.id, status: 'PENDING' } });
    if (existingTransfer) return res.status(409).json({ error: 'This agent already has a pending territory transfer.' });
    const transfer = await prisma.agentTransfer.create({ data: {
      agentId: agent.id,
      fromTerritoryId: agent.territoryId,
      toTerritoryId,
      requestedByTcId: req.user.id,
      recipientTcId,
      reason: String(req.body.reason || '').trim().slice(0, 500) || null,
    }, include: { toTerritory: true, recipientTc: { select: { id: true, firstName: true, lastName: true } } } });
    await logAction(req.user.id, 'REQUEST_AGENT_TRANSFER', 'Agent', agent.id, {
      agentName: agent.name, agentCode: agent.agentId, transferId: transfer.id, fromTerritoryId: agent.territoryId,
      toTerritoryId, toTerritoryName: transfer.toTerritory.name, recipientTcId, recipientTcName: `${transfer.recipientTc.firstName} ${transfer.recipientTc.lastName}`.trim(),
    }, req);
    res.status(201).json(transfer);
  } catch (error) {
    console.error('Agent transfer request failed:', error.code || error.name);
    if (error.code === 'P2002') return res.status(409).json({ error: 'This agent already has a pending territory transfer.' });
    res.status(500).json({ error: 'Could not send this agent transfer request.' });
  }
});

// A coordinator may set location and village details only before the first visit is completed.
router.post('/:id/location/capture', authenticateToken, requireTerritoryAccess, requireRole('TC'), async (req, res) => {
  try {
    const agent = await prisma.agent.findUnique({ where: { id: req.params.id }, include: { sector: true, cell: true, village: true } });
    if (!agent) return res.status(404).json({ error: 'Agent not found.' });
    if (agent.firstVisitCompletedAt) return res.status(409).json({ error: 'The agent’s first visit is complete. Only an administrator can change the territory or location now.' });
    const territoryId = String(req.body.territoryId || agent.territoryId);
    const sectorId = String(req.body.sectorId || '');
    let cellId = String(req.body.cellId || '');
    let villageId = String(req.body.villageId || '');
    const cellName = cleanTerritoryName(req.body.cellName);
    const villageName = cleanTerritoryName(req.body.villageName);
    if ((!cellId && !cellName) || (!villageId && !villageName)) return res.status(400).json({ error: 'Choose or enter both a cell and village.' });
    if (cellName.length > 100 || villageName.length > 100) return res.status(400).json({ error: 'Cell and village names must be 100 characters or fewer.' });
    const sectorError = await validateAgentHierarchy({ territoryId, sectorId, cellId: '', villageId: '' }, false);
    if (sectorError) return res.status(400).json({ error: sectorError });

    let cell = cellId ? await prisma.territory.findUnique({ where: { id: cellId }, select: { id: true, type: true, parentId: true, isActive: true } }) : await findChildTerritory(prisma, { name: cellName, type: 'CELL', parentId: sectorId });
    if (cellId && (!cell || cell.type !== 'CELL' || !cell.isActive || cell.parentId !== sectorId)) return res.status(400).json({ error: 'Choose a cell inside the selected sector.' });
    if (!cellId && cell?.isActive) cellId = cell.id;
    if (villageId && !cellId) return res.status(400).json({ error: 'Choose a cell before selecting a saved village.' });
    let village = villageId ? await prisma.territory.findUnique({ where: { id: villageId }, select: { id: true, type: true, parentId: true, isActive: true } }) : cellId ? await findChildTerritory(prisma, { name: villageName, type: 'VILLAGE', parentId: cellId }) : null;
    if (villageId && (!village || village.type !== 'VILLAGE' || !village.isActive || village.parentId !== cellId)) return res.status(400).json({ error: 'Choose a village inside the selected cell.' });
    if (!villageId && village?.isActive) villageId = village.id;
    if (cellId && villageId) {
      const hierarchyError = await validateAgentHierarchy({ territoryId, sectorId, cellId, villageId });
      if (hierarchyError) return res.status(400).json({ error: hierarchyError });
    }
    const isAssignedHere = (req.user.assignedTerritories || []).includes(territoryId);
    const pendingTransfer = await prisma.agentTransfer.findFirst({ where: { agentId: agent.id, recipientTcId: req.user.id, toTerritoryId: territoryId, status: 'PENDING' } });
    const outgoingTransfer = await prisma.agentTransfer.findFirst({ where: { agentId: agent.id, requestedByTcId: req.user.id, status: 'PENDING' } });
    if (outgoingTransfer && !pendingTransfer) return res.status(409).json({ error: 'This agent is awaiting the destination coordinator. You cannot record their first-visit location.' });
    if (!isAssignedHere && !pendingTransfer) return res.status(403).json({ error: 'This district is outside your assigned territories.' });
    const sameCapture = agent.territoryId === territoryId && agent.sectorId === sectorId && agent.cellId === cellId && agent.villageId === villageId
      && agent.registeredLatitude != null && agent.registeredLongitude != null && agent.locationVerified;
    const { latitude, longitude, accuracy } = req.body;
    const lat = latitude; const lon = longitude; const gpsAccuracy = accuracy;
    if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90 || typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180 || typeof gpsAccuracy !== 'number' || !Number.isFinite(gpsAccuracy) || gpsAccuracy < 0 || gpsAccuracy > 20) {
      return res.status(400).json({ error: 'A precise GPS reading with accuracy of 20 metres or better is required. Move to an open area and try again.' });
    }
    if (agent.firstVisitLocationCapturedAt) {
      if (sameCapture && Math.abs(agent.registeredLatitude - lat) < 1e-7 && Math.abs(agent.registeredLongitude - lon) < 1e-7) return res.json(agent);
      return res.status(409).json({ error: 'The first-visit territory and GPS capture has already been recorded. Ask an administrator to correct it.' });
    }
    const updated = await prisma.$transaction(async (tx) => {
      const resolvedCell = cellId ? { id: cellId } : await findOrCreateChildTerritory(tx, { name: cellName, type: 'CELL', parentId: sectorId });
      const resolvedVillage = villageId ? { id: villageId } : await findOrCreateChildTerritory(tx, { name: villageName, type: 'VILLAGE', parentId: resolvedCell.id });
      const resolvedCellId = resolvedCell.id;
      const resolvedVillageId = resolvedVillage.id;
      const hierarchyError = await validateAgentHierarchy({ territoryId, sectorId, cellId: resolvedCellId, villageId: resolvedVillageId }, true, tx);
      if (hierarchyError) throw new Error(hierarchyError);
      const currentAddress = await areaAddress({ territoryId, sectorId, cellId: resolvedCellId, villageId: resolvedVillageId }, tx);
      const claimed = await tx.agent.updateMany({
        where: { id: agent.id, firstVisitCompletedAt: null, firstVisitLocationCapturedAt: null },
        data: { territoryId, sectorId, cellId: resolvedCellId, villageId: resolvedVillageId, address: currentAddress, registeredLatitude: lat, registeredLongitude: lon, gpsAccuracy, locationVerified: true, firstVisitLocationCapturedAt: new Date() },
      });
      if (!claimed.count) {
        const conflict = new Error('The agent’s first visit has already been completed. Reload the agent before continuing.');
        conflict.statusCode = 409;
        throw conflict;
      }
      await tx.agentLocation.create({ data: { agentId: agent.id, latitude: lat, longitude: lon, accuracy: gpsAccuracy, recordedById: req.user.id, reason: pendingTransfer ? 'FIRST_VISIT_TRANSFER_LOCATION' : 'FIRST_VISIT_LOCATION_CAPTURE' } });
      return tx.agent.findUnique({ where: { id: agent.id }, include: { territory: true, sector: true, cell: true, village: true } });
    }, { maxWait: 10000, timeout: 15000 });
    await logAction(req.user.id, pendingTransfer ? 'COMPLETE_AGENT_TRANSFER_LOCATION' : 'CAPTURE_FIRST_VISIT_LOCATION', 'Agent', agent.id, {
      latitude: lat, longitude: lon, accuracy: gpsAccuracy, territoryId, sectorId, cellId: updated.cellId, villageId: updated.villageId, transferId: pendingTransfer?.id || null,
      territoryName: updated.territory?.name, sectorName: updated.sector?.name, cellName: updated.cell?.name, villageName: updated.village?.name,
    }, req);
    res.status(201).json(updated);
  } catch (error) {
    console.error('First location capture error:', error);
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    if (error.message?.startsWith('Choose an active')) return res.status(400).json({ error: error.message });
    res.status(500).json({ error: 'Could not save the agent location.' });
  }
});

router.get('/:id', authenticateToken, requireTerritoryAccess, requireRole('ADMIN', 'MANAGER', 'TC', 'CHAMPION'), async (req, res) => {
  const agent = await prisma.agent.findUnique({
    where: { id: req.params.id },
    include: { territory: true, sector: true, cell: true, village: true, champion: true }
  });
  if (!agent) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'TC') {
    const assignments = await prisma.tcTerritoryAssignment.findMany({ where: { tcId: req.user.id, isActive: true }, select: { territoryId: true } });
    const pendingTransfer = await prisma.agentTransfer.findFirst({ where: { agentId: agent.id, recipientTcId: req.user.id, status: 'PENDING' } });
    if (!assignments.some((assignment) => assignment.territoryId === agent.territoryId) && !pendingTransfer) return res.status(403).json({ error: 'Access denied to this agent.' });
  }
  if (req.user.role === 'CHAMPION' && agent.championId !== req.user.id) return res.status(403).json({ error: 'Access denied to this agent.' });
  res.json({
    ...agent,
    ...(req.user.role === 'ADMIN' ? { personalDetails: {
      nationalId: decryptPii(agent.nationalIdEncrypted),
      nextOfKinName: decryptPii(agent.nextOfKinNameEncrypted),
      nextOfKinPhone: decryptPii(agent.nextOfKinPhoneEncrypted),
    } } : {}),
  });
});

router.put('/:id', authenticateToken, requireRole('ADMIN', 'MANAGER'), async (req, res) => {
  try {
    const {
      registeredLatitude, registeredLongitude, gpsAccuracy, locationVerified,
      nationalId, nextOfKinName, nextOfKinPhone,
      nationalIdEncrypted, nextOfKinNameEncrypted, nextOfKinPhoneEncrypted,
      relocationConfirmed,
      ...profileFields
    } = req.body;
    const locationFields = ['territoryId', 'sectorId', 'cellId', 'villageId'];
    const existing = await prisma.agent.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Agent not found.' });
    const locationChanged = locationFields.some((field) => profileFields[field] !== undefined && profileFields[field] !== existing[field]);
    if (locationChanged && req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Only administrators can relocate agents after their first visit.' });
    if (locationChanged) {
      const hierarchyError = await validateAgentHierarchy({
        territoryId: profileFields.territoryId !== undefined ? profileFields.territoryId : existing.territoryId,
        sectorId: profileFields.sectorId !== undefined ? profileFields.sectorId : existing.sectorId,
        cellId: profileFields.cellId !== undefined ? profileFields.cellId : existing.cellId,
        villageId: profileFields.villageId !== undefined ? profileFields.villageId : existing.villageId,
      });
      if (hierarchyError) return res.status(400).json({ error: hierarchyError });
      if (typeof registeredLatitude !== 'number' || !Number.isFinite(registeredLatitude) || registeredLatitude < -90 || registeredLatitude > 90
        || typeof registeredLongitude !== 'number' || !Number.isFinite(registeredLongitude) || registeredLongitude < -180 || registeredLongitude > 180
        || typeof gpsAccuracy !== 'number' || !Number.isFinite(gpsAccuracy) || gpsAccuracy < 0 || gpsAccuracy > 20) {
        return res.status(400).json({ error: 'Capture the agent’s new GPS location with accuracy of 20 metres or better before relocating them.' });
      }
      if (relocationConfirmed !== true) return res.status(400).json({ error: 'Capture the new GPS location during this relocation before saving it.' });
      profileFields.registeredLatitude = registeredLatitude;
      profileFields.registeredLongitude = registeredLongitude;
      profileFields.gpsAccuracy = gpsAccuracy;
      profileFields.locationVerified = true;
      profileFields.address = await areaAddress({
        territoryId: profileFields.territoryId !== undefined ? profileFields.territoryId : existing.territoryId,
        sectorId: profileFields.sectorId !== undefined ? profileFields.sectorId : existing.sectorId,
        cellId: profileFields.cellId !== undefined ? profileFields.cellId : existing.cellId,
        villageId: profileFields.villageId !== undefined ? profileFields.villageId : existing.villageId,
      });
    }
    if (nationalId !== undefined) profileFields.nationalIdEncrypted = encryptPii(nationalId);
    if (nextOfKinName !== undefined) profileFields.nextOfKinNameEncrypted = encryptPii(nextOfKinName);
    if (nextOfKinPhone !== undefined) profileFields.nextOfKinPhoneEncrypted = encryptPii(nextOfKinPhone);
    const agent = await prisma.$transaction(async (tx) => {
      const updated = await tx.agent.update({ where: { id: req.params.id }, data: profileFields });
      if (locationChanged) await tx.agentLocation.create({ data: {
        agentId: updated.id, latitude: registeredLatitude, longitude: registeredLongitude, accuracy: gpsAccuracy,
        recordedById: req.user.id, reason: String(req.body.reason || '').trim().slice(0, 500) || 'Administrator relocation',
      } });
      return updated;
    });
    const updatedPersonalData = ['nationalId', 'nextOfKinName', 'nextOfKinPhone'].some((field) => req.body[field] !== undefined);
    await logAction(req.user.id, 'UPDATE_AGENT', 'Agent', agent.id, {
      updatedFields: Object.keys(req.body).filter((field) => !['nationalId', 'nextOfKinName', 'nextOfKinPhone', 'nationalIdEncrypted', 'nextOfKinNameEncrypted', 'nextOfKinPhoneEncrypted'].includes(field)),
      updatedPersonalData,
    }, req);
    if (locationChanged) await logAction(req.user.id, 'ADMIN_RELOCATE_AGENT', 'Agent', agent.id, {
      agentName: agent.name, agentCode: agent.agentId,
      fromTerritoryId: existing.territoryId, toTerritoryId: agent.territoryId,
      fromSectorId: existing.sectorId, toSectorId: agent.sectorId,
      fromCellId: existing.cellId, toCellId: agent.cellId,
      fromVillageId: existing.villageId, toVillageId: agent.villageId,
    }, req);
    res.json(agent);
  } catch (error) {
    res.status(400).json({ error: 'Update failed' });
  }
});

router.patch('/:id/location', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  try {
    const { latitude, longitude, accuracy } = req.body;
    const existing = await prisma.agent.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Agent not found.' });
    if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 20) {
      return res.status(400).json({ error: 'A GPS reading with accuracy of 20 metres or better is required.' });
    }
    
    const nextTerritoryId = req.body.territoryId !== undefined ? req.body.territoryId : existing.territoryId;
    const nextSectorId = req.body.sectorId !== undefined ? req.body.sectorId : existing.sectorId;
    const nextCellId = req.body.cellId !== undefined ? req.body.cellId : existing.cellId;
    const nextVillageId = req.body.villageId !== undefined ? req.body.villageId : existing.villageId;
    const moved = existing.territoryId !== nextTerritoryId || existing.sectorId !== nextSectorId || existing.cellId !== nextCellId || existing.villageId !== nextVillageId;
    const hierarchyError = await validateAgentHierarchy({ territoryId: nextTerritoryId, sectorId: nextSectorId, cellId: nextCellId, villageId: nextVillageId }, moved);
    if (hierarchyError) return res.status(400).json({ error: hierarchyError });
    const reason = String(req.body.reason || '').trim().slice(0, 500) || (moved ? 'Administrator relocation' : 'Administrator GPS correction');
    const currentAddress = moved ? await areaAddress({ territoryId: nextTerritoryId, sectorId: nextSectorId, cellId: nextCellId, villageId: nextVillageId }) : undefined;
    const agent = await prisma.$transaction(async (tx) => {
      const updated = await tx.agent.update({ where: { id: req.params.id }, data: {
        territoryId: nextTerritoryId, sectorId: nextSectorId, cellId: nextCellId, villageId: nextVillageId,
        ...(currentAddress !== undefined ? { address: currentAddress } : {}),
        registeredLatitude: latitude, registeredLongitude: longitude, gpsAccuracy: accuracy, locationVerified: true,
      } });
      await tx.agentLocation.create({ data: { agentId: updated.id, latitude, longitude, accuracy, recordedById: req.user.id, reason } });
      return updated;
    });
    await logAction(req.user.id, moved ? 'ADMIN_RELOCATE_AGENT' : 'ADMIN_UPDATE_AGENT_LOCATION', 'Agent', agent.id, {
      agentName: agent.name, agentCode: agent.agentId, reason,
      fromTerritoryId: existing.territoryId, toTerritoryId: nextTerritoryId,
      fromSectorId: existing.sectorId, toSectorId: nextSectorId,
      fromCellId: existing.cellId, toCellId: nextCellId,
      fromVillageId: existing.villageId, toVillageId: nextVillageId,
    }, req);
    res.json(agent);
  } catch (error) {
    res.status(400).json({ error: 'Location update failed' });
  }
});

router.get('/:id/location-history', authenticateToken, requireTerritoryAccess, requireRole('ADMIN', 'MANAGER', 'TC', 'CHAMPION'), async (req, res) => {
  const agent = await prisma.agent.findUnique({ where: { id: req.params.id }, select: { id: true, territoryId: true, championId: true } });
  if (!agent) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'CHAMPION' && agent.championId !== req.user.id) return res.status(403).json({ error: 'Access denied to this agent.' });
  if (req.user.role === 'TC' && !(req.user.assignedTerritories || []).includes(agent.territoryId)) return res.status(403).json({ error: 'Access denied to this agent.' });
  const requestedPage = Number.parseInt(req.query.page, 10);
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const safePage = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 100) : 25;
  const where = { agentId: req.params.id };
  const total = await prisma.agentLocation.count({ where });
  const pages = Math.ceil(total / limit);
  const page = Math.min(safePage, Math.max(pages, 1));
  const history = await prisma.agentLocation.findMany({
    where,
    skip: (page - 1) * limit,
    take: limit,
    orderBy: { recordedAt: 'desc' },
    include: { recordedBy: { select: { id: true, username: true } } }
  });
  res.json({ data: history, meta: { total, page, limit, pages } });
});

module.exports = router;
