const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken, requireRole } = require('../middleware/auth');

async function visitScope(user) {
  if (user.role === 'TC') {
    const assignments = await prisma.tcTerritoryAssignment.findMany({ where: { tcId: user.id, isActive: true }, select: { territoryId: true } });
    return { territoryId: { in: assignments.map(({ territoryId }) => territoryId) } };
  }
  if (user.role === 'CHAMPION') return { agent: { championId: user.id } };
  return {};
}

function dateFilter(fromDate, toDate) {
  if (!fromDate && !toDate) return undefined;
  const filter = {};
  if (fromDate) filter.gte = new Date(`${fromDate}T00:00:00.000+02:00`);
  if (toDate) {
    const exclusiveEnd = new Date(`${toDate}T00:00:00.000+02:00`);
    exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
    filter.lt = exclusiveEnd;
  }
  return filter;
}

function kigaliDateKey(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Kigali', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addCalendarDays(dateKey, amount) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function kigaliDayRange(dateKey) {
  // Rwanda is UTC+02:00 year-round; day filters should follow the users' local calendar day.
  const start = new Date(`${dateKey}T00:00:00.000+02:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { gte: start, lt: end };
}

function validDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function selectedDateWindow(fromValue, toValue, todayKey) {
  const toDate = toValue || todayKey;
  const fromDate = fromValue || `${toDate.slice(0, 7)}-01`;
  if (!validDateKey(fromDate) || !validDateKey(toDate) || fromDate > toDate || toDate > todayKey) {
    return { error: 'Choose a valid date range ending today or earlier.' };
  }
  const days = Math.floor((new Date(`${toDate}T00:00:00Z`) - new Date(`${fromDate}T00:00:00Z`)) / 86400000) + 1;
  if (days > 366) return { error: 'Choose a date range of 366 days or less.' };
  return { fromDate, toDate, range: { ...kigaliDayRange(fromDate), lt: kigaliDayRange(addCalendarDays(toDate, 1)).lt } };
}

function serializableRange(range) {
  return {
    fromDate: range.gte.toISOString(),
    toDate: new Date(range.lt.getTime() - 1).toISOString(),
  };
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

router.get('/dashboard', authenticateToken, requireRole('ADMIN', 'MANAGER', 'TC', 'CHAMPION'), async (req, res) => {
  try {
    const scope = await visitScope(req.user);
    const agentScope = req.user.role === 'TC'
      ? { territoryId: scope.territoryId }
      : req.user.role === 'CHAMPION' ? { championId: req.user.id } : {};
    const todayKey = kigaliDateKey(new Date());
    const selected = selectedDateWindow(String(req.query.fromDate || ''), String(req.query.toDate || ''), todayKey);
    if (selected.error) return res.status(400).json({ error: selected.error });
    const range = selected.range;
    const dateRanges = { selected: serializableRange(range) };
    const [totalActiveAgents, row] = await Promise.all([
      prisma.agent.count({ where: { ...agentScope, status: 'ACTIVE' } }),
      prisma.$queryRaw`
          SELECT
            COUNT(*) AS "totalVisits",
            COUNT(*) FILTER (WHERE v."visitStatus"::text IN ('COMPLETED', 'FLAGGED')) AS "completedVisits",
            COUNT(DISTINCT v."agentId") AS "uniqueAgentsVisited",
            COUNT(*) FILTER (WHERE v."visitStatus"::text IN ('COMPLETED', 'FLAGGED') AND v."locationStatus"::text = 'VERIFIED') AS "verifiedVisits",
            COUNT(*) FILTER (WHERE v."locationStatus"::text IS DISTINCT FROM 'VERIFIED') AS "flaggedVisitsCount",
            AVG(v."distanceMeters") AS "averageDistance"
          FROM "Visit" v
          WHERE v."visitDate" >= ${range.gte} AND v."visitDate" < ${range.lt}
            AND (${req.user.role !== 'TC'} OR v."territoryId" IN (
              SELECT assignment."territoryId"
              FROM "TcTerritoryAssignment" assignment
              WHERE assignment."tcId" = ${req.user.id}::uuid AND assignment."isActive" = TRUE
            ))
            AND (${req.user.role !== 'CHAMPION'} OR EXISTS (
              SELECT 1 FROM "Agent" a
              WHERE a."id" = v."agentId" AND a."championId" = ${req.user.id}::uuid
            ))
        `,
    ]);
    const totalVisits = Number(row.totalVisits);
    const completedVisits = Number(row.completedVisits);
    const uniqueAgentsVisited = Number(row.uniqueAgentsVisited);
    const verifiedVisits = Number(row.verifiedVisits);
    const averageDistance = row.averageDistance == null ? null : Number(row.averageDistance);
    const stats = { selected: {
      totalVisits, completedVisits, totalActiveAgents,
      coverageRate: totalActiveAgents ? `${(uniqueAgentsVisited / totalActiveAgents * 100).toFixed(2)}%` : '0%',
      verifiedVisitRate: completedVisits ? `${(verifiedVisits / completedVisits * 100).toFixed(2)}%` : '0%',
      flaggedVisitsCount: Number(row.flaggedVisitsCount),
      averageDistance: averageDistance == null || !Number.isFinite(averageDistance) ? '0m' : `${averageDistance.toFixed(2)}m`,
    } };
    const fieldActivity = [];
    if (['TC', 'ADMIN'].includes(req.user.role)) {
      const actionNames = [
        'CAPTURE_FIRST_VISIT_LOCATION', 'CAPTURE_AGENT_LOCATION', 'COMPLETE_AGENT_FIRST_VISIT',
        'REQUEST_AGENT_TRANSFER', 'COMPLETE_AGENT_TRANSFER_LOCATION', 'COMPLETE_AGENT_TRANSFER', 'ADMIN_RELOCATE_AGENT',
      ];
      const auditLogs = await prisma.auditLog.findMany({
        where: {
          action: { in: actionNames }, resourceType: 'Agent', createdAt: range,
          ...(req.user.role === 'TC' ? { userId: req.user.id } : { user: { is: { role: 'TC' } } }),
        },
        include: { user: { select: { id: true, firstName: true, lastName: true, username: true, role: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 15,
      });
      const agentIds = [...new Set(auditLogs.map((entry) => entry.resourceId).filter(Boolean))];
      const territoryIds = [...new Set(auditLogs.flatMap((entry) => [entry.details?.territoryId, entry.details?.toTerritoryId, entry.details?.fromTerritoryId]).filter(Boolean))];
      const sectorIds = [...new Set(auditLogs.flatMap((entry) => [entry.details?.sectorId, entry.details?.toSectorId]).filter(Boolean))];
      const cellIds = [...new Set(auditLogs.flatMap((entry) => [entry.details?.cellId, entry.details?.toCellId]).filter(Boolean))];
      const villageIds = [...new Set(auditLogs.flatMap((entry) => [entry.details?.villageId, entry.details?.toVillageId]).filter(Boolean))];
      const [agents, territories, sectors, cells, villages] = await Promise.all([
        agentIds.length ? prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true, agentId: true } }) : [],
        territoryIds.length ? prisma.territory.findMany({ where: { id: { in: territoryIds } }, select: { id: true, name: true } }) : [],
        sectorIds.length ? prisma.territory.findMany({ where: { id: { in: sectorIds } }, select: { id: true, name: true } }) : [],
        cellIds.length ? prisma.territory.findMany({ where: { id: { in: cellIds } }, select: { id: true, name: true } }) : [],
        villageIds.length ? prisma.territory.findMany({ where: { id: { in: villageIds } }, select: { id: true, name: true } }) : [],
      ]);
      const agentById = new Map(agents.map((agent) => [agent.id, agent]));
      const territoryById = new Map(territories.map((territory) => [territory.id, territory.name]));
      const sectorById = new Map(sectors.map((territory) => [territory.id, territory.name]));
      const cellById = new Map(cells.map((territory) => [territory.id, territory.name]));
      const villageById = new Map(villages.map((territory) => [territory.id, territory.name]));
      const actionLabels = {
        CAPTURE_FIRST_VISIT_LOCATION: 'First-visit location recorded',
        CAPTURE_AGENT_LOCATION: 'Agent GPS location recorded',
        COMPLETE_AGENT_FIRST_VISIT: 'First visit completed',
        REQUEST_AGENT_TRANSFER: 'Agent transfer requested',
        COMPLETE_AGENT_TRANSFER_LOCATION: 'Destination location recorded',
        COMPLETE_AGENT_TRANSFER: 'Agent transfer completed',
        ADMIN_RELOCATE_AGENT: 'Administrator relocated agent',
      };
      for (const entry of auditLogs) {
        const details = entry.details || {};
        const agent = agentById.get(entry.resourceId);
        const territoryId = details.toTerritoryId || details.territoryId || details.fromTerritoryId;
        const actorName = [entry.user?.firstName, entry.user?.lastName].filter(Boolean).join(' ') || entry.user?.username || 'Coordinator';
        fieldActivity.push({
          id: entry.id, action: entry.action, label: actionLabels[entry.action] || 'Field update',
          agentName: details.agentName || agent?.name || 'Agent', agentCode: details.agentCode || agent?.agentId || '',
          tcName: actorName, tcRole: entry.user?.role, territoryName: details.toTerritoryName || territoryById.get(territoryId) || 'Territory',
          sectorName: details.sectorName || sectorById.get(details.toSectorId || details.sectorId) || '',
          cellName: details.cellName || cellById.get(details.toCellId || details.cellId) || '',
          villageName: details.villageName || villageById.get(details.toVillageId || details.villageId) || '',
          createdAt: entry.createdAt,
        });
      }
    }

    res.json({ stats, dateRanges, selectedRange: { fromDate: selected.fromDate, toDate: selected.toDate }, fieldActivity });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'Could not load dashboard data.' });
  }
});

router.get('/visits', authenticateToken, requireRole('ADMIN', 'MANAGER', 'TC', 'CHAMPION'), async (req, res) => {
  try {
    const { fromDate, toDate, tcId, territoryId, agentId, status, unverifiedOnly } = req.query;
    const requestedPage = Number.parseInt(req.query.page, 10);
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const safePage = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 100) : 25;
    const baseWhere = { ...await visitScope(req.user) };
    const visitDate = dateFilter(fromDate, toDate);
    if (visitDate) baseWhere.visitDate = visitDate;
    if (tcId && ['ADMIN', 'MANAGER'].includes(req.user.role)) baseWhere.tcId = tcId;
    if (territoryId && ['ADMIN', 'MANAGER'].includes(req.user.role)) baseWhere.territoryId = territoryId;
    if (agentId) baseWhere.agentId = agentId;
    if (status) baseWhere.visitStatus = status.toUpperCase();
    const where = { ...baseWhere };
    if (unverifiedOnly === 'true') where.locationStatus = { not: 'VERIFIED' };
    const total = await prisma.visit.count({ where });
    const pages = Math.ceil(total / limit);
    const page = Math.min(safePage, Math.max(pages, 1));
    const [data, completedCount, verifiedCount, flaggedCount, photoCount] = await Promise.all([
      prisma.visit.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, visitId: true, agentId: true, tcId: true, territoryId: true,
          visitDate: true, checkInTime: true, distanceMeters: true, gpsAccuracyMeters: true,
          locationStatus: true, visitStatus: true,
          agent: { select: { id: true, agentId: true, name: true } },
          tc: { select: { id: true, firstName: true, lastName: true, username: true } },
        },
        orderBy: [{ visitDate: 'desc' }, { id: 'desc' }],
      }),
      prisma.visit.count({ where: { AND: [baseWhere, { visitStatus: { in: ['COMPLETED', 'FLAGGED'] } }] } }),
      prisma.visit.count({ where: { AND: [baseWhere, { visitStatus: { in: ['COMPLETED', 'FLAGGED'] }, locationStatus: 'VERIFIED' }] } }),
      prisma.visit.count({ where: { AND: [baseWhere, { OR: [{ visitStatus: 'FLAGGED' }, { locationStatus: { not: 'VERIFIED' } }] }] } }),
      prisma.visit.count({ where: { AND: [baseWhere, { photos: { some: {} } }] } }),
    ]);
    res.json({
      data,
      meta: { total, page, limit, pages },
      summary: { total: await prisma.visit.count({ where: baseWhere }), completed: completedCount, verified: verifiedCount, flagged: flaggedCount, photoVisits: photoCount },
    });
  } catch (error) {
    console.error('Visits report error:', error);
    res.status(500).json({ error: 'Could not load visit report data.' });
  }
});

router.get('/movements', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  try {
    const todayKey = kigaliDateKey(new Date());
    const selected = selectedDateWindow(String(req.query.fromDate || ''), String(req.query.toDate || ''), todayKey);
    if (selected.error) return res.status(400).json({ error: selected.error });
    const requestedAt = { gte: selected.range.gte, lt: selected.range.lt };
    const transferWhere = { requestedAt };
    const relocationWhere = { requestedAt };
    const auditWhere = { action: 'ADMIN_RELOCATE_AGENT', resourceType: 'Agent', createdAt: requestedAt };
    const [transfers, relocations, transferStatusCounts, acceptedTransfers, relocationStatusCounts, adminRelocationCount, adminMoves] = await Promise.all([
      prisma.agentTransfer.findMany({
        where: transferWhere, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], take: 500,
        include: {
          agent: { select: { id: true, agentId: true, name: true, phoneNumber: true } },
          fromTerritory: { select: { id: true, name: true } }, toTerritory: { select: { id: true, name: true } },
          requestedByTc: { select: { firstName: true, lastName: true, username: true } },
          recipientTc: { select: { firstName: true, lastName: true, username: true } },
        },
      }),
      prisma.agentRelocationRequest.findMany({
        where: relocationWhere, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], take: 500,
        include: {
          agent: { select: { id: true, agentId: true, name: true, phoneNumber: true } },
          fromTerritory: { select: { id: true, name: true } }, toTerritory: { select: { id: true, name: true } },
          requestedByTc: { select: { firstName: true, lastName: true, username: true } },
          reviewedBy: { select: { firstName: true, lastName: true, username: true } },
        },
      }),
      prisma.agentTransfer.groupBy({ by: ['status'], where: transferWhere, _count: { _all: true } }),
      prisma.agentTransfer.count({ where: { ...transferWhere, status: 'PENDING', acceptedAt: { not: null } } }),
      prisma.agentRelocationRequest.groupBy({ by: ['status'], where: relocationWhere, _count: { _all: true } }),
      prisma.auditLog.count({ where: auditWhere }),
      prisma.auditLog.findMany({ where: auditWhere, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 500, include: { user: { select: { firstName: true, lastName: true, username: true } } } }),
    ]);
    const transferCounts = Object.fromEntries(transferStatusCounts.map((row) => [row.status, row._count._all]));
    const relocationCounts = Object.fromEntries(relocationStatusCounts.map((row) => [row.status, row._count._all]));
    const moveAgentIds = [...new Set(adminMoves.map(({ resourceId }) => resourceId).filter(Boolean))];
    const detailTerritoryIds = [...new Set(adminMoves.flatMap(({ details }) => [details?.fromTerritoryId, details?.toTerritoryId, details?.fromSectorId, details?.toSectorId, details?.fromCellId, details?.toCellId, details?.fromVillageId, details?.toVillageId]).filter(Boolean))];
    const [moveAgents, moveTerritories] = await Promise.all([
      moveAgentIds.length ? prisma.agent.findMany({ where: { id: { in: moveAgentIds } }, select: { id: true, agentId: true, name: true, phoneNumber: true } }) : [],
      detailTerritoryIds.length ? prisma.territory.findMany({ where: { id: { in: detailTerritoryIds } }, select: { id: true, name: true } }) : [],
    ]);
    const agentById = new Map(moveAgents.map((agent) => [agent.id, agent]));
    const territoryById = new Map(moveTerritories.map((territory) => [territory.id, territory.name]));
    const personName = (person) => [person?.firstName, person?.lastName].filter(Boolean).join(' ') || person?.username || '—';
    const rows = [
      ...transfers.map((item) => ({
        id: `transfer-${item.id}`, kind: 'TRANSFER', agentName: item.agent.name, agentNumber: item.agent.agentId,
        phoneNumber: item.agent.phoneNumber, from: item.fromTerritory.name, to: item.toTerritory.name,
        requestedBy: personName(item.requestedByTc), reviewedBy: item.acceptedAt ? personName(item.recipientTc) : '—',
        status: item.status === 'COMPLETED' ? 'COMPLETED' : item.acceptedAt ? 'ACCEPTED_GPS_PENDING' : item.status,
        requestedAt: item.requestedAt, reviewedAt: item.acceptedAt || item.reviewedAt, completedAt: item.completedAt, reason: item.reason || '',
      })),
      ...relocations.map((item) => ({
        id: `relocation-${item.id}`, kind: 'RELOCATION', agentName: item.agent.name, agentNumber: item.agent.agentId,
        phoneNumber: item.agent.phoneNumber, from: item.fromTerritory.name, to: item.toTerritory.name,
        requestedBy: personName(item.requestedByTc), reviewedBy: item.reviewedBy ? personName(item.reviewedBy) : '—',
        status: item.status, requestedAt: item.requestedAt, reviewedAt: item.reviewedAt, completedAt: item.reviewedAt, reason: item.reason || '',
      })),
      ...adminMoves.map((entry) => {
        const details = entry.details || {};
        const agent = agentById.get(entry.resourceId) || {};
        const actor = personName(entry.user);
        const path = (prefix) => [details[`${prefix}TerritoryId`], details[`${prefix}SectorId`], details[`${prefix}CellId`], details[`${prefix}VillageId`]].map((id) => territoryById.get(id)).filter(Boolean).join(' · ');
        return {
          id: `admin-${entry.id}`, kind: 'ADMIN_RELOCATION', agentName: details.agentName || agent.name || 'Agent', agentNumber: details.agentCode || agent.agentId || '',
          phoneNumber: agent.phoneNumber || '', from: path('from') || territoryById.get(details.fromTerritoryId) || '—', to: path('to') || territoryById.get(details.toTerritoryId) || '—',
          requestedBy: actor, reviewedBy: actor, status: 'COMPLETED', requestedAt: entry.createdAt, reviewedAt: entry.createdAt, completedAt: entry.createdAt, reason: details.reason || '',
        };
      }),
    ].sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
    const transferTotal = Object.values(transferCounts).reduce((sum, value) => sum + value, 0);
    const transferCompleted = transferCounts.COMPLETED || 0;
    const acceptedTotal = transferCompleted + acceptedTransfers;
    const relocationTotal = Object.values(relocationCounts).reduce((sum, value) => sum + value, 0);
    const reviewedRelocations = (relocationCounts.APPROVED || 0) + (relocationCounts.REJECTED || 0);
    res.json({
      selectedRange: { fromDate: selected.fromDate, toDate: selected.toDate },
      summary: {
        transferRequests: transferTotal, transfersAccepted: acceptedTotal, transfersCompleted: transferCompleted,
        transfersAwaitingReview: Math.max(0, (transferCounts.PENDING || 0) - acceptedTransfers),
        transferAcceptanceRate: transferTotal ? Number((acceptedTotal / transferTotal * 100).toFixed(1)) : 0,
        transferCompletionRate: acceptedTotal ? Number((transferCompleted / acceptedTotal * 100).toFixed(1)) : 0,
        relocationRequests: relocationTotal, relocationsApproved: relocationCounts.APPROVED || 0,
        relocationsRejected: relocationCounts.REJECTED || 0, relocationsAwaitingReview: relocationCounts.PENDING || 0,
        relocationApprovalRate: reviewedRelocations ? Number(((relocationCounts.APPROVED || 0) / reviewedRelocations * 100).toFixed(1)) : 0,
        adminRelocations: adminRelocationCount,
      },
      events: rows.slice(0, 1000), eventLimitReached: rows.length > 1000,
    });
  } catch (error) {
    console.error('Movement report error:', error.code || error.name);
    res.status(500).json({ error: 'Could not load transfer and relocation activity.' });
  }
});

router.get('/coverage', authenticateToken, requireRole('ADMIN', 'MANAGER', 'TC', 'CHAMPION'), async (req, res) => {
  try {
    const { fromDate, toDate, territoryId } = req.query;
    const visitDate = dateFilter(fromDate, toDate);
    let territories;
    if (req.user.role === 'TC') {
      const assignments = await prisma.tcTerritoryAssignment.findMany({ where: { tcId: req.user.id, isActive: true }, select: { territoryId: true } });
      territories = await prisma.territory.findMany({ where: { id: { in: assignments.map(({ territoryId: id }) => id) }, ...(territoryId ? { id: territoryId } : {}) } });
    } else if (req.user.role === 'CHAMPION') {
      const agents = await prisma.agent.findMany({ where: { championId: req.user.id, sectorId: { not: null } }, select: { sectorId: true }, distinct: ['sectorId'] });
      territories = await prisma.territory.findMany({ where: { id: { in: agents.map(({ sectorId }) => sectorId) }, type: 'SECTOR', ...(territoryId ? { id: territoryId } : {}) } });
    } else {
      territories = await prisma.territory.findMany({ where: { type: 'DISTRICT', ...(territoryId ? { id: territoryId } : {}) } });
    }

    const results = [];
    for (const territory of territories) {
      const agentWhere = req.user.role === 'CHAMPION'
        ? { sectorId: territory.id, championId: req.user.id, status: 'ACTIVE' }
        : { territoryId: territory.id, status: 'ACTIVE' };
      const visitWhere = req.user.role === 'CHAMPION'
        ? { agent: { sectorId: territory.id, championId: req.user.id }, ...(visitDate ? { visitDate } : {}) }
        : { territoryId: territory.id, ...(visitDate ? { visitDate } : {}) };
      const totalAgents = await prisma.agent.count({ where: agentWhere });
      const visits = await prisma.visit.findMany({ where: visitWhere, select: { agentId: true } });
      const uniqueAgentsVisited = new Set(visits.map(({ agentId }) => agentId)).size;
      results.push({ territoryId: territory.id, territoryName: territory.name, totalAgents, uniqueAgentsVisited, coveragePercentage: totalAgents ? `${(uniqueAgentsVisited / totalAgents * 100).toFixed(2)}%` : '0%' });
    }
    res.json(results);
  } catch (error) {
    console.error('Coverage report error:', error);
    res.status(500).json({ error: 'Could not load coverage report data.' });
  }
});

router.get('/export', authenticateToken, requireRole('ADMIN', 'MANAGER', 'TC', 'CHAMPION'), async (req, res) => {
  try {
    const where = { ...await visitScope(req.user) };
    const dateRange = dateFilter(req.query.fromDate, req.query.toDate);
    if (dateRange) where.visitDate = dateRange;
    const visits = await prisma.visit.findMany({ where, include: { agent: true, tc: true, territory: true }, orderBy: { visitDate: 'desc' } });
    const rows = [['visitId', 'visitDate', 'tcUsername', 'agentId', 'agentName', 'territoryName', 'locationStatus', 'visitStatus', 'distanceMeters', 'checkInTime', 'checkOutTime']];
    for (const visit of visits) rows.push([
      visit.visitId, visit.visitDate?.toISOString(), visit.tc?.username, visit.agent?.agentId, visit.agent?.name,
      visit.territory?.name, visit.locationStatus, visit.visitStatus, visit.distanceMeters,
      visit.checkInTime?.toISOString(), visit.checkOutTime?.toISOString(),
    ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="ddin_visits_export.csv"');
    res.send(rows.map((row) => row.map(csvCell).join(',')).join('\r\n'));
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: 'Could not export visit data.' });
  }
});

router.get('/audit-logs', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit || '50', 10)));
    const where = {};
    if (req.query.action) where.action = req.query.action;
    if (req.query.userId) where.userId = req.query.userId;
    if (req.query.resourceType) where.resourceType = req.query.resourceType;
    const search = String(req.query.search || '').trim();
    if (search) {
      where.OR = [
        { action: { contains: search, mode: 'insensitive' } },
        { resourceType: { contains: search, mode: 'insensitive' } },
        { resourceId: { contains: search, mode: 'insensitive' } },
        { user: { username: { contains: search, mode: 'insensitive' } } },
      ];
    }
    const range = dateFilter(req.query.fromDate, req.query.toDate);
    if (range) where.createdAt = range;
    const [data, total] = await Promise.all([
      prisma.auditLog.findMany({ where, skip: (page - 1) * limit, take: limit, include: { user: { select: { username: true } } }, orderBy: { createdAt: 'desc' } }),
      prisma.auditLog.count({ where }),
    ]);
    res.json({ data, meta: { total, page, limit, pages: Math.ceil(total / limit) } });
  } catch (error) {
    console.error('Audit logs error:', error);
    res.status(500).json({ error: 'Could not load audit logs.' });
  }
});

module.exports = router;
