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
  if (fromDate) filter.gte = new Date(`${fromDate}T00:00:00.000Z`);
  if (toDate) {
    const exclusiveEnd = new Date(`${toDate}T00:00:00.000Z`);
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
    const utcCalendarToday = new Date(`${todayKey}T00:00:00.000Z`);
    const weekStartKey = addCalendarDays(todayKey, -utcCalendarToday.getUTCDay());
    const monthStartKey = `${todayKey.slice(0, 7)}-01`;
    const timeFilters = {
      today: kigaliDayRange(todayKey),
      yesterday: kigaliDayRange(addCalendarDays(todayKey, -1)),
      thisWeek: { ...kigaliDayRange(weekStartKey), lt: kigaliDayRange(addCalendarDays(todayKey, 1)).lt },
      thisMonth: { ...kigaliDayRange(monthStartKey), lt: kigaliDayRange(addCalendarDays(todayKey, 1)).lt },
    };
    const dateRanges = Object.fromEntries(Object.entries(timeFilters).map(([period, range]) => [period, serializableRange(range)]));
    let selectedDate = null;
    if (req.query.date !== undefined) {
      selectedDate = String(req.query.date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) return res.status(400).json({ error: 'Choose a valid calendar date.' });
      const selectedCalendarDate = new Date(`${selectedDate}T00:00:00.000Z`);
      if (Number.isNaN(selectedCalendarDate.getTime()) || selectedCalendarDate.toISOString().slice(0, 10) !== selectedDate) {
        return res.status(400).json({ error: 'Choose a valid calendar date.' });
      }
      timeFilters.customDate = kigaliDayRange(selectedDate);
      dateRanges.customDate = serializableRange(timeFilters.customDate);
    }
    const totalActiveAgents = await prisma.agent.count({ where: { ...agentScope, status: 'ACTIVE' } });
    const stats = {};

    for (const [period, visitDate] of Object.entries(timeFilters)) {
      const visits = await prisma.visit.findMany({ where: { ...scope, visitDate } });
      const completedVisits = visits.filter(({ visitStatus }) => ['COMPLETED', 'FLAGGED'].includes(visitStatus));
      const uniqueAgentsVisited = new Set(visits.map(({ agentId }) => agentId)).size;
      const verifiedVisits = completedVisits.filter(({ locationStatus }) => locationStatus === 'VERIFIED').length;
      const flaggedVisitsCount = visits.filter(({ locationStatus }) => locationStatus !== 'VERIFIED').length;
      const distances = visits.map(({ distanceMeters }) => distanceMeters).filter(Number.isFinite);
      stats[period] = {
        totalVisits: visits.length,
        completedVisits: completedVisits.length,
        totalActiveAgents,
        coverageRate: totalActiveAgents ? `${(uniqueAgentsVisited / totalActiveAgents * 100).toFixed(2)}%` : '0%',
        verifiedVisitRate: completedVisits.length ? `${(verifiedVisits / completedVisits.length * 100).toFixed(2)}%` : '0%',
        flaggedVisitsCount,
        averageDistance: distances.length ? `${(distances.reduce((sum, distance) => sum + distance, 0) / distances.length).toFixed(2)}m` : '0m',
      };
    }

    const activityPeriod = req.query.period === 'customDate' && timeFilters.customDate
      ? 'customDate'
      : Object.hasOwn(timeFilters, req.query.period) ? req.query.period : 'today';
    const activityRange = timeFilters[activityPeriod];
    const fieldActivity = [];
    if (['TC', 'ADMIN'].includes(req.user.role)) {
      const actionNames = [
        'CAPTURE_FIRST_VISIT_LOCATION', 'CAPTURE_AGENT_LOCATION', 'COMPLETE_AGENT_FIRST_VISIT',
        'REQUEST_AGENT_TRANSFER', 'COMPLETE_AGENT_TRANSFER_LOCATION', 'COMPLETE_AGENT_TRANSFER', 'ADMIN_RELOCATE_AGENT',
      ];
      const auditLogs = await prisma.auditLog.findMany({
        where: {
          action: { in: actionNames }, resourceType: 'Agent', createdAt: activityRange,
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

    res.json({ stats, dateRanges, selectedDate, fieldActivity, activityPeriod });
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
      prisma.visit.findMany({ where, skip: (page - 1) * limit, take: limit, include: { agent: true, tc: true, report: true, photos: true, territory: true }, orderBy: [{ visitDate: 'desc' }, { id: 'desc' }] }),
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
