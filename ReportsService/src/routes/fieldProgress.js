const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken, requireRole } = require('../middleware/auth');

const COMPLETED_STATUSES = ['COMPLETED', 'FLAGGED'];
const FIELD_ACTIONS = [
  'CAPTURE_FIRST_VISIT_LOCATION', 'CAPTURE_AGENT_LOCATION', 'COMPLETE_AGENT_FIRST_VISIT',
  'COMPLETE_AGENT_TRANSFER_LOCATION', 'COMPLETE_AGENT_TRANSFER', 'REQUEST_AGENT_TRANSFER',
];
const TYPE_FIELD = { DISTRICT: 'territoryId', SECTOR: 'sectorId', CELL: 'cellId', VILLAGE: 'villageId' };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function kigaliDateKey(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Kigali', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${values.year}-${values.month}-${values.day}`;
}

function monthValue(date = new Date()) { return kigaliDateKey(date).slice(0, 7); }

function isValidDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function monthWindow(value) {
  const month = value || monthValue();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return { error: 'Choose a valid month.' };
  const today = kigaliDateKey();
  if (`${month}-01` > today) return { error: 'Choose the current month or an earlier month.' };
  const startUtc = new Date(`${month}-01T00:00:00.000Z`);
  const nextStartUtc = new Date(Date.UTC(startUtc.getUTCFullYear(), startUtc.getUTCMonth() + 1, 1));
  const daysInMonth = new Date(Date.UTC(startUtc.getUTCFullYear(), startUtc.getUTCMonth() + 1, 0)).getUTCDate();
  const daysElapsed = month === today.slice(0, 7) ? Number(today.slice(8, 10)) : daysInMonth;
  const nextMonth = `${nextStartUtc.getUTCFullYear()}-${String(nextStartUtc.getUTCMonth() + 1).padStart(2, '0')}`;
  return {
    month,
    rangeKey: `${month}-01:${nextMonth}-01`,
    fromDate: `${month}-01`,
    toDate: `${nextMonth}-01`,
    today,
    daysInMonth,
    daysElapsed,
    daysRemaining: Math.max(0, daysInMonth - daysElapsed),
    start: new Date(`${month}-01T00:00:00.000+02:00`),
    end: new Date(`${nextMonth}-01T00:00:00.000+02:00`),
  };
}

function dateWindow(fromValue, toValue) {
  const today = kigaliDateKey();
  const toDate = toValue || today;
  const fromDate = fromValue || `${toDate.slice(0, 7)}-01`;
  if (!isValidDateKey(fromDate) || !isValidDateKey(toDate) || fromDate > toDate || toDate > today) {
    return { error: 'Choose a valid date range ending today or earlier.' };
  }
  const length = Math.floor((new Date(`${toDate}T00:00:00Z`) - new Date(`${fromDate}T00:00:00Z`)) / 86400000) + 1;
  if (length > 366) return { error: 'Choose a date range of 366 days or less.' };
  const endExclusive = addCalendarDays(toDate, 1);
  return {
    fromDate, toDate, rangeKey: `${fromDate}:${toDate}`, month: `${fromDate}:${toDate}`,
    today, daysInMonth: length, daysElapsed: length, daysRemaining: 0,
    start: new Date(`${fromDate}T00:00:00+02:00`), end: new Date(`${endExclusive}T00:00:00+02:00`),
  };
}

function addCalendarDays(dateKey, amount) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function dateKeyAtKigali(value) { return kigaliDateKey(value); }

function monthDays(window) {
  const result = [];
  for (let offset = 0; offset < window.daysElapsed; offset += 1) {
    const date = addCalendarDays(window.fromDate, offset);
    const utcDate = new Date(`${date}T00:00:00.000Z`);
    result.push({ date, day: Number(date.slice(8, 10)), weekday: utcDate.getUTCDay() });
  }
  return result;
}

function addMonthsToDateKey(dateKey, months) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const targetMonthIndex = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(targetMonthIndex / 12);
  const targetMonth = targetMonthIndex % 12 + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  return `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

function quarterFieldDays(today = kigaliDateKey()) {
  const end = addMonthsToDateKey(today, 3);
  let count = 0;
  for (let cursor = new Date(`${today}T00:00:00.000Z`); cursor < new Date(`${end}T00:00:00.000Z`); cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const weekday = cursor.getUTCDay();
    if (weekday >= 1 && weekday <= 5) count += 1;
  }
  return { days: count, end };
}

function minimumDailyTarget(totalAgents, fieldDays) {
  return totalAgents > 0 && fieldDays > 0 ? Math.ceil(totalAgents / fieldDays) : 0;
}

async function accessibleDistricts(user) {
  if (user.role === 'TC') {
    const assignments = await prisma.tcTerritoryAssignment.findMany({
      where: { tcId: user.id, isActive: true, territory: { is: { type: 'DISTRICT', isActive: true } } },
      select: { territory: { select: { id: true, name: true, type: true, parentId: true, isActive: true } } },
    });
    return [...new Map(assignments.map(({ territory }) => [territory.id, territory])).values()];
  }
  return prisma.territory.findMany({
    where: { type: 'DISTRICT', isActive: true },
    select: { id: true, name: true, type: true, parentId: true, isActive: true },
  });
}

async function fetchMonthRecords({ user, window, districts }) {
  const districtIds = districts.map(({ id }) => id);
  if (!districtIds.length) return { agents: [], visits: [], actions: [] };
  const visitWhere = {
    territoryId: { in: districtIds },
    visitDate: { gte: window.start, lt: window.end },
    visitStatus: { in: COMPLETED_STATUSES },
    agent: { is: { status: 'ACTIVE' } },
    ...(user.role === 'TC' ? { tcId: user.id } : { tc: { is: { role: 'TC', isActive: true } } }),
  };
  const actionWhere = {
    action: { in: FIELD_ACTIONS },
    createdAt: { gte: window.start, lt: window.end },
    user: { is: { role: 'TC', isActive: true } },
    ...(user.role === 'TC' ? { userId: user.id } : {}),
  };
  const [agents, visits, actions] = await Promise.all([
    prisma.agent.findMany({
      where: { territoryId: { in: districtIds }, status: 'ACTIVE' },
      select: { id: true, territoryId: true, sectorId: true, cellId: true, villageId: true },
    }),
    prisma.visit.findMany({
      where: visitWhere,
      select: {
        id: true, tcId: true, agentId: true, territoryId: true, visitDate: true,
        checkInTime: true, visitStatus: true, locationStatus: true,
        agent: { select: { id: true, territoryId: true, sectorId: true, cellId: true, villageId: true } },
      },
    }),
    prisma.auditLog.findMany({ where: actionWhere, select: { userId: true, action: true, createdAt: true } }),
  ]);
  const activeAgentIds = new Set(agents.map(({ id }) => id));
  return { agents, visits: visits.filter(({ agentId }) => activeAgentIds.has(agentId)), actions };
}

function makeDayCounts(days, visits, actions, tcId) {
  const dayCounts = new Map(days.map(({ date }) => [date, { date, agents: new Set(), visits: 0, fieldActions: 0 }]));
  for (const visit of visits) {
    if (tcId && visit.tcId !== tcId) continue;
    const date = dateKeyAtKigali(visit.visitDate);
    const row = dayCounts.get(date);
    if (!row) continue;
    row.agents.add(visit.agentId);
    row.visits += 1;
  }
  for (const action of actions) {
    if (tcId && action.userId !== tcId) continue;
    const row = dayCounts.get(dateKeyAtKigali(action.createdAt));
    if (row) row.fieldActions += 1;
  }
  return [...dayCounts.values()].map(({ date, agents, visits: visitCount, fieldActions }) => ({
    date,
    label: Number(date.slice(8, 10)),
    agentsVisited: agents.size,
    visits: visitCount,
    fieldActions,
    weekday: WEEKDAYS[new Date(`${date}T00:00:00.000Z`).getUTCDay()],
  }));
}

function weekdayAverages(daily) {
  return WEEKDAYS.map((day) => {
    const matching = daily.filter((entry) => entry.weekday === day);
    const total = matching.reduce((sum, entry) => sum + entry.agentsVisited, 0);
    return { day, days: matching.length, averageAgents: matching.length ? Number((total / matching.length).toFixed(1)) : 0 };
  });
}

function summarize(agentRows, visitRows, actionRows, window, days, tcId, targetPerFieldDay = 6) {
  const activeIds = new Set(agentRows.map(({ id }) => id));
  const visits = visitRows.filter((visit) => activeIds.has(visit.agentId) && (!tcId || visit.tcId === tcId));
  const visitedIds = new Set(visits.map(({ agentId }) => agentId));
  const actionCount = actionRows.filter((action) => !tcId || action.userId === tcId).length;
  const daily = makeDayCounts(days, visitRows, actionRows, tcId);
  const fieldDays = daily.filter(({ agentsVisited }) => agentsVisited > 0);
  const dailyAgentsTotal = daily.reduce((sum, row) => sum + row.agentsVisited, 0);
  const totalAgents = agentRows.length;
  const remainingAgents = Math.max(0, totalAgents - visitedIds.size);
  const projectedAgents = window.daysElapsed
    ? Math.min(totalAgents, Math.round(visitedIds.size / window.daysElapsed * window.daysInMonth))
    : 0;
  return {
    daysElapsed: window.daysElapsed,
    daysInMonth: window.daysInMonth,
    daysRemaining: window.daysRemaining,
    totalAgents,
    visitedAgents: visitedIds.size,
    remainingAgents,
    coveragePercentage: totalAgents ? Number((visitedIds.size / totalAgents * 100).toFixed(1)) : 0,
    completedVisits: visits.length,
    fieldActions: actionCount,
    fieldDays: fieldDays.length,
    agentsVisitedOnFieldDays: dailyAgentsTotal,
    averageAgentsPerFieldDay: fieldDays.length ? Number((dailyAgentsTotal / fieldDays.length).toFixed(1)) : 0,
    daysMeetingTarget: fieldDays.filter(({ agentsVisited }) => agentsVisited >= targetPerFieldDay).length,
    targetPerFieldDay,
    calendarPacePerDay: window.daysElapsed ? Number((visitedIds.size / window.daysElapsed).toFixed(1)) : 0,
    projectedAgents,
    projectedCoveragePercentage: totalAgents ? Number((projectedAgents / totalAgents * 100).toFixed(1)) : 0,
    neededAgentsPerDay: window.daysRemaining ? Math.ceil(remainingAgents / window.daysRemaining) : remainingAgents,
    ...summarizeTrend(daily),
    daily,
    weekdayAverages: weekdayAverages(daily),
  };
}

function summarizeTrend(daily) {
  const weekdayAveragesList = weekdayAverages(daily);
  const strongestDay = [...weekdayAveragesList].sort((a, b) => b.averageAgents - a.averageAgents)[0];
  const highestActionDay = [...daily].sort((a, b) => b.fieldActions - a.fieldActions)[0];
  return {
    strongestWeekday: strongestDay?.averageAgents > 0 ? strongestDay.day : null,
    peakActionDate: highestActionDay?.fieldActions ? highestActionDay.date : null,
  };
}

function districtMetrics(districts, agents, visits) {
  return districts.map((district) => {
    const areaAgents = agents.filter((agent) => agent.territoryId === district.id);
    const areaIds = new Set(areaAgents.map(({ id }) => id));
    const areaVisits = visits.filter((visit) => visit.territoryId === district.id && areaIds.has(visit.agentId));
    const visited = new Set(areaVisits.map(({ agentId }) => agentId)).size;
    const total = areaAgents.length;
    return {
      territoryId: district.id,
      territoryName: district.name,
      provinceId: district.parentId,
      totalAgents: total,
      visitedAgents: visited,
      remainingAgents: Math.max(0, total - visited),
      visits: areaVisits.length,
      coveragePercentage: total ? Number((visited / total * 100).toFixed(1)) : 0,
    };
  });
}

router.get('/', authenticateToken, requireRole('ADMIN', 'MANAGER', 'TC'), async (req, res) => {
  try {
    const window = dateWindow(String(req.query.fromDate || ''), String(req.query.toDate || ''));
    if (window.error) return res.status(400).json({ error: window.error });
    const districts = await accessibleDistricts(req.user);
    const days = monthDays(window);
    const records = await fetchMonthRecords({ user: req.user, window, districts });
    const quarter = quarterFieldDays();
    const ownTarget = minimumDailyTarget(records.agents.length, quarter.days);
    const ownSummary = {
      ...summarize(records.agents, records.visits, records.actions, window, days, req.user.role === 'TC' ? req.user.id : undefined, ownTarget),
      minimumAgentsPerDay: ownTarget,
      quarterWorkingDays: quarter.days,
      coverageWindowEnd: quarter.end,
    };
    const territoryRows = districtMetrics(districts, records.agents, records.visits);
    const focusAreas = [...territoryRows]
      .filter(({ remainingAgents }) => remainingAgents > 0)
      .sort((a, b) => a.coveragePercentage - b.coveragePercentage || b.remainingAgents - a.remainingAgents)
      .slice(0, 3);

    if (req.user.role === 'TC') {
      return res.json({ month: window.month, rangeKey: window.rangeKey, selectedRange: { fromDate: window.fromDate, toDate: window.toDate }, summary: ownSummary, territories: territoryRows, focusAreas });
    }

    const [tcs, assignments] = await Promise.all([
      prisma.user.findMany({
        where: { role: 'TC', isActive: true },
        select: { id: true, username: true, firstName: true, lastName: true },
      }),
      prisma.tcTerritoryAssignment.findMany({
        where: { isActive: true, territory: { is: { type: 'DISTRICT', isActive: true } }, tc: { is: { role: 'TC', isActive: true } } },
        select: { tcId: true, territoryId: true },
      }),
    ]);
    const assignedByTc = new Map();
    for (const assignment of assignments) {
      if (!assignedByTc.has(assignment.tcId)) assignedByTc.set(assignment.tcId, new Set());
      assignedByTc.get(assignment.tcId).add(assignment.territoryId);
    }
    const rankings = tcs.map((tc) => {
      const assignedDistrictIds = assignedByTc.get(tc.id) || new Set();
      const tcAgents = records.agents.filter((agent) => assignedDistrictIds.has(agent.territoryId));
      const target = minimumDailyTarget(tcAgents.length, quarter.days);
      const stats = summarize(tcAgents, records.visits, records.actions, window, days, tc.id, target);
      return {
        tcId: tc.id,
        name: [tc.firstName, tc.lastName].filter(Boolean).join(' ') || tc.username,
        assignedDistricts: assignedDistrictIds.size,
        totalAgents: stats.totalAgents,
        minimumAgentsPerDay: target,
        quarterWorkingDays: quarter.days,
        visitedAgents: stats.visitedAgents,
        remainingAgents: stats.remainingAgents,
        coveragePercentage: stats.coveragePercentage,
        completedVisits: stats.completedVisits,
        fieldActions: stats.fieldActions,
        fieldDays: stats.fieldDays,
        agentsVisitedOnFieldDays: stats.agentsVisitedOnFieldDays,
        daysMeetingTarget: stats.daysMeetingTarget,
        averageAgentsPerFieldDay: stats.averageAgentsPerFieldDay,
        projectedCoveragePercentage: stats.projectedCoveragePercentage,
        weekdayAverages: stats.weekdayAverages,
      };
    }).sort((a, b) => b.coveragePercentage - a.coveragePercentage || b.visitedAgents - a.visitedAgents || b.assignedDistricts - a.assignedDistricts || b.averageAgentsPerFieldDay - a.averageAgentsPerFieldDay);
    const overallAgents = [...new Map(records.agents.map((agent) => [agent.id, agent])).values()];
    const overallTarget = minimumDailyTarget(overallAgents.length, quarter.days);
    const overall = {
      ...summarize(overallAgents, records.visits, records.actions, window, days, undefined, overallTarget),
      minimumAgentsPerDay: overallTarget,
      quarterWorkingDays: quarter.days,
      coverageWindowEnd: quarter.end,
    };
    const assignedTcs = rankings.filter(({ assignedDistricts }) => assignedDistricts > 0);
    const teamFieldDays = assignedTcs.reduce((sum, tc) => sum + tc.fieldDays, 0);
    const weekdayAverages = WEEKDAYS.map((day, index) => {
      const rows = assignedTcs.map((tc) => tc.weekdayAverages[index]);
      const totalCalendarDays = rows.reduce((sum, row) => sum + row.days, 0);
      const agentDayTotal = rows.reduce((sum, row) => sum + row.averageAgents * row.days, 0);
      return { day, days: totalCalendarDays, averageAgents: totalCalendarDays ? Number((agentDayTotal / totalCalendarDays).toFixed(1)) : 0 };
    });
    const strongestWeekday = [...weekdayAverages].sort((a, b) => b.averageAgents - a.averageAgents)[0];
    overall.fieldDays = teamFieldDays;
    overall.agentsVisitedOnFieldDays = assignedTcs.reduce((sum, tc) => sum + tc.agentsVisitedOnFieldDays, 0);
    overall.averageAgentsPerFieldDay = teamFieldDays
      ? Number((overall.agentsVisitedOnFieldDays / teamFieldDays).toFixed(1))
      : 0;
    overall.daysMeetingTarget = assignedTcs.reduce((sum, tc) => sum + tc.daysMeetingTarget, 0);
    overall.weekdayAverages = weekdayAverages;
    overall.strongestWeekday = strongestWeekday?.averageAgents > 0 ? strongestWeekday.day : null;
    return res.json({ month: window.month, rangeKey: window.rangeKey, selectedRange: { fromDate: window.fromDate, toDate: window.toDate }, summary: overall, territories: territoryRows, focusAreas, rankings });
  } catch (error) {
    console.error('Field progress error:', error);
    return res.status(500).json({ error: 'Could not load field progress.' });
  }
});

function agentMatchesTerritory(agent, territory, districts) {
  if (territory.type === 'PROVINCE') {
    const districtIds = new Set(districts.filter(({ parentId }) => parentId === territory.id).map(({ id }) => id));
    return districtIds.has(agent.territoryId);
  }
  const field = TYPE_FIELD[territory.type];
  return Boolean(field && agent[field] === territory.id);
}

async function territoryIsAuthorized(territoryId, districtIds) {
  let current = await prisma.territory.findUnique({ where: { id: territoryId }, select: { id: true, type: true, parentId: true, name: true, isActive: true } });
  if (!current || !current.isActive) return { allowed: false, path: [] };
  const path = [current];
  while (current && current.type !== 'DISTRICT') {
    if (!current.parentId) break;
    current = await prisma.territory.findUnique({ where: { id: current.parentId }, select: { id: true, type: true, parentId: true, name: true, isActive: true } });
    if (current) path.unshift(current);
  }
  const district = path.find(({ type }) => type === 'DISTRICT');
  const isProvince = path.at(-1)?.type === 'PROVINCE' && path.length === 1;
  const provinceHasAssignedDistrict = isProvince && await prisma.territory.count({
    where: { type: 'DISTRICT', isActive: true, parentId: path[0].id, id: { in: [...districtIds] } },
  }) > 0;
  return { allowed: districtIds.has(district?.id) || provinceHasAssignedDistrict, path };
}

router.get('/explorer', authenticateToken, requireRole('ADMIN', 'MANAGER', 'TC'), async (req, res) => {
  try {
    const window = dateWindow(String(req.query.fromDate || ''), String(req.query.toDate || ''));
    if (window.error) return res.status(400).json({ error: window.error });
    const districts = await accessibleDistricts(req.user);
    const districtIds = new Set(districts.map(({ id }) => id));
    const requestedId = String(req.query.territoryId || '').trim();
    let selected = null;
    let breadcrumbs = [];
    if (requestedId) {
      const access = await territoryIsAuthorized(requestedId, districtIds);
      if (!access.allowed) return res.status(403).json({ error: 'This territory is outside your assigned areas.' });
      selected = access.path.at(-1);
      breadcrumbs = access.path;
    }

    const allowedRoots = selected
      ? []
      : req.user.role === 'TC'
        ? [...new Map(districts.map((district) => [district.parentId, district.parentId])).keys()].filter(Boolean)
        : null;
    let nodes;
    if (!selected) {
      const provinces = await prisma.territory.findMany({ where: { type: 'PROVINCE', isActive: true, ...(allowedRoots ? { id: { in: allowedRoots } } : {}) }, orderBy: { name: 'asc' }, select: { id: true, name: true, type: true, parentId: true } });
      nodes = provinces;
      if (req.user.role === 'TC') {
        const districtRoots = districts.filter(({ parentId }) => !parentId);
        nodes = [...nodes, ...districtRoots];
      }
    } else {
      nodes = await prisma.territory.findMany({ where: { parentId: selected.id, isActive: true }, orderBy: { name: 'asc' }, select: { id: true, name: true, type: true, parentId: true } });
      if (req.user.role === 'TC') nodes = nodes.filter((node) => node.type !== 'DISTRICT' || districtIds.has(node.id));
    }

    const districtIdList = [...districtIds];
    const [agents, visits] = districtIdList.length ? await Promise.all([
      prisma.agent.findMany({
        where: { territoryId: { in: districtIdList }, status: 'ACTIVE' },
        select: { id: true, agentId: true, name: true, businessName: true, venue: true, territoryId: true, sectorId: true, cellId: true, villageId: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
      prisma.visit.findMany({
        where: {
          territoryId: { in: districtIdList }, visitDate: { gte: window.start, lt: window.end },
          visitStatus: { in: COMPLETED_STATUSES }, agent: { is: { status: 'ACTIVE' } },
          ...(req.user.role === 'TC' ? { tcId: req.user.id } : { tc: { is: { role: 'TC', isActive: true } } }),
        },
        select: { agentId: true, territoryId: true, visitDate: true },
      }),
    ]) : [[], []];
    const activeIds = new Set(agents.map(({ id }) => id));
    const scopedVisits = visits.filter(({ agentId }) => activeIds.has(agentId));
    const visitedIds = new Set(scopedVisits.map(({ agentId }) => agentId));
    const visitCountByAgent = new Map();
    const lastVisitByAgent = new Map();
    for (const visit of scopedVisits) {
      visitCountByAgent.set(visit.agentId, (visitCountByAgent.get(visit.agentId) || 0) + 1);
      if (!lastVisitByAgent.has(visit.agentId) || lastVisitByAgent.get(visit.agentId) < visit.visitDate) lastVisitByAgent.set(visit.agentId, visit.visitDate);
    }
    const summarizeNode = (territory) => {
      const matches = agents.filter((agent) => agentMatchesTerritory(agent, territory, districts));
      const nodeVisited = matches.filter(({ id }) => visitedIds.has(id)).length;
      return {
        id: territory.id, name: territory.name, type: territory.type,
        totalAgents: matches.length, visitedAgents: nodeVisited,
        remainingAgents: Math.max(0, matches.length - nodeVisited),
        visits: matches.reduce((sum, { id }) => sum + (visitCountByAgent.get(id) || 0), 0),
        coveragePercentage: matches.length ? Number((nodeVisited / matches.length * 100).toFixed(1)) : 0,
      };
    };
    const summaries = nodes.map((node) => ({ ...summarizeNode(node), childCount: node.type === 'VILLAGE' ? 0 : undefined }));
    const areaSummary = selected ? summarizeNode(selected) : null;
    const directAgents = selected && (nodes.length === 0 || selected.type === 'VILLAGE')
      ? agents.filter((agent) => agentMatchesTerritory(agent, selected, districts)).map((agent) => ({
        id: agent.id, agentId: agent.agentId, name: agent.name, businessName: agent.businessName, venue: agent.venue,
        visitedInRange: visitedIds.has(agent.id), visitCount: visitCountByAgent.get(agent.id) || 0,
        lastVisitAt: lastVisitByAgent.get(agent.id) || null,
      }))
      : [];
    res.json({ month: window.month, rangeKey: window.rangeKey, selectedRange: { fromDate: window.fromDate, toDate: window.toDate }, breadcrumbs, selectedArea: areaSummary, children: summaries, agents: directAgents });
  } catch (error) {
    console.error('Territory explorer error:', error);
    res.status(500).json({ error: 'Could not load territory detail.' });
  }
});

const territoryInclude = {
  parent: {
    include: {
      parent: {
        include: {
          parent: {
            include: { parent: true },
          },
        },
      },
    },
  },
};

router.get('/plans', authenticateToken, requireRole('TC'), async (req, res) => {
  try {
    const month = String(req.query.month || monthValue());
    const window = monthWindow(month);
    if (window.error) return res.status(400).json({ error: window.error });
    const utcStart = new Date(`${month}-01T00:00:00.000Z`);
    const nextStart = new Date(Date.UTC(utcStart.getUTCFullYear(), utcStart.getUTCMonth() + 1, 1));
    const [plans, districts] = await Promise.all([prisma.visitPlan.findMany({
      where: { tcId: req.user.id, planDate: { gte: utcStart, lt: nextStart } },
      include: { territory: { include: territoryInclude } },
      orderBy: [{ planDate: 'asc' }, { createdAt: 'asc' }],
    }), accessibleDistricts(req.user)]);
    const districtIds = districts.map(({ id }) => id);
    const [agents, visits] = districtIds.length ? await Promise.all([
      prisma.agent.findMany({ where: { territoryId: { in: districtIds }, status: 'ACTIVE' }, select: { id: true, territoryId: true, sectorId: true, cellId: true, villageId: true } }),
      prisma.visit.findMany({
        where: {
          tcId: req.user.id, territoryId: { in: districtIds }, visitDate: { gte: window.start, lt: window.end },
          visitStatus: { in: COMPLETED_STATUSES }, agent: { is: { status: 'ACTIVE' } },
        },
        select: { agentId: true, visitDate: true },
      }),
    ]) : [[], []];
    const activeIds = new Set(agents.map(({ id }) => id));
    const trackedVisits = visits.filter(({ agentId }) => activeIds.has(agentId));
    res.json(plans.map((plan) => {
      const areaAgents = new Set(agents.filter((agent) => agentMatchesTerritory(agent, plan.territory, districts)).map(({ id }) => id));
      const planDay = plan.planDate.toISOString().slice(0, 10);
      const actualVisits = trackedVisits.filter((visit) => dateKeyAtKigali(visit.visitDate) === planDay && areaAgents.has(visit.agentId));
      const actualAgentsReached = new Set(actualVisits.map(({ agentId }) => agentId)).size;
      return { ...plan, actualAgentsReached, completedVisits: actualVisits.length, hitTarget: actualAgentsReached >= plan.targetAgents };
    }));
  } catch (error) {
    console.error('Visit plans error:', error);
    res.status(500).json({ error: 'Could not load your field plans.' });
  }
});

router.put('/plans', authenticateToken, requireRole('TC'), async (req, res) => {
  try {
    const planDateValue = String(req.body.planDate || '');
    const territoryId = String(req.body.territoryId || '').trim();
    const targetAgents = Number(req.body.targetAgents);
    const notes = String(req.body.notes || '').trim();
    if (!isValidDateKey(planDateValue)) return res.status(400).json({ error: 'Choose a valid plan date.' });
    if (planDateValue < kigaliDateKey()) return res.status(400).json({ error: 'Field plans must be scheduled for today or a future date.' });
    if (planDateValue.slice(0, 7) !== monthValue()) return res.status(400).json({ error: 'Field plans can only be scheduled within the current month.' });
    if (!territoryId) return res.status(400).json({ error: 'Choose a territory for this plan.' });
    if (!Number.isInteger(targetAgents) || targetAgents < 1 || targetAgents > 500) return res.status(400).json({ error: 'Plan for between 1 and 500 agents.' });
    if (notes.length > 500) return res.status(400).json({ error: 'Notes must be 500 characters or fewer.' });
    const districts = await accessibleDistricts(req.user);
    const access = await territoryIsAuthorized(territoryId, new Set(districts.map(({ id }) => id)));
    if (!access.allowed) return res.status(403).json({ error: 'Choose a territory inside your assigned areas.' });
    const territory = access.path.at(-1);
    const planDate = new Date(`${planDateValue}T00:00:00.000Z`);
    const plan = await prisma.visitPlan.upsert({
      where: { tcId_planDate_territoryId: { tcId: req.user.id, planDate, territoryId } },
      update: { targetAgents, notes: notes || null },
      create: { tcId: req.user.id, planDate, territoryId, targetAgents, notes: notes || null },
      include: { territory: { include: territoryInclude } },
    });
    res.json(plan);
  } catch (error) {
    console.error('Save visit plan error:', error);
    res.status(500).json({ error: 'Could not save this field plan.' });
  }
});

router.delete('/plans/:id', authenticateToken, requireRole('TC'), async (req, res) => {
  try {
    const deleted = await prisma.visitPlan.deleteMany({ where: { id: req.params.id, tcId: req.user.id } });
    if (!deleted.count) return res.status(404).json({ error: 'Field plan not found.' });
    res.status(204).end();
  } catch (error) {
    console.error('Delete visit plan error:', error);
    res.status(500).json({ error: 'Could not remove this field plan.' });
  }
});

module.exports = router;
