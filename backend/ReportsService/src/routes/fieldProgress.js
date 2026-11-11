const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { COMPLETED_VISIT_STATUSES, ACCEPTED_LOCATION_STATUSES, coverageState, latestQualifiedVisits } = require('../../../shared/visit-coverage');
const reportsRouter = require('./reports');

const COMPLETED_STATUSES = COMPLETED_VISIT_STATUSES;
const FIELD_ACTIONS = [
  'CAPTURE_FIRST_VISIT_LOCATION', 'CAPTURE_AGENT_LOCATION', 'COMPLETE_AGENT_FIRST_VISIT',
  'COMPLETE_AGENT_TRANSFER_LOCATION', 'COMPLETE_AGENT_TRANSFER', 'REQUEST_AGENT_TRANSFER',
];
const TYPE_FIELD = { DISTRICT: 'territoryId', SECTOR: 'sectorId', CELL: 'cellId', VILLAGE: 'villageId' };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const normalizeAreaName = (value) => String(value || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');

async function moolaPlanningRoster(user, districts) {
  const [registryAgents, territoryRows] = await Promise.all([
    reportsRouter.getMoolaPlanningAgents(user),
    prisma.territory.findMany({ where: { isActive: true }, select: { id: true, name: true, type: true, parentId: true } }),
  ]);
  const allowedDistrictIds = new Set(districts.map(({ id }) => id));
  const byId = new Map(territoryRows.map((area) => [area.id, area]));
  const childrenByParent = new Map();
  for (const area of territoryRows) {
    const key = `${area.type}:${area.parentId || ''}:${normalizeAreaName(area.name)}`;
    childrenByParent.set(key, area);
  }
  const findChild = (type, parentId, name) => childrenByParent.get(`${type}:${parentId}:${normalizeAreaName(name)}`) || null;
  return registryAgents.map((agent) => {
    const location = agent.fieldLocation || {};
    const district = byId.get(location.territoryId)
      || districts.find((area) => normalizeAreaName(area.name) === normalizeAreaName(agent.district));
    if (!district || district.type !== 'DISTRICT' || !allowedDistrictIds.has(district.id)) return null;
    const sector = byId.get(location.sectorId) || findChild('SECTOR', district.id, location.sector || agent.sector);
    const cell = byId.get(location.cellId) || (sector && findChild('CELL', sector.id, location.cell || agent.cell));
    const village = byId.get(location.villageId) || (cell && findChild('VILLAGE', cell.id, location.village || agent.village));
    return {
      id: String(agent.id), agentId: String(agent.loginName || agent.id), name: agent.name || agent.loginName || 'Moola Plus agent',
      businessName: agent.businessType || agent.agentCategory || '', venue: location.venue || '',
      territoryId: district.id, sectorId: sector?.id || null, cellId: cell?.id || null, villageId: village?.id || null,
    };
  }).filter(Boolean);
}

function phoneIdentity(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('250')) digits = digits.slice(3);
  if (digits.startsWith('0')) digits = digits.slice(1);
  return /^7\d{8}$/.test(digits) ? digits : '';
}

function normalizeIdentityText(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

async function externalPlanningRoster(agents, network, districts, territoryRows) {
  const allowedDistrictIds = new Set(districts.map(({ id }) => id));
  const byId = new Map(territoryRows.map((area) => [area.id, area]));
  const childrenByParent = new Map();
  for (const area of territoryRows) childrenByParent.set(`${area.type}:${area.parentId || ''}:${normalizeAreaName(area.name)}`, area);
  const findChild = (type, parentId, name) => childrenByParent.get(`${type}:${parentId || ''}:${normalizeAreaName(name)}`) || null;
  const provinces = territoryRows.filter((area) => area.type === 'PROVINCE');
  return agents.map((agent) => {
    const location = agent.fieldLocation || {};
    const localDistrict = byId.get(location.territoryId || agent.localTerritoryId);
    const province = provinces.find((area) => normalizeAreaName(area.name) === normalizeAreaName(agent.province));
    const district = localDistrict?.type === 'DISTRICT' ? localDistrict : districts.find((area) =>
      normalizeAreaName(area.name) === normalizeAreaName(agent.district) && (!province || area.parentId === province.id));
    if (!district || !allowedDistrictIds.has(district.id)) return null;
    const sector = byId.get(location.sectorId || agent.localSectorId) || findChild('SECTOR', district.id, location.sector || agent.sector);
    const cell = byId.get(location.cellId || agent.localCellId) || (sector && findChild('CELL', sector.id, location.cell || agent.cell));
    const village = byId.get(location.villageId || agent.localVillageId) || (cell && findChild('VILLAGE', cell.id, location.village || agent.village));
    const externalId = String(network === 'MOOLA_PLUS' ? agent.id : agent.agentId || agent.id || '').trim();
    if (!externalId) return null;
    const localAgentId = network === 'IREMBO' ? agent.localAgentId || null : null;
    const moolaLocation = network === 'MOOLA_PLUS' ? location : {};
    const identityName = normalizeIdentityText(agent.name || agent.loginName || agent.agentId);
    const districtName = district.name;
    const source = {
      network, id: externalId, localAgentId, externalAgentId: network === 'MOOLA_PLUS' ? externalId : null,
      name: agent.name || agent.loginName || agent.agentId || 'Agent', agentId: agent.agentId || agent.loginName || externalId,
      phoneNumber: network === 'MOOLA_PLUS' ? agent.phone : agent.phoneNumber,
      territoryId: district.id, sectorId: sector?.id || null, cellId: cell?.id || null, villageId: village?.id || null,
      territoryName: districtName, sectorName: sector?.name || '', cellName: cell?.name || '', villageName: village?.name || '',
      provinceName: province?.name || '', businessName: agent.businessName || agent.businessType || agent.agentCategory || '',
      venue: location.venue || agent.venue || '', locationVerified: Boolean(moolaLocation.locationVerified || agent.locationVerified),
    };
    source.identityName = identityName;
    source.phoneKey = phoneIdentity(source.phoneNumber);
    source.locationIdentity = [identityName, districtName, source.sectorName, source.cellName, source.villageName].map(normalizeIdentityText).join('|');
    source.locationIdentityComplete = Boolean(identityName && source.sectorName && source.cellName && source.villageName);
    source.locationScore = (source.locationVerified ? 100 : 0) + (localAgentId ? 12 : 0)
      + [source.territoryName, source.sectorName, source.cellName, source.villageName].filter(Boolean).length;
    return source;
  }).filter(Boolean);
}

function combinePlanningRoster(rows) {
  const parents = rows.map((_, index) => index);
  const find = (value) => { if (parents[value] !== value) parents[value] = find(parents[value]); return parents[value]; };
  const join = (left, right) => { const a = find(left); const b = find(right); if (a !== b) parents[b] = a; };
  const seen = new Map();
  rows.forEach((row, index) => {
    const keys = [];
    if (row.phoneKey) keys.push(`phone:${row.phoneKey}`);
    if (row.locationIdentityComplete) keys.push(`location:${row.locationIdentity}`);
    if (row.identityName && row.id) keys.push(`code-name:${normalizeIdentityText(row.id)}|${row.identityName}`);
    for (const key of keys) {
      if (seen.has(key)) join(index, seen.get(key));
      else seen.set(key, index);
    }
  });
  const groups = new Map();
  rows.forEach((row, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(row);
  });
  return [...groups.values()].map((records) => {
    const ordered = [...records].sort((a, b) => b.locationScore - a.locationScore || (a.network === 'MOOLA_PLUS' ? -1 : 1));
    const primary = ordered[0];
    const stableId = records.find(({ phoneKey }) => phoneKey)?.phoneKey
      || records.find(({ locationIdentityComplete }) => locationIdentityComplete)?.locationIdentity
      || `${primary.network}:${primary.id}`;
    return {
      ...primary, id: `person:${stableId}`, network: 'COMBINED', preferredNetwork: primary.network, sourceRecords: records,
      localAgentId: records.find((row) => row.network === 'IREMBO' && row.localAgentId)?.localAgentId || null,
      externalAgentId: records.find((row) => row.network === 'MOOLA_PLUS')?.externalAgentId || null,
      identityName: undefined, phoneKey: undefined, locationIdentity: undefined, locationIdentityComplete: undefined, locationScore: undefined,
    };
  });
}

async function combinedPlanningRoster(user, districts) {
  const [iremboRows, moolaRows, territoryRows] = await Promise.all([
    reportsRouter.getIremboPlanningAgents(user, { includeInactive: true }),
    reportsRouter.getMoolaPlanningAgents(user, { includeInactive: true }),
    prisma.territory.findMany({ where: { isActive: true }, select: { id: true, name: true, type: true, parentId: true } }),
  ]);
  const [irembo, moola] = await Promise.all([
    externalPlanningRoster(iremboRows, 'IREMBO', districts, territoryRows),
    externalPlanningRoster(moolaRows, 'MOOLA_PLUS', districts, territoryRows),
  ]);
  return combinePlanningRoster([...irembo, ...moola]);
}

async function planningRoster(network, user, districts) {
  if (network === 'COMBINED') return combinedPlanningRoster(user, districts);
  if (network === 'MOOLA_PLUS') return moolaPlanningRoster(user, districts);
  return prisma.agent.findMany({ where: { territoryId: { in: districts.map(({ id }) => id) }, status: 'ACTIVE', isOnHold: false }, select: { id: true, agentId: true, name: true, territoryId: true, sectorId: true, cellId: true, villageId: true } });
}

function planningVisitIndex(agents, network) {
  const personByVisitKey = new Map();
  const iremboIds = new Set();
  const moolaIds = new Set();
  if (network === 'COMBINED') {
    for (const person of agents) for (const source of person.sourceRecords || []) {
      const id = source.network === 'MOOLA_PLUS' ? source.externalAgentId : source.localAgentId;
      if (!id) continue;
      personByVisitKey.set(`${source.network}:${id}`, person.id);
      if (source.network === 'MOOLA_PLUS') moolaIds.add(id); else iremboIds.add(id);
    }
  } else {
    for (const agent of agents) {
      const id = String(agent.id);
      personByVisitKey.set(`${network}:${id}`, id);
      if (network === 'MOOLA_PLUS') moolaIds.add(id); else iremboIds.add(id);
    }
  }
  const where = [];
  if (iremboIds.size) where.push({ network: 'IREMBO', agentId: { in: [...iremboIds] } });
  if (moolaIds.size) where.push({ network: 'MOOLA_PLUS', externalAgentId: { in: [...moolaIds] } });
  return { personByVisitKey, where, iremboIds: [...iremboIds], moolaIds: [...moolaIds] };
}

function visitPersonId(visit, index) {
  const recordId = visit.network === 'MOOLA_PLUS' ? visit.externalAgentId : visit.agentId;
  return recordId ? index.personByVisitKey.get(`${visit.network}:${recordId}`) || null : null;
}

async function planningCoverage(agents, network) {
  if (network !== 'COMBINED') {
    const latest = await latestQualifiedVisits(prisma, network, agents.map(({ id }) => String(id)));
    return new Map(agents.map((agent) => [agent.id, coverageState(latest.get(String(agent.id)))]));
  }
  const index = planningVisitIndex(agents, network);
  const [irembo, moola] = await Promise.all([
    latestQualifiedVisits(prisma, 'IREMBO', index.iremboIds),
    latestQualifiedVisits(prisma, 'MOOLA_PLUS', index.moolaIds),
  ]);
  return new Map(agents.map((person) => {
    const states = (person.sourceRecords || []).map((source) => {
      const id = source.network === 'MOOLA_PLUS' ? source.externalAgentId : source.localAgentId;
      return id ? coverageState((source.network === 'MOOLA_PLUS' ? moola : irembo).get(String(id))) : coverageState(null);
    });
    const latestDate = states.map((state) => state.lastQualifiedVisitAt).filter(Boolean).sort().at(-1) || null;
    return [person.id, { visitedInCoverage: states.some((state) => state.visitedInCoverage), lastQualifiedVisitAt: latestDate }];
  }));
}

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

function quarterFieldDays(startDate = kigaliDateKey()) {
  const end = addMonthsToDateKey(startDate, 3);
  let count = 0;
  for (let cursor = new Date(`${startDate}T00:00:00.000Z`); cursor < new Date(`${end}T00:00:00.000Z`); cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const weekday = cursor.getUTCDay();
    if (weekday >= 1 && weekday <= 5) count += 1;
  }
  return { days: count, end };
}

function minimumDailyTarget(totalAgents, fieldDays) {
  return totalAgents > 0 && fieldDays > 0 ? Math.ceil(totalAgents / fieldDays) : 0;
}

function isFieldWeekday(dateKey) {
  const weekday = new Date(`${dateKey}T00:00:00.000Z`).getUTCDay();
  return weekday >= 1 && weekday <= 5;
}

function workingDaysBetween(fromDate, toDate) {
  let count = 0;
  for (let cursor = new Date(`${fromDate}T00:00:00.000Z`); cursor <= new Date(`${toDate}T00:00:00.000Z`); cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const day = cursor.getUTCDay();
    if (day >= 1 && day <= 5) count += 1;
  }
  return count;
}

function addWorkingDays(startDate, count) {
  const cursor = new Date(`${startDate}T00:00:00.000Z`);
  let remaining = Math.max(1, count);
  while (remaining > 1) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (cursor.getUTCDay() >= 1 && cursor.getUTCDay() <= 5) remaining -= 1;
  }
  while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6) cursor.setUTCDate(cursor.getUTCDate() + 1);
  return cursor.toISOString().slice(0, 10);
}

function dayRange(dateKey) {
  const nextDate = addCalendarDays(dateKey, 1);
  return { start: new Date(`${dateKey}T00:00:00+02:00`), end: new Date(`${nextDate}T00:00:00+02:00`) };
}

function previousFieldDay(dateKey) {
  let cursor = addCalendarDays(dateKey, -1);
  while (!isFieldWeekday(cursor)) cursor = addCalendarDays(cursor, -1);
  return cursor;
}

function dateKeysBetween(fromDate, toDate) {
  const keys = [];
  for (let cursor = fromDate; cursor <= toDate; cursor = addCalendarDays(cursor, 1)) keys.push(cursor);
  return keys;
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
  if (!districts.length) return { agents: [], visits: [], actions: [] };
  const agents = await combinedPlanningRoster(user, districts);
  const visitIndex = planningVisitIndex(agents, 'COMBINED');
  const actionWhere = {
    action: { in: FIELD_ACTIONS },
    createdAt: { gte: window.start, lt: window.end },
    user: { is: { role: 'TC', isActive: true } },
    ...(user.role === 'TC' ? { userId: user.id } : {}),
  };
  const [visits, actions] = await Promise.all([
    visitIndex.where.length ? prisma.visit.findMany({
      where: {
        OR: visitIndex.where,
        visitDate: { gte: window.start, lt: window.end },
        countsForMetrics: true,
        visitStatus: { in: COMPLETED_STATUSES },
        locationStatus: { in: ACCEPTED_LOCATION_STATUSES },
        ...(user.role === 'TC' ? { tcId: user.id } : { tc: { is: { role: 'TC', isActive: true } } }),
      },
      select: { id: true, tcId: true, network: true, agentId: true, externalAgentId: true, territoryId: true, visitDate: true, checkInTime: true, visitStatus: true, locationStatus: true },
    }) : [],
    prisma.auditLog.findMany({ where: actionWhere, select: { userId: true, action: true, createdAt: true } }),
  ]);
  const canonicalAgents = new Map(agents.map((agent) => [agent.id, agent]));
  const canonicalVisits = visits.flatMap((visit) => {
    const personId = visitPersonId(visit, visitIndex);
    const person = canonicalAgents.get(personId);
    return person ? [{ ...visit, agentId: person.id, territoryId: person.territoryId }] : [];
  });
  return { agents, visits: canonicalVisits, actions };
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
    const areaVisits = visits.filter((visit) => areaIds.has(visit.agentId));
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
  if (territory.type === 'DISTRICT') return agent.territoryId === territory.id;
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
    const network = String(req.query.network || 'IREMBO').toUpperCase();
    if (!['IREMBO', 'MOOLA_PLUS', 'COMBINED'].includes(network)) return res.status(400).json({ error: 'Choose IREMBO, MOOLA_PLUS, or COMBINED.' });
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
    const agents = districtIdList.length ? await planningRoster(network, req.user, districts) : [];
    const visitIndex = planningVisitIndex(agents, network);
    const visits = visitIndex.where.length ? await prisma.visit.findMany({
      where: {
        OR: visitIndex.where,
        visitDate: { gte: window.start, lt: window.end }, countsForMetrics: true,
        visitStatus: { in: COMPLETED_STATUSES }, locationStatus: { in: ACCEPTED_LOCATION_STATUSES },
        ...(req.user.role === 'TC' ? { tcId: req.user.id } : { tc: { is: { role: 'TC', isActive: true } } }),
      },
      select: { network: true, agentId: true, externalAgentId: true, territoryId: true, visitDate: true },
    }) : [];
    const scopedVisits = visits.map((visit) => ({ ...visit, planningAgentId: visitPersonId(visit, visitIndex) })).filter((visit) => visit.planningAgentId);
    const visitCountByAgent = new Map();
    const lastVisitByAgent = new Map();
    for (const visit of scopedVisits) {
      const id = visit.planningAgentId;
      visitCountByAgent.set(id, (visitCountByAgent.get(id) || 0) + 1);
      if (!lastVisitByAgent.has(id) || lastVisitByAgent.get(id) < visit.visitDate) lastVisitByAgent.set(id, visit.visitDate);
    }
    const visitedAgentIds = new Set(scopedVisits.map((visit) => visit.planningAgentId));
    const summarizeNode = (territory) => {
      const matches = agents.filter((agent) => agentMatchesTerritory(agent, territory, districts));
      const nodeVisited = matches.filter(({ id }) => visitedAgentIds.has(id)).length;
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
        network: agent.network === 'COMBINED' ? (agent.externalAgentId ? 'MOOLA_PLUS' : 'IREMBO') : network,
        externalAgentId: agent.externalAgentId || null, localAgentId: agent.localAgentId || null,
        visitedInRange: visitedAgentIds.has(agent.id), visitCount: visitCountByAgent.get(agent.id) || 0,
        lastVisitAt: lastVisitByAgent.get(agent.id) || null,
      }))
      : [];
    res.json({ network, month: window.month, rangeKey: window.rangeKey, selectedRange: { fromDate: window.fromDate, toDate: window.toDate }, breadcrumbs, selectedArea: areaSummary, children: summaries, agents: directAgents });
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
    const network = String(req.query.network || 'IREMBO').toUpperCase();
    if (!['IREMBO', 'MOOLA_PLUS', 'COMBINED'].includes(network)) return res.status(400).json({ error: 'Choose IREMBO, MOOLA_PLUS, or COMBINED.' });
    const month = String(req.query.month || monthValue());
    const window = monthWindow(month);
    if (window.error) return res.status(400).json({ error: window.error });
    const utcStart = new Date(`${month}-01T00:00:00.000Z`);
    const nextStart = new Date(Date.UTC(utcStart.getUTCFullYear(), utcStart.getUTCMonth() + 1, 1));
    const [plans, districts] = await Promise.all([prisma.visitPlan.findMany({
      where: { tcId: req.user.id, network, planDate: { gte: utcStart, lt: nextStart } },
      include: { territory: { include: territoryInclude } },
      orderBy: [{ planDate: 'asc' }, { createdAt: 'asc' }],
    }), accessibleDistricts(req.user)]);
    const districtIds = districts.map(({ id }) => id);
    if (!plans.length || !districtIds.length) return res.json(plans.map((plan) => ({ ...plan, actualAgentsReached: 0, completedVisits: 0, hitTarget: plan.targetAgents === 0 })));
    const rangeStart = `${month}-01`;
    const endDateKey = plans.map((plan) => plan.endDate.toISOString().slice(0, 10)).sort().at(-1);
    const agents = await planningRoster(network, req.user, districts);
    const visitIndex = planningVisitIndex(agents, network);
    const visits = visitIndex.where.length ? await prisma.visit.findMany({
        where: {
          OR: visitIndex.where, tcId: req.user.id,
          ...(network === 'IREMBO' ? { territoryId: { in: districtIds }, agent: { is: { status: 'ACTIVE', isOnHold: false } } } : {}),
          visitDate: { gte: dayRange(rangeStart).start, lt: dayRange(addCalendarDays(endDateKey, 1)).start },
          countsForMetrics: true, visitStatus: { in: COMPLETED_STATUSES }, locationStatus: { in: ACCEPTED_LOCATION_STATUSES },
        },
        select: { network: true, agentId: true, externalAgentId: true, visitDate: true },
      }) : [];
    const trackedVisits = visits.map((visit) => ({ ...visit, planningAgentId: visitPersonId(visit, visitIndex) })).filter((visit) => visit.planningAgentId);
    res.json(plans.map((plan) => {
      const areaAgents = new Set(agents.filter((agent) => agentMatchesTerritory(agent, plan.territory, districts)).map(({ id }) => id));
      const startKey = plan.planDate.toISOString().slice(0, 10);
      const endKey = plan.endDate.toISOString().slice(0, 10);
      const actualVisits = trackedVisits.filter((visit) => {
        const dateKey = dateKeyAtKigali(visit.visitDate);
        return dateKey >= startKey && dateKey <= endKey && areaAgents.has(visit.planningAgentId);
      });
      const actualAgentsReached = new Set(actualVisits.map((visit) => visit.planningAgentId)).size;
      return { ...plan, actualAgentsReached, completedVisits: actualVisits.length, hitTarget: actualAgentsReached >= plan.targetAgents };
    }));
  } catch (error) {
    console.error('Visit plans error:', error);
    res.status(500).json({ error: 'Could not load your field plans.' });
  }
});

router.get('/plan-preview', authenticateToken, requireRole('TC'), async (req, res) => {
  try {
    const network = String(req.query.network || 'IREMBO').toUpperCase();
    if (!['IREMBO', 'MOOLA_PLUS', 'COMBINED'].includes(network)) return res.status(400).json({ error: 'Choose IREMBO, MOOLA_PLUS, or COMBINED.' });
    const territoryId = String(req.query.territoryId || '').trim();
    const startDate = String(req.query.startDate || '');
    const endDate = String(req.query.endDate || startDate);
    const today = kigaliDateKey();
    if (!territoryId || !isValidDateKey(startDate) || !isValidDateKey(endDate) || startDate < today || endDate < startDate) return res.status(400).json({ error: 'Choose an area and a valid future planning interval.' });
    if (Math.floor((new Date(`${endDate}T00:00:00Z`) - new Date(`${startDate}T00:00:00Z`)) / 86400000) > 365) return res.status(400).json({ error: 'A plan can cover at most 366 calendar days.' });
    const districts = await accessibleDistricts(req.user);
    const access = await territoryIsAuthorized(territoryId, new Set(districts.map(({ id }) => id)));
    if (!access.allowed) return res.status(403).json({ error: 'This area is outside your assigned territories.' });
    const territory = access.path.at(-1);
    const districtIds = districts.map(({ id }) => id);
    const agents = await planningRoster(network, req.user, districts);
    const rosterCount = agents.length;
    const areaAgents = agents.filter((agent) => agentMatchesTerritory(agent, territory, districts));
    const coverage = await planningCoverage(areaAgents, network);
    const uncoveredAgents = areaAgents.filter((agent) => !coverage.get(agent.id)?.visitedInCoverage).length;
    const dailyTarget = minimumDailyTarget(rosterCount, quarterFieldDays(today).days);
    const intervalWorkdays = workingDaysBetween(startDate, endDate);
    const minimumAgents = Math.min(uncoveredAgents, dailyTarget * intervalWorkdays);
    const estimatedWorkingDays = dailyTarget ? Math.ceil(uncoveredAgents / dailyTarget) : 0;
    const intervalTooLong = uncoveredAgents > 0 && intervalWorkdays > estimatedWorkingDays;
    res.json({
      uncoveredAgents, rosterCount, dailyTarget, intervalWorkdays, minimumAgents, estimatedWorkingDays,
      intervalTooLong, intervalTooShort: uncoveredAgents > 0 && intervalWorkdays < estimatedWorkingDays,
      extraWorkingDays: intervalTooLong ? intervalWorkdays - estimatedWorkingDays : 0,
      shortByWorkdays: uncoveredAgents > 0 && intervalWorkdays < estimatedWorkingDays ? estimatedWorkingDays - intervalWorkdays : 0,
      suggestedEndDate: estimatedWorkingDays ? addWorkingDays(startDate, estimatedWorkingDays) : null,
    });
  } catch (error) {
    console.error('Field plan preview error:', error);
    res.status(500).json({ error: 'Could not estimate this field plan.' });
  }
});

router.put('/plans', authenticateToken, requireRole('TC'), async (req, res) => {
  try {
    const network = String(req.body.network || 'IREMBO').toUpperCase();
    if (!['IREMBO', 'MOOLA_PLUS', 'COMBINED'].includes(network)) return res.status(400).json({ error: 'Choose IREMBO, MOOLA_PLUS, or COMBINED.' });
    const startDateValue = String(req.body.startDate || req.body.planDate || '');
    const endDateValue = String(req.body.endDate || startDateValue);
    const periodType = String(req.body.periodType || 'DAY').toUpperCase();
    const territoryId = String(req.body.territoryId || '').trim();
    const targetAgents = Number(req.body.targetAgents);
    const notes = String(req.body.notes || '').trim();
    const today = kigaliDateKey();
    if (!isValidDateKey(startDateValue) || !isValidDateKey(endDateValue) || startDateValue < today || endDateValue < startDateValue) return res.status(400).json({ error: 'Choose a valid future field planning interval.' });
    if (Math.floor((new Date(`${endDateValue}T00:00:00Z`) - new Date(`${startDateValue}T00:00:00Z`)) / 86400000) > 365) return res.status(400).json({ error: 'A field plan can cover at most 366 calendar days.' });
    if (!['DAY', 'WEEK', 'MONTH', 'CUSTOM'].includes(periodType)) return res.status(400).json({ error: 'Choose a day, week, month, or custom planning interval.' });
    if (!territoryId) return res.status(400).json({ error: 'Choose a territory for this plan.' });
    if (!Number.isInteger(targetAgents) || targetAgents < 0 || targetAgents > 100000) return res.status(400).json({ error: 'Plan for between 0 and 100,000 agents.' });
    if (notes.length > 500) return res.status(400).json({ error: 'Notes must be 500 characters or fewer.' });
    const districts = await accessibleDistricts(req.user);
    const districtIds = new Set(districts.map(({ id }) => id));
    const access = await territoryIsAuthorized(territoryId, districtIds);
    if (!access.allowed) return res.status(403).json({ error: 'Choose a territory inside your assigned areas.' });
    const territory = access.path.at(-1);
    const allAgents = await planningRoster(network, req.user, districts);
    const assignedAgents = allAgents.length;
    const areaAgents = allAgents.filter((agent) => agentMatchesTerritory(agent, territory, districts));
    const coverage = await planningCoverage(areaAgents, network);
    const uncoveredCount = areaAgents.filter((agent) => !coverage.get(agent.id)?.visitedInCoverage).length;
    const quarter = quarterFieldDays(today);
    const dailyTarget = minimumDailyTarget(assignedAgents, quarter.days);
    const intervalWorkdays = workingDaysBetween(startDateValue, endDateValue);
    const minimumAgents = Math.min(uncoveredCount, dailyTarget * intervalWorkdays);
    if (targetAgents < minimumAgents) return res.status(400).json({ error: `This plan must include at least ${minimumAgents} agent${minimumAgents === 1 ? '' : 's'} for the selected area and dates.`, minimumAgents, uncoveredAgents: uncoveredCount, estimatedWorkingDays: dailyTarget ? Math.ceil(uncoveredCount / dailyTarget) : 0 });
    if (targetAgents > uncoveredCount) return res.status(400).json({ error: `Only ${uncoveredCount} agents in this area are due for coverage.`, minimumAgents, uncoveredAgents: uncoveredCount });
    const planDate = new Date(`${startDateValue}T00:00:00.000Z`);
    const endDate = new Date(`${endDateValue}T00:00:00.000Z`);
    const estimatedWorkingDays = dailyTarget ? Math.ceil(uncoveredCount / dailyTarget) : 0;
    const plan = await prisma.visitPlan.upsert({
      where: { tcId_network_planDate_territoryId: { tcId: req.user.id, network, planDate, territoryId } },
      update: { endDate, periodType, targetAgents, minimumAgents, estimatedWorkingDays, notes: notes || null },
      create: { tcId: req.user.id, network, planDate, endDate, periodType, territoryId, targetAgents, minimumAgents, estimatedWorkingDays, notes: notes || null },
      include: { territory: { include: territoryInclude } },
    });
    res.json({ ...plan, uncoveredAgents: uncoveredCount, dailyTarget, intervalWorkdays });
  } catch (error) {
    console.error('Save visit plan error:', error);
    res.status(500).json({ error: 'Could not save this field plan.' });
  }
});

router.get('/daily-workload', authenticateToken, requireRole('TC'), async (req, res) => {
  try {
    const today = kigaliDateKey();
    const districts = await accessibleDistricts(req.user);
    const districtIds = districts.map(({ id }) => id);
    if (!districtIds.length) return res.json({ date: today, isWorkday: isFieldWeekday(today), dailyTarget: 0, completedToday: 0, carryOver: 0, requiredToday: 0, dueCount: 0, dueAgents: [], rosterCount: 0, coverageRemaining: 0 });
    const agents = await combinedPlanningRoster(req.user, districts);
    const visitIndex = planningVisitIndex(agents, 'COMBINED');
    const quarterStart = addMonthsToDateKey(today, -3);
    const [coverageByAgent, visits] = await Promise.all([
      planningCoverage(agents, 'COMBINED'),
      visitIndex.where.length ? prisma.visit.findMany({
        where: {
          tcId: req.user.id,
          OR: visitIndex.where,
          visitDate: { gte: dayRange(quarterStart).start, lt: dayRange(today).end },
          countsForMetrics: true,
          visitStatus: { in: COMPLETED_STATUSES },
          locationStatus: { in: ACCEPTED_LOCATION_STATUSES },
        },
        select: { network: true, agentId: true, externalAgentId: true, visitDate: true },
      }) : [],
    ]);
    const agentsByDate = new Map();
    for (const visit of visits) {
      const personId = visitPersonId(visit, visitIndex);
      if (!personId) continue;
      const key = dateKeyAtKigali(visit.visitDate);
      if (!agentsByDate.has(key)) agentsByDate.set(key, new Set());
      agentsByDate.get(key).add(personId);
    }
    const quarterDays = dateKeysBetween(quarterStart, addCalendarDays(today, -1));
    let carryOver = 0;
    for (const dateKey of quarterDays) {
      if (!isFieldWeekday(dateKey)) continue;
      const required = minimumDailyTarget(agents.length, quarterFieldDays(dateKey).days);
      const completed = agentsByDate.get(dateKey)?.size || 0;
      carryOver = Math.max(0, carryOver + required - completed);
    }
    const isWorkday = isFieldWeekday(today);
    const dailyTarget = isWorkday ? minimumDailyTarget(agents.length, quarterFieldDays(today).days) : 0;
    const completedToday = agentsByDate.get(today)?.size || 0;
    const requiredToday = dailyTarget + carryOver;
    const remainingTarget = Math.max(0, requiredToday - completedToday);
    const dueAgents = agents.map((agent) => ({ ...agent, ...(coverageByAgent.get(agent.id) || coverageState(null)) }))
      .filter((agent) => !agent.visitedInCoverage)
      .sort((a, b) => {
        if (!a.lastQualifiedVisitAt && b.lastQualifiedVisitAt) return -1;
        if (a.lastQualifiedVisitAt && !b.lastQualifiedVisitAt) return 1;
        const aDate = a.lastQualifiedVisitAt ? new Date(a.lastQualifiedVisitAt).getTime() : 0;
        const bDate = b.lastQualifiedVisitAt ? new Date(b.lastQualifiedVisitAt).getTime() : 0;
        return aDate - bDate || a.name.localeCompare(b.name);
      }).slice(0, Math.min(remainingTarget, 100));
    const rosterCount = agents.length;
    const dueWithNetworkIds = dueAgents.map((agent) => ({
      ...agent,
      externalAgentId: agent.externalAgentId || null,
      localAgentId: agent.localAgentId || null,
      agentId: agent.agentId || agent.externalAgentId || agent.localAgentId || agent.id,
      preferredNetwork: agent.preferredNetwork || 'IREMBO',
    }));
    res.json({
      date: today, isWorkday, dailyTarget, completedToday, carryOver, requiredToday,
      remainingTarget, dueCount: dueWithNetworkIds.length, dueAgents: dueWithNetworkIds,
      rosterCount, coverageRemaining: agents.filter((agent) => !(coverageByAgent.get(agent.id)?.visitedInCoverage)).length,
      coverageWindowEnd: quarterFieldDays(today).end,
    });
  } catch (error) {
    console.error('Daily field workload error:', error);
    res.status(500).json({ error: 'Could not calculate today’s field workload.' });
  }
});

router.get('/follow-ups', authenticateToken, requireRole('ADMIN', 'MANAGER'), async (_req, res) => {
  try {
    const today = kigaliDateKey();
    const quarterStart = addMonthsToDateKey(today, -3);
    const lastClosedWorkday = previousFieldDay(today);
    const [tcs, assignments, districts] = await Promise.all([
      prisma.user.findMany({ where: { role: 'TC', isActive: true }, select: { id: true, firstName: true, lastName: true, username: true } }),
      prisma.tcTerritoryAssignment.findMany({
        where: { isActive: true, territory: { is: { type: 'DISTRICT', isActive: true } } },
        select: { tcId: true, territoryId: true },
      }),
      accessibleDistricts({ role: 'ADMIN' }),
    ]);
    const agents = await combinedPlanningRoster({ role: 'ADMIN' }, districts);
    const tcById = new Map(tcs.map((tc) => [tc.id, tc]));
    const districtIdsByTc = new Map();
    for (const assignment of assignments) {
      if (!tcById.has(assignment.tcId)) continue;
      if (!districtIdsByTc.has(assignment.tcId)) districtIdsByTc.set(assignment.tcId, new Set());
      districtIdsByTc.get(assignment.tcId).add(assignment.territoryId);
    }
    const agentIdsByTc = new Map();
    for (const tc of tcs) {
      const districtIds = districtIdsByTc.get(tc.id) || new Set();
      agentIdsByTc.set(tc.id, new Set(agents.filter((agent) => districtIds.has(agent.territoryId)).map(({ id }) => id)));
    }
    const tcIds = tcs.map(({ id }) => id);
    const visitIndex = planningVisitIndex(agents, 'COMBINED');
    const [visits, existing] = tcIds.length && visitIndex.where.length ? await Promise.all([
      prisma.visit.findMany({
        where: {
          tcId: { in: tcIds }, OR: visitIndex.where, visitDate: { gte: dayRange(quarterStart).start, lt: dayRange(today).start },
          countsForMetrics: true, visitStatus: { in: COMPLETED_STATUSES }, locationStatus: { in: ACCEPTED_LOCATION_STATUSES },
        },
        select: { tcId: true, network: true, agentId: true, externalAgentId: true, visitDate: true },
      }),
      prisma.fieldWorkdayFollowUp.findMany({ where: { workDate: { gte: new Date(`${quarterStart}T00:00:00.000Z`), lte: new Date(`${lastClosedWorkday}T00:00:00.000Z`) } }, select: { tcId: true, workDate: true } }),
    ]) : [[], []];
    const visitsByTcDate = new Map();
    for (const visit of visits) {
      const personId = visitPersonId(visit, visitIndex);
      if (!personId || !agentIdsByTc.get(visit.tcId)?.has(personId)) continue;
      const key = `${visit.tcId}:${dateKeyAtKigali(visit.visitDate)}`;
      if (!visitsByTcDate.has(key)) visitsByTcDate.set(key, new Set());
      visitsByTcDate.get(key).add(personId);
    }
    const existingKeys = new Set(existing.map((row) => `${row.tcId}:${row.workDate.toISOString().slice(0, 10)}`));
    const missedRows = [];
    for (const tc of tcs) {
      const rosterCount = agentIdsByTc.get(tc.id)?.size || 0;
      if (!rosterCount) continue;
      for (const dateKey of dateKeysBetween(quarterStart, lastClosedWorkday)) {
        if (!isFieldWeekday(dateKey)) continue;
        const key = `${tc.id}:${dateKey}`;
        if (existingKeys.has(key)) continue;
        const requiredAgents = minimumDailyTarget(rosterCount, quarterFieldDays(dateKey).days);
        const completedAgents = visitsByTcDate.get(key)?.size || 0;
        const missedAgents = Math.max(0, requiredAgents - completedAgents);
        if (missedAgents > 0) missedRows.push({ tcId: tc.id, workDate: new Date(`${dateKey}T00:00:00.000Z`), requiredAgents, completedAgents, missedAgents });
      }
    }
    if (missedRows.length) await prisma.fieldWorkdayFollowUp.createMany({ data: missedRows, skipDuplicates: true });
    const followUps = await prisma.fieldWorkdayFollowUp.findMany({
      where: { workDate: { gte: new Date(`${quarterStart}T00:00:00.000Z`), lte: new Date(`${lastClosedWorkday}T00:00:00.000Z`) }, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
      include: { tc: { select: { id: true, firstName: true, lastName: true, username: true } } },
      orderBy: [{ workDate: 'asc' }, { missedAgents: 'desc' }],
    });
    res.json({ data: followUps, total: followUps.length, throughDate: lastClosedWorkday });
  } catch (error) {
    console.error('Field workday follow-up error:', error);
    res.status(500).json({ error: 'Could not load coordinator follow-ups.' });
  }
});

router.put('/follow-ups/:id/review', authenticateToken, requireRole('ADMIN', 'MANAGER'), async (req, res) => {
  try {
    const status = String(req.body.status || '').toUpperCase();
    const reviewNote = String(req.body.reviewNote || '').trim();
    if (!['ACKNOWLEDGED', 'RESOLVED'].includes(status)) return res.status(400).json({ error: 'Choose ACKNOWLEDGED or RESOLVED.' });
    if (reviewNote.length > 500) return res.status(400).json({ error: 'The review note must be 500 characters or fewer.' });
    const updated = await prisma.fieldWorkdayFollowUp.updateMany({
      where: { id: req.params.id, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
      data: { status, reviewNote: reviewNote || null, reviewedById: req.user.id, reviewedAt: new Date() },
    });
    if (!updated.count) return res.status(404).json({ error: 'Open field follow-up not found.' });
    const row = await prisma.fieldWorkdayFollowUp.findUnique({ where: { id: req.params.id }, include: { tc: { select: { id: true, firstName: true, lastName: true, username: true } } } });
    res.json(row);
  } catch (error) {
    console.error('Review field workday follow-up error:', error);
    res.status(500).json({ error: 'Could not save the follow-up review.' });
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
