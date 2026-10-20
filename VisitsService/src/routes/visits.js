const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { performance } = require('node:perf_hooks');
const { authenticateToken, requireRole, requireTerritoryAccess } = require('../middleware/auth');
const prisma = require('../utils/prisma');
const { logAction } = require('../utils/auditLog');
const { calculateDistance } = require('../utils/gps');
const { cleanTerritoryName, findChildTerritory, findOrCreateChildTerritory } = require('../../../shared/territory-capture');

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
const visitWhereForUser = (user, query = {}) => {
  const where = {};
  if (query.agentId) where.agentId = query.agentId;
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
      { tc: { firstName: { contains: search, mode: 'insensitive' } } },
      { tc: { lastName: { contains: search, mode: 'insensitive' } } },
      { tc: { username: { contains: search, mode: 'insensitive' } } },
    ];
  }
  return where;
};

router.post('/check-in', authenticateToken, requireTerritoryAccess, requireRole('TC'), async (req, res) => {
  try {
    const { agentId, tcLatitude, tcLongitude, gpsAccuracyMeters } = req.body;
    const requestedVisitId = typeof req.body.visitId === 'string' ? req.body.visitId.trim() : '';
    const coordinates = [tcLatitude, tcLongitude, gpsAccuracyMeters];
    if (!agentId || coordinates.some((value) => typeof value !== 'number' || !Number.isFinite(value)) || coordinates[2] < 0) {
      return res.status(400).json({ error: 'A valid agent and GPS reading are required.' });
    }
    if (coordinates[0] < -90 || coordinates[0] > 90 || coordinates[1] < -180 || coordinates[1] > 180) return res.status(400).json({ error: 'The device returned invalid GPS coordinates.' });
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
    const [pendingTransfer, config, existingVisit] = await Promise.all([
      req.user.role === 'TC'
        ? prisma.agentTransfer.findFirst({ where: { agentId: agent.id, recipientTcId: req.user.id, status: 'PENDING', toTerritoryId: agent.territoryId } })
        : null,
      prisma.systemConfig.findUnique({ where: { key: 'GEOFENCE_RADIUS_METERS' } }),
      requestedVisitId
        ? prisma.visit.findUnique({ where: { visitId: requestedVisitId }, include: { agent: true } })
        : null,
    ]);
    const radiusMeters = config ? Number.parseInt(config.value, 10) : 100;
    if (req.user.role === 'TC' && !(req.user.assignedTerritories || []).includes(agent.territoryId) && !pendingTransfer) {
      return res.status(403).json({ error: 'This agent is outside your assigned territory.' });
    }
    if (existingVisit) {
      if (existingVisit.tcId !== req.user.id || existingVisit.agentId !== agent.id) return res.status(409).json({ error: 'This client visit ID already belongs to another visit.' });
      return res.json({ ...existingVisit, radiusMeters });
    }
    const sector = agent.sector;
    if (!sector || sector.type !== 'SECTOR' || sector.parentId !== agent.territoryId || (!agent.firstVisitCompletedAt && !sector.isActive)) return res.status(400).json({ error: 'The agent must be assigned to an active sector in their district before a first visit can start.' });
    if (!agent.firstVisitCompletedAt) {
      const cell = agent.cell;
      const village = agent.village;
      if (!cell || cell.type !== 'CELL' || !cell.isActive || cell.parentId !== agent.sectorId || !village || village.type !== 'VILLAGE' || !village.isActive || village.parentId !== agent.cellId) {
        return res.status(400).json({ error: 'Assign the agent’s sector, cell and village at the first visit before checking in.' });
      }
      if (!agent.firstVisitLocationCapturedAt) return res.status(400).json({ error: 'Capture the agent’s cell, village and precise GPS location at the first visit before checking in.' });
    }
    if (agent.registeredLatitude == null || agent.registeredLongitude == null) return res.status(400).json({ error: 'Capture the agent’s registered GPS location before starting this visit.' });
    if (!agent.locationVerified) return res.status(400).json({ error: 'The agent’s registered location needs official verification before a visit can start.' });

    const [tcLatitudeValue, tcLongitudeValue, accuracy] = coordinates;
    const distanceMeters = calculateDistance(tcLatitudeValue, tcLongitudeValue, agent.registeredLatitude, agent.registeredLongitude);
    if (accuracy > 50) return res.status(400).json({ error: `GPS accuracy is ±${Math.round(accuracy)} m. Improve the signal before checking in (maximum ±50 m).` });
    if (distanceMeters > radiusMeters) return res.status(403).json({ error: `You are ${Math.round(distanceMeters)} m from the agent. Check-in is allowed within ${radiusMeters} m.` });
    const locationStatus = 'VERIFIED';
    const firstVisit = !agent.firstVisitCompletedAt;
    const visit = await prisma.$transaction(async (tx) => {
      const created = await tx.visit.create({
        data: {
          visitId: requestedVisitId || makeVisitId(), agentId: agent.id, tcId: req.user.id, territoryId: agent.territoryId,
          visitDate: new Date(), checkInTime: new Date(), agentLatitude: agent.registeredLatitude,
          agentLongitude: agent.registeredLongitude, tcLatitude: tcLatitudeValue, tcLongitude: tcLongitudeValue,
          distanceMeters, gpsAccuracyMeters: accuracy, locationStatus, visitStatus: 'STARTED', isOffline: false,
        },
        include: { agent: true },
      });
      if (firstVisit) await tx.agent.updateMany({ where: { id: agent.id, firstVisitCompletedAt: null }, data: { firstVisitCompletedAt: created.checkInTime } });
      if (pendingTransfer) await tx.agentTransfer.update({ where: { id: pendingTransfer.id }, data: { status: 'COMPLETED', completedAt: created.checkInTime } });
      return created;
    }, { maxWait: 10000, timeout: 15000 });
    await logAction(req.user.id, 'CREATE_VISIT', 'Visit', visit.id, { visitId: visit.visitId, locationStatus }, req);
    if (firstVisit) await logAction(req.user.id, pendingTransfer ? 'COMPLETE_AGENT_TRANSFER' : 'COMPLETE_AGENT_FIRST_VISIT', 'Agent', agent.id, {
      agentName: agent.name, agentCode: agent.agentId, territoryId: agent.territoryId,
      sectorId: agent.sectorId, cellId: agent.cellId, villageId: agent.villageId, transferId: pendingTransfer?.id || null,
    }, req);
    res.status(201).json({ ...visit, radiusMeters });
  } catch (error) {
    console.error('Check-in error:', error);
    res.status(500).json({ error: 'Could not start the visit.' });
  }
});

router.put('/:id/photo', authenticateToken, requireRole('ADMIN', 'MANAGER', 'TC'), verifyPhotoVisit, parsePhotoUpload, async (req, res) => {
  const databaseStartedAt = performance.now();
  try {
    if (!req.file) return res.status(400).json({ error: 'A visit photo is required.' });
    const photoResult = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${req.visit.id}))::text`;
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
    const fields = {
      operatingStatus: req.body.operatingStatus,
      servicesOffered: req.body.servicesOffered || '', productsOffered: req.body.productsOffered || '',
      generalObservations: req.body.generalObservations || '', liquidityObservations: req.body.liquidityObservations || '',
      customerQualityObservations: req.body.customerQualityObservations || '', challengesFaced: req.body.challengesFaced || '',
      supportNeeds: req.body.supportNeeds || '', trainingNeeds: req.body.trainingNeeds || '',
      followUpActions: req.body.followUpActions || '', additionalRemarks: req.body.additionalRemarks || '',
      checklistData: req.body.checklistData || {},
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
    const updatedVisit = await prisma.visit.update({ where: { id: visit.id }, data: { checkOutTime: new Date(), visitStatus } });
    await logAction(req.user.id, 'COMPLETE_VISIT', 'Visit', visit.id, { visitStatus }, req);
    res.json(updatedVisit);
  } catch (error) {
    console.error('Check-out error:', error);
    res.status(500).json({ error: 'Could not complete the visit.' });
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
      prisma.visit.findMany({ where, skip: (safePage - 1) * limit, take: limit, include: { agent: true, tc: true }, orderBy: [{ visitDate: 'desc' }, { id: 'desc' }] }),
    ]);
    const pages = Math.ceil(total / limit);
    const page = Math.min(safePage, Math.max(pages, 1));
    const data = page === safePage ? firstPage : await prisma.visit.findMany({ where, skip: (page - 1) * limit, take: limit, include: { agent: true, tc: true }, orderBy: [{ visitDate: 'desc' }, { id: 'desc' }] });
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
    if (req.user.role === 'CHAMPION' && visit.agent.championId !== req.user.id) return res.status(403).json({ error: 'Access denied to this visit.' });
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
      if (!assignedTerritories.includes(agent.territoryId) && (!transfer || !assignedTerritories.includes(transfer.toTerritoryId))) return res.status(403).json({ error: 'An offline visit references an agent outside your assigned district.' });
      const tcLatitude = item.tcLatitude; const tcLongitude = item.tcLongitude; const accuracy = item.gpsAccuracyMeters;
      if ([tcLatitude, tcLongitude, accuracy].some((value) => typeof value !== 'number' || !Number.isFinite(value)) || tcLatitude < -90 || tcLatitude > 90 || tcLongitude < -180 || tcLongitude > 180 || accuracy < 0 || accuracy > 50) return res.status(400).json({ error: 'An offline visit needs a valid, accurate GPS reading.' });
      const needsLocationCapture = !agent.firstVisitCompletedAt && !agent.firstVisitLocationCapturedAt;
      let registeredLatitude = agent.registeredLatitude;
      let registeredLongitude = agent.registeredLongitude;
      let registeredAccuracy = agent.gpsAccuracy;
      let territoryId = agent.territoryId;
      let sectorId = agent.sectorId;
      let cellId = agent.cellId;
      let villageId = agent.villageId;
      let cellName = '';
      let villageName = '';
      if (needsLocationCapture) {
        const captured = item.agentLocation;
        if (!captured || typeof captured.latitude !== 'number' || typeof captured.longitude !== 'number' || typeof captured.accuracy !== 'number' || !Number.isFinite(captured.latitude) || !Number.isFinite(captured.longitude) || !Number.isFinite(captured.accuracy) || captured.latitude < -90 || captured.latitude > 90 || captured.longitude < -180 || captured.longitude > 180 || captured.accuracy < 0 || captured.accuracy > 20) {
          return res.status(400).json({ error: 'Capture the agent’s cell, village and GPS location with accuracy of 20 metres or better before syncing the first visit.' });
        }
        territoryId = String(captured.territoryId || agent.territoryId);
        sectorId = String(captured.sectorId || '');
        cellId = String(captured.cellId || '');
        villageId = String(captured.villageId || '');
        cellName = cleanTerritoryName(captured.cellName);
        villageName = cleanTerritoryName(captured.villageName);
        if ((!cellId && !cellName) || (!villageId && !villageName)) return res.status(400).json({ error: 'The offline first-visit location needs both a cell and village name.' });
        if (cellName.length > 100 || villageName.length > 100) return res.status(400).json({ error: 'Cell and village names must be 100 characters or fewer.' });
        const [district, sector] = await Promise.all([
          prisma.territory.findUnique({ where: { id: territoryId }, select: { type: true, isActive: true } }),
          prisma.territory.findUnique({ where: { id: sectorId }, select: { type: true, parentId: true, isActive: true } }),
        ]);
        if (!district || district.type !== 'DISTRICT' || !district.isActive || !sector || sector.type !== 'SECTOR' || !sector.isActive || sector.parentId !== territoryId) {
          return res.status(400).json({ error: 'The offline first-visit district, sector, cell and village do not form a valid territory path.' });
        }
        let cell = cellId ? await prisma.territory.findUnique({ where: { id: cellId }, select: { type: true, parentId: true, isActive: true } }) : await findChildTerritory(prisma, { name: cellName, type: 'CELL', parentId: sectorId });
        if (cellId && (!cell || cell.type !== 'CELL' || !cell.isActive || cell.parentId !== sectorId)) return res.status(400).json({ error: 'The offline cell must belong to the selected sector.' });
        if (!cellId && cell?.isActive) cellId = cell.id;
        if (villageId && !cellId) return res.status(400).json({ error: 'Choose a cell before selecting a saved village.' });
        let village = villageId ? await prisma.territory.findUnique({ where: { id: villageId }, select: { type: true, parentId: true, isActive: true } }) : cellId ? await findChildTerritory(prisma, { name: villageName, type: 'VILLAGE', parentId: cellId }) : null;
        if (villageId && (!village || village.type !== 'VILLAGE' || !village.isActive || village.parentId !== cellId)) return res.status(400).json({ error: 'The offline village must belong to the selected cell.' });
        if (!villageId && village?.isActive) villageId = village.id;
        if (!assignedTerritories.includes(territoryId) && (!transfer || transfer.toTerritoryId !== territoryId)) return res.status(403).json({ error: 'An offline location change must use your assigned territory or a transfer routed to your account.' });
        if (calculateDistance(tcLatitude, tcLongitude, captured.latitude, captured.longitude) > 20) return res.status(400).json({ error: 'The first location capture and visit check-in must be within 20 metres of each other.' });
        registeredLatitude = captured.latitude;
        registeredLongitude = captured.longitude;
        registeredAccuracy = captured.accuracy;
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
      const distanceMeters = calculateDistance(tcLatitude, tcLongitude, registeredLatitude, registeredLongitude);
      if (distanceMeters > radiusMeters) return res.status(403).json({ error: `An offline visit is ${Math.round(distanceMeters)} m from the agent, outside the ${radiusMeters} m check-in radius.` });
      const visitDate = new Date(item.visitDate || item.checkInTime || Date.now());
      const checkInTime = new Date(item.checkInTime || item.visitDate || Date.now());
      if (Number.isNaN(visitDate.getTime()) || Number.isNaN(checkInTime.getTime())) return res.status(400).json({ error: 'An offline visit has an invalid visit time.' });
      const existingVisit = await prisma.visit.findUnique({ where: { visitId: item.visitId }, select: { id: true, tcId: true, agentId: true } });
      if (existingVisit && (existingVisit.tcId !== req.user.id || existingVisit.agentId !== agent.id)) return res.status(409).json({ error: 'This client visit ID already belongs to another visit.' });
      validated.push({ item, agent, territoryId, sectorId, cellId, villageId, cellName, villageName, transfer, tcLatitude, tcLongitude, accuracy, distanceMeters, registeredLatitude, registeredLongitude, registeredAccuracy, needsLocationCapture, existingVisit, visitDate, checkInTime });
    }
    const syncedVisits = await prisma.$transaction(async (tx) => {
      const results = [];
      for (const record of validated) {
        const { item, agent, territoryId, sectorId, transfer, tcLatitude, tcLongitude, accuracy, distanceMeters, registeredLatitude, registeredLongitude, registeredAccuracy, needsLocationCapture, visitDate, checkInTime } = record;
        let { cellId, villageId } = record;
        let existing = await tx.visit.findUnique({ where: { visitId: item.visitId }, select: { id: true, visitId: true, tcId: true, agentId: true } });
        if (existing) {
          if (existing.tcId !== req.user.id || existing.agentId !== agent.id) throw new Error('This client visit ID already belongs to another visit.');
          results.push({ clientVisitId: item.visitId, id: existing.id, visitId: existing.visitId, created: false });
          continue;
        }
        if (needsLocationCapture) {
          if (!cellId) cellId = (await findOrCreateChildTerritory(tx, { name: record.cellName, type: 'CELL', parentId: sectorId })).id;
          if (!villageId) villageId = (await findOrCreateChildTerritory(tx, { name: record.villageName, type: 'VILLAGE', parentId: cellId })).id;
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
            where: { id: agent.id, firstVisitCompletedAt: null, firstVisitLocationCapturedAt: null },
            data: { territoryId, sectorId, cellId, villageId, registeredLatitude, registeredLongitude, gpsAccuracy: registeredAccuracy, locationVerified: true, firstVisitLocationCapturedAt: checkInTime },
          });
          if (!claimed.count) {
            const current = await tx.agent.findUnique({ where: { id: agent.id }, select: { territoryId: true, sectorId: true, cellId: true, villageId: true, registeredLatitude: true, registeredLongitude: true, locationVerified: true, firstVisitCompletedAt: true, firstVisitLocationCapturedAt: true } });
            if (current?.firstVisitCompletedAt || current?.firstVisitLocationCapturedAt || current?.territoryId !== territoryId || current?.sectorId !== sectorId || current?.cellId !== cellId || current?.villageId !== villageId || !current?.locationVerified || current.registeredLatitude !== registeredLatitude || current.registeredLongitude !== registeredLongitude) throw new Error('Another coordinator recorded this agent’s first-visit location. Refresh the agent record before syncing.');
          } else {
            await tx.agentLocation.create({ data: {
              agentId: agent.id,
              latitude: registeredLatitude,
              longitude: registeredLongitude,
              accuracy: registeredAccuracy,
              recordedById: req.user.id,
              reason: transfer ? 'OFFLINE_FIRST_VISIT_TRANSFER' : 'OFFLINE_FIRST_VISIT_CAPTURE',
            } });
          }
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
            tcLatitude,
            tcLongitude,
            distanceMeters,
            locationStatus: 'VERIFIED',
            gpsAccuracyMeters: accuracy,
            // Reports and photo evidence sync after check-in using their existing authenticated endpoints.
            visitStatus: 'STARTED',
            isOffline: true,
            syncStatus: 'SYNCED',
          },
        });
        const firstVisit = !agent.firstVisitCompletedAt;
        if (firstVisit) await tx.agent.updateMany({ where: { id: agent.id, firstVisitCompletedAt: null }, data: { firstVisitCompletedAt: checkInTime } });
        if (firstVisit && transfer) await tx.agentTransfer.update({ where: { id: transfer.id }, data: { status: 'COMPLETED', completedAt: checkInTime } });
        results.push({ clientVisitId: item.visitId, id: visit.id, visitId: visit.visitId, agentId: agent.id, agentName: agent.name, agentCode: agent.agentId, territoryId, sectorId, cellId, villageId, firstVisit: !agent.firstVisitCompletedAt, transferId: transfer?.id || null, created: true });
      }
      return results;
    }, { maxWait: 10000, timeout: 30000 });
    await Promise.all(syncedVisits.filter((visit) => visit.created).map((visit) => logAction(req.user.id, 'SYNC_OFFLINE_VISIT', 'Visit', visit.id, { visitId: visit.visitId }, req)));
    await Promise.all(syncedVisits.filter((visit) => visit.created && visit.firstVisit).map((visit) => logAction(req.user.id, visit.transferId ? 'COMPLETE_AGENT_TRANSFER' : 'COMPLETE_AGENT_FIRST_VISIT', 'Agent', visit.agentId, {
      agentName: visit.agentName, agentCode: visit.agentCode, territoryId: visit.territoryId, sectorId: visit.sectorId,
      cellId: visit.cellId, villageId: visit.villageId, transferId: visit.transferId,
    }, req)));
    res.json({ syncedCount: syncedVisits.length, syncedVisits, needsCompletion: syncedVisits.length > 0 });
  } catch (error) {
    console.error('Visit sync error:', error);
    res.status(error.message?.includes('client visit ID') || error.message?.includes('registered this agent') ? 409 : 500).json({ error: error.message || 'Could not synchronize offline visits.' });
  }
});

module.exports = router;
