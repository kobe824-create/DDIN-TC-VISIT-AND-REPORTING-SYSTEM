const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { coverageState, latestQualifiedVisits } = require('../../../shared/visit-coverage');

async function visitScope(user) {
  if (!['ADMIN', 'MANAGER'].includes(user.role)) {
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

const DDIN_REPORTS_BASE_URL = (process.env.DDIN_REPORTS_API_BASE_URL
  || 'https://core-api.ddin.rw/v1/agency/thirdpartyagency/services/reports').replace(/\/$/, '');
const DDIN_AGENT_LIST_URL = process.env.DDIN_AGENT_LIST_API_URL || `${DDIN_REPORTS_BASE_URL}/agents/list`;
const DDIN_DEPOSITS_URL = process.env.DDIN_AGENT_DEPOSITS_API_URL || `${DDIN_REPORTS_BASE_URL}/float/manual-deposit/per-agent`;
const DDIN_BALANCE_URL = process.env.DDIN_FLOAT_BALANCE_API_URL || `${DDIN_REPORTS_BASE_URL}/float/balance`;
const IREMBO_ACTIVITY_FEED_URL = String(process.env.IREMBO_ACTIVITY_FEED_URL || '').trim();
const DDIN_AGENT_LIST_CACHE_MS = Math.max(30000, Number.parseInt(process.env.DDIN_AGENT_LIST_CACHE_MS || '300000', 10));
let ddinDataCache = null;
let ddinDataRequest = null;
let iremboActivityCache = null;
let iremboActivityRequest = null;

const normalizeDistrictName = (value) => String(value || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
const numberOrZero = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};
const ACTIVITY_LEVELS = [
  { name: 'Active', minimum: 80, maximum: null, range: '80+ transactions' },
  { name: 'Transacting', minimum: 30, maximum: 79, range: '30–79 transactions' },
  { name: 'Dormant', minimum: 1, maximum: 29, range: '1–29 transactions' },
  { name: 'Inactive', minimum: 0, maximum: 0, range: '0 transactions' },
];

function pickFeedValue(row, fieldNames) {
  const fields = new Map(Object.entries(row || {}).map(([name, value]) => [name.trim().toLocaleLowerCase().replace(/[ _-]+/g, ''), value]));
  for (const name of fieldNames) {
    const value = fields.get(name.toLocaleLowerCase().replace(/[ _-]+/g, ''));
    if (value != null) return value;
  }
  return null;
}

function classifyTransactionActivity(value) {
  const normalized = String(value ?? '').replaceAll(',', '').trim();
  const count = normalized === '' ? 0 : numberOrZero(normalized);
  if (count >= 80) return 'Active';
  if (count >= 30) return 'Transacting';
  if (count >= 1) return 'Dormant';
  return 'Inactive';
}

function getIremboActivityLevels() { return ACTIVITY_LEVELS.map(({ name, range }) => ({ name, range })); }

function parseIremboFeedRows(payload) {
  if (payload?.success === false) throw new Error('The Irembo activity feed reported an unsuccessful response.');
  if (Array.isArray(payload)) {
    if (payload.length && payload.some((item) => Array.isArray(item?.rows))) {
      return payload.flatMap((item) => Array.isArray(item.rows) ? item.rows : []);
    }
    return payload;
  }
  for (const key of ['rows', 'data', 'records', 'results', 'agents', 'items']) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  if (payload && typeof payload === 'object') return [payload];
  throw new Error('The Irembo activity feed returned an unsupported response.');
}

function normalizeRwandaPhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('250')) digits = digits.slice(3);
  if (digits.startsWith('0')) digits = digits.slice(1);
  return /^7\d{8}$/.test(digits) ? `+250${digits}` : '';
}

function normalizePhoneField(value) {
  const raw = String(value || '').trim();
  const rwandaNumber = normalizeRwandaPhone(raw);
  if (rwandaNumber) return rwandaNumber;
  if (!/^(?:\+|00)/.test(raw)) return '';
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length < 8 || digits.length > 15) return '';
  return `+${digits}`;
}

async function fetchIremboActivityData(forceRefresh = false) {
  if (!IREMBO_ACTIVITY_FEED_URL) throw new Error('IREMBO_ACTIVITY_FEED_URL is not configured.');
  if (!forceRefresh && iremboActivityCache && Date.now() - iremboActivityCache.cachedAt < DDIN_AGENT_LIST_CACHE_MS) {
    return { ...iremboActivityCache, stale: false };
  }
  if (iremboActivityRequest) return iremboActivityRequest;
  iremboActivityRequest = (async () => {
    try {
      const response = await fetch(IREMBO_ACTIVITY_FEED_URL, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error('The Irembo activity feed returned HTTP ' + response.status + '.');
      const rows = parseIremboFeedRows(await response.json());
      const agents = rows.map((row, index) => {
        const rawCount = pickFeedValue(row, ['Total Transactions', 'Transactions', 'Transaction Count', 'Txn Count']);
        const normalized = String(rawCount ?? '').replaceAll(',', '').trim();
        const transactionCount = normalized === '' ? 0 : Math.max(0, Math.trunc(numberOrZero(normalized)));
        const agentId = String(pickFeedValue(row, ['Agent ID', 'Agent Code', 'Agent Number', 'Code', 'ID', 'Username', 'Login Name']) || '').trim();
        const firstName = String(pickFeedValue(row, ['First Name', 'Firstname']) || '').trim();
        const lastName = String(pickFeedValue(row, ['Last Name', 'Lastname', 'Surname']) || '').trim();
        const phoneField = pickFeedValue(row, ['Phone Number', 'Phone', 'Telephone', 'Mobile Number', 'Mobile', 'Contact Number', 'Contact', 'MSISDN']);
        return {
          id: agentId || `irembo-${index}`,
          agentId,
          name: String(pickFeedValue(row, ['Agent Name', 'Full Name', 'Name']) || [firstName, lastName].filter(Boolean).join(' ') || agentId || 'Irembo agent').trim(),
          phoneNumber: normalizePhoneField(phoneField) || normalizeRwandaPhone(agentId),
          province: String(pickFeedValue(row, ['Province']) || '').trim(),
          district: String(pickFeedValue(row, ['District']) || '').trim(),
          sector: String(pickFeedValue(row, ['Sector']) || '').trim(),
          cell: String(pickFeedValue(row, ['Cell']) || '').trim(),
          village: String(pickFeedValue(row, ['Village']) || '').trim(),
          businessName: String(pickFeedValue(row, ['Business Name', 'Business']) || '').trim(),
          registrationDate: pickFeedValue(row, ['Registration Date', 'Registered At', 'Created At']) || null,
          activityDate: pickFeedValue(row, ['Transaction Date', 'Activity Date', 'Last Transaction Date', 'Report Date']) || null,
          franchisee: String(pickFeedValue(row, ['Franchisee', 'Business Category', 'Business Type']) || '').trim(),
          transactionCount,
          activityStatus: classifyTransactionActivity(transactionCount),
        };
      });
      iremboActivityCache = { agents, fetchedAt: new Date().toISOString(), cachedAt: Date.now() };
      return { ...iremboActivityCache, stale: false };
    } catch (error) {
      if (iremboActivityCache) return { ...iremboActivityCache, stale: true };
      throw error;
    } finally {
      iremboActivityRequest = null;
    }
  })();
  return iremboActivityRequest;
}

function getIremboActivitySummary(agents, fetchedAt, stale) {
  const byStatus = Object.fromEntries(ACTIVITY_LEVELS.map(({ name }) => [name, 0]));
  const districts = new Map();
  const franchisees = new Map();
  let totalTransactions = 0;
  for (const agent of agents) {
    byStatus[agent.activityStatus] = (byStatus[agent.activityStatus] || 0) + 1;
    totalTransactions += agent.transactionCount;
    const districtName = agent.district || 'Unknown';
    const district = districts.get(districtName) || { name: districtName, total: 0, totalTransactions: 0 };
    district.total += 1;
    district.totalTransactions += agent.transactionCount;
    district[agent.activityStatus] = (district[agent.activityStatus] || 0) + 1;
    districts.set(districtName, district);
    const franchisee = agent.franchisee || 'Unspecified';
    franchisees.set(franchisee, (franchisees.get(franchisee) || 0) + 1);
  }
  return {
    totalAgents: agents.length,
    totalTransactions,
    averageTransactions: agents.length ? Number((totalTransactions / agents.length).toFixed(1)) : 0,
    byStatus,
    activityLevels: getIremboActivityLevels(),
    byDistrict: [...districts.values()].sort((a, b) => b.total - a.total).slice(0, 10),
    byFranchisee: [...franchisees.entries()].map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total).slice(0, 8),
    filters: getNetworkFilterOptions(agents),
    fetchedAt,
    stale,
    source: 'Irembo transaction feed',
  };
}

const normalizedFilter = (value) => String(value || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
function getNetworkFilterOptions(agents) {
  const unique = (key) => [...new Set(agents.map((agent) => String(agent[key] || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const locations = new Map();
  for (const agent of agents) {
    const row = Object.fromEntries(['province', 'district', 'sector', 'cell', 'village'].map((field) => [field, String(agent[field] || '').trim()]));
    const key = Object.values(row).join('\u0000');
    locations.set(key, row);
  }
  return { provinces: unique('province'), districts: unique('district'), sectors: unique('sector'), cells: unique('cell'), villages: unique('village'), locations: [...locations.values()] };
}

function filterNetworkAgents(agents, query = {}) {
  const filters = ['province', 'district', 'sector', 'cell', 'village'];
  return agents.map((agent) => {
    const fromDate = String(query.fromDate || '');
    const toDate = String(query.toDate || '');
    if (!fromDate && !toDate) return agent;
    const datedDeposits = Array.isArray(agent.datedDepositActivity) ? agent.datedDepositActivity.filter((row) => row.date) : [];
    if (datedDeposits.length) {
      const rows = datedDeposits.filter((row) => (!fromDate || row.date >= fromDate) && (!toDate || row.date <= toDate));
      const byBank = new Map();
      for (const row of rows) {
        const current = byBank.get(row.bankUsed) || { bankUsed: row.bankUsed, depositCount: 0, totalDeposited: 0 };
        current.depositCount += row.depositCount;
        current.totalDeposited += row.totalDeposited;
        byBank.set(row.bankUsed, current);
      }
      const reportedDepositCount = rows.reduce((sum, row) => sum + row.depositCount, 0);
      return {
        ...agent,
        reportedDepositCount,
        activityStatus: classifyMoolaActivity(reportedDepositCount),
        hasDeposited: reportedDepositCount > 0,
        totalDeposited: rows.reduce((sum, row) => sum + row.totalDeposited, 0),
        depositActivity: [...byBank.values()],
      };
    }
    return agent;
  }).filter((agent) => {
    for (const field of filters) {
      const selected = normalizedFilter(query[field]);
      if (selected && normalizedFilter(agent[field]) !== selected) return false;
    }
    const fromDate = String(query.fromDate || '');
    const toDate = String(query.toDate || '');
    if (fromDate || toDate) {
      if (Array.isArray(agent.datedDepositActivity) && agent.datedDepositActivity.some((row) => row.date)) return true;
      const rawDate = agent.activityDate || agent.registrationDate;
      const date = rawDate ? new Date(rawDate) : null;
      if (!date || Number.isNaN(date.getTime())) return false;
      const key = date.toISOString().slice(0, 10);
      if (fromDate && key < fromDate) return false;
      if (toDate && key > toDate) return false;
    }
    return true;
  });
}

async function getPerformanceSnapshot(agents, user) {
  const activeAgents = agents.filter((agent) => agent.activityStatus === 'Active');
  const rankedAgents = [...agents].sort((a, b) => b.transactionCount - a.transactionCount || a.name.localeCompare(b.name));
  if (user.role === 'TC') {
    return {
      kind: 'agents',
      best: rankedAgents.slice(0, 8),
      needsAttention: [...rankedAgents].reverse().slice(0, 8),
    };
  }
  const assignments = await prisma.tcTerritoryAssignment.findMany({
    where: { isActive: true, tc: { is: { role: 'TC', isActive: true } }, territory: { is: { type: 'DISTRICT', isActive: true } } },
    select: { tcId: true, tc: { select: { firstName: true, lastName: true, username: true } }, territory: { select: { name: true } } },
  });
  const byTc = new Map();
  for (const assignment of assignments) {
    const key = assignment.tcId;
    const row = byTc.get(key) || { id: key, name: [assignment.tc.firstName, assignment.tc.lastName].filter(Boolean).join(' ') || assignment.tc.username, districts: new Set(), activeAgents: 0, totalAgents: 0 };
    const district = normalizedFilter(assignment.territory.name);
    const alreadyCountedDistrict = [...row.districts].some((name) => normalizedFilter(name) === district);
    row.districts.add(assignment.territory.name);
    if (!alreadyCountedDistrict) {
      const districtAgents = agents.filter((agent) => normalizedFilter(agent.district) === district);
      row.totalAgents += districtAgents.length;
      row.activeAgents += districtAgents.filter((agent) => agent.activityStatus === 'Active').length;
    }
    byTc.set(key, row);
  }
  const territories = [...byTc.values()].map((row) => ({ ...row, districts: [...row.districts] }))
    .sort((a, b) => b.activeAgents - a.activeAgents || a.name.localeCompare(b.name));
  return {
    kind: 'territories',
    territories,
    activeAgents: activeAgents.length,
    best: rankedAgents.slice(0, 8),
    needsAttention: [...rankedAgents].reverse().slice(0, 8),
  };
}

function queryMatchesAgent(agent, query = {}) {
  const status = String(query.status || '').trim().toLocaleLowerCase();
  const search = String(query.search || '').trim().toLocaleLowerCase();
  if (status && agent.activityStatus.toLocaleLowerCase() !== status) return false;
  if (search && ![agent.name, agent.agentId, agent.phoneNumber, agent.district, agent.sector, agent.cell, agent.village, agent.franchisee]
    .some((value) => String(value || '').toLocaleLowerCase().includes(search))) return false;
  return true;
}

function sortNetworkAgents(agents, query = {}) {
  const allowedSorts = new Set(['transactions', 'name', 'activity', 'registrationDate']);
  const sortBy = allowedSorts.has(String(query.sortBy || '')) ? String(query.sortBy) : 'transactions';
  const direction = String(query.sortDirection || '').toLowerCase() === 'asc' ? 1 : -1;
  const activityRank = { Inactive: 0, Dormant: 1, Transacting: 2, Active: 3 };
  const value = (agent) => {
    if (sortBy === 'transactions') return Number(agent.transactionCount ?? agent.reportedDepositCount ?? 0);
    if (sortBy === 'activity') return activityRank[agent.activityStatus] ?? -1;
    if (sortBy === 'registrationDate') return agent.registrationDate ? new Date(agent.registrationDate).getTime() || 0 : 0;
    return String(agent.name || agent.loginName || agent.agentId || '').toLocaleLowerCase();
  };
  return [...agents].sort((left, right) => {
    const a = value(left);
    const b = value(right);
    const comparison = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
    return comparison * direction || String(left.id).localeCompare(String(right.id));
  });
}

function exportNetworkAgentsCsv(res, agents, network) {
  const headers = ['Agent name', 'Agent ID', 'Phone', 'Activity status', 'Transactions', 'Province', 'District', 'Sector', 'Cell', 'Village', 'Registered'];
  const rows = agents.map((agent) => [
    agent.name || agent.loginName || '', agent.agentId || agent.loginName || '', agent.phoneNumber || agent.phone || '',
    agent.activityStatus || '', agent.transactionCount ?? agent.reportedDepositCount ?? 0,
    agent.province || '', agent.district || '', agent.sector || '', agent.cell || '', agent.village || '', agent.registrationDate || '',
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${network.toLocaleLowerCase()}-agents.csv"`);
  res.send([headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n'));
}

async function filterMoolaAgentsByAreaIds(agents, query = {}) {
  const filters = ['provinceId', 'territoryId', 'sectorId', 'cellId', 'villageId'];
  if (!filters.some((field) => String(query[field] || '').trim())) return agents;
  const territories = await prisma.territory.findMany({ where: { isActive: true }, select: { id: true, name: true, type: true, parentId: true } });
  const byId = new Map(territories.map((row) => [row.id, row]));
  const children = new Map();
  for (const row of territories) children.set(`${row.type}:${row.parentId || ''}:${normalizeDistrictName(row.name)}`, row);
  const child = (type, parentId, name) => children.get(`${type}:${parentId || ''}:${normalizeDistrictName(name)}`) || null;
  const normalizedFilterValue = Object.fromEntries(filters.map((field) => [field, String(query[field] || '').trim()]));
  return agents.filter((agent) => {
    const location = agent.fieldLocation || {};
    const provinceName = agent.province || '';
    const province = territories.find((row) => row.type === 'PROVINCE' && normalizeDistrictName(row.name) === normalizeDistrictName(provinceName));
    const district = byId.get(location.territoryId)
      || territories.find((row) => row.type === 'DISTRICT' && normalizeDistrictName(row.name) === normalizeDistrictName(agent.district) && (!province || row.parentId === province.id));
    const sector = byId.get(location.sectorId) || (district && child('SECTOR', district.id, location.sector || agent.sector));
    const cell = byId.get(location.cellId) || (sector && child('CELL', sector.id, location.cell || agent.cell));
    const village = byId.get(location.villageId) || (cell && child('VILLAGE', cell.id, location.village || agent.village));
    const actual = {
      provinceId: district ? byId.get(district.parentId)?.id || '' : '',
      territoryId: district?.id || '', sectorId: sector?.id || '', cellId: cell?.id || '', villageId: village?.id || '',
    };
    return filters.every((field) => !normalizedFilterValue[field] || actual[field] === normalizedFilterValue[field]);
  });
}

function classifyMoolaActivity(depositCount) {
  const count = numberOrZero(depositCount);
  if (count >= 80) return 'Active';
  if (count >= 30) return 'Transacting';
  if (count >= 1) return 'Dormant';
  return 'Inactive';
}

async function getDdinRows(url, headers) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('The DDIN registry returned HTTP ' + response.status + '.');
  const payload = await response.json();
  if (payload?.success === false) throw new Error('The DDIN registry reported an unsuccessful response.');
  if (!Array.isArray(payload?.data)) throw new Error('The DDIN registry returned an unsupported response.');
  return payload.data;
}

async function fetchDdinAgentData(forceRefresh = false) {
  if (!forceRefresh && ddinDataCache && Date.now() - ddinDataCache.cachedAt < DDIN_AGENT_LIST_CACHE_MS) {
    return { ...ddinDataCache, stale: false };
  }
  if (ddinDataRequest) return ddinDataRequest;

  ddinDataRequest = (async () => {
    try {
      const headers = { accept: 'application/json' };
      const apiKey = String(process.env.DDIN_API_KEY || '').trim();
      if (apiKey) headers.authorization = 'Bearer ' + apiKey;
      const [registryRows, depositRows, balanceRows] = await Promise.all([
        getDdinRows(DDIN_AGENT_LIST_URL, headers),
        getDdinRows(DDIN_DEPOSITS_URL, headers),
        getDdinRows(DDIN_BALANCE_URL, headers),
      ]);

      const depositsByLogin = new Map();
      for (const deposit of depositRows) {
        const key = String(deposit?.username || '').trim().toLocaleLowerCase();
        if (!key) continue;
        const current = depositsByLogin.get(key) || { depositCount: 0, totalDeposited: 0, activity: new Map(), datedActivity: [] };
        const depositCount = numberOrZero(deposit?.countDeposit);
        const totalAmount = numberOrZero(deposit?.totalAmount);
        const rawDate = deposit?.transactionDate || deposit?.depositDate || deposit?.date || deposit?.createdAt || deposit?.reportDate;
        const date = rawDate && !Number.isNaN(new Date(rawDate).getTime()) ? new Date(rawDate).toISOString().slice(0, 10) : null;
        current.depositCount += depositCount;
        current.totalDeposited += totalAmount;
        const bankUsed = String(deposit?.bankUsed || 'Other').trim() || 'Other';
        const bankRow = current.activity.get(bankUsed) || { bankUsed, depositCount: 0, totalDeposited: 0 };
        bankRow.depositCount += depositCount;
        bankRow.totalDeposited += totalAmount;
        current.activity.set(bankUsed, bankRow);
        if (date) current.datedActivity.push({ date, bankUsed, depositCount, totalDeposited: totalAmount });
        depositsByLogin.set(key, current);
      }

      const agents = registryRows.map((row) => {
        const loginName = String(row?.loginName || '').trim();
        const deposit = depositsByLogin.get(loginName.toLocaleLowerCase()) || { depositCount: 0, totalDeposited: 0, activity: new Map(), datedActivity: [] };
        const depositCount = Math.max(0, Math.trunc(deposit.depositCount));
        return {
          id: String(row?.id ?? loginName),
          loginName,
          name: String(row?.name || loginName || 'Agent'),
          phone: String(row?.phone || ''),
          province: String(row?.province || ''),
          district: String(row?.district || ''),
          sector: String(row?.sector || ''),
          cell: String(row?.cell || ''),
          village: String(row?.village || ''),
          city: String(row?.city || ''),
          businessType: String(row?.businessType || ''),
          agentCategory: String(row?.agentCategory || ''),
          gender: String(row?.gender || ''),
          registrationDate: row?.registrationDate || null,
          reportedDepositCount: depositCount,
          activityStatus: classifyMoolaActivity(depositCount),
          hasDeposited: depositCount > 0,
          totalDeposited: deposit.totalDeposited,
          depositActivity: [...deposit.activity.values()],
          datedDepositActivity: deposit.datedActivity,
        };
      });

      ddinDataCache = {
        agents,
        balanceRows: balanceRows.map((row) => ({ accountName: String(row?.accountName || ''), balance: numberOrZero(row?.balance) })),
        fetchedAt: new Date().toISOString(),
        cachedAt: Date.now(),
      };
      return { ...ddinDataCache, stale: false };
    } catch (error) {
      if (ddinDataCache) return { ...ddinDataCache, stale: true };
      throw error;
    } finally {
      ddinDataRequest = null;
    }
  })();
  return ddinDataRequest;
}

async function allowedNetworkDistricts(user) {
  if (user.role === 'TC') {
    const assignments = await prisma.tcTerritoryAssignment.findMany({
      where: { tcId: user.id, isActive: true, territory: { is: { type: 'DISTRICT', isActive: true } } },
      select: { territory: { select: { name: true } } },
    });
    return new Set(assignments.map(({ territory }) => normalizeDistrictName(territory.name)));
  }
  if (user.role === 'CHAMPION') {
    const assignedDistricts = await prisma.agent.findMany({
      where: { championId: user.id, territory: { is: { type: 'DISTRICT', isActive: true } } },
      select: { territoryId: true, territory: { select: { name: true } } },
      distinct: ['territoryId'],
    });
    return new Set(assignedDistricts.map(({ territory }) => normalizeDistrictName(territory.name)));
  }
  return null;
}

function scopedMoolaAgents(agents, districtScope) {
  return districtScope === null ? agents : agents.filter((agent) => districtScope.has(normalizeDistrictName(agent.district)));
}

async function enrichIremboTerritories(agents) {
  const codes = [...new Set(agents.map((agent) => agent.agentId).filter(Boolean))];
  if (!codes.length) return agents;
  const localRows = [];
  for (let start = 0; start < codes.length; start += 500) {
    localRows.push(...await prisma.agent.findMany({
      where: { agentId: { in: codes.slice(start, start + 500) } },
      select: {
        id: true, agentId: true, territoryId: true, isOnHold: true,
        territory: { select: { name: true, parent: { select: { name: true } } } },
        sector: { select: { name: true } }, cell: { select: { name: true } }, village: { select: { name: true } },
      },
    }));
  }
  const byCode = new Map(localRows.map((row) => [row.agentId, row]));
  return agents.map((agent) => {
    const local = byCode.get(agent.agentId);
    if (!local) return agent;
    return {
      ...agent,
      localAgentId: local.id,
      localTerritoryId: local.territoryId,
      registryDistrict: agent.district || '',
      isOnHold: local.isOnHold,
      province: local.territory?.parent?.name || agent.province || '',
      district: local.territory?.name || agent.district || '',
      sector: agent.sector || local.sector?.name || '',
      cell: agent.cell || local.cell?.name || '',
      village: agent.village || local.village?.name || '',
    };
  });
}

async function withMoolaFieldLocations(agents, districtScope, hideOnHold = false) {
  const ids = agents.map(({ id }) => id).filter(Boolean);
  if (!ids.length) return [];
  const [locations, transfers] = await Promise.all([
    prisma.moolaAgentLocation.findMany({
      where: { externalAgentId: { in: ids } },
      include: {
        territory: { select: { id: true, name: true } },
        relocationRequests: { where: { status: 'PENDING' }, take: 1, include: { toTerritory: { select: { id: true, name: true } } } },
      },
    }),
    prisma.moolaAgentTransfer.findMany({ where: { externalAgentId: { in: ids }, status: { in: ['PENDING', 'ON_HOLD'] } }, include: { fromTerritory: { select: { id: true, name: true } }, toTerritory: { select: { id: true, name: true } }, requestedByTc: { select: { id: true, firstName: true, lastName: true } }, recipientTc: { select: { id: true, firstName: true, lastName: true } } }, orderBy: { requestedAt: 'desc' } }),
  ]);
  const byId = new Map(locations.map((location) => [location.externalAgentId, location]));
  const transferById = new Map();
  for (const transfer of transfers) if (!transferById.has(transfer.externalAgentId)) transferById.set(transfer.externalAgentId, transfer);
  return agents.map((agent) => {
    const location = byId.get(agent.id);
    const pendingTransfer = transferById.get(agent.id) || null;
    if (!location) return { ...agent, cell: agent.cell || '', village: agent.village || '', pendingTransfer };
    const district = location.territory?.name || agent.district;
    return {
      ...agent,
      registryDistrict: agent.district,
      district,
      cell: location.cellName || agent.cell || '',
      village: location.villageName || agent.village || '',
      fieldLocation: {
        territoryId: location.territoryId,
        sectorId: location.sectorId,
        cellId: location.cellId,
        villageId: location.villageId,
        district,
        sector: location.sectorName || agent.sector,
        cell: location.cellName || '',
        village: location.villageName || '',
        venue: location.venue || '',
        latitude: location.latitude,
        longitude: location.longitude,
        accuracy: location.accuracy,
        locationVerified: location.locationVerified,
        isOnHold: location.isOnHold,
        firstLocationCapturedAt: location.firstLocationCapturedAt,
        firstVisitCompletedAt: location.firstVisitCompletedAt,
        pendingRelocation: location.relocationRequests[0] || null,
      },
      pendingTransfer,
    };
  }).filter((agent) => (districtScope === null || districtScope.has(normalizeDistrictName(agent.district)))
    && !(hideOnHold && (agent.fieldLocation?.isOnHold || agent.pendingTransfer?.status === 'ON_HOLD')));
}

function getMoolaAnalytics(agents, fetchedAt, stale, canSeeMoney, balanceRows = []) {
  const byStatus = Object.fromEntries(ACTIVITY_LEVELS.map(({ name }) => [name, 0]));
  const districts = new Map();
  const categories = new Map();
  const registrationMonths = new Map();
  let reportedDepositCount = 0;
  let depositors = 0;
  let totalDeposited = 0;
  for (const agent of agents) {
    byStatus[agent.activityStatus] = (byStatus[agent.activityStatus] || 0) + 1;
    reportedDepositCount += agent.reportedDepositCount;
    if (agent.hasDeposited) depositors += 1;
    totalDeposited += agent.totalDeposited;
    const districtName = agent.district || 'Unknown';
    const district = districts.get(districtName) || { name: districtName, total: 0 };
    district.total += 1;
    district[agent.activityStatus] = (district[agent.activityStatus] || 0) + 1;
    districts.set(districtName, district);
    const categoryName = agent.agentCategory || agent.businessType || 'Unspecified';
    categories.set(categoryName, (categories.get(categoryName) || 0) + 1);
    if (agent.registrationDate) {
      const date = new Date(agent.registrationDate);
      if (!Number.isNaN(date.getTime())) {
        const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
        registrationMonths.set(key, (registrationMonths.get(key) || 0) + 1);
      }
    }
  }
  const now = new Date();
  const monthlyRegistrations = Array.from({ length: 12 }, (_, index) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + index, 1));
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    return { month: key, count: registrationMonths.get(key) || 0 };
  });
  return {
    totalAgents: agents.length,
    byStatus,
    activityLevels: ACTIVITY_LEVELS,
    reportedDepositCount,
    depositingAgents: depositors,
    agentsWithoutDeposits: Math.max(0, agents.length - depositors),
    byDistrict: [...districts.values()].sort((a, b) => b.total - a.total).slice(0, 10),
    byCategory: [...categories.entries()].map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total).slice(0, 8),
    registrationsByMonth: monthlyRegistrations,
    filters: getNetworkFilterOptions(agents),
    totalDeposited: canSeeMoney ? totalDeposited : null,
    floatBalance: canSeeMoney ? balanceRows.reduce((sum, row) => sum + numberOrZero(row.balance), 0) : null,
    fetchedAt,
    stale,
    source: 'DDIN agent registry',
    activityCountSource: 'countDeposit from manual deposit report',
  };
}

function shapeMoolaAgent(agent, canSeeMoney) {
  const { totalDeposited, depositActivity = [], datedDepositActivity: _datedDepositActivity, ...publicFields } = agent;
  const safeActivity = depositActivity.map(({ bankUsed, depositCount, totalDeposited: amount }) => ({ bankUsed, depositCount, totalDeposited: canSeeMoney ? amount : null }));
  publicFields.depositActivity = safeActivity;
  return canSeeMoney ? { ...publicFields, totalDeposited } : publicFields;
}

router.get('/moola-plus/summary', authenticateToken, requireRole('ADMIN', 'MANAGER', 'TC', 'CHAMPION'), async (req, res) => {
  try {
    const [registry, districts] = await Promise.all([fetchDdinAgentData(req.query.refresh === 'true'), allowedNetworkDistricts(req.user)]);
    const scoped = await withMoolaFieldLocations(registry.agents, districts, req.user.role === 'TC');
    const agents = filterNetworkAgents(scoped, req.query);
    const canSeeMoney = ['ADMIN', 'MANAGER'].includes(req.user.role);
    const summary = getMoolaAnalytics(agents, registry.fetchedAt, registry.stale, canSeeMoney, registry.balanceRows);
    summary.filters = getNetworkFilterOptions(scoped);
    summary.performance = await getPerformanceSnapshot(agents.map((agent) => ({ ...agent, transactionCount: agent.reportedDepositCount })), req.user);
    res.json(summary);
  } catch (error) {
    console.error('DDIN agent registry summary error:', error.name || 'Error');
    res.status(502).json({ error: 'Could not load the DDIN Moola+ registry and activity reports.' });
  }
});

router.get('/moola-plus/agents', authenticateToken, requireRole('ADMIN', 'MANAGER', 'TC', 'CHAMPION'), async (req, res) => {
  try {
    const [registry, districts] = await Promise.all([fetchDdinAgentData(), allowedNetworkDistricts(req.user)]);
    const canSeeMoney = ['ADMIN', 'MANAGER'].includes(req.user.role);
    const scoped = await withMoolaFieldLocations(registry.agents, districts, req.user.role === 'TC');
    const search = String(req.query.search || '').trim().toLocaleLowerCase();
    const status = String(req.query.status || '').trim().toLocaleLowerCase();
    const requestedAgentIds = new Set(String(req.query.agentIds || '').split(',').map((id) => id.trim()).filter(Boolean));
    const dateAndLocationFiltered = await filterMoolaAgentsByAreaIds(filterNetworkAgents(scoped, req.query), req.query);
    const filtered = dateAndLocationFiltered.filter((agent) => {
      if (requestedAgentIds.size && !requestedAgentIds.has(String(agent.id))) return false;
      if (status && agent.activityStatus.toLocaleLowerCase() !== status) return false;
      if (!search) return true;
      return [agent.name, agent.loginName, agent.district, agent.sector, agent.businessType, agent.agentCategory]
        .some((value) => String(value || '').toLocaleLowerCase().includes(search));
    });
    const withFilters = sortNetworkAgents(filtered, req.query);
    if (String(req.query.download || '').toLowerCase() === 'csv') return exportNetworkAgentsCsv(res, withFilters, 'moola-plus');
    const summary = getMoolaAnalytics(dateAndLocationFiltered, registry.fetchedAt, registry.stale, canSeeMoney, registry.balanceRows);
    const requestedPage = Number.parseInt(req.query.page, 10);
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 100) : 25;
    const pages = Math.ceil(withFilters.length / limit);
    const page = Math.min(Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1, Math.max(pages, 1));
    const pageAgents = withFilters.slice((page - 1) * limit, page * limit);
    const lastQualifiedVisitByAgent = await latestQualifiedVisits(prisma, 'MOOLA_PLUS', pageAgents.map(({ id }) => String(id)));
    res.json({
      data: pageAgents.map((agent) => ({
        ...shapeMoolaAgent(agent, canSeeMoney),
        ...coverageState(lastQualifiedVisitByAgent.get(String(agent.id))),
      })),
      total: withFilters.length,
      page,
      pages,
      summary,
      fetchedAt: registry.fetchedAt,
      stale: registry.stale,
      filters: {
        ...getNetworkFilterOptions(scoped),
      },
    });
  } catch (error) {
    console.error('DDIN agent registry list error:', error.name || 'Error');
    res.status(502).json({ error: 'Could not load Moola+ agents.' });
  }
});

router.get('/irembo/agents', authenticateToken, requireRole('ADMIN', 'MANAGER', 'TC', 'CHAMPION'), async (req, res) => {
  try {
    const [feed, districts] = await Promise.all([fetchIremboActivityData(), allowedNetworkDistricts(req.user)]);
    const enriched = await enrichIremboTerritories(feed.agents);
    const scoped = scopedMoolaAgents(enriched.filter((agent) => req.user.role !== 'TC' || !agent.isOnHold), districts);
    const search = String(req.query.search || '').trim().toLocaleLowerCase();
    const filtered = sortNetworkAgents(filterNetworkAgents(scoped, req.query).filter((agent) => queryMatchesAgent(agent, req.query))
      .filter((agent) => !search || [agent.name, agent.agentId, agent.phoneNumber, agent.district, agent.sector, agent.cell, agent.village, agent.franchisee]
        .some((value) => String(value || '').toLocaleLowerCase().includes(search))), req.query);
    if (String(req.query.download || '').toLowerCase() === 'csv') return exportNetworkAgentsCsv(res, filtered, 'irembo');
    const requestedPage = Number.parseInt(req.query.page, 10);
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 100) : 25;
    const pages = Math.ceil(filtered.length / limit);
    const page = Math.min(Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1, Math.max(pages, 1));
    const pageAgents = filtered.slice((page - 1) * limit, page * limit);
    res.json({
      data: pageAgents, total: filtered.length, page, pages,
      filters: getNetworkFilterOptions(scoped), activityLevels: getIremboActivityLevels(), fetchedAt: feed.fetchedAt, stale: feed.stale,
    });
  } catch (error) {
    console.error('Irembo agent list error:', error.name || 'Error');
    res.status(502).json({ error: 'Could not load Irembo agents.' });
  }
});

router.get('/irembo/agents/:id', authenticateToken, requireRole('ADMIN', 'MANAGER', 'TC', 'CHAMPION'), async (req, res) => {
  try {
    const [feed, districts] = await Promise.all([fetchIremboActivityData(), allowedNetworkDistricts(req.user)]);
    const agent = scopedMoolaAgents((await enrichIremboTerritories(feed.agents)).filter((item) => req.user.role !== 'TC' || !item.isOnHold), districts).find((item) => item.id === String(req.params.id));
    if (!agent) return res.status(404).json({ error: 'Irembo agent was not found in your assigned areas.' });
    res.json({ data: agent, fetchedAt: feed.fetchedAt, stale: feed.stale });
  } catch (error) {
    console.error('Irembo agent detail error:', error.name || 'Error');
    res.status(502).json({ error: 'Could not load this Irembo agent.' });
  }
});

router.get('/moola-plus/agents/:id', authenticateToken, requireRole('ADMIN', 'MANAGER', 'TC', 'CHAMPION'), async (req, res) => {
  try {
    const [registry, districts] = await Promise.all([fetchDdinAgentData(), allowedNetworkDistricts(req.user)]);
    const agent = (await withMoolaFieldLocations(registry.agents, districts, req.user.role === 'TC')).find((item) => item.id === String(req.params.id));
    if (!agent) return res.status(404).json({ error: 'Moola+ agent was not found in your assigned areas.' });
    const lastQualifiedVisitByAgent = await latestQualifiedVisits(prisma, 'MOOLA_PLUS', [String(agent.id)]);
    res.json({ data: {
      ...shapeMoolaAgent(agent, ['ADMIN', 'MANAGER'].includes(req.user.role)),
      ...coverageState(lastQualifiedVisitByAgent.get(String(agent.id))),
    }, fetchedAt: registry.fetchedAt, stale: registry.stale });
  } catch (error) {
    console.error('DDIN agent registry detail error:', error.name || 'Error');
    res.status(502).json({ error: 'Could not load this Moola+ agent.' });
  }
});

router.get('/irembo/activity', authenticateToken, requireRole('ADMIN', 'MANAGER', 'TC', 'CHAMPION'), async (req, res) => {
  try {
    const [feed, districts] = await Promise.all([
      fetchIremboActivityData(req.query.refresh === 'true'),
      allowedNetworkDistricts(req.user),
    ]);
    const scoped = scopedMoolaAgents(await enrichIremboTerritories(feed.agents), districts);
    const agents = filterNetworkAgents(scoped, req.query);
    const summary = getIremboActivitySummary(agents, feed.fetchedAt, feed.stale);
    summary.filters = getNetworkFilterOptions(scoped);
    summary.performance = await getPerformanceSnapshot(agents, req.user);
    res.json(summary);
  } catch (error) {
    console.error('Irembo transaction feed error:', error.name || 'Error');
    res.status(502).json({ error: 'Could not load Irembo transaction activity.' });
  }
});

router.get('/dashboard', authenticateToken, requireRole('ADMIN', 'MANAGER', 'TC', 'CHAMPION'), async (req, res) => {
  try {
    const scope = await visitScope(req.user);
    const agentScope = req.user.role === 'TC'
      ? { territoryId: scope.territoryId, isOnHold: false }
      : req.user.role === 'CHAMPION' ? { championId: req.user.id, isOnHold: false } : { isOnHold: false };
    const todayKey = kigaliDateKey(new Date());
    const selected = selectedDateWindow(String(req.query.fromDate || ''), String(req.query.toDate || ''), todayKey);
    if (selected.error) return res.status(400).json({ error: selected.error });
    const range = selected.range;
    const dateRanges = { selected: serializableRange(range) };
    const [totalAgents, totalActiveAgents, row] = await Promise.all([
      prisma.agent.count({ where: agentScope }),
      prisma.agent.count({ where: { ...agentScope, status: 'ACTIVE', isOnHold: false } }),
      prisma.$queryRaw`
          SELECT
            COUNT(*) FILTER (WHERE v."countsForMetrics" = TRUE) AS "totalVisits",
            COUNT(*) FILTER (WHERE v."countsForMetrics" = TRUE AND v."visitStatus"::text IN ('COMPLETED', 'FLAGGED')) AS "completedVisits",
            COUNT(DISTINCT v."agentId") FILTER (WHERE v."countsForMetrics" = TRUE AND v."visitStatus"::text IN ('COMPLETED', 'FLAGGED')) AS "uniqueAgentsVisited",
            COUNT(*) FILTER (WHERE v."countsForMetrics" = TRUE AND v."visitStatus"::text IN ('COMPLETED', 'FLAGGED') AND v."locationStatus"::text = 'VERIFIED') AS "verifiedVisits",
            COUNT(*) FILTER (WHERE v."countsForMetrics" = TRUE AND (v."visitStatus"::text = 'FLAGGED' OR v."locationStatus"::text IS DISTINCT FROM 'VERIFIED')) AS "flaggedVisitsCount",
            AVG(v."distanceMeters") FILTER (WHERE v."countsForMetrics" = TRUE) AS "averageDistance"
          FROM "Visit" v
          WHERE v."visitDate" >= ${range.gte} AND v."visitDate" < ${range.lt}
            AND v."network"::text = 'IREMBO'
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
      totalVisits, completedVisits, totalAgents, totalActiveAgents,
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
    const { fromDate, toDate, tcId, territoryId, agentId, externalAgentId, status, unverifiedOnly } = req.query;
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
    if (externalAgentId) baseWhere.externalAgentId = String(externalAgentId);
    if (['IREMBO', 'MOOLA_PLUS'].includes(String(req.query.network || '').toUpperCase())) baseWhere.network = String(req.query.network).toUpperCase();
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
          id: true, visitId: true, network: true, agentId: true, externalAgentId: true, externalAgentName: true, externalAgentCode: true, tcId: true, territoryId: true,
          visitDate: true, checkInTime: true, distanceMeters: true, gpsAccuracyMeters: true,
          locationStatus: true, visitStatus: true, countsForMetrics: true,
          agent: { select: { id: true, agentId: true, name: true } },
          tc: { select: { id: true, firstName: true, lastName: true, username: true } },
        },
        orderBy: [{ visitDate: 'desc' }, { id: 'desc' }],
      }),
      prisma.visit.count({ where: { AND: [baseWhere, { countsForMetrics: true, visitStatus: { in: ['COMPLETED', 'FLAGGED'] } }] } }),
      prisma.visit.count({ where: { AND: [baseWhere, { countsForMetrics: true, visitStatus: { in: ['COMPLETED', 'FLAGGED'] }, locationStatus: 'VERIFIED' }] } }),
      prisma.visit.count({ where: { AND: [baseWhere, { countsForMetrics: true, OR: [{ visitStatus: 'FLAGGED' }, { locationStatus: { not: 'VERIFIED' } }] }] } }),
      prisma.visit.count({ where: { AND: [baseWhere, { countsForMetrics: true, photos: { some: {} } }] } }),
    ]);
    const metricVisitWhere = { AND: [baseWhere, { countsForMetrics: true, visitStatus: { in: ['COMPLETED', 'FLAGGED'] } }] };
    const uniqueAgentGroups = await prisma.visit.groupBy({
      by: [String(req.query.network || '').toUpperCase() === 'MOOLA_PLUS' ? 'externalAgentId' : 'agentId'],
      where: metricVisitWhere,
    });
    const totalCounted = await prisma.visit.count({ where: { AND: [baseWhere, { countsForMetrics: true }] } });
    const allNetworkVisitCount = await prisma.visit.count({ where: baseWhere });
    res.json({
      data,
      meta: { total, page, limit, pages },
      summary: {
        total: totalCounted,
        uniqueAgentsVisited: uniqueAgentGroups.filter((group) => String(group.externalAgentId ?? group.agentId ?? '')).length,
        followUps: Math.max(0, allNetworkVisitCount - totalCounted),
        completed: completedCount, verified: verifiedCount, flagged: flaggedCount, photoVisits: photoCount,
      },
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
        ? { sectorId: territory.id, championId: req.user.id, status: 'ACTIVE', isOnHold: false }
        : { territoryId: territory.id, status: 'ACTIVE', isOnHold: false };
      const visitWhere = req.user.role === 'CHAMPION'
        ? { countsForMetrics: true, visitStatus: { in: ['COMPLETED', 'FLAGGED'] }, agent: { sectorId: territory.id, championId: req.user.id }, ...(visitDate ? { visitDate } : {}) }
        : { countsForMetrics: true, visitStatus: { in: ['COMPLETED', 'FLAGGED'] }, territoryId: territory.id, ...(visitDate ? { visitDate } : {}) };
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
    if (['IREMBO', 'MOOLA_PLUS'].includes(String(req.query.network || '').toUpperCase())) where.network = String(req.query.network).toUpperCase();
    const visits = await prisma.visit.findMany({ where, include: { agent: true, tc: true, territory: true }, orderBy: { visitDate: 'desc' } });
    const rows = [['visitId', 'visitDate', 'tcUsername', 'agentId', 'agentName', 'territoryName', 'locationStatus', 'visitStatus', 'countsForMetrics', 'distanceMeters', 'checkInTime', 'checkOutTime']];
    for (const visit of visits) rows.push([
      visit.visitId, visit.visitDate?.toISOString(), visit.tc?.username, visit.agent?.agentId || visit.externalAgentCode, visit.agent?.name || visit.externalAgentName,
      visit.territory?.name, visit.locationStatus, visit.visitStatus, visit.countsForMetrics, visit.distanceMeters,
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

router.getMoolaPlanningAgents = async (user, { includeInactive = false } = {}) => {
  const [registry, districtScope] = await Promise.all([fetchDdinAgentData(), allowedNetworkDistricts(user)]);
  const agents = await withMoolaFieldLocations(registry.agents, districtScope, true);
  return agents.filter((agent) => (includeInactive || agent.activityStatus === 'Active')
    && !agent.fieldLocation?.isOnHold && agent.pendingTransfer?.status !== 'ON_HOLD');
};

router.getIremboPlanningAgents = async (user, { includeInactive = false } = {}) => {
  const [feed, districts] = await Promise.all([fetchIremboActivityData(), allowedNetworkDistricts(user)]);
  const enriched = await enrichIremboTerritories(feed.agents);
  return scopedMoolaAgents(enriched, districts).filter((agent) => (includeInactive || agent.activityStatus === 'Active') && !agent.isOnHold);
};

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
