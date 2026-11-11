const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { performance } = require('node:perf_hooks');
const { authenticateToken, requireRole, requireTerritoryAccess } = require('../middleware/auth');
const prisma = require('../utils/prisma');
const { logAction } = require('../utils/auditLog');
const { advisoryTransactionLock } = require('../../../shared/advisory-locks');
const { calculateDistance } = require('../utils/gps');
const { ACCEPTED_LOCATION_STATUSES, COMPLETED_VISIT_STATUSES } = require('../../../shared/visit-coverage');

const router = express.Router();
const storage = multer.diskStorage({
  destination: path.join(__dirname, '../../uploads'),
  filename: (_req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: (_req, file, cb) => {
  if (!file.mimetype.startsWith('image/')) return cb(new Error('Please capture an image file.'));
  cb(null, true);
} });
const parsePhotoUpload = (req, res, next) => {
  const startedAt = performance.now();
  upload.single('photo')(req, res, (error) => {
    req.photoUploadMs = Math.round(performance.now() - startedAt);
    if (!error) return next();
    const tooLarge = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE';
    const invalidImage = error.message === 'Please capture an image file.';
    const status = tooLarge ? 413 : (error instanceof multer.MulterError || invalidImage ? 400 : 500);
    console.warn(JSON.stringify({ event: 'photo_upload_rejected', requestId: req.requestId, code: error.code || error.name, status }));
    return res.status(status).json({ error: tooLarge ? 'The visit photo must be 10 MB or smaller.' : invalidImage ? error.message : status === 400 ? 'The photo upload is invalid.' : 'Could not receive the visit photo.' });
  });
};
const verifyPhotoVisit = async (req, res, next) => {
  const startedAt = performance.now();
  try {
    const visit = await prisma.visit.findUnique({ where: { id: req.params.id } });
    req.photoLookupMs = Math.round(performance.now() - startedAt);
    if (!visit) return res.status(404).json({ error: 'Visit not found.' });
    if (req.user.role === 'TC' && visit.tcId !== req.user.id) return res.status(403).json({ error: 'You cannot edit this visit.' });
    req.visit = visit;
    next();
  } catch (error) {
    req.photoLookupMs = Math.round(performance.now() - startedAt);
    console.error(JSON.stringify({ event: 'photo_visit_lookup_failed', requestId: req.requestId, code: error.code || error.name }));
    res.status(503).json({ error: 'The visit service is busy. Please retry the photo upload.' });
  }
};

const makeVisitId = () => `VIS-${new Date().getFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`;
function shiftKigaliMonths(value, monthOffset) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Kigali',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  const monthIndex = Number(values.year) * 12 + Number(values.month) - 1 + monthOffset;
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex % 12 + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(Number(values.day), lastDay);
  const milliseconds = String(value.getMilliseconds()).padStart(3, '0');
  const dateKey = String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  return new Date(dateKey + 'T' + values.hour + ':' + values.minute + ':' + values.second + '.' + milliseconds + '+02:00');
}

async function visitCountsForMetrics(tx, agentId, visitDate, network = 'IREMBO', externalAgentId = null) {
  const windowStart = shiftKigaliMonths(visitDate, -3);
  const windowEnd = shiftKigaliMonths(visitDate, 3);
  const eligibleVisitWhere = {
    network,
    ...(network === 'IREMBO' ? { agentId } : { externalAgentId }),
    countsForMetrics: true,
    visitStatus: { in: COMPLETED_VISIT_STATUSES },
    locationStatus: { in: ACCEPTED_LOCATION_STATUSES },
  };
  const [earlierEligibleVisits, laterEligibleVisit] = await Promise.all([
    tx.visit.findMany({
      where: { ...eligibleVisitWhere, visitDate: { gte: windowStart, lte: visitDate } },
      select: { visitDate: true },
    }),
    tx.visit.findFirst({
      where: { ...eligibleVisitWhere, visitDate: { gt: visitDate, lt: windowEnd } },
      select: { id: true },
    }),
  ]);
  const overlapsEarlierWindow = earlierEligibleVisits.some(({ visitDate: previousDate }) => visitDate < shiftKigaliMonths(previousDate, 3));
  return !overlapsEarlierWindow && !laterEligibleVisit;
}

function conflict(message) { const error = new Error(message); error.statusCode = 409; return error; }
const visitWhereForUser = (user, query = {}) => {
  const where = {};
  if (query.agentId) where.agentId = query.agentId;
  if (query.externalAgentId) where.externalAgentId = String(query.externalAgentId);
  if (query.network && ['IREMBO', 'MOOLA_PLUS'].includes(String(query.network).toUpperCase())) where.network = String(query.network).toUpperCase();
  if (query.tcId && ['ADMIN', 'MANAGER'].includes(user.role)) where.tcId = query.tcId;
  if (query.status) where.visitStatus = query.status.toUpperCase();
  if (query.fromDate || query.toDate) {
    where.visitDate = {};
    if (query.fromDate) where.visitDate.gte = new Date(query.fromDate);
    if (query.toDate) where.visitDate.lte = new Date(query.toDate);
  }
  if (user.role === 'TC') {
    where.territoryId = { in: user.assignedTerritories || [] };
  } else if (query.territoryId && ['ADMIN', 'MANAGER'].includes(user.role)) {
    where.territoryId = query.territoryId;
  }
  if (user.role === 'CHAMPION') where.agent = { championId: user.id };
  const search = String(query.search || '').trim();
  if (search) {
    where.OR = [
      { visitId: { contains: search, mode: 'insensitive' } },
      { agent: { name: { contains: search, mode: 'insensitive' } } },
      { agent: { agentId: { contains: search, mode: 'insensitive' } } },
      { agent: { businessName: { contains: search, mode: 'insensitive' } } },
      { externalAgentName: { contains: search, mode: 'insensitive' } },
      { externalAgentCode: { contains: search, mode: 'insensitive' } },
      { tc: { firstName: { contains: search, mode: 'insensitive' } } },
      { tc: { lastName: { contains: search, mode: 'insensitive' } } },
      { tc: { username: { contains: search, mode: 'insensitive' } } },
    ];
  }
  return where;
};

async function getUpstreamMoolaAgent(req, externalAgentId) {
  const base = String(process.env.REPORTS_SERVICE_URL || 'http://reports-service:3004').replace(/\/$/, '');
  const response = await fetch(`${base}/api/v1/reports/moola-plus/agents/${encodeURIComponent(externalAgentId)}`, {
    headers: { authorization: req.headers.authorization || '', accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('The upstream Moola Plus registry is unavailable.');
  const payload = await response.json();
  return payload?.data || null;
}

function validCoordinates(latitude, longitude, accuracy) {
  return [latitude, longitude, accuracy].every((value) => typeof value === 'number' && Number.isFinite(value))
    && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180 && accuracy >= 0;
}

const normalizeLocationName = (value) => String(value || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');

function moolaLocationShape(location) {
  if (!location) return null;
  return {
    territoryId: location.territoryId, territory: location.territory,
    sectorId: location.sectorId, cellId: location.cellId, villageId: location.villageId,
    sectorName: location.sectorName, cellName: location.cellName, villageName: location.villageName,
    venue: location.venue, latitude: location.latitude, longitude: location.longitude,
    accuracy: location.accuracy, locationVerified: location.locationVerified,
    isOnHold: location.isOnHold,
    firstLocationCapturedAt: location.firstLocationCapturedAt, firstVisitCompletedAt: location.firstVisitCompletedAt,
    pendingRelocation: location.relocationRequests?.find((request) => request.status === 'PENDING') || null,
  };
}

async function validateMoolaFieldLocation({ territoryId, sectorId, cellId, villageId, venue }) {
  const ids = [territoryId, sectorId, cellId, villageId].map((value) => String(value || '').trim());
  if (ids.some((id) => !id) || !String(venue || '').trim()) return { error: 'Choose the district, sector, cell and village, and enter the agent’s venue before check-in.' };
  if (String(venue).trim().length > 200) return { error: 'Venue must be 200 characters or fewer.' };
  const areas = await prisma.territory.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, type: true, parentId: true, isActive: true } });
  const byId = new Map(areas.map((area) => [area.id, area]));
  const district = byId.get(ids[0]);
  const sector = byId.get(ids[1]);
  const cell = byId.get(ids[2]);
  const village = byId.get(ids[3]);
  if (!district || district.type !== 'DISTRICT' || !district.isActive) return { error: 'Choose an active district.' };
  if (!sector || sector.type !== 'SECTOR' || !sector.isActive || sector.parentId !== district.id) return { error: 'Choose an active sector inside the selected district.' };
  if (!cell || cell.type !== 'CELL' || !cell.isActive || cell.parentId !== sector.id) return { error: 'Choose an active cell inside the selected sector.' };
  if (!village || village.type !== 'VILLAGE' || !village.isActive || village.parentId !== cell.id) return { error: 'Choose an active village inside the selected cell.' };
  return { location: { territoryId: district.id, sectorId: sector.id, cellId: cell.id, villageId: village.id, sectorName: sector.name, cellName: cell.name, villageName: village.name, venue: String(venue).trim() } };
}

async function moolaDistrictForAgent(agent, location = null) {
  if (location?.territoryId) return prisma.territory.findUnique({ where: { id: location.territoryId }, select: { id: true, name: true, type: true, isActive: true } });
  const districtName = String(agent?.district || '').trim();
  if (!districtName) return null;
  return prisma.territory.findFirst({ where: { type: 'DISTRICT', isActive: true, name: { equals: districtName, mode: 'insensitive' } }, select: { id: true, name: true, type: true, isActive: true } });
}

async function moolaTransferTargets(excludedTerritoryIds = []) {
  const assignments = await prisma.tcTerritoryAssignment.findMany({
    where: { isActive: true, territoryId: { notIn: excludedTerritoryIds }, territory: { is: { type: 'DISTRICT', isActive: true } }, tc: { is: { role: 'TC', isActive: true } } },
    include: { territory: { select: { id: true, name: true, parent: { select: { name: true } } } }, tc: { select: { id: true, firstName: true, lastName: true } } },
  });
  const targets = new Map();
  for (const assignment of assignments) {
    const target = targets.get(assignment.territoryId) || { id: assignment.territoryId, name: assignment.territory.name, province: assignment.territory.parent?.name || '', coordinators: [] };
    if (!target.coordinators.some((coordinator) => coordinator.id === assignment.tc.id)) target.coordinators.push(assignment.tc);
    targets.set(assignment.territoryId, target);
  }
  return [...targets.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function createMovementNotices(tx, { recipientTcIds, network, externalAgentId, agentName, agentCode, noticeType, fromTerritoryName, toTerritoryName }) {
  const recipientIds = [...new Set(recipientTcIds)].filter(Boolean);
  if (!recipientIds.length) return;
  await tx.agentMovementNotice.createMany({ data: recipientIds.map((recipientTcId) => ({
    recipientTcId, network, externalAgentId, agentName, agentCode: agentCode || null, noticeType,
    fromTerritoryName: fromTerritoryName || null, toTerritoryName: toTerritoryName || null,
  })) });
}

async function createMoolaMovementNotices(tx, { externalAgentId, agentName, agentCode, fromTerritoryId, toTerritoryId, noticeType }) {
  const territoryIds = [...new Set([fromTerritoryId, toTerritoryId].filter(Boolean))];
  const [territories, assignments] = await Promise.all([
    tx.territory.findMany({ where: { id: { in: territoryIds } }, select: { id: true, name: true } }),
    tx.tcTerritoryAssignment.findMany({ where: { territoryId: { in: territoryIds }, isActive: true, tc: { is: { role: 'TC', isActive: true } } }, select: { tcId: true } }),
  ]);
  const nameById = new Map(territories.map((territory) => [territory.id, territory.name]));
  await createMovementNotices(tx, {
    recipientTcIds: assignments.map(({ tcId }) => tcId), network: 'MOOLA_PLUS', externalAgentId,
    agentName, agentCode, noticeType, fromTerritoryName: nameById.get(fromTerritoryId), toTerritoryName: nameById.get(toTerritoryId),
  });
}

router.get('/moola-plus/relocation-districts', authenticateToken, requireTerritoryAccess, requireRole('TC'), async (req, res) => {
  try {
    const districts = await prisma.territory.findMany({
      where: { type: 'DISTRICT', isActive: true, id: { in: req.user.assignedTerritories || [] } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    res.json(districts);
  } catch (error) {
    console.error('Moola relocation district lookup error:', error.code || error.name);
    res.status(500).json({ error: 'Could not load relocation districts.' });
  }
});

router.get('/moola-plus/agents/:externalAgentId/location', authenticateToken, requireTerritoryAccess, requireRole('ADMIN', 'MANAGER', 'TC', 'CHAMPION'), async (req, res) => {
  try {
    const agent = await getUpstreamMoolaAgent(req, String(req.params.externalAgentId));
    if (!agent) return res.status(404).json({ error: 'Moola Plus agent not found in your assigned areas.' });
    const location = await prisma.moolaAgentLocation.findUnique({
      where: { externalAgentId: String(req.params.externalAgentId) },
      include: { territory: { select: { id: true, name: true } }, relocationRequests: { where: { status: 'PENDING' }, orderBy: { requestedAt: 'desc' }, take: 1, include: { toTerritory: { select: { id: true, name: true } } } } },
    });
    if (location && req.user.role === 'TC' && !(req.user.assignedTerritories || []).includes(location.territoryId)) return res.status(403).json({ error: 'This Moola Plus agent is outside your assigned territory.' });
    const visits = await prisma.visit.findMany({ where: { network: 'MOOLA_PLUS', externalAgentId: String(req.params.externalAgentId) }, select: { id: true, visitId: true, visitDate: true, visitStatus: true, locationStatus: true, countsForMetrics: true, tc: { select: { firstName: true, lastName: true, username: true } } }, orderBy: { visitDate: 'desc' }, take: 10 });
    const pendingTransfer = await prisma.moolaAgentTransfer.findFirst({ where: { externalAgentId: String(req.params.externalAgentId), status: { in: ['PENDING', 'ON_HOLD'] } }, orderBy: { requestedAt: 'desc' }, include: { fromTerritory: { select: { id: true, name: true } }, toTerritory: { select: { id: true, name: true } }, requestedByTc: { select: { id: true, firstName: true, lastName: true } }, recipientTc: { select: { id: true, firstName: true, lastName: true } } } });
    res.json({ location: moolaLocationShape(location), recentVisits: visits, pendingTransfer });
  } catch (error) {
    console.error('Moola location lookup error:', error.code || error.name);
    res.status(500).json({ error: 'Could not load the Moola Plus field profile.' });
  }
});

router.post('/moola-plus/agents/:externalAgentId/location/capture', authenticateToken, requireTerritoryAccess, requireRole('TC'), async (req, res) => {
  try {
    const externalAgentId = String(req.params.externalAgentId || '').trim();
    const territoryId = String(req.body.territoryId || '').trim();
    const { latitude, longitude } = req.body;
    const accuracy = req.body.accuracy ?? req.body.gpsAccuracyMeters;
    if (!externalAgentId || externalAgentId.length > 200 || !territoryId || !validCoordinates(latitude, longitude, accuracy)) {
      return res.status(400).json({ error: 'Choose the assigned district and capture a valid GPS location.' });
    }
    if (accuracy > 20) return res.status(422).json({ error: `GPS accuracy is ±${Math.round(accuracy)} m. First-location capture needs 20 m accuracy or better; move to a clearer location and retry.` });
    if (!(req.user.assignedTerritories || []).includes(territoryId)) return res.status(403).json({ error: 'This district is outside your assigned territory.' });
    const [agent, territory, locationResult] = await Promise.all([
      getUpstreamMoolaAgent(req, externalAgentId),
      prisma.territory.findUnique({ where: { id: territoryId }, select: { id: true, name: true, type: true, isActive: true } }),
      validateMoolaFieldLocation({ ...req.body, territoryId }),
    ]);
    if (!agent) return res.status(404).json({ error: 'Moola Plus agent not found in the upstream registry.' });
    if (!territory || territory.type !== 'DISTRICT' || !territory.isActive) return res.status(400).json({ error: 'Choose an active district.' });
    if (locationResult.error) return res.status(400).json({ error: locationResult.error });
    const result = await prisma.$transaction(async (tx) => {
      await advisoryTransactionLock(tx, externalAgentId, 'AGENT_MOVE');
      const [currentLocation, outgoingTransfer, incomingTransfer] = await Promise.all([
        tx.moolaAgentLocation.findUnique({ where: { externalAgentId } }),
        tx.moolaAgentTransfer.findFirst({ where: { externalAgentId, requestedByTcId: req.user.id, status: 'PENDING', acceptedAt: null }, select: { id: true } }),
        tx.moolaAgentTransfer.findFirst({ where: { externalAgentId, recipientTcId: req.user.id, status: 'PENDING', acceptedAt: null }, select: { id: true, acceptedAt: true } }),
      ]);
      if (currentLocation?.isOnHold) throw conflict('This agent is on hold until an administrator assigns a new coordinator.');
      if (outgoingTransfer) throw conflict('This agent is awaiting transfer review.');
      if (incomingTransfer && !incomingTransfer.acceptedAt) throw conflict('Accept the agent transfer before capturing its new location.');
      if (currentLocation && currentLocation.territoryId !== territoryId) throw conflict('This agent has a different saved district. Request relocation or transfer before capturing a new location.');
      if (!currentLocation && normalizeLocationName(agent.district) !== normalizeLocationName(territory.name) && !incomingTransfer?.acceptedAt) {
        throw conflict('Choose the agent’s registered district for its first location capture.');
      }
      const capturedAt = new Date();
      const saved = await tx.moolaAgentLocation.upsert({
        where: { externalAgentId },
        create: {
          externalAgentId, agentName: agent.name, loginName: agent.loginName || externalAgentId,
          ...locationResult.location, latitude, longitude, accuracy, locationVerified: true,
          firstLocationCapturedAt: capturedAt, updatedById: req.user.id,
        },
        update: {
          agentName: agent.name, loginName: agent.loginName || externalAgentId,
          ...locationResult.location, latitude, longitude, accuracy, locationVerified: true,
          firstLocationCapturedAt: currentLocation?.firstLocationCapturedAt || capturedAt,
          isOnHold: false, updatedById: req.user.id,
        },
      });
      return saved;
    }, { maxWait: 10000, timeout: 15000 });
    await logAction(req.user.id, 'CAPTURE_FIRST_VISIT_LOCATION', 'MoolaPlusAgent', externalAgentId, { territoryId, accuracyMeters: accuracy }, req);
    res.status(201).json({
      ...result,
      territoryId: result.territoryId, sectorId: result.sectorId, cellId: result.cellId, villageId: result.villageId,
      registeredLatitude: result.latitude, registeredLongitude: result.longitude, gpsAccuracy: result.accuracy,
      locationVerified: result.locationVerified, firstVisitLocationCapturedAt: result.firstLocationCapturedAt,
      firstVisitCompletedAt: result.firstVisitCompletedAt, venue: result.venue,
      sector: { name: result.sectorName }, cell: { name: result.cellName }, village: { name: result.villageName },
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Moola Plus location capture failed:', error.code || error.name);
    res.status(500).json({ error: 'Could not save the Moola Plus agent location.' });
  }
});

router.get('/moola-plus/agents/:externalAgentId/transfer-targets', authenticateToken, requireTerritoryAccess, requireRole('TC'), async (req, res) => {
  try {
    const [agent, location] = await Promise.all([
      getUpstreamMoolaAgent(req, String(req.params.externalAgentId)),
      prisma.moolaAgentLocation.findUnique({ where: { externalAgentId: String(req.params.externalAgentId) }, select: { territoryId: true, isOnHold: true } }),
    ]);
    if (!agent) return res.status(404).json({ error: 'Moola Plus agent not found.' });
    const district = await moolaDistrictForAgent(agent, location);
    if (!district || !(req.user.assignedTerritories || []).includes(district.id)) return res.status(403).json({ error: 'This agent is outside your assigned district.' });
    if (location?.isOnHold) return res.status(409).json({ error: 'This agent is on hold until an administrator assigns a new coordinator.' });
    res.json(await moolaTransferTargets(req.user.assignedTerritories || []));
  } catch (error) {
    console.error('Moola transfer destination lookup error:', error.code || error.name);
    res.status(500).json({ error: 'Could not load destination coordinators.' });
  }
});

router.post('/moola-plus/agents/:externalAgentId/admin-relocate', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  try {
    const externalAgentId = String(req.params.externalAgentId || '').trim();
    const toTerritoryId = String(req.body.territoryId || '').trim();
    const [agent, location, destination] = await Promise.all([
      getUpstreamMoolaAgent(req, externalAgentId),
      prisma.moolaAgentLocation.findUnique({ where: { externalAgentId } }),
      prisma.territory.findUnique({ where: { id: toTerritoryId }, select: { id: true, name: true, type: true, isActive: true } }),
    ]);
    if (!agent) return res.status(404).json({ error: 'Moola Plus agent not found.' });
    if (!destination || destination.type !== 'DISTRICT' || !destination.isActive) return res.status(400).json({ error: 'Choose an active destination district.' });
    const source = await moolaDistrictForAgent(agent, location);
    if (!source) return res.status(409).json({ error: 'The agent has no recorded district. Capture the first field location before relocating.' });
    if (source.id === destination.id) return res.status(400).json({ error: 'Choose a different district for relocation.' });
    const updated = await prisma.$transaction(async (tx) => {
      await advisoryTransactionLock(tx, externalAgentId, 'AGENT_MOVE');
      const [pendingTransfer, pendingRelocation] = await Promise.all([
        tx.moolaAgentTransfer.findFirst({ where: { externalAgentId, status: { in: ['PENDING', 'ON_HOLD'] } }, select: { id: true } }),
        tx.moolaRelocationRequest.findFirst({ where: { externalAgentId, status: 'PENDING' }, select: { id: true } }),
      ]);
      if (pendingTransfer || pendingRelocation) throw conflict(pendingTransfer ? 'Resolve the pending transfer before relocating this agent.' : 'Resolve the pending relocation request before moving this agent.');
      const moved = await tx.moolaAgentLocation.upsert({
        where: { externalAgentId },
        create: { externalAgentId, agentName: agent.name, loginName: agent.loginName || externalAgentId, territoryId: destination.id, updatedById: req.user.id },
        update: { territoryId: destination.id, sectorId: null, cellId: null, villageId: null, sectorName: null, cellName: null, villageName: null, venue: null, latitude: null, longitude: null, accuracy: null, locationVerified: false, firstLocationCapturedAt: null, isOnHold: false, updatedById: req.user.id },
      });
      await createMoolaMovementNotices(tx, { externalAgentId, agentName: agent.name, agentCode: agent.loginName || externalAgentId, fromTerritoryId: source.id, toTerritoryId: destination.id, noticeType: 'RELOCATED' });
      return moved;
    }, { maxWait: 10000, timeout: 15000 });
    await logAction(req.user.id, 'ADMIN_RELOCATE_MOOLA_AGENT', 'MoolaAgentLocation', externalAgentId, { fromTerritoryId: source.id, toTerritoryId: destination.id, reason: String(req.body.reason || '').trim().slice(0, 500) || null }, req);
    res.json({ location: moolaLocationShape(updated), territory: destination });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Admin Moola Plus relocation failed:', error.code || error.name);
    res.status(500).json({ error: 'Could not relocate this Moola Plus agent.' });
  }
});

router.post('/moola-plus/agents/:externalAgentId/admin-transfer', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  try {
    const externalAgentId = String(req.params.externalAgentId || '').trim();
    const toTerritoryId = String(req.body.toTerritoryId || '').trim();
    const recipientTcId = String(req.body.recipientTcId || '').trim();
    const [agent, location] = await Promise.all([
      getUpstreamMoolaAgent(req, externalAgentId),
      prisma.moolaAgentLocation.findUnique({ where: { externalAgentId } }),
    ]);
    if (!agent) return res.status(404).json({ error: 'Moola Plus agent not found.' });
    const source = await moolaDistrictForAgent(agent, location);
    if (!source) return res.status(409).json({ error: 'The agent has no recorded district. Capture the first field location before transferring.' });
    const destination = await prisma.tcTerritoryAssignment.findFirst({ where: { territoryId: toTerritoryId, tcId: recipientTcId, isActive: true, territory: { is: { type: 'DISTRICT', isActive: true } }, tc: { is: { role: 'TC', isActive: true } } }, select: { territory: { select: { id: true, name: true } }, tc: { select: { id: true, firstName: true, lastName: true } } } });
    if (!destination || toTerritoryId === source.id) return res.status(400).json({ error: 'Choose an active TC assigned to a different district.' });
    const transfer = await prisma.$transaction(async (tx) => {
      await advisoryTransactionLock(tx, externalAgentId, 'AGENT_MOVE');
      const [pendingTransfer, pendingRelocation, sourceAssignments] = await Promise.all([
        tx.moolaAgentTransfer.findFirst({ where: { externalAgentId, status: { in: ['PENDING', 'ON_HOLD'] } }, select: { id: true } }),
        tx.moolaRelocationRequest.findFirst({ where: { externalAgentId, status: 'PENDING' }, select: { id: true } }),
        tx.tcTerritoryAssignment.findMany({ where: { territoryId: source.id, isActive: true, tc: { is: { role: 'TC', isActive: true } } }, select: { tcId: true } }),
      ]);
      if (pendingTransfer || pendingRelocation) throw conflict(pendingTransfer ? 'This agent already has a transfer awaiting review.' : 'This agent already has a relocation request awaiting review.');
      const created = await tx.moolaAgentTransfer.create({ data: {
        externalAgentId, agentName: agent.name, loginName: agent.loginName || externalAgentId, phoneNumber: agent.phone || null,
        fromTerritoryId: source.id, toTerritoryId, requestedByTcId: sourceAssignments[0]?.tcId || req.user.id,
        recipientTcId, reason: String(req.body.reason || '').trim().slice(0, 500) || null, adminRoutedAt: new Date(),
      }, include: { fromTerritory: { select: { id: true, name: true } }, toTerritory: { select: { id: true, name: true } }, recipientTc: { select: { id: true, firstName: true, lastName: true } } } });
      await createMoolaMovementNotices(tx, { externalAgentId, agentName: agent.name, agentCode: agent.loginName || externalAgentId, fromTerritoryId: source.id, toTerritoryId, noticeType: 'TRANSFER_ROUTED' });
      return created;
    }, { maxWait: 10000, timeout: 15000 });
    await logAction(req.user.id, 'ADMIN_ROUTE_MOOLA_AGENT_TRANSFER', 'MoolaAgentTransfer', transfer.id, { externalAgentId, fromTerritoryId: source.id, toTerritoryId, recipientTcId }, req);
    res.status(201).json(transfer);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Admin Moola Plus transfer routing failed:', error.code || error.name);
    res.status(500).json({ error: 'Could not route this Moola Plus agent to the selected TC.' });
  }
});

router.post('/moola-plus/agents/:externalAgentId/transfer', authenticateToken, requireTerritoryAccess, requireRole('TC'), async (req, res) => {
  try {
    const externalAgentId = String(req.params.externalAgentId || '').trim();
    const toTerritoryId = String(req.body.toTerritoryId || '').trim();
    const recipientTcId = String(req.body.recipientTcId || '').trim();
    const [agent, location] = await Promise.all([
      getUpstreamMoolaAgent(req, externalAgentId),
      prisma.moolaAgentLocation.findUnique({ where: { externalAgentId } }),
    ]);
    if (!agent) return res.status(404).json({ error: 'Moola Plus agent not found.' });
    if (!String(agent.phone || '').trim()) return res.status(409).json({ error: 'Add the agent’s phone number before requesting a transfer so the receiving TC can confirm their location.' });
    const fromTerritory = await moolaDistrictForAgent(agent, location);
    if (!fromTerritory || !(req.user.assignedTerritories || []).includes(fromTerritory.id)) return res.status(403).json({ error: 'This agent is outside your assigned district.' });
    if (location?.isOnHold) return res.status(409).json({ error: 'This agent is on hold until an administrator assigns a new coordinator.' });
    const destination = await prisma.tcTerritoryAssignment.findFirst({ where: { territoryId: toTerritoryId, tcId: recipientTcId, isActive: true, territory: { is: { type: 'DISTRICT', isActive: true } }, tc: { is: { role: 'TC', isActive: true } } }, select: { territory: { select: { id: true, name: true } }, tc: { select: { id: true, firstName: true, lastName: true } } } });
    if (!destination || toTerritoryId === fromTerritory.id || (req.user.assignedTerritories || []).includes(toTerritoryId)) return res.status(400).json({ error: 'Choose an active TC assigned to a different district.' });
    const transfer = await prisma.$transaction(async (tx) => {
      await advisoryTransactionLock(tx, externalAgentId, 'AGENT_MOVE');
      const [pending, relocation] = await Promise.all([
        tx.moolaAgentTransfer.findFirst({ where: { externalAgentId, status: { in: ['PENDING', 'ON_HOLD'] } }, select: { id: true } }),
        tx.moolaRelocationRequest.findFirst({ where: { externalAgentId, status: 'PENDING' }, select: { id: true } }),
      ]);
      if (pending || relocation) throw conflict(pending ? 'This agent already has a transfer awaiting review.' : 'This agent already has a relocation request awaiting review.');
      return tx.moolaAgentTransfer.create({ data: {
        externalAgentId, agentName: agent.name, loginName: agent.loginName || externalAgentId, phoneNumber: agent.phone || null,
        fromTerritoryId: fromTerritory.id, toTerritoryId, requestedByTcId: req.user.id, recipientTcId,
        reason: String(req.body.reason || '').trim().slice(0, 500) || null,
      }, include: { fromTerritory: { select: { id: true, name: true } }, toTerritory: { select: { id: true, name: true } }, recipientTc: { select: { id: true, firstName: true, lastName: true } } } });
    }, { maxWait: 10000, timeout: 15000 });
    await logAction(req.user.id, 'REQUEST_MOOLA_AGENT_TRANSFER', 'MoolaAgentTransfer', transfer.id, { externalAgentId, fromTerritoryId: fromTerritory.id, toTerritoryId, recipientTcId }, req);
    res.status(201).json(transfer);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Moola agent transfer request failed:', error.code || error.name);
    res.status(500).json({ error: 'Could not send this Moola Plus transfer request.' });
  }
});

router.get('/moola-plus/transfer-inbox', authenticateToken, requireTerritoryAccess, requireRole('TC'), async (req, res) => {
  try {
    const transfers = await prisma.moolaAgentTransfer.findMany({ where: { recipientTcId: req.user.id, status: 'PENDING', acceptedAt: null }, include: { fromTerritory: { select: { id: true, name: true, parent: { select: { name: true } } } }, toTerritory: { select: { id: true, name: true, parent: { select: { name: true } } } }, requestedByTc: { select: { id: true, firstName: true, lastName: true, phoneNumber: true } } }, orderBy: { requestedAt: 'asc' } });
    res.json(transfers);
  } catch (error) {
    console.error('Moola transfer inbox error:', error.code || error.name);
    res.status(500).json({ error: 'Could not load incoming Moola Plus transfers.' });
  }
});

router.put('/moola-plus/transfer-requests/:id/review', authenticateToken, requireTerritoryAccess, requireRole('TC'), async (req, res) => {
  try {
    const decision = String(req.body.decision || '').toUpperCase();
    if (!['ACCEPT', 'REJECT'].includes(decision)) return res.status(400).json({ error: 'Choose whether to accept or reject this transfer.' });
    const reviewNote = String(req.body.note || '').trim().slice(0, 500) || null;
    if (decision === 'REJECT' && !reviewNote) return res.status(400).json({ error: 'Enter a reason for rejecting this transfer.' });
    const transfer = await prisma.moolaAgentTransfer.findUnique({ where: { id: req.params.id } });
    if (!transfer || transfer.recipientTcId !== req.user.id || transfer.status !== 'PENDING' || transfer.acceptedAt) return res.status(409).json({ error: 'This Moola Plus transfer is no longer awaiting your review.' });
    if (decision === 'ACCEPT' && !(req.user.assignedTerritories || []).includes(transfer.toTerritoryId)) return res.status(403).json({ error: 'You are no longer assigned to the destination district.' });
    const result = await prisma.$transaction(async (tx) => {
      await advisoryTransactionLock(tx, transfer.externalAgentId, 'AGENT_MOVE');
      const current = await tx.moolaAgentTransfer.findUnique({ where: { id: transfer.id } });
      if (!current || current.status !== 'PENDING' || current.acceptedAt) throw conflict('This Moola Plus transfer has already been reviewed.');
      const now = new Date();
      if (decision === 'REJECT') {
        const changed = await tx.moolaAgentTransfer.updateMany({ where: { id: current.id, status: 'PENDING', acceptedAt: null }, data: { status: 'ON_HOLD', reviewedAt: now, reviewNote } });
        if (!changed.count) throw conflict('This Moola Plus transfer has already been reviewed.');
        await tx.moolaAgentLocation.upsert({ where: { externalAgentId: current.externalAgentId }, create: { externalAgentId: current.externalAgentId, agentName: current.agentName, loginName: current.loginName, territoryId: current.fromTerritoryId, updatedById: req.user.id, isOnHold: true }, update: { isOnHold: true, updatedById: req.user.id } });
        return tx.moolaAgentTransfer.findUnique({ where: { id: current.id } });
      }
      const [pendingRelocation, moved] = await Promise.all([
        tx.moolaRelocationRequest.findFirst({ where: { externalAgentId: current.externalAgentId, status: 'PENDING' }, select: { id: true } }),
        tx.moolaAgentTransfer.updateMany({ where: { id: current.id, status: 'PENDING', acceptedAt: null }, data: { acceptedAt: now, reviewedAt: now, reviewNote } }),
      ]);
      if (pendingRelocation) throw conflict('This agent has a relocation request awaiting administrator review. Resolve it before accepting the transfer.');
      if (!moved.count) throw conflict('This Moola Plus transfer has already been reviewed.');
      await tx.moolaAgentLocation.upsert({ where: { externalAgentId: current.externalAgentId }, create: { externalAgentId: current.externalAgentId, agentName: current.agentName, loginName: current.loginName, territoryId: current.toTerritoryId, updatedById: req.user.id }, update: { territoryId: current.toTerritoryId, sectorId: null, cellId: null, villageId: null, sectorName: null, cellName: null, villageName: null, venue: null, latitude: null, longitude: null, accuracy: null, locationVerified: false, firstLocationCapturedAt: null, isOnHold: false, updatedById: req.user.id } });
      return tx.moolaAgentTransfer.findUnique({ where: { id: current.id } });
    }, { maxWait: 10000, timeout: 15000 });
    await logAction(req.user.id, decision === 'ACCEPT' ? 'ACCEPT_MOOLA_AGENT_TRANSFER' : 'REJECT_MOOLA_AGENT_TRANSFER', 'MoolaAgentTransfer', result.id, { externalAgentId: result.externalAgentId, toTerritoryId: result.toTerritoryId, reviewNote }, req);
    res.json(result);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Moola transfer review failed:', error.code || error.name);
    res.status(500).json({ error: 'Could not review this Moola Plus transfer.' });
  }
});

router.get('/moola-plus/transfer-holds', authenticateToken, requireRole('ADMIN'), async (_req, res) => {
  try {
    const rows = await prisma.moolaAgentTransfer.findMany({ where: { status: 'ON_HOLD' }, include: { fromTerritory: { select: { id: true, name: true, parent: { select: { name: true } } } }, toTerritory: { select: { id: true, name: true, parent: { select: { name: true } } } }, requestedByTc: { select: { id: true, firstName: true, lastName: true } }, recipientTc: { select: { id: true, firstName: true, lastName: true } } }, orderBy: { reviewedAt: 'asc' } });
    res.json(rows);
  } catch (error) { res.status(500).json({ error: 'Could not load Moola Plus agents awaiting reassignment.' }); }
});

router.get('/moola-plus/transfer-hold-targets', authenticateToken, requireRole('ADMIN'), async (_req, res) => {
  try { res.json(await moolaTransferTargets()); }
  catch (error) { res.status(500).json({ error: 'Could not load active coordinator districts.' }); }
});

  router.put('/moola-plus/transfer-holds/:id/route', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  try {
    const toTerritoryId = String(req.body.toTerritoryId || '').trim();
    const recipientTcId = String(req.body.recipientTcId || '').trim();
    const assignment = await prisma.tcTerritoryAssignment.findFirst({ where: { territoryId: toTerritoryId, tcId: recipientTcId, isActive: true, territory: { is: { type: 'DISTRICT', isActive: true } }, tc: { is: { role: 'TC', isActive: true } } }, select: { tc: { select: { id: true } } } });
    if (!assignment) return res.status(400).json({ error: 'Choose an active TC assigned to the destination district.' });
    const transfer = await prisma.$transaction(async (tx) => {
      const current = await tx.moolaAgentTransfer.findUnique({ where: { id: req.params.id } });
      if (!current || current.status !== 'ON_HOLD') throw conflict('This held Moola Plus agent has already been routed.');
      await advisoryTransactionLock(tx, current.externalAgentId, 'AGENT_MOVE');
      const refreshed = await tx.moolaAgentTransfer.findUnique({ where: { id: current.id } });
      if (!refreshed || refreshed.status !== 'ON_HOLD') throw conflict('This held Moola Plus agent has already been routed.');
      const changed = await tx.moolaAgentTransfer.updateMany({ where: { id: current.id, status: 'ON_HOLD' }, data: { status: 'PENDING', toTerritoryId, recipientTcId, adminRoutedAt: new Date(), acceptedAt: null, reviewedAt: null } });
      if (!changed.count) throw conflict('This held Moola Plus agent has already been routed.');
      await tx.moolaAgentLocation.updateMany({ where: { externalAgentId: current.externalAgentId }, data: { isOnHold: true, updatedById: req.user.id } });
      return tx.moolaAgentTransfer.findUnique({ where: { id: current.id }, include: { toTerritory: { select: { id: true, name: true } }, recipientTc: { select: { id: true, firstName: true, lastName: true } } } });
    });
    await logAction(req.user.id, 'ADMIN_ROUTE_HELD_MOOLA_AGENT', 'MoolaAgentTransfer', transfer.id, { externalAgentId: transfer.externalAgentId, toTerritoryId, recipientTcId }, req);
    res.json(transfer);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Moola transfer hold routing failed:', error.code || error.name);
    res.status(500).json({ error: 'Could not route this Moola Plus agent.' });
  }
});

router.post('/moola-plus/check-in', authenticateToken, requireTerritoryAccess, requireRole('TC'), async (req, res) => {
  try {
    const externalAgentId = String(req.body.externalAgentId || '').trim();
    const territoryId = String(req.body.territoryId || '').trim();
    const { tcLatitude, tcLongitude, gpsAccuracyMeters } = req.body;
    const hasGps = validCoordinates(tcLatitude, tcLongitude, gpsAccuracyMeters);
    const requestedVisitId = typeof req.body.visitId === 'string' ? req.body.visitId.trim() : '';
    if (!externalAgentId || externalAgentId.length > 200 || !territoryId || !hasGps) return res.status(400).json({ error: 'Choose an agent and assigned district, then capture a fresh GPS location to check in.' });
    if (requestedVisitId && (requestedVisitId.length > 80 || !/^[A-Za-z0-9_-]+$/.test(requestedVisitId))) return res.status(400).json({ error: 'The client visit ID is invalid.' });
    if (!(req.user.assignedTerritories || []).includes(territoryId)) return res.status(403).json({ error: 'This district is outside your assigned territory.' });
    const [agent, territory, config, existingVisit] = await Promise.all([
      getUpstreamMoolaAgent(req, externalAgentId),
      prisma.territory.findUnique({ where: { id: territoryId }, select: { id: true, name: true, type: true, isActive: true } }),
      prisma.systemConfig.findUnique({ where: { key: 'GEOFENCE_RADIUS_METERS' } }),
      requestedVisitId ? prisma.visit.findUnique({ where: { visitId: requestedVisitId } }) : null,
    ]);
    if (!agent) return res.status(404).json({ error: 'Moola Plus agent not found in the upstream registry.' });
    if (!territory || territory.type !== 'DISTRICT' || !territory.isActive) return res.status(400).json({ error: 'Choose an active district.' });
    const radiusMeters = config ? Number.parseInt(config.value, 10) : 100;
    const [previousLocation, pendingTransfer, incomingTransfer] = await Promise.all([
      prisma.moolaAgentLocation.findUnique({ where: { externalAgentId } }),
      prisma.moolaAgentTransfer.findFirst({ where: { externalAgentId, requestedByTcId: req.user.id, status: 'PENDING', acceptedAt: null }, select: { id: true } }),
      prisma.moolaAgentTransfer.findFirst({ where: { externalAgentId, recipientTcId: req.user.id, status: 'PENDING', acceptedAt: null }, select: { id: true } }),
    ]);
    if (previousLocation?.isOnHold) return res.status(409).json({ error: 'This agent is on hold until an administrator assigns a new coordinator.' });
    if (pendingTransfer) return res.status(409).json({ error: 'This agent is awaiting transfer review. You cannot start a visit until the transfer is resolved.' });
    if (incomingTransfer) return res.status(409).json({ error: 'Review and accept this transfer from the dashboard before visiting the agent.' });
    if (previousLocation && previousLocation.territoryId !== territoryId) return res.status(409).json({ error: 'This agent has a different saved district. Submit a relocation request and wait for approval before visiting there.' });
    const hasSavedCoordinates = Boolean(previousLocation?.locationVerified && previousLocation.latitude != null && previousLocation.longitude != null);
    const savedDistance = hasSavedCoordinates ? calculateDistance(tcLatitude, tcLongitude, previousLocation.latitude, previousLocation.longitude) : null;
    if (gpsAccuracyMeters > 50) return res.status(422).json({ error: `GPS accuracy is ±${Math.round(gpsAccuracyMeters)} m. Move closer to the agent or find a clearer GPS reading before checking in.` });
    if (hasSavedCoordinates && savedDistance > radiusMeters) return res.status(403).json({ error: `You are ${Math.round(savedDistance)} m from the agent’s saved location. Check-in is allowed only within the configured ${radiusMeters} m radius.` });
    if (existingVisit) {
      if (existingVisit.tcId !== req.user.id || existingVisit.externalAgentId !== externalAgentId || existingVisit.network !== 'MOOLA_PLUS') return res.status(409).json({ error: 'This client visit ID already belongs to another visit.' });
      if (!hasSavedCoordinates || existingVisit.locationStatus !== 'VERIFIED') return res.status(409).json({ error: 'This visit has no verified saved agent location. Capture the agent’s location and start a new check-in.' });
      return res.json({ ...existingVisit, distanceMeters: savedDistance, radiusMeters });
    }
    if (!previousLocation && String(agent.district || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ') !== territory.name.trim().toLocaleLowerCase().replace(/\s+/g, ' ')) {
      return res.status(403).json({ error: 'Choose the agent’s registered district for its first visit.' });
    }
    const firstLocation = !previousLocation?.locationVerified || previousLocation.latitude == null || previousLocation.longitude == null
      || !previousLocation.sectorId || !previousLocation.cellId || !previousLocation.villageId || !previousLocation.venue;
    const locationResult = firstLocation ? await validateMoolaFieldLocation({ territoryId, ...req.body }) : null;
    if (locationResult?.error) return res.status(400).json({ error: locationResult.error });
    if (!hasSavedCoordinates && gpsAccuracyMeters > 20) return res.status(422).json({ error: `First-visit GPS accuracy is ±${Math.round(gpsAccuracyMeters)} m. Capture the agent’s coordinates with accuracy of 20 m or better before checking in.` });
    const locationAssignment = locationResult?.location || previousLocation;
    const checkInTime = new Date();
    const visit = await prisma.$transaction(async (tx) => {
      await advisoryTransactionLock(tx, externalAgentId, 'AGENT_MOVE');
      const [currentLocation, currentOutgoingTransfer, currentIncomingTransfer] = await Promise.all([
        tx.moolaAgentLocation.findUnique({ where: { externalAgentId } }),
        tx.moolaAgentTransfer.findFirst({ where: { externalAgentId, requestedByTcId: req.user.id, status: 'PENDING', acceptedAt: null }, select: { id: true } }),
        tx.moolaAgentTransfer.findFirst({ where: { externalAgentId, recipientTcId: req.user.id, status: 'PENDING', acceptedAt: null }, select: { id: true } }),
      ]);
      if (currentLocation?.isOnHold) throw conflict('This agent is on hold until an administrator assigns a new coordinator.');
      if (currentOutgoingTransfer) throw conflict('This agent is awaiting transfer review. You cannot start a visit until the transfer is resolved.');
      if (currentIncomingTransfer) throw conflict('Review and accept this transfer from the dashboard before visiting the agent.');
      if (currentLocation && currentLocation.territoryId !== territoryId) throw conflict('The Moola Plus agent location changed before check-in. Reload the profile.');
      const needsLocation = !currentLocation?.locationVerified || currentLocation.latitude == null || currentLocation.longitude == null
        || !currentLocation.sectorId || !currentLocation.cellId || !currentLocation.villageId || !currentLocation.venue;
      if (needsLocation !== firstLocation) throw conflict('The Moola Plus location changed before check-in. Reload the agent and try again.');
      const currentHasSavedCoordinates = Boolean(currentLocation?.locationVerified && currentLocation.latitude != null && currentLocation.longitude != null);
      const distance = currentHasSavedCoordinates
        ? calculateDistance(tcLatitude, tcLongitude, currentLocation.latitude, currentLocation.longitude)
        : 0;
      if (gpsAccuracyMeters > (currentHasSavedCoordinates ? 50 : 20)) throw conflict(`GPS accuracy must be ${currentHasSavedCoordinates ? '50' : '20'} m or better before check-in.`);
      if (distance > radiusMeters) throw conflict(`You are ${Math.round(distance)} m from the agent’s saved location. Check-in is allowed only within the configured ${radiusMeters} m radius.`);
      const locationStatus = 'VERIFIED';
      await advisoryTransactionLock(tx, externalAgentId, 'MOOLA_METRIC_WINDOW');
      const data = {
        visitId: requestedVisitId || makeVisitId(), network: 'MOOLA_PLUS', externalAgentId,
        externalAgentName: agent.name, externalAgentCode: agent.loginName || externalAgentId,
        tc: { connect: { id: req.user.id } }, territory: { connect: { id: territoryId } }, visitDate: checkInTime, checkInTime,
        agentLatitude: needsLocation ? (hasGps && gpsAccuracyMeters <= 20 ? tcLatitude : currentLocation?.latitude ?? null) : currentLocation.latitude,
        agentLongitude: needsLocation ? (hasGps && gpsAccuracyMeters <= 20 ? tcLongitude : currentLocation?.longitude ?? null) : currentLocation.longitude,
        tcLatitude: hasGps ? tcLatitude : null, tcLongitude: hasGps ? tcLongitude : null,
        distanceMeters: distance, gpsAccuracyMeters: hasGps ? gpsAccuracyMeters : null,
        locationStatus, locationMethod: 'GPS',
        visitStatus: 'STARTED', countsForMetrics: false, isOffline: false,
      };
      const created = await tx.visit.create({ data });
      if (needsLocation) {
        const accurate = hasGps && gpsAccuracyMeters <= 20;
        await tx.moolaAgentLocation.upsert({
          where: { externalAgentId },
          create: { externalAgentId, agentName: agent.name, loginName: agent.loginName || externalAgentId, ...locationAssignment, latitude: accurate ? tcLatitude : null, longitude: accurate ? tcLongitude : null, accuracy: accurate ? gpsAccuracyMeters : null, locationVerified: accurate, firstLocationCapturedAt: accurate ? checkInTime : null, updatedById: req.user.id },
          update: { agentName: agent.name, loginName: agent.loginName || externalAgentId, ...locationAssignment, latitude: accurate ? tcLatitude : null, longitude: accurate ? tcLongitude : null, accuracy: accurate ? gpsAccuracyMeters : null, locationVerified: accurate, firstLocationCapturedAt: accurate ? checkInTime : null, isOnHold: false, updatedById: req.user.id },
        });
      }
      await tx.moolaAgentTransfer.updateMany({ where: { externalAgentId, recipientTcId: req.user.id, status: 'PENDING', acceptedAt: { not: null } }, data: { status: 'COMPLETED', completedAt: checkInTime } });
      return created;
    }, { maxWait: 10000, timeout: 15000 });
    await logAction(req.user.id, 'CREATE_VISIT', 'MoolaPlusVisit', visit.id, { visitId: visit.visitId, externalAgentId, territoryId, locationStatus: visit.locationStatus, locationMethod: visit.locationMethod }, req);
    res.status(201).json({ ...visit, radiusMeters });
  } catch (error) {
    console.error('Moola Plus check-in error:', error.code || error.name);
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    res.status(error.message?.includes('upstream') ? 502 : 500).json({ error: error.message?.includes('upstream') ? error.message : 'Could not start the Moola Plus visit. Please retry or contact an administrator.' });
  }
});

router.post('/moola-plus/agents/:externalAgentId/relocation-requests', authenticateToken, requireTerritoryAccess, requireRole('TC'), async (req, res) => {
  try {
    const externalAgentId = String(req.params.externalAgentId || '').trim();
    const toTerritoryId = String(req.body.territoryId || '').trim();
    const reason = String(req.body.reason || '').trim();
    const [agent, destination, location] = await Promise.all([
      getUpstreamMoolaAgent(req, externalAgentId),
      prisma.territory.findUnique({ where: { id: toTerritoryId }, select: { id: true, type: true, isActive: true } }),
      prisma.moolaAgentLocation.findUnique({ where: { externalAgentId } }),
    ]);
    if (!agent) return res.status(404).json({ error: 'Moola Plus agent not found in the upstream registry.' });
    if (!location) return res.status(409).json({ error: 'Complete the agent’s first visit before requesting a relocation.' });
    if (!(req.user.assignedTerritories || []).includes(location.territoryId)) return res.status(403).json({ error: 'This agent is outside your assigned territory.' });
    if (!(req.user.assignedTerritories || []).includes(toTerritoryId)) return res.status(403).json({ error: 'Relocation requests must stay inside your assigned districts. Use a transfer request for another TC’s district.' });
    if (!destination || destination.type !== 'DISTRICT' || !destination.isActive || toTerritoryId === location.territoryId) return res.status(400).json({ error: 'Choose a different active district.' });
    if (reason.length > 500) return res.status(400).json({ error: 'Relocation note must be 500 characters or fewer.' });
    const request = await prisma.$transaction(async (tx) => {
      await advisoryTransactionLock(tx, externalAgentId, 'AGENT_MOVE');
      const [pending, pendingTransfer] = await Promise.all([
        tx.moolaRelocationRequest.findFirst({ where: { externalAgentId, status: 'PENDING' }, select: { id: true } }),
        tx.moolaAgentTransfer.findFirst({ where: { externalAgentId, status: { in: ['PENDING', 'ON_HOLD'] } }, select: { id: true } }),
      ]);
      if (pending || pendingTransfer) throw conflict(pending ? 'This agent already has a relocation request awaiting review.' : 'This agent already has a transfer awaiting review.');
      return tx.moolaRelocationRequest.create({ data: {
        externalAgentId, agentName: agent.name, loginName: agent.loginName || externalAgentId,
        fromTerritoryId: location.territoryId, toTerritoryId, reason: reason || null, requestedByTcId: req.user.id,
      }, include: { fromTerritory: { select: { id: true, name: true } }, toTerritory: { select: { id: true, name: true } } } });
    }, { maxWait: 10000, timeout: 15000 });
    res.status(201).json(request);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Moola relocation request error:', error.code || error.name);
    res.status(500).json({ error: 'Could not submit this relocation request.' });
  }
});

router.get('/moola-plus/relocation-requests', authenticateToken, requireRole('ADMIN'), async (_req, res) => {
  try {
    const requests = await prisma.moolaRelocationRequest.findMany({ where: { status: 'PENDING' }, orderBy: { requestedAt: 'asc' }, include: { fromTerritory: { select: { id: true, name: true } }, toTerritory: { select: { id: true, name: true } }, requestedByTc: { select: { firstName: true, lastName: true, username: true } } } });
    res.json(requests);
  } catch (error) { res.status(500).json({ error: 'Could not load Moola Plus relocation requests.' }); }
});

router.post('/moola-plus/relocation-requests/:id/review', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  try {
    const action = String(req.body.action || '').toUpperCase();
    if (!['APPROVE', 'REJECT'].includes(action)) return res.status(400).json({ error: 'Choose APPROVE or REJECT.' });
    const reviewNote = String(req.body.reviewNote || '').trim();
    const result = await prisma.$transaction(async (tx) => {
      const requestId = req.params.id;
      const initial = await tx.moolaRelocationRequest.findUnique({ where: { id: requestId }, select: { externalAgentId: true } });
      if (!initial) throw conflict('This Moola Plus relocation request has already been reviewed.');
      await advisoryTransactionLock(tx, initial.externalAgentId, 'AGENT_MOVE');
      const request = await tx.moolaRelocationRequest.findUnique({ where: { id: req.params.id } });
      if (!request || request.status !== 'PENDING') throw conflict('This Moola Plus relocation request has already been reviewed.');
      if (action === 'APPROVE') {
        const transfer = await tx.moolaAgentTransfer.findFirst({ where: { externalAgentId: request.externalAgentId, status: { in: ['PENDING', 'ON_HOLD'] } }, select: { id: true } });
        if (transfer) throw conflict('Resolve the pending transfer before approving this relocation.');
      }
      const reviewedAt = new Date();
      const updated = await tx.moolaRelocationRequest.update({ where: { id: request.id }, data: { status: action === 'APPROVE' ? 'APPROVED' : 'REJECTED', reviewedById: req.user.id, reviewedAt, reviewNote: reviewNote || null } });
      if (action === 'APPROVE') {
        const location = await tx.moolaAgentLocation.update({ where: { externalAgentId: request.externalAgentId }, data: { territoryId: request.toTerritoryId, sectorId: null, cellId: null, villageId: null, sectorName: null, cellName: null, villageName: null, venue: null, latitude: null, longitude: null, accuracy: null, locationVerified: false, firstLocationCapturedAt: null, updatedById: req.user.id } });
        await createMoolaMovementNotices(tx, { externalAgentId: request.externalAgentId, agentName: request.agentName, agentCode: request.loginName, fromTerritoryId: request.fromTerritoryId, toTerritoryId: request.toTerritoryId, noticeType: 'RELOCATED' });
        return { ...updated, location };
      }
      return updated;
    });
    await logAction(req.user.id, action === 'APPROVE' ? 'APPROVE_MOOLA_RELOCATION' : 'REJECT_MOOLA_RELOCATION', 'MoolaRelocationRequest', result.id, { externalAgentId: result.externalAgentId, toTerritoryId: result.toTerritoryId }, req);
    res.json(result);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Moola relocation review error:', error.code || error.name);
    res.status(500).json({ error: 'Could not review this relocation request.' });
  }
});

router.post('/check-in', authenticateToken, requireTerritoryAccess, requireRole('TC'), async (req, res) => {
  try {
    const { agentId, tcLatitude, tcLongitude, gpsAccuracyMeters } = req.body;
    const hasGps = validCoordinates(tcLatitude, tcLongitude, gpsAccuracyMeters);
    const requestedVisitId = typeof req.body.visitId === 'string' ? req.body.visitId.trim() : '';
    if (!agentId || !hasGps) return res.status(400).json({ error: 'Choose an agent and capture a fresh GPS location to check in.' });
    if (requestedVisitId && (requestedVisitId.length > 80 || !/^[A-Za-z0-9_-]+$/.test(requestedVisitId))) return res.status(400).json({ error: 'The client visit ID is invalid.' });

    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      include: {
        sector: { select: { type: true, parentId: true, isActive: true } },
        cell: { select: { type: true, parentId: true, isActive: true } },
        village: { select: { type: true, parentId: true, isActive: true } },
      },
    });
    if (!agent) return res.status(404).json({ error: 'Agent not found.' });
    const [pendingTransfer, unreviewedIncomingTransfer, config, existingVisit] = await Promise.all([
      req.user.role === 'TC'
        ? prisma.agentTransfer.findFirst({ where: { agentId: agent.id, recipientTcId: req.user.id, status: 'PENDING', acceptedAt: { not: null }, toTerritoryId: agent.territoryId } })
        : null,
      req.user.role === 'TC'
        ? prisma.agentTransfer.findFirst({ where: { agentId: agent.id, recipientTcId: req.user.id, status: 'PENDING', acceptedAt: null }, select: { id: true } })
        : null,
      prisma.systemConfig.findUnique({ where: { key: 'GEOFENCE_RADIUS_METERS' } }),
      requestedVisitId
        ? prisma.visit.findUnique({ where: { visitId: requestedVisitId }, include: { agent: true } })
        : null,
    ]);
    const radiusMeters = config ? Number.parseInt(config.value, 10) : 100;
    if (gpsAccuracyMeters > 50) return res.status(422).json({ error: `GPS accuracy is ±${Math.round(gpsAccuracyMeters)} m. Move closer to the agent or find a clearer GPS reading before checking in.` });
    if (unreviewedIncomingTransfer) return res.status(409).json({ error: 'Review and accept this transfer from the dashboard before visiting the agent.' });
    if (req.user.role === 'TC' && !(req.user.assignedTerritories || []).includes(agent.territoryId) && !pendingTransfer) {
      return res.status(403).json({ error: 'This agent is outside your assigned territory.' });
    }
    if (existingVisit) {
      if (existingVisit.tcId !== req.user.id || existingVisit.agentId !== agent.id) return res.status(409).json({ error: 'This client visit ID already belongs to another visit.' });
      if (existingVisit.locationStatus !== 'VERIFIED' || existingVisit.locationMethod !== 'GPS') return res.status(409).json({ error: 'This visit does not have a verified GPS check-in. Start a new check-in from the agent location.' });
      if (!agent.locationVerified || agent.registeredLatitude == null || agent.registeredLongitude == null) return res.status(409).json({ error: 'The agent needs a verified saved location before check-in.' });
      const retryDistance = calculateDistance(tcLatitude, tcLongitude, agent.registeredLatitude, agent.registeredLongitude);
      if (retryDistance > radiusMeters) return res.status(403).json({ error: `You are ${Math.round(retryDistance)} m from the agent’s saved location. Check-in is allowed only within the configured ${radiusMeters} m radius.` });
      return res.json({ ...existingVisit, radiusMeters });
    }
    if (req.user.role === 'TC') {
      const outgoingTransfer = await prisma.agentTransfer.findFirst({ where: { agentId: agent.id, requestedByTcId: req.user.id, status: 'PENDING' }, select: { id: true } });
      if (outgoingTransfer && !pendingTransfer) return res.status(409).json({ error: 'This agent is awaiting review by the destination coordinator. You cannot start a visit until the transfer is resolved.' });
    }
    const sector = agent.sector;
    if (!sector || sector.type !== 'SECTOR' || sector.parentId !== agent.territoryId || (!agent.firstVisitCompletedAt && !sector.isActive)) return res.status(400).json({ error: 'The agent must be assigned to an active sector in their district before a first visit can start.' });
    if (!agent.firstVisitCompletedAt) {
      if (!String(agent.venue || '').trim()) return res.status(400).json({ error: 'Record the agent’s venue during the first visit before checking in.' });
      const cell = agent.cell;
      const village = agent.village;
      if (!cell || cell.type !== 'CELL' || !cell.isActive || cell.parentId !== agent.sectorId || !village || village.type !== 'VILLAGE' || !village.isActive || village.parentId !== agent.cellId) {
        return res.status(400).json({ error: 'Assign the agent’s sector, cell and village at the first visit before checking in.' });
      }
      if (!agent.firstVisitLocationCapturedAt) return res.status(400).json({ error: 'Capture the agent’s cell, village and precise GPS location at the first visit before checking in.' });
    }
    if (agent.registeredLatitude == null || agent.registeredLongitude == null) return res.status(400).json({ error: 'Capture the agent’s registered GPS location before starting this visit.' });
    if (!agent.locationVerified) return res.status(400).json({ error: 'The agent’s registered location needs official verification before a visit can start.' });

    const distanceMeters = calculateDistance(tcLatitude, tcLongitude, agent.registeredLatitude, agent.registeredLongitude);
    if (distanceMeters > radiusMeters) return res.status(403).json({ error: `You are ${Math.round(distanceMeters)} m from the agent’s saved location. Check-in is allowed only within the configured ${radiusMeters} m radius.` });
    const locationStatus = 'VERIFIED';
    const firstVisit = !agent.firstVisitCompletedAt;
    const checkInTime = new Date();
    const visit = await prisma.$transaction(async (tx) => {
      await advisoryTransactionLock(tx, agent.id, 'AGENT_MOVE');
      const currentAgent = await tx.agent.findUnique({ where: { id: agent.id }, select: { territoryId: true, registeredLatitude: true, registeredLongitude: true, locationVerified: true } });
      if (!currentAgent || currentAgent.territoryId !== agent.territoryId || currentAgent.registeredLatitude !== agent.registeredLatitude || currentAgent.registeredLongitude !== agent.registeredLongitude || currentAgent.locationVerified !== agent.locationVerified) {
        throw conflict('The agent location changed before check-in. Reload the agent and capture its current location first.');
      }
      const currentDistance = calculateDistance(tcLatitude, tcLongitude, currentAgent.registeredLatitude, currentAgent.registeredLongitude);
      if (currentDistance > radiusMeters) throw conflict(`You are ${Math.round(currentDistance)} m from the agent’s saved location. Check-in is allowed only within the configured ${radiusMeters} m radius.`);
      await advisoryTransactionLock(tx, agent.id, 'AGENT_METRIC_WINDOW');
      const created = await tx.visit.create({
        data: {
          visitId: requestedVisitId || makeVisitId(), agentId: agent.id, tcId: req.user.id, territoryId: agent.territoryId,
          visitDate: checkInTime, checkInTime, agentLatitude: agent.registeredLatitude,
          agentLongitude: agent.registeredLongitude, tcLatitude: hasGps ? tcLatitude : null, tcLongitude: hasGps ? tcLongitude : null,
          distanceMeters, gpsAccuracyMeters: hasGps ? gpsAccuracyMeters : null, locationStatus,
          locationMethod: 'GPS', visitStatus: 'STARTED',
          countsForMetrics: false, isOffline: false,
        },
        include: { agent: true },
      });
      if (firstVisit) await tx.agent.updateMany({ where: { id: agent.id, firstVisitCompletedAt: null }, data: { firstVisitCompletedAt: created.checkInTime } });
      if (pendingTransfer) await tx.agentTransfer.update({ where: { id: pendingTransfer.id }, data: { status: 'COMPLETED', completedAt: created.checkInTime } });
      return created;
    }, { maxWait: 10000, timeout: 15000 });
    await logAction(req.user.id, 'CREATE_VISIT', 'Visit', visit.id, { visitId: visit.visitId, locationStatus, locationMethod: visit.locationMethod }, req);
    if (firstVisit) await logAction(req.user.id, pendingTransfer ? 'COMPLETE_AGENT_TRANSFER' : 'COMPLETE_AGENT_FIRST_VISIT', 'Agent', agent.id, {
      agentName: agent.name, agentCode: agent.agentId, territoryId: agent.territoryId,
      sectorId: agent.sectorId, cellId: agent.cellId, villageId: agent.villageId, transferId: pendingTransfer?.id || null,
    }, req);
    res.status(201).json({ ...visit, radiusMeters });
  } catch (error) {
    console.error('Check-in error:', error);
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    res.status(500).json({ error: 'Could not start the visit.' });
  }
});

router.put('/:id/photo', authenticateToken, requireRole('ADMIN', 'MANAGER', 'TC'), verifyPhotoVisit, parsePhotoUpload, async (req, res) => {
  const databaseStartedAt = performance.now();
  try {
    if (!req.file) return res.status(400).json({ error: 'A visit photo is required.' });
    const photoResult = await prisma.$transaction(async (tx) => {
      await advisoryTransactionLock(tx, req.visit.id);
      const existingPhoto = await tx.visitPhoto.findFirst({ where: { visitId: req.visit.id, originalFilename: req.file.originalname } });
      if (existingPhoto) return { photo: existingPhoto, created: false };
      const photo = await tx.visitPhoto.create({
        data: {
          visitId: req.visit.id, photoUrl: `/uploads/${req.file.filename}`, photoCapturedAt: new Date(),
          fileSizeBytes: req.file.size, mimeType: req.file.mimetype, originalFilename: req.file.originalname,
        },
      });
      return { photo, created: true };
    }, { maxWait: 10000, timeout: 15000 });
    req.photoDatabaseMs = Math.round(performance.now() - databaseStartedAt);
    if (!photoResult.created) {
      await fs.promises.unlink(req.file.path).catch(() => {});
      return res.json(photoResult.photo);
    }
    res.status(201).json(photoResult.photo);
  } catch (error) {
    req.photoDatabaseMs = Math.round(performance.now() - databaseStartedAt);
    if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
    console.error(JSON.stringify({ event: 'photo_upload_save_failed', requestId: req.requestId, code: error.code || error.name }));
    res.status(503).json({ error: 'The visit service is busy saving this photo. Please retry.' });
  }
});

router.post('/:id/report', authenticateToken, requireRole('ADMIN', 'MANAGER', 'TC'), async (req, res) => {
  try {
    const visit = await prisma.visit.findUnique({ where: { id: req.params.id } });
    if (!visit) return res.status(404).json({ error: 'Visit not found.' });
    if (req.user.role === 'TC' && visit.tcId !== req.user.id) return res.status(403).json({ error: 'You cannot edit this visit.' });
    const checklistData = req.body.checklistData;
    if (!checklistData || typeof checklistData !== 'object' || Array.isArray(checklistData)) return res.status(400).json({ error: 'Provide visit report responses before submitting.' });
    const answerFor = (id) => {
      const value = checklistData[id];
      return value && typeof value === 'object' && !Array.isArray(value) ? value.answer : value;
    };
    const questionConfig = await prisma.systemConfig.findUnique({ where: { key: 'VISIT_CHECKLIST_SCHEMA' }, select: { value: true } });
    if (questionConfig?.value) {
      const parsed = JSON.parse(questionConfig.value);
      const questions = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.questions) ? parsed.questions : [];
      for (const item of questions) {
        const answer = answerFor(item.id);
        const textAnswer = String(answer ?? '').trim();
        const required = visit.network === 'IREMBO' && (item.section || 'DDIN') === 'IREMBO';
        if (!textAnswer) {
          if (required) return res.status(400).json({ error: `Answer the required IREMBO question: ${item.text}` });
          continue;
        }
        if (item.type === 'NUMBER' && !Number.isFinite(Number(textAnswer))) return res.status(400).json({ error: `Enter a number for: ${item.text}` });
        if (item.type === 'YES_NO' && !['Yes', 'No'].includes(textAnswer)) return res.status(400).json({ error: `Choose Yes or No for: ${item.text}` });
        if (item.type === 'MULTIPLE_CHOICE' && !(item.options || []).includes(textAnswer)) return res.status(400).json({ error: `Choose one of the listed options for: ${item.text}` });
        if (item.type === 'TEXT' && typeof answer !== 'string') return res.status(400).json({ error: `Enter a written response for: ${item.text}` });
      }
    }
    const fields = {
      operatingStatus: req.body.operatingStatus,
      servicesOffered: req.body.servicesOffered || '', productsOffered: req.body.productsOffered || '',
      generalObservations: req.body.generalObservations || '', liquidityObservations: req.body.liquidityObservations || '',
      customerQualityObservations: req.body.customerQualityObservations || '', challengesFaced: req.body.challengesFaced || '',
      supportNeeds: req.body.supportNeeds || '', trainingNeeds: req.body.trainingNeeds || '',
      followUpActions: req.body.followUpActions || '', additionalRemarks: req.body.additionalRemarks || '',
      checklistData,
    };
    const report = await prisma.visitReport.upsert({
      where: { visitId: visit.id }, update: fields, create: { visitId: visit.id, ...fields },
    });
    res.status(201).json(report);
  } catch (error) {
    console.error('Submit report error:', error);
    res.status(500).json({ error: 'Could not save the visit report.' });
  }
});

router.put('/:id/check-out', authenticateToken, requireRole('ADMIN', 'MANAGER', 'TC'), async (req, res) => {
  try {
    const visit = await prisma.visit.findUnique({ where: { id: req.params.id }, include: { photos: true, report: true } });
    if (!visit) return res.status(404).json({ error: 'Visit not found.' });
    if (req.user.role === 'TC' && visit.tcId !== req.user.id) return res.status(403).json({ error: 'You cannot complete this visit.' });
    if (!visit.photos.length) return res.status(400).json({ error: 'Capture a visit photo before checking out.' });
    if (!visit.report) return res.status(400).json({ error: 'Complete the visit report before checking out.' });
    const visitStatus = visit.locationStatus === 'VERIFIED' ? 'COMPLETED' : 'FLAGGED';
    const checkOutTime = new Date();
    const updatedVisit = await prisma.$transaction(async (tx) => {
      let countsForMetrics = false;
      if (visitStatus === 'COMPLETED') {
        const lockId = visit.network === 'MOOLA_PLUS' ? visit.externalAgentId : visit.agentId;
        await advisoryTransactionLock(tx, lockId, 'AGENT_METRIC_WINDOW');
        countsForMetrics = await visitCountsForMetrics(tx, visit.agentId, visit.visitDate, visit.network, visit.externalAgentId);
      }
      const updated = await tx.visit.update({ where: { id: visit.id }, data: { checkOutTime, visitStatus, countsForMetrics } });
      if (visit.network === 'MOOLA_PLUS' && visit.externalAgentId) await tx.moolaAgentLocation.updateMany({ where: { externalAgentId: visit.externalAgentId, firstVisitCompletedAt: null }, data: { firstVisitCompletedAt: checkOutTime } });
      return updated;
    });
    await logAction(req.user.id, 'COMPLETE_VISIT', 'Visit', visit.id, { visitStatus }, req);
    res.json(updatedVisit);
  } catch (error) {
    console.error('Check-out error:', error);
    res.status(500).json({ error: 'Could not complete the visit.' });
  }
});

router.put('/:id/location-review', authenticateToken, requireRole('ADMIN', 'MANAGER'), async (req, res) => {
  try {
    const decision = String(req.body.decision || '').toUpperCase();
    const note = String(req.body.note || '').trim();
    if (!['APPROVE', 'REJECT'].includes(decision)) return res.status(400).json({ error: 'Choose APPROVE or REJECT.' });
    if (!note || note.length > 500) return res.status(400).json({ error: 'Enter a review note of 1 to 500 characters.' });
    const visit = await prisma.visit.findUnique({ where: { id: req.params.id } });
    if (!visit) return res.status(404).json({ error: 'Visit not found.' });
    if (visit.visitStatus !== 'FLAGGED' || visit.locationStatus === 'VERIFIED' || visit.locationStatus === 'MANUAL_REVIEW_APPROVED') {
      return res.status(409).json({ error: 'Only completed visits awaiting location review can be reviewed.' });
    }
    const updated = await prisma.$transaction(async (tx) => {
      const lockId = visit.network === 'MOOLA_PLUS' ? visit.externalAgentId : visit.agentId;
      await advisoryTransactionLock(tx, lockId, 'AGENT_METRIC_WINDOW');
      const current = await tx.visit.findUnique({ where: { id: visit.id } });
      if (!current || current.visitStatus !== 'FLAGGED' || current.locationReviewedAt) throw conflict('This location review has already been completed.');
      const approved = decision === 'APPROVE';
      const locationStatus = approved ? 'MANUAL_REVIEW_APPROVED' : current.locationStatus;
      const visitStatus = approved ? 'COMPLETED' : 'REJECTED';
      const countsForMetrics = approved
        ? await visitCountsForMetrics(tx, current.agentId, current.visitDate, current.network, current.externalAgentId)
        : false;
      return tx.visit.update({
        where: { id: current.id },
        data: {
          locationStatus,
          visitStatus,
          countsForMetrics,
          locationReviewNote: note,
          locationReviewedAt: new Date(),
          locationReviewedById: req.user.id,
        },
      });
    }, { maxWait: 10000, timeout: 15000 });
    await logAction(req.user.id, `LOCATION_REVIEW_${decision}`, 'Visit', visit.id, { note, locationMethod: visit.locationMethod }, req);
    res.json(updated);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Visit location review error:', error.code || error.name);
    res.status(500).json({ error: 'Could not save the location review.' });
  }
});

router.get('/', authenticateToken, requireTerritoryAccess, async (req, res) => {
  try {
    const requestedPage = Number.parseInt(req.query.page, 10);
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const safePage = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 100) : 25;
    const where = visitWhereForUser(req.user, req.query);
    const [total, firstPage] = await Promise.all([
      prisma.visit.count({ where }),
      prisma.visit.findMany({
        where,
        skip: (safePage - 1) * limit,
        take: limit,
        select: {
          id: true, visitId: true, network: true, agentId: true, externalAgentId: true, externalAgentName: true, externalAgentCode: true, tcId: true, territoryId: true,
          visitDate: true, checkInTime: true, checkOutTime: true, distanceMeters: true,
          gpsAccuracyMeters: true, locationStatus: true, visitStatus: true, countsForMetrics: true, isOffline: true, syncStatus: true,
          agent: { select: { id: true, agentId: true, name: true, businessName: true } },
          tc: { select: { id: true, firstName: true, lastName: true, username: true } },
        },
        orderBy: [{ visitDate: 'desc' }, { id: 'desc' }],
      }),
    ]);
    const pages = Math.ceil(total / limit);
    const page = Math.min(safePage, Math.max(pages, 1));
    const data = page === safePage ? firstPage : await prisma.visit.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true, visitId: true, network: true, agentId: true, externalAgentId: true, externalAgentName: true, externalAgentCode: true, tcId: true, territoryId: true,
        visitDate: true, checkInTime: true, checkOutTime: true, distanceMeters: true,
        gpsAccuracyMeters: true, locationStatus: true, visitStatus: true, countsForMetrics: true, isOffline: true, syncStatus: true,
        agent: { select: { id: true, agentId: true, name: true, businessName: true } },
        tc: { select: { id: true, firstName: true, lastName: true, username: true } },
      },
      orderBy: [{ visitDate: 'desc' }, { id: 'desc' }],
    });
    res.json({ data, meta: { total, page, limit, pages } });
  } catch (error) {
    console.error('List visits error:', error);
    res.status(500).json({ error: 'Could not load visits.' });
  }
});

router.get('/:id', authenticateToken, requireTerritoryAccess, async (req, res) => {
  try {
    const visit = await prisma.visit.findUnique({ where: { id: req.params.id }, include: { agent: true, report: true, photos: true, tc: true, territory: true } });
    if (!visit) return res.status(404).json({ error: 'Visit not found.' });
    if (req.user.role === 'TC' && !(req.user.assignedTerritories || []).includes(visit.territoryId)) {
      return res.status(403).json({ error: 'Access denied to this visit.' });
    }
    if (req.user.role === 'CHAMPION' && (!visit.agent || visit.agent.championId !== req.user.id)) return res.status(403).json({ error: 'Access denied to this visit.' });
    res.json(visit);
  } catch (error) {
    console.error('Get visit error:', error);
    res.status(500).json({ error: 'Could not load this visit.' });
  }
});

router.post('/sync', authenticateToken, requireTerritoryAccess, requireRole('TC'), async (req, res) => {
  try {
    if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Expected an array of visits.' });
    if (req.body.length > 50) return res.status(413).json({ error: 'Sync at most 50 visits at a time.' });
    const config = await prisma.systemConfig.findUnique({ where: { key: 'GEOFENCE_RADIUS_METERS' } });
    const radiusMeters = config ? Number.parseInt(config.value, 10) : 100;
    const validated = [];
    const receivedIds = new Set();
    for (const item of req.body) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return res.status(400).json({ error: 'Each offline visit must be an object.' });
      if (typeof item.visitId !== 'string' || !item.visitId.trim() || item.visitId.length > 80) return res.status(400).json({ error: 'Each offline visit needs a stable client visit ID.' });
      if (receivedIds.has(item.visitId)) return res.status(400).json({ error: 'The sync batch contains a duplicate client visit ID.' });
      receivedIds.add(item.visitId);
      const agent = item.agentId ? await prisma.agent.findUnique({ where: { id: item.agentId } }) : null;
      if (!agent) return res.status(400).json({ error: 'An offline visit references an unknown agent.' });
      const assignedTerritories = req.user.assignedTerritories || [];
      const transfer = await prisma.agentTransfer.findFirst({ where: { agentId: agent.id, recipientTcId: req.user.id, status: 'PENDING' } });
      if (transfer && !transfer.acceptedAt) return res.status(409).json({ error: 'The destination coordinator must review this transfer before a visit can be synced.' });
      const outgoingTransfer = await prisma.agentTransfer.findFirst({ where: { agentId: agent.id, requestedByTcId: req.user.id, status: 'PENDING' }, select: { id: true } });
      if (outgoingTransfer && !transfer) return res.status(409).json({ error: 'This agent is awaiting review by the destination coordinator. Sync will be available after the transfer is resolved.' });
      if (!assignedTerritories.includes(agent.territoryId) && (!transfer || !assignedTerritories.includes(transfer.toTerritoryId))) return res.status(403).json({ error: 'An offline visit references an agent outside your assigned district.' });
      const tcLatitude = item.tcLatitude; const tcLongitude = item.tcLongitude; const accuracy = item.gpsAccuracyMeters;
      const hasGps = validCoordinates(tcLatitude, tcLongitude, accuracy);
      if (!hasGps) return res.status(400).json({ error: 'An offline visit needs a fresh GPS reading.' });
      if (accuracy > 50) return res.status(422).json({ error: 'GPS accuracy must be 50 metres or better before an offline visit can sync.' });
      const needsLocationCapture = Boolean(agent.registeredLatitude == null || agent.registeredLongitude == null || !agent.locationVerified || (!agent.firstVisitCompletedAt && !agent.firstVisitLocationCapturedAt));
      let registeredLatitude = agent.registeredLatitude;
      let registeredLongitude = agent.registeredLongitude;
      let registeredAccuracy = agent.gpsAccuracy;
      let territoryId = agent.territoryId;
      let sectorId = agent.sectorId;
      let cellId = agent.cellId;
      let villageId = agent.villageId;
      let venue = String(agent.venue || '').trim();
      if (needsLocationCapture) {
        const captured = item.agentLocation;
        if (!captured || typeof captured.latitude !== 'number' || typeof captured.longitude !== 'number' || typeof captured.accuracy !== 'number' || !Number.isFinite(captured.latitude) || !Number.isFinite(captured.longitude) || !Number.isFinite(captured.accuracy) || captured.latitude < -90 || captured.latitude > 90 || captured.longitude < -180 || captured.longitude > 180 || captured.accuracy < 0 || captured.accuracy > 20) {
          return res.status(400).json({ error: 'Capture the agent’s cell, village and GPS location with accuracy of 20 metres or better before syncing the first visit.' });
        }
        venue = String(captured.venue || '').trim();
        if (!venue) return res.status(400).json({ error: 'The offline first-visit record needs the agent’s venue.' });
        if (venue.length > 200) return res.status(400).json({ error: 'Venue must be 200 characters or fewer.' });
        territoryId = String(captured.territoryId || agent.territoryId);
        sectorId = String(captured.sectorId || '');
        cellId = String(captured.cellId || '');
        villageId = String(captured.villageId || '');
        if (!transfer?.acceptedAt && territoryId !== agent.territoryId) return res.status(409).json({ error: 'The offline location uses a different district. Refresh the agent package after the approved relocation.' });
        if (!cellId || !villageId) return res.status(409).json({ error: 'Refresh your offline territory list and select an official cell and village before syncing this first visit.' });
        const [district, sector] = await Promise.all([
          prisma.territory.findUnique({ where: { id: territoryId }, select: { type: true, isActive: true } }),
          prisma.territory.findUnique({ where: { id: sectorId }, select: { type: true, parentId: true, isActive: true } }),
        ]);
        if (!district || district.type !== 'DISTRICT' || !district.isActive || !sector || sector.type !== 'SECTOR' || !sector.isActive || sector.parentId !== territoryId) {
          return res.status(400).json({ error: 'The offline first-visit district, sector, cell and village do not form a valid territory path.' });
        }
        const cell = await prisma.territory.findUnique({ where: { id: cellId }, select: { type: true, parentId: true, isActive: true } });
        if (!cell || cell.type !== 'CELL' || !cell.isActive || cell.parentId !== sectorId) return res.status(400).json({ error: 'Choose an official cell inside the selected sector.' });
        if (villageId && !cellId) return res.status(400).json({ error: 'Choose a cell before selecting a saved village.' });
        const village = await prisma.territory.findUnique({ where: { id: villageId }, select: { type: true, parentId: true, isActive: true } });
        if (!village || village.type !== 'VILLAGE' || !village.isActive || village.parentId !== cellId) return res.status(400).json({ error: 'Choose an official village inside the selected cell.' });
        if (!assignedTerritories.includes(territoryId) && (!transfer || transfer.toTerritoryId !== territoryId)) return res.status(403).json({ error: 'An offline location change must use your assigned territory or a transfer routed to your account.' });
        if (calculateDistance(tcLatitude, tcLongitude, captured.latitude, captured.longitude) > radiusMeters) return res.status(403).json({ error: `The first check-in must be within the configured ${radiusMeters} metre radius of the captured agent location.` });
        registeredLatitude = captured.latitude;
        registeredLongitude = captured.longitude;
        registeredAccuracy = captured.accuracy;
      } else if (!agent.firstVisitCompletedAt && !venue) {
        const captured = item.agentLocation;
        venue = String(captured?.venue || '').trim();
        if (!venue) return res.status(400).json({ error: 'The offline first-visit record needs the agent’s venue.' });
        if (venue.length > 200) return res.status(400).json({ error: 'Venue must be 200 characters or fewer.' });
        if (captured?.latitude !== agent.registeredLatitude || captured?.longitude !== agent.registeredLongitude) return res.status(400).json({ error: 'The offline venue update must use the agent’s saved first-visit location.' });
      }
      const sector = sectorId ? await prisma.territory.findUnique({ where: { id: sectorId }, select: { type: true, parentId: true, isActive: true } }) : null;
      if (!sector || sector.type !== 'SECTOR' || sector.parentId !== territoryId || (!agent.firstVisitCompletedAt && !sector.isActive)) return res.status(400).json({ error: 'The agent must have a valid active sector before their first visit.' });
      if (!needsLocationCapture && (!agent.firstVisitCompletedAt || cellId || villageId)) {
        const [cell, village] = await Promise.all([
          cellId ? prisma.territory.findUnique({ where: { id: cellId }, select: { type: true, parentId: true, isActive: true } }) : null,
          villageId ? prisma.territory.findUnique({ where: { id: villageId }, select: { type: true, parentId: true, isActive: true } }) : null,
        ]);
        if (!cell || cell.type !== 'CELL' || !cell.isActive || cell.parentId !== sectorId || !village || village.type !== 'VILLAGE' || !village.isActive || village.parentId !== cellId) return res.status(400).json({ error: 'The agent must have a valid active cell and village for their first visit.' });
      }
      if (!agent.firstVisitCompletedAt && !needsLocationCapture && !agent.firstVisitLocationCapturedAt) return res.status(400).json({ error: 'The first-visit GPS capture is missing. Refresh the agent record before syncing.' });
      const distanceMeters = hasGps ? calculateDistance(tcLatitude, tcLongitude, registeredLatitude, registeredLongitude) : null;
      if (distanceMeters == null || distanceMeters > radiusMeters) return res.status(403).json({ error: `You are ${Math.round(distanceMeters || 0)} metres from the agent’s saved location. Sync is allowed only within the configured ${radiusMeters} metre radius.` });
      const visitDate = new Date(item.visitDate || item.checkInTime || Date.now());
      const checkInTime = new Date(item.checkInTime || item.visitDate || Date.now());
      if (Number.isNaN(visitDate.getTime()) || Number.isNaN(checkInTime.getTime())) return res.status(400).json({ error: 'An offline visit has an invalid visit time.' });
      const existingVisit = await prisma.visit.findUnique({ where: { visitId: item.visitId }, select: { id: true, tcId: true, agentId: true, countsForMetrics: true } });
      if (existingVisit && (existingVisit.tcId !== req.user.id || existingVisit.agentId !== agent.id)) return res.status(409).json({ error: 'This client visit ID already belongs to another visit.' });
      validated.push({ item, agent, territoryId, sectorId, cellId, villageId, venue, transfer, tcLatitude, tcLongitude, accuracy, hasGps, distanceMeters, registeredLatitude, registeredLongitude, registeredAccuracy, needsLocationCapture, existingVisit, visitDate, checkInTime });
    }
    const syncedVisits = await prisma.$transaction(async (tx) => {
      const results = [];
      for (const record of validated) {
        const { item, agent, territoryId, sectorId, transfer, tcLatitude, tcLongitude, accuracy, hasGps, distanceMeters, registeredLatitude, registeredLongitude, registeredAccuracy, venue, needsLocationCapture, visitDate, checkInTime } = record;
        let { cellId, villageId } = record;
        let existing = await tx.visit.findUnique({ where: { visitId: item.visitId }, select: { id: true, visitId: true, tcId: true, agentId: true, countsForMetrics: true } });
        if (existing) {
          if (existing.tcId !== req.user.id || existing.agentId !== agent.id) throw new Error('This client visit ID already belongs to another visit.');
          results.push({ clientVisitId: item.visitId, id: existing.id, visitId: existing.visitId, countsForMetrics: existing.countsForMetrics, created: false });
          continue;
        }
        await advisoryTransactionLock(tx, agent.id, 'AGENT_MOVE');
        const currentAgent = await tx.agent.findUnique({ where: { id: agent.id }, select: { territoryId: true, registeredLatitude: true, registeredLongitude: true, locationVerified: true } });
        if (!currentAgent || currentAgent.territoryId !== agent.territoryId || currentAgent.registeredLatitude !== agent.registeredLatitude || currentAgent.registeredLongitude !== agent.registeredLongitude || currentAgent.locationVerified !== agent.locationVerified) throw new Error('The agent location changed before the offline visit synced. Refresh the agent package and retry.');
        if (!needsLocationCapture && calculateDistance(tcLatitude, tcLongitude, currentAgent.registeredLatitude, currentAgent.registeredLongitude) > radiusMeters) throw conflict(`You are outside the configured ${radiusMeters} metre radius around the agent’s saved location.`);
        await advisoryTransactionLock(tx, agent.id, 'AGENT_METRIC_WINDOW');
        if (needsLocationCapture) {
          if (!cellId || !villageId) throw conflict('Refresh your offline territory list and select an official cell and village before syncing this first visit.');
          const [district, sector, cell, village] = await Promise.all([
            tx.territory.findUnique({ where: { id: territoryId }, select: { type: true, isActive: true } }),
            tx.territory.findUnique({ where: { id: sectorId }, select: { type: true, parentId: true, isActive: true } }),
            tx.territory.findUnique({ where: { id: cellId }, select: { type: true, parentId: true, isActive: true } }),
            tx.territory.findUnique({ where: { id: villageId }, select: { type: true, parentId: true, isActive: true } }),
          ]);
          if (!district || district.type !== 'DISTRICT' || !district.isActive || !sector || sector.type !== 'SECTOR' || !sector.isActive || sector.parentId !== territoryId || !cell || cell.type !== 'CELL' || !cell.isActive || cell.parentId !== sectorId || !village || village.type !== 'VILLAGE' || !village.isActive || village.parentId !== cellId) {
            throw new Error('The offline first-visit district, sector, cell and village do not form a valid territory path.');
          }
          const claimed = await tx.agent.updateMany({
            where: agent.firstVisitCompletedAt || agent.firstVisitLocationCapturedAt
              ? { id: agent.id, territoryId: agent.territoryId, registeredLatitude: agent.registeredLatitude, registeredLongitude: agent.registeredLongitude, locationVerified: agent.locationVerified }
              : { id: agent.id, firstVisitCompletedAt: null, firstVisitLocationCapturedAt: null },
            data: { territoryId, sectorId, cellId, villageId, venue, registeredLatitude, registeredLongitude, gpsAccuracy: registeredAccuracy, locationVerified: true, firstVisitLocationCapturedAt: agent.firstVisitLocationCapturedAt || checkInTime },
          });
          if (!claimed.count) {
            const current = await tx.agent.findUnique({ where: { id: agent.id }, select: { territoryId: true, sectorId: true, cellId: true, villageId: true, registeredLatitude: true, registeredLongitude: true, locationVerified: true, firstVisitCompletedAt: true, firstVisitLocationCapturedAt: true } });
            if (current?.territoryId !== territoryId || current?.sectorId !== sectorId || current?.cellId !== cellId || current?.villageId !== villageId || !current?.locationVerified || current.registeredLatitude !== registeredLatitude || current.registeredLongitude !== registeredLongitude) throw new Error('Another coordinator recorded this agent’s location. Refresh the agent record before syncing.');
          } else {
            await tx.agentLocation.create({ data: {
              agentId: agent.id,
              latitude: registeredLatitude,
              longitude: registeredLongitude,
              accuracy: registeredAccuracy,
              recordedById: req.user.id,
              reason: transfer?.acceptedAt ? 'OFFLINE_TRANSFER_LOCATION_CAPTURE' : agent.firstVisitCompletedAt || agent.firstVisitLocationCapturedAt ? 'OFFLINE_RELOCATION_LOCATION_CAPTURE' : 'OFFLINE_FIRST_VISIT_CAPTURE',
            } });
            if (transfer?.acceptedAt) await tx.agentTransfer.update({ where: { id: transfer.id }, data: { status: 'COMPLETED', completedAt: checkInTime } });
          }
        } else if (!agent.firstVisitCompletedAt && venue !== agent.venue) {
          await tx.agent.updateMany({ where: { id: agent.id, firstVisitCompletedAt: null }, data: { venue } });
        }
        const visit = await tx.visit.create({
          data: {
            visitId: item.visitId,
            agentId: agent.id,
            tcId: req.user.id,
            territoryId,
            visitDate,
            checkInTime,
            checkOutTime: null,
            agentLatitude: registeredLatitude,
            agentLongitude: registeredLongitude,
            tcLatitude: hasGps ? tcLatitude : null,
            tcLongitude: hasGps ? tcLongitude : null,
            distanceMeters,
            locationStatus: 'VERIFIED',
            locationMethod: 'GPS',
            gpsAccuracyMeters: hasGps ? accuracy : null,
            // Reports and photo evidence sync after check-in using their existing authenticated endpoints.
            visitStatus: 'STARTED',
            countsForMetrics: false,
            isOffline: true,
            syncStatus: 'SYNCED',
          },
        });
        const firstVisit = !agent.firstVisitCompletedAt;
        if (firstVisit) await tx.agent.updateMany({ where: { id: agent.id, firstVisitCompletedAt: null }, data: { firstVisitCompletedAt: checkInTime } });
        if (firstVisit && transfer && !transfer.acceptedAt) await tx.agentTransfer.update({ where: { id: transfer.id }, data: { status: 'COMPLETED', completedAt: checkInTime } });
        results.push({ clientVisitId: item.visitId, id: visit.id, visitId: visit.visitId, agentId: agent.id, agentName: agent.name, agentCode: agent.agentId, territoryId, sectorId, cellId, villageId, firstVisit: !agent.firstVisitCompletedAt, transferId: transfer?.id || null, transferLocationCaptured: Boolean(transfer?.acceptedAt && needsLocationCapture), countsForMetrics: visit.countsForMetrics, created: true });
      }
      return results;
    }, { maxWait: 10000, timeout: 30000 });
    await Promise.all(syncedVisits.filter((visit) => visit.created).map((visit) => logAction(req.user.id, 'SYNC_OFFLINE_VISIT', 'Visit', visit.id, { visitId: visit.visitId }, req)));
    await Promise.all(syncedVisits.filter((visit) => visit.created && (visit.firstVisit || visit.transferLocationCaptured)).map((visit) => logAction(req.user.id, visit.transferId ? 'COMPLETE_AGENT_TRANSFER' : 'COMPLETE_AGENT_FIRST_VISIT', 'Agent', visit.agentId, {
      agentName: visit.agentName, agentCode: visit.agentCode, territoryId: visit.territoryId, sectorId: visit.sectorId,
      cellId: visit.cellId, villageId: visit.villageId, transferId: visit.transferId,
    }, req)));
    res.json({ syncedCount: syncedVisits.length, syncedVisits, needsCompletion: syncedVisits.length > 0 });
  } catch (error) {
    console.error('Visit sync error:', error);
    res.status(error.statusCode || (error.message?.includes('client visit ID') || error.message?.includes('registered this agent') ? 409 : 500)).json({ error: error.message || 'Could not synchronize offline visits.' });
  }
});

module.exports = router;
