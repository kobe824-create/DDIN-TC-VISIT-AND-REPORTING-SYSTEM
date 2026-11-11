const express = require('express');
const router = express.Router();
const crypto = require('node:crypto');
const prisma = require('../utils/prisma');
const { authenticateToken, requireRole, requireTerritoryAccess } = require('../middleware/auth');
const { logAction } = require('../utils/auditLog');
const { decryptPii, encryptPii } = require('../../../shared/pii');
const { advisoryTransactionLock } = require('../../../shared/advisory-locks');
const { coverageState, kigaliDateKey, latestQualifiedVisits } = require('../../../shared/visit-coverage');

const queryIds = (value) => (Array.isArray(value) ? value : value ? [value] : []).map(String).filter(Boolean);
const isDatabaseSchemaError = (error) => ['P2021', 'P2022'].includes(error?.code);
const databaseMigrationMessage = 'The database is missing an application update. Apply the pending Prisma migrations and restart the services.';
const sectorWhatsAppGroupKey = (sectorId) => `SECTOR_WHATSAPP_GROUP:${sectorId}`;
const sectorWhatsAppInviteKey = (sectorId) => `SECTOR_WHATSAPP_INVITE:${sectorId}`;
const moolaGroupId = (district, sector) => crypto.createHash('sha256').update(`${String(district || '').trim().toLocaleLowerCase()}\u0000${String(sector || '').trim().toLocaleLowerCase()}`).digest('hex').slice(0, 24);
const moolaWhatsAppGroupKey = (groupId) => `MOOLA_PLUS_WHATSAPP_GROUP:${groupId}`;
const moolaWhatsAppInviteKey = (groupId) => `MOOLA_PLUS_WHATSAPP_INVITE:${groupId}`;

function normalizeWhatsAppNumber(value) {
  let digits = String(value || '').trim().split('@')[0].replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (/^0\d{9}$/.test(digits)) digits = `250${digits.slice(1)}`;
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

function parseSystemConfigJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

async function createAgentMovementNotices(tx, { agent, fromTerritoryId, toTerritoryId, noticeType }) {
  const territories = await tx.territory.findMany({ where: { id: { in: [...new Set([fromTerritoryId, toTerritoryId].filter(Boolean))] } }, select: { id: true, name: true } });
  const nameById = new Map(territories.map((territory) => [territory.id, territory.name]));
  const assignments = await tx.tcTerritoryAssignment.findMany({ where: { territoryId: { in: [...nameById.keys()] }, isActive: true, tc: { is: { role: 'TC', isActive: true } } }, select: { tcId: true } });
  const recipientTcIds = [...new Set(assignments.map(({ tcId }) => tcId))];
  if (!recipientTcIds.length) return;
  await tx.agentMovementNotice.createMany({ data: recipientTcIds.map((recipientTcId) => ({
    recipientTcId, agentId: agent.id, network: 'IREMBO', agentName: agent.name, agentCode: agent.agentId, noticeType,
    fromTerritoryName: nameById.get(fromTerritoryId) || null, toTerritoryName: nameById.get(toTerritoryId) || null,
  })) });
}

function whatsAppProviderReady() {
  return Boolean(String(process.env.WHAPI_API_TOKEN || '').trim());
}

async function whapiRequest(path, { method = 'GET', body } = {}) {
  if (!whatsAppProviderReady()) {
    const error = new Error('WhatsApp group API is not configured.');
    error.statusCode = 503;
    throw error;
  }
  let response;
  try {
    response = await fetch(`https://gate.whapi.cloud${path}`, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${String(process.env.WHAPI_API_TOKEN || '').trim()}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
  } catch (cause) {
    const error = new Error('The WhatsApp provider could not be reached.');
    error.statusCode = 502;
    error.ambiguous = true;
    error.cause = cause;
    throw error;
  }
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { /* Provider returned a non-JSON error. */ }
  if (!response.ok) {
    const error = new Error('The WhatsApp provider rejected the group operation.');
    error.statusCode = response.status;
    error.ambiguous = response.status >= 500;
    error.providerData = data;
    throw error;
  }
  return data;
}

function extractWhapiGroupId(data) {
  const id = data?.id || data?.group?.id || data?.chat?.id;
  return typeof id === 'string' && /^[\d-]{10,31}@g\.us$/.test(id) ? id : null;
}

async function getWhapiInviteUrl(groupId) {
  const data = await whapiRequest(`/groups/${encodeURIComponent(groupId)}/invite`);
  const candidate = data?.invite_url || data?.url || data?.link;
  if (typeof candidate === 'string' && candidate.startsWith('https://chat.whatsapp.com/')) return candidate;
  const inviteCode = data?.invite_code || data?.code;
  return typeof inviteCode === 'string' && /^[A-Za-z0-9_-]+$/.test(inviteCode)
    ? `https://chat.whatsapp.com/${inviteCode}`
    : '';
}

function normalizeProviderNumbers(values) {
  return new Set((Array.isArray(values) ? values : [])
    .map((value) => {
      const raw = typeof value === 'string' ? value : value?.id || value?.phone || '';
      return String(raw).endsWith('@lid') ? null : normalizeWhatsAppNumber(raw);
    })
    .filter(Boolean));
}

function getProviderParticipantResult(data, requested) {
  const failedNumbers = new Set([
    ...normalizeProviderNumbers(data?.unprocessed_participants || []),
    ...normalizeProviderNumbers(data?.failed || []),
  ]);
  const processedValues = data?.processed || [];
  const processedNumbers = normalizeProviderNumbers(processedValues);
  const participants = Array.isArray(data?.participants) ? data.participants : [];
  const groupMemberNumbers = normalizeProviderNumbers(participants);
  const observed = new Set([...processedNumbers, ...groupMemberNumbers]);
  const hasSuccessList = processedValues.length > 0 || participants.length > 0;
  const addedNumbers = hasSuccessList
    ? new Set([...observed].filter((number) => requested.has(number) && !failedNumbers.has(number)))
    : new Set([...requested].filter((number) => !failedNumbers.has(number)));
  if (hasSuccessList) {
    for (const number of requested) if (!addedNumbers.has(number)) failedNumbers.add(number);
  }
  return { addedNumbers, failedNumbers };
}

async function saveSectorWhatsAppGroup(client, sector, groupData, userId) {
  const key = sectorWhatsAppGroupKey(sector.id);
  const value = JSON.stringify(groupData);
  await client.systemConfig.upsert({
    where: { key },
    create: { key, value, description: `WhatsApp group for ${sector.name}, ${sector.parent.name}`, updatedById: userId },
    update: { value, description: `WhatsApp group for ${sector.name}, ${sector.parent.name}`, updatedById: userId },
  });
}

async function getMoolaPlusGroups(req) {
  const base = String(process.env.REPORTS_SERVICE_URL || 'http://reports-service:3004').replace(/\/$/, '');
  const agents = [];
  let pages = 1;
  for (let page = 1; page <= pages && page <= 500; page += 1) {
    const query = new URLSearchParams({ page: String(page), limit: '100' });
    const response = await fetch(`${base}/api/v1/reports/moola-plus/agents?${query}`, {
      headers: { authorization: req.headers.authorization || '', accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const error = new Error('Could not load Moola Plus agents for WhatsApp groups.');
      error.statusCode = response.status >= 500 ? 502 : response.status;
      throw error;
    }
    const payload = await response.json();
    agents.push(...(Array.isArray(payload.data) ? payload.data : []));
    pages = Math.max(1, Number(payload.pages) || 1);
  }

  const groups = new Map();
  for (const agent of agents) {
    const districtName = String(agent.fieldLocation?.district || agent.district || '').trim() || 'Unassigned district';
    const sectorName = String(agent.fieldLocation?.sector || agent.sector || '').trim() || 'Unspecified sector';
    const id = moolaGroupId(districtName, sectorName);
    const group = groups.get(id) || { id, name: sectorName, districtName, agents: [] };
    group.agents.push({
      id: String(agent.id),
      agentId: String(agent.loginName || agent.id),
      name: String(agent.name || agent.loginName || 'Moola Plus agent'),
      phoneNumber: String(agent.phone || ''),
    });
    groups.set(id, group);
  }

  const result = [...groups.values()].sort((a, b) => a.districtName.localeCompare(b.districtName) || a.name.localeCompare(b.name));
  const keys = result.flatMap(({ id }) => [moolaWhatsAppGroupKey(id), moolaWhatsAppInviteKey(id)]);
  const configs = keys.length ? await prisma.systemConfig.findMany({ where: { key: { in: keys } }, select: { key: true, value: true } }) : [];
  const configByKey = new Map(configs.map((row) => [row.key, row.value]));
  return result.map((group) => {
    const stored = parseSystemConfigJson(configByKey.get(moolaWhatsAppGroupKey(group.id)));
    return {
      ...group,
      inviteUrl: stored?.inviteUrl || configByKey.get(moolaWhatsAppInviteKey(group.id)) || '',
      group: stored ? {
        status: stored.status || 'active',
        groupName: stored.groupName || `DDIN ${group.name}`,
        createdAt: stored.createdAt || null,
        attemptedCount: Number.isInteger(stored.attemptedCount) ? stored.attemptedCount : (stored.attemptedAgentIds || []).length,
        addedCount: Number.isInteger(stored.addedCount) ? stored.addedCount : (stored.addedAgentIds || []).length,
        failedCount: Number.isInteger(stored.failedCount) ? stored.failedCount : (stored.failedAgentIds || []).length,
      } : null,
      providerAvailable: whatsAppProviderReady(),
    };
  });
}

async function saveMoolaWhatsAppGroup(client, group, groupData, userId) {
  const key = moolaWhatsAppGroupKey(group.id);
  const value = JSON.stringify(groupData);
  await client.systemConfig.upsert({
    where: { key },
    create: { key, value, description: `WhatsApp group for Moola Plus ${group.name}, ${group.districtName}`, updatedById: userId },
    update: { value, description: `WhatsApp group for Moola Plus ${group.name}, ${group.districtName}`, updatedById: userId },
  });
}

// Express 4 does not forward rejected async route promises. Wrap async handlers
// so an unexpected database/query error becomes a request error instead of
// terminating the Agents service process.
const forwardAsyncErrors = (handler) => {
  if (handler.constructor?.name !== 'AsyncFunction') return handler;
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
};
for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
  const register = router[method].bind(router);
  router[method] = (path, ...handlers) => register(path, ...handlers.map(forwardAsyncErrors));
}

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

function normalizeAreaLabel(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ');
}

async function fetchIremboSourceAgent(req, agentCode) {
  const base = String(process.env.REPORTS_SERVICE_URL || 'http://reports-service:3004').replace(/\/$/, '');
  let response;
  try {
    response = await fetch(`${base}/api/v1/reports/irembo/agents/${encodeURIComponent(agentCode)}`, {
      headers: { authorization: req.headers.authorization || '', accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw Object.assign(new Error('Could not reach the Irembo activity feed. Try again when online.'), { statusCode: 502 });
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.data) throw Object.assign(new Error(payload.error || 'Irembo agent not found in the feed.'), { statusCode: response.status || 502 });
  return payload.data;
}

async function ensureIremboFieldAgent(req, agentCode) {
  const code = String(agentCode || '').trim();
  if (!code || code.startsWith('irembo-')) throw Object.assign(new Error('This feed row has no Irembo agent code and cannot be linked to field actions.'), { statusCode: 409 });
  const source = await fetchIremboSourceAgent(req, code);
  if (source.localAgentId) {
    const linked = await prisma.agent.findUnique({ where: { id: source.localAgentId } });
    if (linked) return linked;
  }
  const existing = await prisma.agent.findFirst({ where: { agentId: { equals: String(source.agentId || code), mode: 'insensitive' } } });
  if (existing) {
    if (req.user.role === 'TC' && !(req.user.assignedTerritories || []).includes(existing.territoryId)) throw Object.assign(new Error('This Irembo agent is outside your assigned district.'), { statusCode: 403 });
    return existing;
  }

  const allAreas = await prisma.territory.findMany({
    where: { isActive: true },
    select: { id: true, name: true, type: true, parentId: true },
  });
  const province = allAreas.find((area) => area.type === 'PROVINCE' && normalizeAreaLabel(area.name) === normalizeAreaLabel(source.province));
  const districtMatches = allAreas.filter((area) => area.type === 'DISTRICT'
    && normalizeAreaLabel(area.name) === normalizeAreaLabel(source.district)
    && (!province || area.parentId === province.id));
  if (districtMatches.length !== 1) throw Object.assign(new Error('This Irembo record is not linked because its district does not match one active system district.'), { statusCode: 409 });
  const territory = districtMatches[0];
  if (req.user.role === 'TC' && !(req.user.assignedTerritories || []).includes(territory.id)) throw Object.assign(new Error('This Irembo agent is outside your assigned district.'), { statusCode: 403 });
  const findChild = (type, parentId, name) => allAreas.find((area) => area.type === type && area.parentId === parentId && normalizeAreaLabel(area.name) === normalizeAreaLabel(name));
  const sector = findChild('SECTOR', territory.id, source.sector);
  const cell = sector && findChild('CELL', sector.id, source.cell);
  const village = cell && findChild('VILLAGE', cell.id, source.village);
  try {
    return await prisma.agent.create({
      data: {
        agentId: String(source.agentId || code), name: String(source.name || source.agentId || code),
        phoneNumber: source.phoneNumber || null, businessName: source.franchisee || source.businessName || null,
        address: [source.province, source.district, source.sector, source.cell, source.village].filter(Boolean).join(' · ') || null,
        territoryId: territory.id, sectorId: sector?.id || null, cellId: cell?.id || null, villageId: village?.id || null,
        status: source.activityStatus === 'Active' ? 'ACTIVE' : 'INACTIVE', createdById: req.user.id,
      },
    });
  } catch (error) {
    if (error.code === 'P2002') {
      const linked = await prisma.agent.findFirst({ where: { agentId: { equals: String(source.agentId || code), mode: 'insensitive' } } });
      if (linked) return linked;
    }
    throw error;
  }
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

router.get('/sector-groups', authenticateToken, requireTerritoryAccess, requireRole('TC'), async (req, res) => {
  try {
    const districtIds = req.user.assignedTerritories || [];
    if (!districtIds.length) return res.json([]);
    const sectors = await prisma.territory.findMany({
      where: { type: 'SECTOR', isActive: true, parentId: { in: districtIds }, parent: { is: { isActive: true } } },
      select: { id: true, name: true, parentId: true, parent: { select: { name: true } } },
      orderBy: [{ parent: { name: 'asc' } }, { name: 'asc' }],
    });
    const sectorIds = sectors.map(({ id }) => id);
    const [agents, configs] = await Promise.all([
      sectorIds.length ? prisma.agent.findMany({
        where: { sectorId: { in: sectorIds }, status: 'ACTIVE', isOnHold: false },
        select: { id: true, agentId: true, name: true, phoneNumber: true, sectorId: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }) : [],
      sectorIds.length ? prisma.systemConfig.findMany({ where: { key: { in: sectorIds.flatMap((id) => [sectorWhatsAppInviteKey(id), sectorWhatsAppGroupKey(id)]) } }, select: { key: true, value: true } }) : [],
    ]);
    const configByKey = new Map(configs.map((row) => [row.key, row.value]));
    res.json(sectors.map((sector) => ({
      id: sector.id, name: sector.name, districtId: sector.parentId, districtName: sector.parent.name,
      inviteUrl: parseSystemConfigJson(configByKey.get(sectorWhatsAppGroupKey(sector.id)))?.inviteUrl
        || configByKey.get(sectorWhatsAppInviteKey(sector.id)) || '',
      group: (() => {
        const group = parseSystemConfigJson(configByKey.get(sectorWhatsAppGroupKey(sector.id)));
        if (!group) return null;
        return {
          status: group.status || 'active',
          groupName: group.groupName || `DDIN ${sector.name}`,
          createdAt: group.createdAt || null,
          attemptedCount: Number.isInteger(group.attemptedCount) ? group.attemptedCount : (group.attemptedAgentIds || []).length,
          addedCount: Number.isInteger(group.addedCount) ? group.addedCount : (group.addedAgentIds || []).length,
          failedCount: Number.isInteger(group.failedCount) ? group.failedCount : (group.failedAgentIds || []).length,
        };
      })(),
      agents: agents.filter((agent) => agent.sectorId === sector.id),
    })).map((sector) => ({ ...sector, providerAvailable: whatsAppProviderReady() })));
  } catch (error) {
    console.error('Sector WhatsApp groups error:', error.code || error.name);
    res.status(500).json({ error: 'Could not load sectors and agent contact details.' });
  }
});

router.put('/sector-groups/:sectorId', authenticateToken, requireTerritoryAccess, requireRole('TC'), async (req, res) => {
  try {
    const sectorId = String(req.params.sectorId || '');
    const inviteUrl = String(req.body.inviteUrl || '').trim();
    const sector = await prisma.territory.findFirst({ where: { id: sectorId, type: 'SECTOR', isActive: true, parentId: { in: req.user.assignedTerritories || [] } }, select: { id: true, name: true, parent: { select: { name: true } } } });
    if (!sector) return res.status(404).json({ error: 'This sector is not in your assigned districts.' });
    const key = sectorWhatsAppInviteKey(sector.id);
    let normalizedUrl = '';
    if (inviteUrl) {
      const url = new URL(inviteUrl);
      if (url.protocol !== 'https:' || url.hostname !== 'chat.whatsapp.com' || !/^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) {
        return res.status(400).json({ error: 'Paste a valid WhatsApp group invite link from chat.whatsapp.com.' });
      }
      normalizedUrl = url.toString();
    }
    const result = await prisma.$transaction(async (tx) => {
      await advisoryTransactionLock(tx, sector.id, 'WHATSAPP_SECTOR_GROUP');
      const groupConfig = await tx.systemConfig.findUnique({ where: { key: sectorWhatsAppGroupKey(sector.id) }, select: { value: true } });
      if (parseSystemConfigJson(groupConfig?.value)?.groupId) {
        const conflict = new Error('This sector already has a provider-managed group. Its invite link is managed by the group integration.');
        conflict.statusCode = 409;
        throw conflict;
      }
      if (!normalizedUrl) {
        await tx.systemConfig.deleteMany({ where: { key } });
        return { inviteUrl: '', action: 'REMOVE_SECTOR_WHATSAPP_INVITE' };
      }
      await tx.systemConfig.upsert({
        where: { key },
        create: { key, value: normalizedUrl, description: `WhatsApp invite for ${sector.name}, ${sector.parent.name}`, updatedById: req.user.id },
        update: { value: normalizedUrl, description: `WhatsApp invite for ${sector.name}, ${sector.parent.name}`, updatedById: req.user.id },
      });
      return { inviteUrl: normalizedUrl, action: 'SAVE_SECTOR_WHATSAPP_INVITE' };
    }, { timeout: 10000 });
    await logAction(req.user.id, result.action, 'Territory', sector.id, { sectorName: sector.name }, req);
    res.json({ sectorId: sector.id, inviteUrl: result.inviteUrl });
  } catch (error) {
    if (error instanceof TypeError) return res.status(400).json({ error: 'Paste a valid WhatsApp group invite link.' });
    if (error.statusCode === 409) return res.status(409).json({ error: error.message });
    console.error('Save sector WhatsApp invite failed:', error.code || error.name);
    res.status(500).json({ error: 'Could not save the WhatsApp group invite link.' });
  }
});

router.post('/sector-groups/:sectorId/create', authenticateToken, requireTerritoryAccess, requireRole('TC'), async (req, res) => {
  const sectorId = String(req.params.sectorId || '');
  if (req.body?.confirmAgentConsent !== true) {
    return res.status(400).json({ error: 'Confirm that every agent being added agreed to join this group and share their phone number with the WhatsApp provider.' });
  }
  if (!whatsAppProviderReady()) {
    return res.status(503).json({ error: 'Automatic WhatsApp group creation is not configured. An administrator must set WHAPI_API_TOKEN for AgentsService.' });
  }

  try {
    const sector = await prisma.territory.findFirst({
      where: { id: sectorId, type: 'SECTOR', isActive: true, parentId: { in: req.user.assignedTerritories || [] } },
      select: { id: true, name: true, parent: { select: { name: true } } },
    });
    if (!sector) return res.status(404).json({ error: 'This sector is not in your assigned districts.' });

    const agents = await prisma.agent.findMany({
      where: { sectorId: sector.id, status: 'ACTIVE', isOnHold: false },
      select: { id: true, phoneNumber: true },
      orderBy: [{ id: 'asc' }],
    });
    const byNumber = new Map();
    let missingPhoneCount = 0;
    let invalidPhoneCount = 0;
    for (const agent of agents) {
      if (!agent.phoneNumber?.trim()) {
        missingPhoneCount += 1;
        continue;
      }
      const number = normalizeWhatsAppNumber(agent.phoneNumber);
      if (!number) {
        invalidPhoneCount += 1;
        continue;
      }
      if (!byNumber.has(number)) byNumber.set(number, []);
      byNumber.get(number).push(agent.id);
    }
    const groupKey = sectorWhatsAppGroupKey(sector.id);
    if (!byNumber.size) return res.status(400).json({ error: 'No active agents in this sector have a valid phone number.', missingPhoneCount, invalidPhoneCount });
    if (byNumber.size > 1023) return res.status(400).json({ error: 'This sector has more numbers than one WhatsApp group can hold. Use the manual group workflow or split the group.' });

    const groupConfig = await prisma.$transaction(async (tx) => {
      await advisoryTransactionLock(tx, sector.id, 'WHATSAPP_SECTOR_GROUP');
      const stored = await tx.systemConfig.findUnique({ where: { key: groupKey }, select: { value: true } });
      const group = parseSystemConfigJson(stored?.value);
      if (group) return { group, created: false };
      const manualInvite = await tx.systemConfig.findUnique({ where: { key: sectorWhatsAppInviteKey(sector.id) }, select: { value: true } });
      if (manualInvite?.value) {
        const conflict = new Error('A manual WhatsApp group link is already saved for this sector. Remove or replace that link before creating a provider-managed group.');
        conflict.statusCode = 409;
        throw conflict;
      }
      const requestId = require('node:crypto').randomUUID();
      const groupName = `DDIN ${sector.name}`.slice(0, 25);
      const pending = {
        provider: 'whapi', status: 'creating', requestId, groupName,
        createdAt: new Date().toISOString(), createdById: req.user.id,
        attemptedAgentIds: [], addedAgentIds: [], failedAgentIds: [],
        attemptedCount: 0, addedCount: 0, failedCount: 0,
      };
      await saveSectorWhatsAppGroup(tx, sector, pending, req.user.id);
      return { group: pending, created: true };
    }, { timeout: 10000 });

    if (groupConfig.group.status === 'creating' && !groupConfig.created) {
      return res.status(409).json({ error: 'A previous group creation may still be in progress. Check the provider account before trying again to avoid creating duplicates.' });
    }
    if (groupConfig.group.status === 'needs_review') {
      return res.status(409).json({ error: 'A previous provider request may have created a group without saving its ID. Ask an administrator to review the WhatsApp provider account before retrying.' });
    }

    if (groupConfig.created) {
      const requested = new Set(byNumber.keys());
      let created;
      try {
        created = await whapiRequest('/groups', {
          method: 'POST',
          body: { subject: groupConfig.group.groupName, participants: [...requested] },
        });
      } catch (error) {
        if (error.ambiguous) {
          await saveSectorWhatsAppGroup(prisma, sector, { ...groupConfig.group, status: 'needs_review' }, req.user.id);
        } else {
          await prisma.systemConfig.deleteMany({ where: { key: groupKey } });
        }
        throw error;
      }
      const groupId = extractWhapiGroupId(created);
      if (!groupId) {
        await saveSectorWhatsAppGroup(prisma, sector, { ...groupConfig.group, status: 'needs_review' }, req.user.id);
        return res.status(502).json({ error: 'The provider responded but did not return a usable group ID. Ask an administrator to review the provider account before retrying.' });
      }
      const { addedNumbers, failedNumbers } = getProviderParticipantResult(created, requested);
      let inviteUrl = '';
      try { inviteUrl = await getWhapiInviteUrl(groupId); } catch (error) {
        console.error('WhatsApp group invite lookup failed:', error.statusCode || error.name);
      }
      const activeGroup = {
        ...groupConfig.group,
        status: 'active', groupId, inviteUrl,
        attemptedAgentIds: [...new Set([...requested].flatMap((number) => byNumber.get(number) || []))],
        addedAgentIds: [...new Set([...addedNumbers].flatMap((number) => byNumber.get(number) || []))],
        failedAgentIds: [...new Set([...failedNumbers].flatMap((number) => byNumber.get(number) || []))],
        attemptedCount: requested.size, addedCount: addedNumbers.size, failedCount: failedNumbers.size,
      };
      await saveSectorWhatsAppGroup(prisma, sector, activeGroup, req.user.id);
      await logAction(req.user.id, 'CREATE_SECTOR_WHATSAPP_GROUP', 'Territory', sector.id, {
        sectorName: sector.name, provider: 'whapi', consentConfirmed: true,
        requestedCount: requested.size, addedCount: addedNumbers.size,
        failedCount: failedNumbers.size, missingPhoneCount, invalidPhoneCount,
      }, req);
      return res.status(201).json({
        sectorId: sector.id, groupName: activeGroup.groupName, inviteUrl,
        created: true, attemptedCount: requested.size, addedCount: addedNumbers.size,
        failedCount: failedNumbers.size, missingPhoneCount, invalidPhoneCount,
        message: inviteUrl ? 'WhatsApp group created.' : 'WhatsApp group created, but the provider did not return an invite link. The group is saved; ask an administrator to refresh the link.',
      });
    }

    const updated = await prisma.$transaction(async (tx) => {
      await advisoryTransactionLock(tx, sector.id, 'WHATSAPP_SECTOR_GROUP');
      const stored = await tx.systemConfig.findUnique({ where: { key: groupKey }, select: { value: true } });
      const storedGroup = parseSystemConfigJson(stored?.value);
      if (!storedGroup?.groupId || storedGroup.status !== 'active') {
        const unavailable = new Error('This sector group is not ready for member updates. Ask an administrator to review its provider status.');
        unavailable.statusCode = 409;
        throw unavailable;
      }
      const alreadyAttempted = new Set(storedGroup.attemptedAgentIds || []);
      const newNumbers = [...byNumber.entries()]
        .filter(([, agentIds]) => !agentIds.every((agentId) => alreadyAttempted.has(agentId)))
        .map(([number]) => number);
      if (!newNumbers.length) {
        let inviteUrl = storedGroup.inviteUrl || '';
        if (!inviteUrl) {
          try {
            inviteUrl = await getWhapiInviteUrl(storedGroup.groupId);
            if (inviteUrl) await saveSectorWhatsAppGroup(tx, sector, { ...storedGroup, inviteUrl }, req.user.id);
          } catch (error) {
            console.error('WhatsApp group invite refresh failed:', error.statusCode || error.name);
          }
        }
        return {
          sectorId: sector.id, groupName: storedGroup.groupName, inviteUrl,
          created: false, attemptedCount: storedGroup.attemptedCount || 0,
          addedCount: storedGroup.addedCount || 0, failedCount: storedGroup.failedCount || 0,
          missingPhoneCount, invalidPhoneCount,
          message: storedGroup.failedCount
            ? inviteUrl ? 'No new agent numbers are recorded. Use the invite link for people the provider could not add.' : 'No new agent numbers are recorded. Retry to refresh the group invite link for people the provider could not add.'
            : 'This group already includes all active agent numbers recorded for the sector.',
        };
      }
      const requested = new Set(newNumbers);
      let result;
      try {
        result = await whapiRequest(`/groups/${encodeURIComponent(storedGroup.groupId)}/participants`, {
          method: 'POST', body: { participants: newNumbers },
        });
      } catch (error) {
        if (error.statusCode === 409) {
          result = await whapiRequest(`/groups/${encodeURIComponent(storedGroup.groupId)}`);
        } else {
          throw error;
        }
      }
      const { addedNumbers, failedNumbers } = getProviderParticipantResult(result, requested);
      const attemptedAgentIds = new Set([...(storedGroup.attemptedAgentIds || []), ...newNumbers.flatMap((number) => byNumber.get(number) || [])]);
      const allAddedAgentIds = new Set([...(storedGroup.addedAgentIds || []), ...[...addedNumbers].flatMap((number) => byNumber.get(number) || [])]);
      const allFailedAgentIds = new Set([...(storedGroup.failedAgentIds || []), ...[...failedNumbers].flatMap((number) => byNumber.get(number) || [])]);
      const updatedGroup = {
        ...storedGroup,
        attemptedAgentIds: [...attemptedAgentIds], addedAgentIds: [...allAddedAgentIds], failedAgentIds: [...allFailedAgentIds],
        attemptedCount: (storedGroup.attemptedCount || 0) + newNumbers.length,
        addedCount: (storedGroup.addedCount || 0) + addedNumbers.size,
        failedCount: (storedGroup.failedCount || 0) + failedNumbers.size,
      };
      await saveSectorWhatsAppGroup(tx, sector, updatedGroup, req.user.id);
      return {
        sectorId: sector.id, groupName: storedGroup.groupName, inviteUrl: storedGroup.inviteUrl || '',
        created: false, attemptedCount: newNumbers.length, addedCount: addedNumbers.size,
        failedCount: failedNumbers.size, missingPhoneCount, invalidPhoneCount,
        message: 'New agents were processed for the sector WhatsApp group.',
      };
    }, { timeout: 35000 });
    await logAction(req.user.id, 'ADD_SECTOR_WHATSAPP_GROUP_MEMBERS', 'Territory', sector.id, {
      sectorName: sector.name, provider: 'whapi', consentConfirmed: true,
      requestedCount: updated.attemptedCount, addedCount: updated.addedCount,
      failedCount: updated.failedCount, missingPhoneCount, invalidPhoneCount,
    }, req);
    return res.json(updated);
  } catch (error) {
    if (error.statusCode === 409) return res.status(409).json({ error: error.message });
    if (error.statusCode === 503) return res.status(503).json({ error: error.message });
    if (error.statusCode && error.statusCode < 500) {
      return res.status(error.statusCode).json({ error: 'The WhatsApp provider could not complete this group action. Check its channel connection and group permissions.' });
    }
    console.error('WhatsApp sector group operation failed:', error.statusCode || error.code || error.name);
    res.status(502).json({ error: error.message || 'Could not complete the WhatsApp group operation.' });
  }
});

router.get('/moola-plus-sector-groups', authenticateToken, requireTerritoryAccess, requireRole('TC'), async (req, res) => {
  try { res.json(await getMoolaPlusGroups(req)); }
  catch (error) {
    console.error('Moola Plus WhatsApp groups error:', error.statusCode || error.code || error.name);
    res.status(error.statusCode || 502).json({ error: error.message || 'Could not load Moola Plus sector groups.' });
  }
});

router.put('/moola-plus-sector-groups/:groupId', authenticateToken, requireTerritoryAccess, requireRole('TC'), async (req, res) => {
  try {
    const group = (await getMoolaPlusGroups(req)).find((item) => item.id === String(req.params.groupId));
    if (!group) return res.status(404).json({ error: 'This Moola Plus sector is not in your assigned districts.' });
    const inviteUrl = String(req.body.inviteUrl || '').trim();
    let normalizedUrl = '';
    if (inviteUrl) {
      const url = new URL(inviteUrl);
      if (url.protocol !== 'https:' || url.hostname !== 'chat.whatsapp.com' || !/^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return res.status(400).json({ error: 'Paste a valid WhatsApp group invite link from chat.whatsapp.com.' });
      normalizedUrl = url.toString();
    }
    const key = moolaWhatsAppInviteKey(group.id);
    const saved = await prisma.$transaction(async (tx) => {
      await advisoryTransactionLock(tx, group.id, 'WHATSAPP_MOOLA_PLUS_GROUP');
      const current = await tx.systemConfig.findUnique({ where: { key: moolaWhatsAppGroupKey(group.id) }, select: { value: true } });
      if (parseSystemConfigJson(current?.value)?.groupId) {
        const conflict = new Error('This sector already has a provider-managed group. Its invite link is managed by the group integration.');
        conflict.statusCode = 409;
        throw conflict;
      }
      if (!normalizedUrl) { await tx.systemConfig.deleteMany({ where: { key } }); return ''; }
      await tx.systemConfig.upsert({ where: { key }, create: { key, value: normalizedUrl, description: `WhatsApp invite for Moola Plus ${group.name}, ${group.districtName}`, updatedById: req.user.id }, update: { value: normalizedUrl, description: `WhatsApp invite for Moola Plus ${group.name}, ${group.districtName}`, updatedById: req.user.id } });
      return normalizedUrl;
    }, { timeout: 10000 });
    await logAction(req.user.id, saved ? 'SAVE_MOOLA_PLUS_WHATSAPP_INVITE' : 'REMOVE_MOOLA_PLUS_WHATSAPP_INVITE', 'MoolaPlusWhatsAppGroup', group.id, { sectorName: group.name, districtName: group.districtName }, req);
    res.json({ groupId: group.id, inviteUrl: saved });
  } catch (error) {
    if (error instanceof TypeError) return res.status(400).json({ error: 'Paste a valid WhatsApp group invite link.' });
    if (error.statusCode === 409) return res.status(409).json({ error: error.message });
    console.error('Save Moola Plus WhatsApp invite failed:', error.statusCode || error.code || error.name);
    res.status(error.statusCode || 500).json({ error: error.message || 'Could not save the WhatsApp group invite link.' });
  }
});

router.post('/moola-plus-sector-groups/:groupId/create', authenticateToken, requireTerritoryAccess, requireRole('TC'), async (req, res) => {
  if (req.body?.confirmAgentConsent !== true) return res.status(400).json({ error: 'Confirm that every agent being added agreed to join this group and share their phone number with the WhatsApp provider.' });
  if (!whatsAppProviderReady()) return res.status(503).json({ error: 'Automatic WhatsApp group creation is not configured. An administrator must set WHAPI_API_TOKEN for AgentsService.' });
  try {
    const group = (await getMoolaPlusGroups(req)).find((item) => item.id === String(req.params.groupId));
    if (!group) return res.status(404).json({ error: 'This Moola Plus sector is not in your assigned districts.' });
    const byNumber = new Map();
    let missingPhoneCount = 0;
    let invalidPhoneCount = 0;
    for (const agent of group.agents) {
      if (!agent.phoneNumber.trim()) { missingPhoneCount += 1; continue; }
      const number = normalizeWhatsAppNumber(agent.phoneNumber);
      if (!number) { invalidPhoneCount += 1; continue; }
      if (!byNumber.has(number)) byNumber.set(number, []);
      byNumber.get(number).push(agent.id);
    }
    if (!byNumber.size) return res.status(400).json({ error: 'No Moola Plus agents in this sector have a valid phone number.', missingPhoneCount, invalidPhoneCount });
    if (byNumber.size > 1023) return res.status(400).json({ error: 'This sector has more numbers than one WhatsApp group can hold. Split the group or use its manual invite link.' });

    const key = moolaWhatsAppGroupKey(group.id);
    const reserved = await prisma.$transaction(async (tx) => {
      await advisoryTransactionLock(tx, group.id, 'WHATSAPP_MOOLA_PLUS_GROUP');
      const existing = await tx.systemConfig.findUnique({ where: { key }, select: { value: true } });
      const current = parseSystemConfigJson(existing?.value);
      if (current) return { group: current, created: false };
      const invite = await tx.systemConfig.findUnique({ where: { key: moolaWhatsAppInviteKey(group.id) }, select: { value: true } });
      if (invite?.value) { const conflict = new Error('A manual WhatsApp group link is already saved for this sector. Remove it before creating a provider-managed group.'); conflict.statusCode = 409; throw conflict; }
      const pending = { provider: 'whapi', status: 'creating', requestId: crypto.randomUUID(), groupName: `DDIN ${group.name} ${group.districtName}`.slice(0, 25), createdAt: new Date().toISOString(), createdById: req.user.id, attemptedAgentIds: [], addedAgentIds: [], failedAgentIds: [], attemptedCount: 0, addedCount: 0, failedCount: 0 };
      await saveMoolaWhatsAppGroup(tx, group, pending, req.user.id);
      return { group: pending, created: true };
    }, { timeout: 10000 });
    if (reserved.group.status === 'creating' && !reserved.created) return res.status(409).json({ error: 'A previous group creation may still be in progress. Check the provider account before trying again.' });
    if (reserved.group.status === 'needs_review') return res.status(409).json({ error: 'An administrator needs to review the WhatsApp provider account before retrying this group.' });

    if (reserved.created) {
      let providerGroup;
      try { providerGroup = await whapiRequest('/groups', { method: 'POST', body: { subject: reserved.group.groupName, participants: [...byNumber.keys()] } }); }
      catch (error) {
        if (error.ambiguous) await saveMoolaWhatsAppGroup(prisma, group, { ...reserved.group, status: 'needs_review' }, req.user.id);
        else await prisma.systemConfig.deleteMany({ where: { key } });
        throw error;
      }
      const groupId = extractWhapiGroupId(providerGroup);
      if (!groupId) { await saveMoolaWhatsAppGroup(prisma, group, { ...reserved.group, status: 'needs_review' }, req.user.id); return res.status(502).json({ error: 'The provider did not return a usable group ID. Ask an administrator to review the provider account before retrying.' }); }
      const requested = new Set(byNumber.keys());
      const { addedNumbers, failedNumbers } = getProviderParticipantResult(providerGroup, requested);
      let inviteUrl = '';
      try { inviteUrl = await getWhapiInviteUrl(groupId); } catch (error) { console.error('Moola Plus invite lookup failed:', error.statusCode || error.name); }
      const activeGroup = { ...reserved.group, status: 'active', groupId, inviteUrl, attemptedAgentIds: [...new Set([...requested].flatMap((number) => byNumber.get(number) || []))], addedAgentIds: [...new Set([...addedNumbers].flatMap((number) => byNumber.get(number) || []))], failedAgentIds: [...new Set([...failedNumbers].flatMap((number) => byNumber.get(number) || []))], attemptedCount: requested.size, addedCount: addedNumbers.size, failedCount: failedNumbers.size };
      await saveMoolaWhatsAppGroup(prisma, group, activeGroup, req.user.id);
      await logAction(req.user.id, 'CREATE_MOOLA_PLUS_WHATSAPP_GROUP', 'MoolaPlusWhatsAppGroup', group.id, { sectorName: group.name, districtName: group.districtName, consentConfirmed: true, requestedCount: requested.size, addedCount: addedNumbers.size, failedCount: failedNumbers.size, missingPhoneCount, invalidPhoneCount }, req);
      return res.status(201).json({ groupId: group.id, groupName: activeGroup.groupName, inviteUrl, created: true, attemptedCount: requested.size, addedCount: addedNumbers.size, failedCount: failedNumbers.size, missingPhoneCount, invalidPhoneCount, message: inviteUrl ? 'WhatsApp group created.' : 'WhatsApp group created, but no invite link was returned. Ask an administrator to refresh it.' });
    }

    const stored = reserved.group;
    if (!stored.groupId || stored.status !== 'active') return res.status(409).json({ error: 'This group is not ready for member updates. Ask an administrator to review its provider status.' });
    const attempted = new Set(stored.attemptedAgentIds || []);
    const newNumbers = [...byNumber.entries()].filter(([, ids]) => !ids.every((id) => attempted.has(id))).map(([number]) => number);
    if (!newNumbers.length) return res.json({ groupId: group.id, groupName: stored.groupName, inviteUrl: stored.inviteUrl || '', created: false, attemptedCount: 0, addedCount: 0, failedCount: stored.failedCount || 0, missingPhoneCount, invalidPhoneCount, message: 'This group already includes all recorded Moola Plus agent numbers.' });
    const requested = new Set(newNumbers);
    const providerResult = await whapiRequest(`/groups/${encodeURIComponent(stored.groupId)}/participants`, { method: 'POST', body: { participants: newNumbers } });
    const { addedNumbers, failedNumbers } = getProviderParticipantResult(providerResult, requested);
    const updated = { ...stored, attemptedAgentIds: [...new Set([...attempted, ...newNumbers.flatMap((number) => byNumber.get(number) || [])])], addedAgentIds: [...new Set([...(stored.addedAgentIds || []), ...[...addedNumbers].flatMap((number) => byNumber.get(number) || [])])], failedAgentIds: [...new Set([...(stored.failedAgentIds || []), ...[...failedNumbers].flatMap((number) => byNumber.get(number) || [])])], attemptedCount: (stored.attemptedCount || 0) + newNumbers.length, addedCount: (stored.addedCount || 0) + addedNumbers.size, failedCount: (stored.failedCount || 0) + failedNumbers.size };
    await saveMoolaWhatsAppGroup(prisma, group, updated, req.user.id);
    await logAction(req.user.id, 'ADD_MOOLA_PLUS_WHATSAPP_GROUP_MEMBERS', 'MoolaPlusWhatsAppGroup', group.id, { sectorName: group.name, districtName: group.districtName, consentConfirmed: true, requestedCount: newNumbers.length, addedCount: addedNumbers.size, failedCount: failedNumbers.size, missingPhoneCount, invalidPhoneCount }, req);
    res.json({ groupId: group.id, groupName: updated.groupName, inviteUrl: updated.inviteUrl || '', created: false, attemptedCount: newNumbers.length, addedCount: addedNumbers.size, failedCount: failedNumbers.size, missingPhoneCount, invalidPhoneCount, message: 'New Moola Plus agents were processed for the WhatsApp group.' });
  } catch (error) {
    if ([409, 503].includes(error.statusCode)) return res.status(error.statusCode).json({ error: error.message });
    if (error.statusCode && error.statusCode < 500) return res.status(error.statusCode).json({ error: 'The WhatsApp provider could not complete this group action.' });
    console.error('Moola Plus WhatsApp group operation failed:', error.statusCode || error.code || error.name);
    res.status(error.statusCode || 502).json({ error: error.message || 'Could not complete the Moola Plus WhatsApp group operation.' });
  }
});

async function lockAgentMoveAndCheckPending(tx, agentId) {
  await advisoryTransactionLock(tx, agentId, 'AGENT_MOVE');
  const [pendingTransfer, pendingRelocation] = await Promise.all([
    tx.agentTransfer.findFirst({ where: { agentId, status: 'PENDING' }, select: { id: true } }),
    tx.agentRelocationRequest.findFirst({ where: { agentId, status: 'PENDING' }, select: { id: true } }),
  ]);
  if (pendingTransfer || pendingRelocation) {
    const conflict = new Error(pendingTransfer
      ? 'This agent has a pending territory transfer. Resolve it before relocating the agent.'
      : 'This agent has a relocation request awaiting admin review. Review it before making another move.');
    conflict.statusCode = 409;
    throw conflict;
  }
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
  const planId = String(req.query.planId || '').trim();
  if (planId) {
    if (req.user.role !== 'TC') return res.status(403).json({ error: 'Only the assigned coordinator can load agents from this plan.' });
    const plan = await prisma.visitPlan.findUnique({ where: { id: planId }, include: { territory: { select: { id: true, type: true, parentId: true } } } });
    if (!plan || plan.tcId !== req.user.id) return res.status(404).json({ error: 'Field plan not found.' });
    const today = kigaliDateKey();
    if (today < plan.planDate.toISOString().slice(0, 10) || today > plan.endDate.toISOString().slice(0, 10)) return res.status(409).json({ error: 'This plan is not active today. Choose an active plan or browse agents without a plan.' });
    const areaField = { DISTRICT: 'territoryId', SECTOR: 'sectorId', CELL: 'cellId', VILLAGE: 'villageId' }[plan.territory.type];
    if (areaField) where.AND = [...(where.AND || []), { [areaField]: plan.territory.id }];
    else if (plan.territory.type === 'PROVINCE') {
      const provinceDistricts = await prisma.territory.findMany({ where: { type: 'DISTRICT', parentId: plan.territory.id, isActive: true, id: { in: assignedTerritories } }, select: { id: true } });
      where.AND = [...(where.AND || []), { territoryId: { in: provinceDistricts.map(({ id }) => id) } }];
    }
  }
  const priorityAgentIds = queryIds(req.query.priorityAgentIds);
  if (priorityAgentIds.length) where.id = { in: priorityAgentIds };
  const search = String(req.query.search || '').trim();
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { agentId: { contains: search, mode: 'insensitive' } },
      { businessName: { contains: search, mode: 'insensitive' } },
      { venue: { contains: search, mode: 'insensitive' } },
      { phoneNumber: { contains: search, mode: 'insensitive' } }
    ];
  }

  if (req.user.role === 'TC') {
    where.AND = [...(where.AND || []), { OR: [
      { isOnHold: false },
      { isOnHold: true, transfers: { some: { recipientTcId: req.user.id, status: 'PENDING' } } },
    ] }];
  } else {
    where.isOnHold = false;
  }

  // Coordinators see their districts and transfer requests routed to them.
  if (req.user.role === 'TC') {
    const territoryScope = requestedTerritoryId
      ? [{ territoryId: requestedTerritoryId }, { transfers: { some: { recipientTcId: req.user.id, status: 'PENDING', toTerritoryId: requestedTerritoryId } } }]
      : [{ territoryId: { in: assignedTerritories } }, pendingTransferScope];
    where.AND = [...(where.AND || []), { OR: territoryScope }];
    where.AND.push({ OR: [
      { NOT: { transfers: { some: { status: 'PENDING', requestedByTcId: req.user.id } } } },
      { transfers: { some: { status: 'PENDING', recipientTcId: req.user.id } } },
    ] });
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

  try {
    const counts = await prisma.agent.groupBy({ by: ['status', 'locationVerified'], where, _count: { _all: true } });
    const summary = counts.reduce((result, group) => {
      const count = group._count._all;
      result.total += count;
      if (group.status === 'ACTIVE') result.active += count;
      if (group.locationVerified) result.locationVerified += count;
      return result;
    }, { total: 0, active: 0, locationVerified: 0 });
    const { total, active: activeCount, locationVerified: verifiedCount } = summary;
    const pages = Math.ceil(total / limit);
    const page = Math.min(safePage, Math.max(pages, 1));
    const agents = await prisma.agent.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: {
        id: true, agentId: true, name: true, phoneNumber: true, businessName: true, venue: true, address: true,
        status: true, territoryId: true, sectorId: true, cellId: true, villageId: true,
        registeredLatitude: true, registeredLongitude: true, gpsAccuracy: true, locationVerified: true,
        firstVisitLocationCapturedAt: true, firstVisitCompletedAt: true,
        territory: { select: { id: true, name: true } },
        sector: { select: { id: true, name: true } },
        cell: { select: { id: true, name: true } },
        village: { select: { id: true, name: true } },
        champion: { select: { id: true, firstName: true, lastName: true } },
        transfers: {
          where: { status: 'PENDING', ...(req.user.role === 'TC' ? { recipientTcId: req.user.id } : {}) },
          select: {
            id: true, fromTerritoryId: true, toTerritoryId: true, recipientTcId: true,
            status: true, acceptedAt: true, requestedAt: true, adminRoutedAt: true,
            toTerritory: { select: { id: true, name: true } },
            requestedByTc: { select: { id: true, firstName: true, lastName: true } },
          },
        },
        ...(req.user.role === 'ADMIN' ? { relocationRequests: {
          where: { status: 'PENDING' },
          take: 1,
          select: { id: true, requestedAt: true },
        } } : {}),
      },
    });
    const lastQualifiedVisitByAgent = await latestQualifiedVisits(prisma, 'IREMBO', agents.map(({ id }) => id));
    const agentsWithCoverage = agents.map((agent) => ({
      ...agent,
      ...coverageState(lastQualifiedVisitByAgent.get(agent.id)),
    }));
    if (priorityAgentIds.length) {
      const priorityOrder = new Map(priorityAgentIds.map((id, index) => [id, index]));
      agentsWithCoverage.sort((a, b) => (priorityOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (priorityOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER));
    }

    res.json({
      data: agentsWithCoverage,
      total,
      page,
      limit,
      pages,
      summary: { active: activeCount, locationVerified: verifiedCount },
    });
  } catch (error) {
    console.error('List agents error:', error);
    if (isDatabaseSchemaError(error)) return res.status(503).json({ error: databaseMigrationMessage });
    res.status(500).json({ error: 'Could not load agents.' });
  }
});

router.get('/offline-pack', authenticateToken, requireTerritoryAccess, requireRole('TC'), async (req, res) => {
  try {
    const territoryIds = req.user.assignedTerritories || [];
    const [agents, geofence, checklist, territories] = await Promise.all([
      prisma.agent.findMany({
        where: {
          status: 'ACTIVE',
          isOnHold: false,
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
          venue: true,
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
          transfers: { where: { recipientTcId: req.user.id, status: 'PENDING' }, select: { id: true, fromTerritoryId: true, toTerritoryId: true, status: true, acceptedAt: true, requestedAt: true, adminRoutedAt: true } },
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
    const lastQualifiedVisitByAgent = await latestQualifiedVisits(prisma, 'IREMBO', agents.map(({ id }) => id));
    const agentsWithCoverage = agents.map((agent) => ({
      ...agent,
      ...coverageState(lastQualifiedVisitByAgent.get(agent.id)),
    }));
    let checklistSchema = [];
    if (checklist?.value) {
      const parsed = JSON.parse(checklist.value);
      checklistSchema = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.questions) ? parsed.questions : [];
    }
    res.json({
      userId: req.user.id,
      downloadedAt: new Date().toISOString(),
      agents: agentsWithCoverage,
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
    const venue = String(req.body.venue || '').trim();
    if (!venue) return res.status(400).json({ error: 'Enter the agent’s venue.' });
    if (venue.length > 200) return res.status(400).json({ error: 'Venue must be 200 characters or fewer.' });
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
        venue,
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

router.get('/movement-notices', authenticateToken, requireRole('TC'), async (req, res) => {
  try {
    const notices = await prisma.agentMovementNotice.findMany({ where: { recipientTcId: req.user.id, readAt: null }, orderBy: { createdAt: 'desc' }, take: 20 });
    res.json(notices);
  } catch (error) {
    console.error('Agent movement notices error:', error.code || error.name);
    res.status(500).json({ error: 'Could not load agent movement updates.' });
  }
});

router.patch('/movement-notices/:id/read', authenticateToken, requireRole('TC'), async (req, res) => {
  try {
    const updated = await prisma.agentMovementNotice.updateMany({ where: { id: req.params.id, recipientTcId: req.user.id, readAt: null }, data: { readAt: new Date() } });
    if (!updated.count) return res.status(404).json({ error: 'This movement update is no longer available.' });
    res.json({ id: req.params.id, read: true });
  } catch (error) {
    console.error('Agent movement notice acknowledgement error:', error.code || error.name);
    res.status(500).json({ error: 'Could not acknowledge this movement update.' });
  }
});

router.get('/:id/transfer-targets', authenticateToken, requireTerritoryAccess, requireRole('TC'), async (req, res) => {
  const agent = await prisma.agent.findUnique({ where: { id: req.params.id }, select: { id: true, territoryId: true, firstVisitLocationCapturedAt: true, firstVisitCompletedAt: true } });
  if (!agent) return res.status(404).json({ error: 'Agent not found.' });
  if (!(req.user.assignedTerritories || []).includes(agent.territoryId)) return res.status(403).json({ error: 'This agent is outside your assigned district.' });
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

router.post('/irembo/:agentCode/field-record', authenticateToken, requireTerritoryAccess, requireRole('ADMIN', 'TC'), async (req, res) => {
  try {
    const agent = await ensureIremboFieldAgent(req, req.params.agentCode);
    if (req.user.role === 'TC' && !(req.user.assignedTerritories || []).includes(agent.territoryId)) return res.status(403).json({ error: 'This Irembo agent is outside your assigned district.' });
    await logAction(req.user.id, 'LINK_IREMBO_FIELD_RECORD', 'Agent', agent.id, { agentCode: agent.agentId }, req);
    res.json(agent);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Irembo field record link failed:', error.code || error.name);
    res.status(500).json({ error: 'Could not prepare this Irembo agent for field actions.' });
  }
});

router.post('/:id/admin-transfer', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  try {
    const agent = await prisma.agent.findUnique({ where: { id: req.params.id }, select: { id: true, agentId: true, name: true, phoneNumber: true, territoryId: true } });
    if (!agent) return res.status(404).json({ error: 'Agent not found.' });
    const toTerritoryId = String(req.body.toTerritoryId || '').trim();
    const recipientTcId = String(req.body.recipientTcId || '').trim();
    const destination = await prisma.tcTerritoryAssignment.findFirst({ where: { territoryId: toTerritoryId, tcId: recipientTcId, isActive: true, territory: { is: { type: 'DISTRICT', isActive: true } }, tc: { is: { role: 'TC', isActive: true } } }, select: { territory: { select: { id: true, name: true } }, tc: { select: { id: true, firstName: true, lastName: true } } } });
    if (!destination || toTerritoryId === agent.territoryId) return res.status(400).json({ error: 'Choose an active TC assigned to a different district.' });
    const transfer = await prisma.$transaction(async (tx) => {
      await advisoryTransactionLock(tx, agent.id, 'AGENT_MOVE');
      const [pendingTransfer, pendingRelocation, sourceAssignment] = await Promise.all([
        tx.agentTransfer.findFirst({ where: { agentId: agent.id, status: { in: ['PENDING', 'ON_HOLD'] } }, select: { id: true } }),
        tx.agentRelocationRequest.findFirst({ where: { agentId: agent.id, status: 'PENDING' }, select: { id: true } }),
        tx.tcTerritoryAssignment.findFirst({ where: { territoryId: agent.territoryId, isActive: true, tc: { is: { role: 'TC', isActive: true } } }, select: { tcId: true } }),
      ]);
      if (pendingTransfer || pendingRelocation) throw Object.assign(new Error(pendingTransfer ? 'This agent already has a transfer awaiting review.' : 'This agent already has a relocation request awaiting review.'), { statusCode: 409 });
      const created = await tx.agentTransfer.create({ data: {
        agentId: agent.id, fromTerritoryId: agent.territoryId, toTerritoryId, requestedByTcId: sourceAssignment?.tcId || req.user.id,
        recipientTcId, reason: String(req.body.reason || '').trim().slice(0, 500) || null, adminRoutedAt: new Date(),
      }, include: { fromTerritory: { select: { id: true, name: true } }, toTerritory: { select: { id: true, name: true } }, recipientTc: { select: { id: true, firstName: true, lastName: true } } } });
      if (sourceAssignment?.tcId) await tx.agentMovementNotice.create({ data: { recipientTcId: sourceAssignment.tcId, agentId: agent.id, network: 'IREMBO', agentName: agent.name, agentCode: agent.agentId, noticeType: 'TRANSFER_ROUTED', fromTerritoryName: (await tx.territory.findUnique({ where: { id: agent.territoryId }, select: { name: true } }))?.name, toTerritoryName: destination.territory.name } });
      return created;
    }, { maxWait: 10000, timeout: 15000 });
    await logAction(req.user.id, 'ADMIN_ROUTE_AGENT_TRANSFER', 'Agent', agent.id, { transferId: transfer.id, fromTerritoryId: agent.territoryId, toTerritoryId, recipientTcId }, req);
    res.status(201).json(transfer);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Admin agent transfer routing failed:', error.code || error.name);
    res.status(500).json({ error: 'Could not route this agent to the selected TC.' });
  }
});

router.get('/transfer-holds', authenticateToken, requireRole('ADMIN'), async (_req, res) => {
  try {
    const transfers = await prisma.agentTransfer.findMany({
      where: { status: 'ON_HOLD' },
      include: {
        agent: { select: { id: true, agentId: true, name: true, phoneNumber: true, businessName: true, territory: { select: { id: true, name: true } } } },
        fromTerritory: { select: { id: true, name: true, parent: { select: { name: true } } } },
        toTerritory: { select: { id: true, name: true, parent: { select: { name: true } } } },
        requestedByTc: { select: { id: true, firstName: true, lastName: true, phoneNumber: true } },
        recipientTc: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: [{ reviewedAt: 'asc' }, { requestedAt: 'asc' }],
    });
    res.json(transfers);
  } catch (error) {
    console.error('Transfer hold inbox error:', error.code || error.name);
    res.status(500).json({ error: 'Could not load agents waiting for administrator reassignment.' });
  }
});

router.get('/transfer-hold-targets', authenticateToken, requireRole('ADMIN'), async (_req, res) => {
  try {
    const assignments = await prisma.tcTerritoryAssignment.findMany({
      where: { isActive: true, territory: { is: { type: 'DISTRICT', isActive: true } }, tc: { is: { role: 'TC', isActive: true } } },
      include: { territory: { select: { id: true, name: true, parent: { select: { name: true } } } }, tc: { select: { id: true, firstName: true, lastName: true } } },
    });
    const targets = new Map();
    for (const assignment of assignments) {
      const target = targets.get(assignment.territoryId) || { id: assignment.territoryId, name: assignment.territory.name, province: assignment.territory.parent?.name || '', coordinators: [] };
      if (!target.coordinators.some((tc) => tc.id === assignment.tc.id)) target.coordinators.push(assignment.tc);
      targets.set(assignment.territoryId, target);
    }
    res.json([...targets.values()].sort((a, b) => a.name.localeCompare(b.name)));
  } catch (error) {
    console.error('Transfer hold destination list error:', error.code || error.name);
    res.status(500).json({ error: 'Could not load active coordinator districts.' });
  }
});

router.put('/transfer-holds/:id/route', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  try {
    const toTerritoryId = String(req.body.toTerritoryId || '').trim();
    const recipientTcId = String(req.body.recipientTcId || '').trim();
    const destination = toTerritoryId ? await prisma.tcTerritoryAssignment.findFirst({
      where: { territoryId: toTerritoryId, tcId: recipientTcId, isActive: true, territory: { is: { type: 'DISTRICT', isActive: true } }, tc: { is: { role: 'TC', isActive: true } } },
      select: { territory: { select: { id: true, name: true } }, tc: { select: { id: true, firstName: true, lastName: true } } },
    }) : null;
    if (!destination) return res.status(400).json({ error: 'Choose an active TC assigned to the destination district.' });
    const transfer = await prisma.$transaction(async (tx) => {
      const current = await tx.agentTransfer.findUnique({ where: { id: req.params.id }, select: { id: true, agentId: true, status: true, fromTerritoryId: true, toTerritoryId: true } });
      if (!current || current.status !== 'ON_HOLD') {
        const conflict = new Error('This held agent has already been routed or reviewed. Refresh the request list.');
        conflict.statusCode = current ? 409 : 404;
        throw conflict;
      }
      await advisoryTransactionLock(tx, current.agentId, 'AGENT_MOVE');
      const claimed = await tx.agentTransfer.updateMany({ where: { id: current.id, status: 'ON_HOLD' }, data: {
        status: 'PENDING', toTerritoryId, recipientTcId, adminRoutedAt: new Date(), acceptedAt: null, reviewedAt: null,
      } });
      if (!claimed.count) {
        const conflict = new Error('This held agent has already been routed or reviewed. Refresh the request list.');
        conflict.statusCode = 409;
        throw conflict;
      }
      return tx.agentTransfer.findUnique({ where: { id: current.id }, include: { agent: true, toTerritory: true, recipientTc: { select: { id: true, firstName: true, lastName: true } } } });
    });
    await logAction(req.user.id, 'ADMIN_ROUTE_HELD_AGENT', 'Agent', transfer.agentId, { transferId: transfer.id, toTerritoryId, recipientTcId }, req);
    res.json(transfer);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Admin transfer routing failed:', error.code || error.name);
    res.status(500).json({ error: 'Could not route this held agent.' });
  }
});

router.post('/:id/transfer', authenticateToken, requireTerritoryAccess, requireRole('TC'), async (req, res) => {
  try {
    const agent = await prisma.agent.findUnique({ where: { id: req.params.id }, select: { id: true, territoryId: true, name: true, agentId: true, phoneNumber: true } });
    if (!agent) return res.status(404).json({ error: 'Agent not found.' });
    if (!(req.user.assignedTerritories || []).includes(agent.territoryId)) return res.status(403).json({ error: 'This agent is outside your assigned district.' });
    if (!String(agent.phoneNumber || '').trim()) return res.status(409).json({ error: 'Add the agent’s phone number before requesting a transfer so the receiving TC can call and confirm their location.' });
    const toTerritoryId = String(req.body.toTerritoryId || '');
    const recipientTcId = String(req.body.recipientTcId || '');
    const destination = toTerritoryId ? await prisma.territory.findUnique({ where: { id: toTerritoryId }, select: { id: true, type: true, isActive: true } }) : null;
    if (!destination || destination.type !== 'DISTRICT' || !destination.isActive || toTerritoryId === agent.territoryId || (req.user.assignedTerritories || []).includes(toTerritoryId)) {
      return res.status(400).json({ error: 'Choose a different active district outside your assigned territories.' });
    }
    const receiverAssignment = await prisma.tcTerritoryAssignment.findFirst({ where: { tcId: recipientTcId, territoryId: toTerritoryId, isActive: true, tc: { is: { role: 'TC', isActive: true } } } });
    if (!receiverAssignment) return res.status(400).json({ error: 'Choose an active coordinator assigned to the destination district.' });
    const transfer = await prisma.$transaction(async (tx) => {
      await advisoryTransactionLock(tx, agent.id, 'AGENT_MOVE');
      const existingTransfer = await tx.agentTransfer.findFirst({ where: { agentId: agent.id, status: 'PENDING' } });
      if (existingTransfer) {
        const conflict = new Error('This agent already has a pending territory transfer.');
        conflict.statusCode = 409;
        throw conflict;
      }
      const pendingRelocation = await tx.agentRelocationRequest.findFirst({ where: { agentId: agent.id, status: 'PENDING' }, select: { id: true } });
      if (pendingRelocation) {
        const conflict = new Error('This agent already has a relocation request awaiting admin review.');
        conflict.statusCode = 409;
        throw conflict;
      }
      return tx.agentTransfer.create({ data: {
        agentId: agent.id,
        fromTerritoryId: agent.territoryId,
        toTerritoryId,
        requestedByTcId: req.user.id,
        recipientTcId,
        reason: String(req.body.reason || '').trim().slice(0, 500) || null,
      }, include: { toTerritory: true, recipientTc: { select: { id: true, firstName: true, lastName: true } } } });
    }, { maxWait: 10000, timeout: 15000 });
    await logAction(req.user.id, 'REQUEST_AGENT_TRANSFER', 'Agent', agent.id, {
      agentName: agent.name, agentCode: agent.agentId, transferId: transfer.id, fromTerritoryId: agent.territoryId,
      toTerritoryId, toTerritoryName: transfer.toTerritory.name, recipientTcId, recipientTcName: `${transfer.recipientTc.firstName} ${transfer.recipientTc.lastName}`.trim(),
    }, req);
    res.status(201).json(transfer);
  } catch (error) {
    console.error('Agent transfer request failed:', error.code || error.name);
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    if (error.code === 'P2002') return res.status(409).json({ error: 'This agent already has a pending territory transfer.' });
    res.status(500).json({ error: 'Could not send this agent transfer request.' });
  }
});

router.get('/transfer-inbox', authenticateToken, requireTerritoryAccess, requireRole('TC'), async (req, res) => {
  try {
    const transfers = await prisma.agentTransfer.findMany({
      where: { recipientTcId: req.user.id, status: 'PENDING', acceptedAt: null },
      include: {
        agent: { select: { id: true, agentId: true, name: true, phoneNumber: true, businessName: true, address: true } },
        fromTerritory: { select: { id: true, name: true, parent: { select: { name: true } } } },
        toTerritory: { select: { id: true, name: true, parent: { select: { name: true } } } },
        requestedByTc: { select: { id: true, firstName: true, lastName: true, phoneNumber: true } },
      },
      orderBy: { requestedAt: 'asc' },
    });
    res.json(transfers);
  } catch (error) {
    console.error('Transfer inbox error:', error.code || error.name);
    res.status(500).json({ error: 'Could not load incoming transfer requests.' });
  }
});

router.put('/transfer-requests/:id/review', authenticateToken, requireTerritoryAccess, requireRole('TC'), async (req, res) => {
  try {
    const decision = String(req.body.decision || '').toUpperCase();
    if (!['ACCEPT', 'REJECT'].includes(decision)) return res.status(400).json({ error: 'Choose whether to accept or reject this transfer.' });
    const reviewNote = String(req.body.note || '').trim().slice(0, 500) || null;
    if (decision === 'REJECT' && !reviewNote) return res.status(400).json({ error: 'Enter a reason for rejecting this transfer.' });
    const transfer = await prisma.agentTransfer.findUnique({
      where: { id: req.params.id },
      include: { agent: { select: { id: true, agentId: true, name: true } } },
    });
    if (!transfer) return res.status(404).json({ error: 'Transfer request not found.' });
    if (transfer.recipientTcId !== req.user.id) return res.status(403).json({ error: 'This transfer was sent to another coordinator.' });
    if (transfer.status !== 'PENDING' || transfer.acceptedAt) return res.status(409).json({ error: 'This transfer has already been reviewed.' });

    if (decision === 'REJECT') {
      const rejected = await prisma.$transaction(async (tx) => {
        await advisoryTransactionLock(tx, transfer.agentId, 'AGENT_MOVE');
        const changed = await tx.agentTransfer.updateMany({
          where: { id: transfer.id, recipientTcId: req.user.id, status: 'PENDING', acceptedAt: null },
          data: { status: 'ON_HOLD', reviewedAt: new Date(), reviewNote },
        });
        if (!changed.count) return false;
        await tx.agent.update({ where: { id: transfer.agentId }, data: { isOnHold: true } });
        return true;
      });
      if (!rejected) return res.status(409).json({ error: 'This transfer has already been reviewed.' });
      await logAction(req.user.id, 'REJECT_AGENT_TRANSFER', 'Agent', transfer.agentId, { agentName: transfer.agent.name, agentCode: transfer.agent.agentId, transferId: transfer.id, note: reviewNote }, req);
      return res.json({ id: transfer.id, status: 'ON_HOLD', reviewNote });
    }

    if (!(req.user.assignedTerritories || []).includes(transfer.toTerritoryId)) return res.status(403).json({ error: 'You are no longer assigned to the destination district.' });
    const accepted = await prisma.$transaction(async (tx) => {
      await advisoryTransactionLock(tx, transfer.agentId, 'AGENT_MOVE');
      const pendingRelocation = await tx.agentRelocationRequest.findFirst({ where: { agentId: transfer.agentId, status: 'PENDING' }, select: { id: true } });
      if (pendingRelocation) {
        const conflict = new Error('This agent has a relocation request awaiting admin review. Resolve it before accepting the transfer.');
        conflict.statusCode = 409;
        throw conflict;
      }
      const claimed = await tx.agentTransfer.updateMany({
        where: { id: transfer.id, recipientTcId: req.user.id, status: 'PENDING', acceptedAt: null },
        data: { acceptedAt: new Date(), reviewedAt: new Date(), reviewNote },
      });
      if (!claimed.count) {
        const conflict = new Error('This transfer has already been reviewed.');
        conflict.statusCode = 409;
        throw conflict;
      }
      const moved = await tx.agent.updateMany({ where: { id: transfer.agentId, territoryId: transfer.fromTerritoryId }, data: {
        territoryId: transfer.toTerritoryId, sectorId: null, cellId: null, villageId: null,
        address: null, registeredLatitude: null, registeredLongitude: null, gpsAccuracy: null, locationVerified: false,
        isOnHold: false,
      } });
      if (!moved.count) {
        const conflict = new Error('The agent’s territory changed before this transfer was accepted. Refresh the request and review again.');
        conflict.statusCode = 409;
        throw conflict;
      }
      return tx.agentTransfer.findUnique({ where: { id: transfer.id } });
    });
    await logAction(req.user.id, 'ACCEPT_AGENT_TRANSFER', 'Agent', transfer.agentId, { agentName: transfer.agent.name, agentCode: transfer.agent.agentId, transferId: transfer.id, toTerritoryId: transfer.toTerritoryId, note: reviewNote }, req);
    return res.json(accepted);
  } catch (error) {
    console.error('Transfer review failed:', error.code || error.name);
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    res.status(500).json({ error: 'Could not review this transfer request.' });
  }
});

router.post('/:id/relocation-requests', authenticateToken, requireTerritoryAccess, requireRole('TC'), async (req, res) => {
  try {
    const agent = await prisma.agent.findUnique({ where: { id: req.params.id }, select: { id: true, agentId: true, name: true, territoryId: true, sectorId: true, cellId: true, villageId: true, firstVisitLocationCapturedAt: true } });
    if (!agent) return res.status(404).json({ error: 'Agent not found.' });
    const assignedTerritories = req.user.assignedTerritories || [];
    if (!assignedTerritories.includes(agent.territoryId)) return res.status(403).json({ error: 'This agent is outside your assigned district.' });
    if (!agent.firstVisitLocationCapturedAt) return res.status(409).json({ error: 'Use the one-time first-visit location capture before requesting a later relocation.' });
    const toTerritoryId = String(req.body.territoryId || '').trim();
    const toSectorId = String(req.body.sectorId || '').trim();
    const toCellId = String(req.body.cellId || '').trim();
    const toVillageId = String(req.body.villageId || '').trim();
    if (!assignedTerritories.includes(toTerritoryId)) return res.status(403).json({ error: 'Relocation requests must stay inside your assigned districts. Use a transfer request for another TC’s district.' });
    const hierarchyError = await validateAgentHierarchy({ territoryId: toTerritoryId, sectorId: toSectorId, cellId: toCellId, villageId: toVillageId });
    if (hierarchyError) return res.status(400).json({ error: hierarchyError });
    if (agent.territoryId === toTerritoryId && agent.sectorId === toSectorId && agent.cellId === toCellId && agent.villageId === toVillageId) {
      return res.status(400).json({ error: 'Choose a different location before requesting relocation.' });
    }
    const request = await prisma.$transaction(async (tx) => {
      await advisoryTransactionLock(tx, agent.id, 'AGENT_MOVE');
      const currentAgent = await tx.agent.findUnique({ where: { id: agent.id }, select: { territoryId: true, firstVisitLocationCapturedAt: true } });
      if (!currentAgent || currentAgent.territoryId !== agent.territoryId || !currentAgent.firstVisitLocationCapturedAt) {
        const conflict = new Error('The agent changed while this request was being prepared. Reload the profile and try again.');
        conflict.statusCode = 409;
        throw conflict;
      }
      const [pendingRequest, pendingTransfer] = await Promise.all([
        tx.agentRelocationRequest.findFirst({ where: { agentId: agent.id, status: 'PENDING' }, select: { id: true } }),
        tx.agentTransfer.findFirst({ where: { agentId: agent.id, status: 'PENDING' }, select: { id: true } }),
      ]);
      if (pendingRequest || pendingTransfer) {
        const conflict = new Error(pendingRequest ? 'This agent already has a relocation request awaiting admin review.' : 'Resolve the pending territory transfer before requesting a relocation.');
        conflict.statusCode = 409;
        throw conflict;
      }
      const previousTcRelocation = await tx.agentRelocationRequest.findFirst({ where: { agentId: agent.id, status: 'APPROVED' }, select: { id: true } });
      if (previousTcRelocation) {
        const conflict = new Error('The TC relocation allowance for this agent has already been used. Ask an administrator to make any further move.');
        conflict.statusCode = 409;
        throw conflict;
      }
      return tx.agentRelocationRequest.create({ data: {
        agentId: agent.id, fromTerritoryId: currentAgent.territoryId, toTerritoryId, toSectorId, toCellId, toVillageId,
        reason: String(req.body.reason || '').trim().slice(0, 500) || null,
        requestedByTcId: req.user.id,
      } });
    }, { maxWait: 10000, timeout: 15000 });
    await logAction(req.user.id, 'REQUEST_AGENT_RELOCATION', 'Agent', agent.id, { agentName: agent.name, agentCode: agent.agentId, requestId: request.id, fromTerritoryId: agent.territoryId, toTerritoryId }, req);
    res.status(201).json(request);
  } catch (error) {
    console.error('Relocation request failed:', error.code || error.name);
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    if (error.code === 'P2002') return res.status(409).json({ error: 'This agent already has a relocation request awaiting admin review.' });
    res.status(500).json({ error: 'Could not send this relocation request.' });
  }
});

router.get('/relocation-requests', authenticateToken, requireRole('ADMIN'), async (_req, res) => {
  try {
    const requests = await prisma.agentRelocationRequest.findMany({
      where: { status: 'PENDING' },
      include: {
        agent: { select: { id: true, agentId: true, name: true, phoneNumber: true, territory: { select: { name: true } } } },
        fromTerritory: { select: { id: true, name: true } },
        toTerritory: { select: { id: true, name: true } },
        requestedByTc: { select: { id: true, firstName: true, lastName: true, phoneNumber: true } },
      },
      orderBy: { requestedAt: 'asc' },
    });
    const areaIds = [...new Set(requests.flatMap(({ toSectorId, toCellId, toVillageId }) => [toSectorId, toCellId, toVillageId]))];
    const areas = areaIds.length ? await prisma.territory.findMany({ where: { id: { in: areaIds } }, select: { id: true, name: true, type: true } }) : [];
    const areaById = new Map(areas.map((area) => [area.id, area]));
    res.json(requests.map((request) => ({ ...request, destinationPath: [request.toTerritory, areaById.get(request.toSectorId), areaById.get(request.toCellId), areaById.get(request.toVillageId)].filter(Boolean).map(({ name }) => name).join(' · ') })));
  } catch (error) {
    console.error('Relocation request inbox error:', error.code || error.name, error.message);
    if (isDatabaseSchemaError(error)) return res.status(503).json({ error: databaseMigrationMessage });
    res.status(500).json({ error: 'Could not load relocation requests.' });
  }
});

router.put('/relocation-requests/:id/review', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  try {
    const decision = String(req.body.decision || '').toUpperCase();
    if (!['APPROVE', 'REJECT'].includes(decision)) return res.status(400).json({ error: 'Choose whether to approve or reject this relocation.' });
    const reviewNote = String(req.body.note || '').trim().slice(0, 500) || null;
    const request = await prisma.agentRelocationRequest.findUnique({ where: { id: req.params.id }, include: { agent: { select: { id: true, agentId: true, name: true, territoryId: true } } } });
    if (!request) return res.status(404).json({ error: 'Relocation request not found.' });
    if (request.status !== 'PENDING') return res.status(409).json({ error: 'This relocation request has already been reviewed.' });
    if (decision === 'REJECT') {
      const rejected = await prisma.agentRelocationRequest.updateMany({ where: { id: request.id, status: 'PENDING' }, data: { status: 'REJECTED', reviewedById: req.user.id, reviewedAt: new Date(), reviewNote } });
      if (!rejected.count) return res.status(409).json({ error: 'This relocation request has already been reviewed.' });
      await logAction(req.user.id, 'REJECT_AGENT_RELOCATION', 'Agent', request.agentId, { agentName: request.agent.name, agentCode: request.agent.agentId, requestId: request.id, note: reviewNote }, req);
      return res.json({ id: request.id, status: 'REJECTED' });
    }
    const moved = await prisma.$transaction(async (tx) => {
      await advisoryTransactionLock(tx, request.agentId, 'AGENT_MOVE');
      const claimed = await tx.agentRelocationRequest.updateMany({ where: { id: request.id, status: 'PENDING' }, data: { status: 'APPROVED', reviewedById: req.user.id, reviewedAt: new Date(), reviewNote } });
      if (!claimed.count) {
        const conflict = new Error('This relocation request has already been reviewed.');
        conflict.statusCode = 409;
        throw conflict;
      }
      const hierarchy = { territoryId: request.toTerritoryId, sectorId: request.toSectorId, cellId: request.toCellId, villageId: request.toVillageId };
      const hierarchyError = await validateAgentHierarchy(hierarchy, true, tx);
      if (hierarchyError) {
        const conflict = new Error(`The requested location is no longer valid: ${hierarchyError}`);
        conflict.statusCode = 409;
        throw conflict;
      }
      const address = await areaAddress(hierarchy, tx);
      const updated = await tx.agent.updateMany({ where: { id: request.agentId, territoryId: request.fromTerritoryId }, data: {
        ...hierarchy, address, registeredLatitude: null, registeredLongitude: null,
        gpsAccuracy: null, locationVerified: false,
      } });
      if (!updated.count) {
        const conflict = new Error('The agent’s territory changed after this request was submitted. Refresh and review the current location.');
        conflict.statusCode = 409;
        throw conflict;
      }
      return tx.agent.findUnique({ where: { id: request.agentId } });
    });
    await logAction(req.user.id, 'APPROVE_AGENT_RELOCATION', 'Agent', moved.id, { agentName: request.agent.name, agentCode: request.agent.agentId, requestId: request.id, fromTerritoryId: request.fromTerritoryId, toTerritoryId: request.toTerritoryId, note: reviewNote }, req);
    return res.json({ id: request.id, status: 'APPROVED', agent: moved });
  } catch (error) {
    console.error('Relocation review failed:', error.code || error.name);
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    res.status(500).json({ error: 'Could not review this relocation request.' });
  }
});

// A coordinator may set location and village details only before the first visit is completed.
router.post('/:id/location/capture', authenticateToken, requireTerritoryAccess, requireRole('TC'), async (req, res) => {
  try {
    const agent = await prisma.agent.findUnique({ where: { id: req.params.id }, include: { sector: true, cell: true, village: true } });
    if (!agent) return res.status(404).json({ error: 'Agent not found.' });
    const venue = String(req.body.venue || '').trim();
    if (!venue) return res.status(400).json({ error: 'Enter the agent’s venue before capturing the first-visit location.' });
    if (venue.length > 200) return res.status(400).json({ error: 'Venue must be 200 characters or fewer.' });
    const territoryId = String(req.body.territoryId || agent.territoryId);
    const sectorId = String(req.body.sectorId || '');
    let cellId = String(req.body.cellId || '');
    let villageId = String(req.body.villageId || '');
    if (!cellId || !villageId) return res.status(400).json({ error: 'Select a saved cell and village from the official territory list.' });
    const sectorError = await validateAgentHierarchy({ territoryId, sectorId, cellId: '', villageId: '' }, false);
    if (sectorError) return res.status(400).json({ error: sectorError });

    const hierarchyError = await validateAgentHierarchy({ territoryId, sectorId, cellId, villageId });
    if (hierarchyError) return res.status(400).json({ error: hierarchyError });
    const isAssignedHere = (req.user.assignedTerritories || []).includes(territoryId);
    const pendingTransfer = await prisma.agentTransfer.findFirst({ where: { agentId: agent.id, recipientTcId: req.user.id, toTerritoryId: territoryId, status: 'PENDING', acceptedAt: { not: null } } });
    const unreviewedIncomingTransfer = await prisma.agentTransfer.findFirst({ where: { agentId: agent.id, recipientTcId: req.user.id, status: 'PENDING', acceptedAt: null }, select: { id: true } });
    if (unreviewedIncomingTransfer) return res.status(409).json({ error: 'Review and accept this transfer from the dashboard before recording the agent’s location.' });
    const outgoingTransfer = await prisma.agentTransfer.findFirst({ where: { agentId: agent.id, requestedByTcId: req.user.id, status: 'PENDING' } });
    if (territoryId !== agent.territoryId && !pendingTransfer) return res.status(409).json({ error: 'The agent’s district can only change through an approved relocation or accepted transfer.' });
    const needsLocationCapture = agent.registeredLatitude == null || agent.registeredLongitude == null || !agent.locationVerified || (!agent.firstVisitCompletedAt && !agent.firstVisitLocationCapturedAt);
    if (agent.firstVisitCompletedAt && !needsLocationCapture && !pendingTransfer) return res.status(409).json({ error: 'This agent already has a verified location. Request an administrator-approved relocation before changing it.' });
    if (outgoingTransfer && !pendingTransfer) return res.status(409).json({ error: 'This agent is awaiting the destination coordinator. You cannot record their first-visit location.' });
    if (!isAssignedHere && !pendingTransfer) return res.status(403).json({ error: 'This district is outside your assigned territories.' });
    const sameCapture = agent.territoryId === territoryId && agent.sectorId === sectorId && agent.cellId === cellId && agent.villageId === villageId
      && agent.registeredLatitude != null && agent.registeredLongitude != null && agent.locationVerified;
    const { latitude, longitude, accuracy } = req.body;
    const lat = latitude; const lon = longitude; const gpsAccuracy = accuracy;
    if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90 || typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180 || typeof gpsAccuracy !== 'number' || !Number.isFinite(gpsAccuracy) || gpsAccuracy < 0 || gpsAccuracy > 20) {
      return res.status(400).json({ error: 'A precise GPS reading with accuracy of 20 metres or better is required. Move to an open area and try again.' });
    }
    if (agent.firstVisitLocationCapturedAt && !needsLocationCapture && !pendingTransfer) {
      if (sameCapture && Math.abs(agent.registeredLatitude - lat) < 1e-7 && Math.abs(agent.registeredLongitude - lon) < 1e-7) {
        if (agent.venue === venue) return res.json(agent);
        const claimed = await prisma.agent.updateMany({ where: { id: agent.id, firstVisitCompletedAt: null, firstVisitLocationCapturedAt: { not: null } }, data: { venue } });
        if (!claimed.count) return res.status(409).json({ error: 'The agent’s first visit is complete. Only an administrator can change the venue now.' });
        const updated = await prisma.agent.findUnique({ where: { id: agent.id }, include: { territory: true, sector: true, cell: true, village: true } });
        await logAction(req.user.id, 'UPDATE_FIRST_VISIT_VENUE', 'Agent', agent.id, { venue }, req);
        return res.json(updated);
      }
      return res.status(409).json({ error: 'The first-visit territory and GPS capture has already been recorded. Ask an administrator to correct it.' });
    }
    const updated = await prisma.$transaction(async (tx) => {
      await advisoryTransactionLock(tx, agent.id, 'AGENT_MOVE');
      const currentAgent = await tx.agent.findUnique({ where: { id: agent.id }, select: { territoryId: true, sectorId: true, cellId: true, villageId: true, registeredLatitude: true, registeredLongitude: true, locationVerified: true, firstVisitLocationCapturedAt: true, firstVisitCompletedAt: true } });
      if (!currentAgent || currentAgent.territoryId !== agent.territoryId || currentAgent.sectorId !== agent.sectorId || currentAgent.cellId !== agent.cellId || currentAgent.villageId !== agent.villageId || currentAgent.registeredLatitude !== agent.registeredLatitude || currentAgent.registeredLongitude !== agent.registeredLongitude || currentAgent.locationVerified !== agent.locationVerified || currentAgent.firstVisitLocationCapturedAt?.getTime() !== agent.firstVisitLocationCapturedAt?.getTime() || currentAgent.firstVisitCompletedAt?.getTime() !== agent.firstVisitCompletedAt?.getTime()) {
        const conflict = new Error('The agent location changed while this capture was in progress. Reload the agent before continuing.');
        conflict.statusCode = 409;
        throw conflict;
      }
      const resolvedCell = { id: cellId };
      const resolvedVillage = { id: villageId };
      const resolvedCellId = resolvedCell.id;
      const resolvedVillageId = resolvedVillage.id;
      const hierarchyError = await validateAgentHierarchy({ territoryId, sectorId, cellId: resolvedCellId, villageId: resolvedVillageId }, true, tx);
      if (hierarchyError) throw new Error(hierarchyError);
      const currentAddress = await areaAddress({ territoryId, sectorId, cellId: resolvedCellId, villageId: resolvedVillageId }, tx);
      const claimed = await tx.agent.updateMany({
        where: agent.firstVisitCompletedAt || agent.firstVisitLocationCapturedAt ? {
          id: agent.id, territoryId: agent.territoryId, registeredLatitude: agent.registeredLatitude, registeredLongitude: agent.registeredLongitude, locationVerified: agent.locationVerified,
        } : { id: agent.id, firstVisitCompletedAt: null, firstVisitLocationCapturedAt: null },
        data: { territoryId, sectorId, cellId: resolvedCellId, villageId: resolvedVillageId, venue, address: currentAddress, registeredLatitude: lat, registeredLongitude: lon, gpsAccuracy, locationVerified: true, firstVisitLocationCapturedAt: agent.firstVisitLocationCapturedAt || new Date() },
      });
      if (!claimed.count) {
        const conflict = new Error('The agent location changed while this capture was in progress. Reload the agent before continuing.');
        conflict.statusCode = 409;
        throw conflict;
      }
      const recaptureAfterMove = Boolean(agent.firstVisitCompletedAt || agent.firstVisitLocationCapturedAt);
      await tx.agentLocation.create({ data: { agentId: agent.id, latitude: lat, longitude: lon, accuracy: gpsAccuracy, recordedById: req.user.id, reason: pendingTransfer ? 'TRANSFER_LOCATION_CAPTURE' : recaptureAfterMove ? 'RELOCATION_LOCATION_CAPTURE' : 'FIRST_VISIT_LOCATION_CAPTURE' } });
      if (pendingTransfer) await tx.agentTransfer.update({ where: { id: pendingTransfer.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
      return tx.agent.findUnique({ where: { id: agent.id }, include: { territory: true, sector: true, cell: true, village: true } });
    }, { maxWait: 10000, timeout: 15000 });
    await logAction(req.user.id, pendingTransfer ? 'COMPLETE_AGENT_TRANSFER_LOCATION' : agent.firstVisitCompletedAt || agent.firstVisitLocationCapturedAt ? 'CAPTURE_AGENT_LOCATION' : 'CAPTURE_FIRST_VISIT_LOCATION', 'Agent', agent.id, {
      latitude: lat, longitude: lon, accuracy: gpsAccuracy, territoryId, sectorId, cellId: updated.cellId, villageId: updated.villageId, transferId: pendingTransfer?.id || null,
      venue, territoryName: updated.territory?.name, sectorName: updated.sector?.name, cellName: updated.cell?.name, villageName: updated.village?.name,
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
  try {
    const agent = await prisma.agent.findUnique({
      where: { id: req.params.id },
      include: {
        territory: true, sector: true, cell: true, village: true, champion: true,
        transfers: { where: { status: 'PENDING' }, select: { id: true, fromTerritoryId: true, toTerritoryId: true, status: true, acceptedAt: true, requestedAt: true, recipientTcId: true, toTerritory: { select: { id: true, name: true } } } },
        relocationRequests: { where: { status: 'PENDING', ...(req.user.role === 'TC' ? { requestedByTcId: req.user.id } : {}) }, orderBy: { requestedAt: 'desc' }, take: 1, select: { id: true, toTerritoryId: true, status: true, requestedAt: true, toTerritory: { select: { name: true } } } },
      }
    });
    if (!agent) return res.status(404).json({ error: 'Not found' });
    if (req.user.role === 'TC') {
      const [assignments, pendingTransfer, approvedRelocation] = await Promise.all([
        prisma.tcTerritoryAssignment.findMany({ where: { tcId: req.user.id, isActive: true }, select: { territoryId: true } }),
        prisma.agentTransfer.findFirst({ where: { agentId: agent.id, recipientTcId: req.user.id, status: 'PENDING' }, select: { id: true } }),
        prisma.agentRelocationRequest.findFirst({ where: { agentId: agent.id, status: 'APPROVED' }, select: { id: true } }),
      ]);
      if (!assignments.some((assignment) => assignment.territoryId === agent.territoryId) && !pendingTransfer) return res.status(403).json({ error: 'Access denied to this agent.' });
      agent.tcRelocationUsed = Boolean(approvedRelocation);
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
  } catch (error) {
    console.error('Get agent error:', error.code || error.name);
    if (isDatabaseSchemaError(error)) return res.status(503).json({ error: databaseMigrationMessage });
    res.status(500).json({ error: 'Could not load this agent.' });
  }
});

router.put('/:id', authenticateToken, requireRole('ADMIN', 'MANAGER'), async (req, res) => {
  try {
    const {
      registeredLatitude, registeredLongitude, gpsAccuracy, locationVerified,
      nationalId, nextOfKinName, nextOfKinPhone,
      nationalIdEncrypted, nextOfKinNameEncrypted, nextOfKinPhoneEncrypted,
      ...profileFields
    } = req.body;
    if (profileFields.venue !== undefined) {
      profileFields.venue = String(profileFields.venue || '').trim();
      if (!profileFields.venue) return res.status(400).json({ error: 'Enter the agent’s venue.' });
      if (profileFields.venue.length > 200) return res.status(400).json({ error: 'Venue must be 200 characters or fewer.' });
    }
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
      profileFields.registeredLatitude = null;
      profileFields.registeredLongitude = null;
      profileFields.gpsAccuracy = null;
      profileFields.locationVerified = false;
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
      if (locationChanged) await lockAgentMoveAndCheckPending(tx, existing.id);
      const updatedCount = await tx.agent.updateMany({
        where: locationChanged ? {
          id: req.params.id,
          territoryId: existing.territoryId,
          sectorId: existing.sectorId,
          cellId: existing.cellId,
          villageId: existing.villageId,
        } : { id: req.params.id },
        data: profileFields,
      });
      if (!updatedCount.count) {
        const conflict = new Error('The agent record changed before this update was saved. Reload it and try again.');
        conflict.statusCode = 409;
        throw conflict;
      }
      const updated = await tx.agent.findUnique({ where: { id: req.params.id } });
      if (locationChanged && req.user.role === 'ADMIN') await createAgentMovementNotices(tx, { agent: updated, fromTerritoryId: existing.territoryId, toTerritoryId: updated.territoryId, noticeType: 'RELOCATED' });
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
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    res.status(400).json({ error: 'Update failed' });
  }
});

router.patch('/:id/location', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  try {
    const { latitude, longitude, accuracy } = req.body;
    const existing = await prisma.agent.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Agent not found.' });
    
    const nextTerritoryId = req.body.territoryId !== undefined ? req.body.territoryId : existing.territoryId;
    const nextSectorId = req.body.sectorId !== undefined ? req.body.sectorId : existing.sectorId;
    const nextCellId = req.body.cellId !== undefined ? req.body.cellId : existing.cellId;
    const nextVillageId = req.body.villageId !== undefined ? req.body.villageId : existing.villageId;
    const moved = existing.territoryId !== nextTerritoryId || existing.sectorId !== nextSectorId || existing.cellId !== nextCellId || existing.villageId !== nextVillageId;
    if (!moved && (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 20)) {
      return res.status(400).json({ error: 'A GPS reading with accuracy of 20 metres or better is required for a location correction.' });
    }
    const hierarchyError = await validateAgentHierarchy({ territoryId: nextTerritoryId, sectorId: nextSectorId, cellId: nextCellId, villageId: nextVillageId }, moved);
    if (hierarchyError) return res.status(400).json({ error: hierarchyError });
    const reason = String(req.body.reason || '').trim().slice(0, 500) || (moved ? 'Administrator relocation' : 'Administrator GPS correction');
    const currentAddress = moved ? await areaAddress({ territoryId: nextTerritoryId, sectorId: nextSectorId, cellId: nextCellId, villageId: nextVillageId }) : undefined;
    const agent = await prisma.$transaction(async (tx) => {
      await lockAgentMoveAndCheckPending(tx, existing.id);
      const updatedCount = await tx.agent.updateMany({ where: {
        id: req.params.id,
        territoryId: existing.territoryId,
        sectorId: existing.sectorId,
        cellId: existing.cellId,
        villageId: existing.villageId,
      }, data: {
        territoryId: nextTerritoryId, sectorId: nextSectorId, cellId: nextCellId, villageId: nextVillageId,
        ...(currentAddress !== undefined ? { address: currentAddress } : {}),
        registeredLatitude: moved ? null : latitude,
        registeredLongitude: moved ? null : longitude,
        gpsAccuracy: moved ? null : accuracy,
        locationVerified: !moved,
      } });
      if (!updatedCount.count) {
        const conflict = new Error('The agent’s location changed before the relocation was saved. Reload the agent list and try again.');
        conflict.statusCode = 409;
        throw conflict;
      }
      const updated = await tx.agent.findUnique({ where: { id: req.params.id } });
      if (moved) await createAgentMovementNotices(tx, { agent: updated, fromTerritoryId: existing.territoryId, toTerritoryId: nextTerritoryId, noticeType: 'RELOCATED' });
      if (!moved) await tx.agentLocation.create({ data: { agentId: updated.id, latitude, longitude, accuracy, recordedById: req.user.id, reason } });
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
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Administrator agent relocation failed:', error.code || error.name);
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

router.use((error, _req, res, next) => {
  console.error('Unhandled agent request error:', error.code || error.name);
  if (res.headersSent) return next(error);
  if (isDatabaseSchemaError(error)) return res.status(503).json({ error: databaseMigrationMessage });
  return res.status(500).json({ error: 'Could not complete the agent request.' });
});

module.exports = router;
