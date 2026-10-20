const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');
const prisma = require('../utils/prisma');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { logAction } = require('../utils/auditLog');
const { parseTabularUpload } = require(path.join(__dirname, '..', '..', '..', 'shared', 'tabular'));
const { canonicalDistrict, clean, findHeader, normalize, slug } = require(path.join(__dirname, '..', '..', '..', 'shared', 'import-normalization'));

function parseTcRows(upload) {
  const sheet = parseTabularUpload(upload);
  if (sheet.length < 2) throw new Error('The spreadsheet must contain a header row and at least one TC row.');
  const headers = sheet[0].values || [];
  const nameIndex = findHeader(headers, ['TC NAMES', 'TC NAME', 'FULL NAME', 'NAME']);
  const phoneIndex = findHeader(headers, ['PHONE NUMBER', 'PHONE', 'MOBILE']);
  const emailIndex = findHeader(headers, ['EMAIL', 'EMAIL ADDRESS']);
  const territoryIndex = findHeader(headers, ['TERRITORY', 'DISTRICT', 'DISTRICTS']);
  if ([nameIndex, phoneIndex, emailIndex, territoryIndex].some((index) => index < 0)) {
    throw new Error('Required columns were not found. Include TC Name, Phone Number, Email and Territory.');
  }
  const cellValue = (row, index) => clean(row.values?.[index]);
  const errors = [];
  const records = [];
  for (const row of sheet.slice(1)) {
    if (!(row.values || []).some((value) => clean(value))) continue;
    const name = cellValue(row, nameIndex);
    const phoneNumber = cellValue(row, phoneIndex);
    const email = cellValue(row, emailIndex).toLowerCase();
    const districts = [...new Set(cellValue(row, territoryIndex).split(/[,;\n]/).map(canonicalDistrict).filter(Boolean))];
    const rowErrors = [];
    const digits = phoneNumber.replace(/\D/g, '');
    // Reserved .test contacts are for incoming TCs whose real details are not yet known.
    const placeholderContact = !phoneNumber && email.endsWith('@ddin.test');
    if (!name) rowErrors.push('TC Name is blank.');
    if (name && name.split(/\s+/).length < 2) rowErrors.push('TC Name needs a first and last name.');
    if (!placeholderContact && (!phoneNumber || digits.length < 7 || digits.length > 15)) rowErrors.push('Phone Number must contain 7 to 15 digits unless using a reserved @ddin.test placeholder email.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) rowErrors.push('Email is missing or invalid.');
    if (!districts.length) rowErrors.push('At least one district is required.');
    if (rowErrors.length) {
      errors.push({ row: row.rowNumber, reasons: rowErrors });
      continue;
    }
    const parts = name.split(/\s+/);
    const username = digits ? `tc-${digits}` : `tc-${slug(name)}`;
    records.push({ row: row.rowNumber, name, firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1), phoneNumber: phoneNumber || null, email, username, districts });
  }

  const duplicateKeys = new Map();
  for (const record of records) {
    const duplicateFields = [['email', record.email], ['username', record.username]];
    if (record.phoneNumber) duplicateFields.push(['phone', record.phoneNumber.replace(/\D/g, '')]);
    for (const [key, value] of duplicateFields) {
      const normalized = normalize(value);
      if (!duplicateKeys.has(key)) duplicateKeys.set(key, new Map());
      const grouped = duplicateKeys.get(key);
      if (!grouped.has(normalized)) grouped.set(normalized, []);
      grouped.get(normalized).push(record);
    }
  }
  const duplicateRecords = new Set();
  for (const [field, grouped] of duplicateKeys) {
    for (const group of grouped.values()) {
      if (group.length < 2) continue;
      for (const record of group) duplicateRecords.add(record);
      errors.push({ rows: group.map((record) => record.row), reasons: [`${field === 'phone' ? 'Phone Number' : field} appears more than once. All matching rows were held.`] });
    }
  }
  return { records: records.filter((record) => !duplicateRecords.has(record)), errors, rowCount: sheet.length - 1 };
}

async function analyzeTcImport(upload) {
  const parsed = parseTcRows(upload);
  const districts = await prisma.territory.findMany({ where: { type: 'DISTRICT' }, select: { id: true, name: true, code: true } });
  const districtsByName = new Map();
  const districtsByCode = new Map();
  for (const district of districts) {
    districtsByName.set(normalize(district.name), district);
    districtsByCode.set(String(district.code).toUpperCase(), district);
  }
  const ready = [];
  for (const record of parsed.records) {
    const districtRows = record.districts.map((name) => districtsByName.get(normalize(name)) || districtsByCode.get(`DIST-${slug(name).toUpperCase()}`));
    const missingDistricts = record.districts.filter((_name, index) => !districtRows[index]);
    if (missingDistricts.length) {
      parsed.errors.push({ row: record.row, reasons: [`Districts not yet registered: ${missingDistricts.join(', ')}.`] });
      continue;
    }
    record.territoryRows = [...new Map(districtRows.map((district) => [district.id, district])).values()];
    ready.push(record);
  }
  const emails = ready.map((record) => record.email);
  const usernames = ready.map((record) => record.username);
  const existingUsers = emails.length ? await prisma.user.findMany({
    where: { OR: [{ email: { in: emails, mode: 'insensitive' } }, { username: { in: usernames, mode: 'insensitive' } }] },
    select: { email: true, username: true },
  }) : [];
  const existingEmails = new Set(existingUsers.map((user) => normalize(user.email)));
  const existingUsernames = new Set(existingUsers.map((user) => normalize(user.username)));
  const newRows = [];
  for (const record of ready) {
    if (existingEmails.has(normalize(record.email)) || existingUsernames.has(normalize(record.username))) {
      parsed.errors.push({ row: record.row, reasons: ['This email or generated username already belongs to an account. Existing account was not changed.'] });
    } else newRows.push(record);
  }
  return {
    ...parsed,
    ready: newRows,
    summary: { rows: parsed.rowCount, importable: newRows.length, errors: parsed.errors.length, assignedDistricts: new Set(newRows.flatMap((record) => record.territoryRows.map((district) => district.id))).size },
  };
}

router.post('/bulk-import/preview', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  try {
    const analysis = await analyzeTcImport(req.body);
    res.json({ summary: analysis.summary, errors: analysis.errors });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Could not read this TC spreadsheet.' });
  }
});

router.post('/bulk-import', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  try {
    const analysis = await analyzeTcImport(req.body);
    if (!analysis.ready.length) return res.status(400).json({ error: 'No new valid TC rows are available to import.', summary: analysis.summary, errors: analysis.errors });
    const sharedTemporaryPassword = process.env.TC_INITIAL_PASSWORD || '';
    if (sharedTemporaryPassword.length < 8) {
      return res.status(503).json({ error: 'The shared TC initial password is not configured. Ask the system administrator to set TC_INITIAL_PASSWORD.' });
    }
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const credentials = analysis.ready.map((record) => ({
      ...record,
      temporaryPassword: sharedTemporaryPassword,
    }));
    const users = await Promise.all(credentials.map(async (record) => ({
      username: record.username,
      email: record.email,
      phoneNumber: record.phoneNumber,
      passwordHash: await bcrypt.hash(record.temporaryPassword, 12),
      role: 'TC',
      firstName: record.firstName,
      lastName: record.lastName,
      mustChangePassword: true,
      passwordResetExpiresAt: expiresAt,
    })));
    const created = await prisma.$transaction(async (tx) => {
      await tx.user.createMany({ data: users });
      const createdUsers = await tx.user.findMany({ where: { username: { in: users.map((user) => user.username) } }, select: { id: true, username: true } });
      const userByUsername = new Map(createdUsers.map((user) => [user.username, user]));
      const assignmentRows = credentials.flatMap((record) => record.territoryRows.map((district) => ({
        tcId: userByUsername.get(record.username).id,
        territoryId: district.id,
        assignedById: req.user.id,
      })));
      if (assignmentRows.length) await tx.tcTerritoryAssignment.createMany({ data: assignmentRows, skipDuplicates: true });
      return createdUsers;
    }, { maxWait: 10000, timeout: 30000 });

    const createdUsernames = new Set(created.map((user) => user.username));
    const credentialOutput = credentials.filter((record) => createdUsernames.has(record.username)).map((record) => ({
      name: record.name,
      username: record.username,
      email: record.email,
      phoneNumber: record.phoneNumber,
      districts: record.territoryRows.map((district) => district.name),
      temporaryPassword: record.temporaryPassword,
      expiresAt: expiresAt.toISOString(),
    }));
    await logAction(req.user.id, 'BULK_IMPORT_TCS', 'User', null, {
      sourceFile: path.basename(String(req.body.fileName || 'TC spreadsheet')).slice(0, 160),
      imported: credentialOutput.length,
      heldRows: analysis.errors.length,
      rows: analysis.rowCount,
      temporaryCredentialExpiry: expiresAt.toISOString(),
    }, req);
    res.status(201).json({ summary: { ...analysis.summary, imported: credentialOutput.length }, errors: analysis.errors, credentials: credentialOutput });
  } catch (error) {
    console.error('Bulk TC import failed:', error.code || error.name);
    res.status(400).json({ error: error.message || 'Could not import TC accounts.' });
  }
});

router.get('/', authenticateToken, requireRole('ADMIN', 'MANAGER'), async (req, res) => {
  const requestedPage = Number.parseInt(req.query.page, 10);
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const safePage = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 100) : 25;
  const where = {};
  if (req.query.role) where.role = req.query.role;
  const search = String(req.query.search || '').trim();
  if (search) {
    where.OR = [
      { username: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
      { firstName: { contains: search, mode: 'insensitive' } },
      { lastName: { contains: search, mode: 'insensitive' } },
    ];
  }

  const total = await prisma.user.count({ where });
  const pages = Math.ceil(total / limit);
  const page = Math.min(safePage, Math.max(pages, 1));
  const users = await prisma.user.findMany({
    where,
    skip: (page - 1) * limit,
    take: limit,
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
    select: { id: true, username: true, email: true, role: true, firstName: true, lastName: true, isActive: true, mustChangePassword: true, createdAt: true }
  });

  res.json({ data: users, total, page, limit, pages });
});

router.get('/:id', authenticateToken, requireRole('ADMIN', 'MANAGER'), async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: { id: true, username: true, email: true, role: true, firstName: true, lastName: true, isActive: true, mustChangePassword: true, createdAt: true }
  });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

router.post('/:id/reset-password', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, username: true, role: true } });
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (target.role !== 'TC') return res.status(400).json({ error: 'Password reset is available here for TC accounts only.' });

    const temporaryPassword = crypto.randomBytes(18).toString('base64url');
    const passwordHash = await bcrypt.hash(temporaryPassword, 12);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await prisma.user.update({
      where: { id: target.id },
      data: {
        passwordHash,
        mustChangePassword: true,
        passwordResetExpiresAt: expiresAt,
        tokenVersion: { increment: 1 },
      },
    });

    await logAction(req.user.id, 'RESET_USER_PASSWORD', 'User', target.id, {
      username: target.username,
      role: target.role,
      temporaryPasswordExpiresAt: expiresAt.toISOString(),
    }, req);

    res.json({
      temporaryPassword,
      expiresAt: expiresAt.toISOString(),
      user: { id: target.id, username: target.username, role: target.role },
    });
  } catch (error) {
    console.error('User password reset failed:', error.code || error.name);
    res.status(500).json({ error: 'Could not reset this account password.' });
  }
});

router.put('/:id', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  try {
    const { username, email, role, firstName, lastName, phoneNumber, isActive } = req.body;
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { username, email, role, firstName, lastName, phoneNumber, isActive },
      select: { id: true, username: true, role: true }
    });
    await logAction(req.user.id, 'UPDATE_USER', 'User', user.id, { username, email, role, firstName, lastName, phoneNumber, isActive }, req);
    res.json(user);
  } catch (error) {
    res.status(400).json({ error: 'Update failed' });
  }
});

router.patch('/:id/status', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  try {
    const { isActive } = req.body;
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { isActive },
      select: { id: true, username: true, isActive: true }
    });
    await logAction(req.user.id, 'CHANGE_USER_STATUS', 'User', user.id, { isActive }, req);
    res.json(user);
  } catch (error) {
    res.status(400).json({ error: 'Status update failed' });
  }
});

module.exports = router;
