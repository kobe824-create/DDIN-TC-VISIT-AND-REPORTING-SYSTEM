const express = require('express');
const path = require('path');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { logAction } = require('../utils/auditLog');
const { parseTabularUpload } = require(path.join(__dirname, '..', '..', '..', 'shared', 'tabular'));
const { canonicalDistrict, canonicalProvince, canonicalProvinceForDistrict, clean, findHeader, normalize, slug } = require(path.join(__dirname, '..', '..', '..', 'shared', 'import-normalization'));
const { encryptPii } = require(path.join(__dirname, '..', '..', '..', 'shared', 'pii'));

function normalizeAgentPhone(value, isUsername = false) {
  const source = clean(value);
  if (!source) return null;
  const digits = source.replace(/\D/g, '');
  if (/^2507\d{8}$/.test(digits)) return `+${digits}`;
  if (/^0?7\d{8}$/.test(digits)) return `+250${digits.replace(/^0/, '')}`;
  if (isUsername) return null;
  if (/^250\d{9}$/.test(digits)) return `+${digits}`;
  if (/^0\d{9}$/.test(digits)) return `+250${digits.slice(1)}`;
  if (source.startsWith('+') && digits.length >= 7 && digits.length <= 15) return `+${digits}`;
  if (digits.length >= 7 && digits.length <= 15) return digits;
  return null;
}

function parseAgentRows(upload) {
  const sheet = parseTabularUpload(upload);
  if (sheet.length < 2) throw new Error('The spreadsheet must contain a header row and at least one agent row.');
  const headers = sheet[0].values || [];
  const codeIndex = findHeader(headers, ['AGENT CODE', 'AGENT ID', 'AGENT IDENTIFIER']);
  const explicitPhoneIndex = findHeader(headers, ['AGENT PHONE NUMBER', 'AGENT PHONE', 'PHONE NUMBER', 'PHONE', 'MOBILE NUMBER', 'MOBILE PHONE', 'MOBILE', 'TELEPHONE NUMBER', 'TELEPHONE']);
  // In the supplied March roster, the agent's own mobile is stored under AGENT USERNAME.
  const usernameIndex = explicitPhoneIndex < 0 ? findHeader(headers, ['AGENT USERNAME']) : -1;
  const phoneIndex = explicitPhoneIndex >= 0 ? explicitPhoneIndex : usernameIndex;
  const phoneIsUsername = explicitPhoneIndex < 0 && usernameIndex >= 0;
  let nameIndex = findHeader(headers, ['AGENT NAME', 'AGENT FULL NAME', 'FULL NAME', 'NAME']);
  // The supplied March workbook has the agent name column in B, but its B1 header is blank.
  if (nameIndex < 0 && !clean(headers[1]) && headers.length >= 3) nameIndex = 1;
  const provinceIndex = findHeader(headers, ['PROVINCE', 'REGION']);
  const districtIndex = findHeader(headers, ['DISTRICT']);
  const sectorIndex = findHeader(headers, ['SECTOR']);
  const cellIndex = findHeader(headers, ['CELL']);
  const villageIndex = findHeader(headers, ['VILLAGE']);
  const nationalIdIndex = findHeader(headers, ['ID', 'NATIONAL ID', 'ID NUMBER', 'NATIONAL ID NUMBER']);
  const nextOfKinNameIndex = findHeader(headers, ['NEXT OF KIN NAME', 'NEXT OF KIN', 'NEXT OF KIN FULL NAME']);
  const nextOfKinPhoneIndex = findHeader(headers, ['NEXT OF KIN PHONE NUMBER', 'NEXT OF KIN PHONE', 'NEXT OF KIN MOBILE']);
  if ([codeIndex, nameIndex, provinceIndex, districtIndex].some((index) => index < 0)) {
    throw new Error('Required columns were not found. Include Agent Code, Agent Name, Province and District.');
  }

  const errors = [];
  const warnings = [];
  const records = [];
  const cellValue = (row, index) => index < 0 ? '' : clean(row.values[index]);
  for (const row of sheet.slice(1)) {
    const source = row.values || [];
    if (!source.some((value) => clean(value))) continue;
    const agentId = cellValue(row, codeIndex).toUpperCase();
    const name = cellValue(row, nameIndex);
    const sourceProvince = cellValue(row, provinceIndex);
    const suppliedProvinceName = canonicalProvince(sourceProvince);
    const sourceDistrict = cellValue(row, districtIndex);
    const districtName = canonicalDistrict(sourceDistrict);
    const expectedProvinceName = canonicalProvinceForDistrict(districtName);
    const provinceName = expectedProvinceName || suppliedProvinceName;
    const sectorName = cellValue(row, sectorIndex);
    const cellName = cellValue(row, cellIndex);
    const villageName = cellValue(row, villageIndex);
    const phoneSource = cellValue(row, phoneIndex);
    const phoneNumber = normalizeAgentPhone(phoneSource, phoneIsUsername);
    const rowErrors = [];
    if (!agentId) rowErrors.push('Agent Code is blank.');
    if (!name) rowErrors.push('Agent Name is blank.');
    if (!sourceProvince) rowErrors.push('Province is blank.');
    else if (!suppliedProvinceName) rowErrors.push('Province is not recognized.');
    if (!districtName) rowErrors.push('District is blank.');
    if (rowErrors.length) {
      errors.push({ row: row.rowNumber, key: agentId || '', reasons: rowErrors });
      continue;
    }
    if (phoneSource && !phoneNumber) {
      warnings.push({ row: row.rowNumber, key: agentId, reason: phoneIsUsername
        ? 'Agent username is not a recognizable Rwanda mobile number; no agent phone was imported.'
        : 'Agent phone number has an unsupported format; no agent phone was imported.' });
    }
    if (expectedProvinceName && suppliedProvinceName && suppliedProvinceName !== expectedProvinceName) {
      warnings.push({ row: row.rowNumber, key: agentId, reason: `District ${districtName} belongs to ${expectedProvinceName}; the supplied province ${suppliedProvinceName} was corrected.` });
    }
    if (!sectorName) warnings.push({ row: row.rowNumber, key: agentId, reason: 'Sector is blank. This agent will need a sector before its first visit.' });
    records.push({
      row: row.rowNumber, agentId, name, provinceName, districtName, sectorName, cellName, villageName,
      nationalId: cellValue(row, nationalIdIndex),
      nextOfKinName: cellValue(row, nextOfKinNameIndex),
      nextOfKinPhone: cellValue(row, nextOfKinPhoneIndex),
      phoneNumber,
    });
  }

  const grouped = new Map();
  for (const record of records) {
    const key = normalize(record.agentId);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(record);
  }
  const duplicateRecords = new Set();
  for (const [key, group] of grouped) {
    if (group.length < 2) continue;
    for (const record of group) duplicateRecords.add(record);
    errors.push({ rows: group.map((record) => record.row), key, reasons: ['Agent Code appears more than once in the uploaded file. All rows for this code were held for review.'] });
  }
  const uniqueRecords = records.filter((record) => !duplicateRecords.has(record));
  return { errors, headers, records: uniqueRecords, rowCount: sheet.length - 1, warnings };
}

function addressOf(record) {
  return [record.provinceName, record.districtName, record.sectorName, record.cellName, record.villageName].filter(Boolean).join(', ');
}

async function applyTcImportScope(parsed, tcId) {
  const assignments = await prisma.tcTerritoryAssignment.findMany({
    where: { tcId, isActive: true, territory: { is: { isActive: true, type: 'DISTRICT' } } },
    select: { territory: { select: { id: true, name: true, parent: { select: { name: true, type: true } } } } },
  });
  const assignedDistricts = new Map();
  for (const assignment of assignments) {
    const district = assignment.territory;
    if (district.parent?.type !== 'PROVINCE') continue;
    const provinceName = canonicalProvince(district.parent.name) || district.parent.name;
    const districtName = canonicalDistrict(district.name) || district.name;
    assignedDistricts.set(`${normalize(provinceName)}|${normalize(districtName)}`, district);
  }

  const records = [];
  const districtIds = [...new Set([...assignedDistricts.values()].map((district) => district.id))];
  const sectors = districtIds.length ? await prisma.territory.findMany({
    where: { type: 'SECTOR', isActive: true, parentId: { in: districtIds } },
    select: { id: true, name: true, parentId: true },
  }) : [];
  const sectorsByDistrictAndName = new Map(sectors.map((sector) => [`${sector.parentId}|${normalize(sector.name)}`, sector]));
  const sectorIds = sectors.map((sector) => sector.id);
  const cells = sectorIds.length ? await prisma.territory.findMany({ where: { type: 'CELL', isActive: true, parentId: { in: sectorIds } }, select: { id: true, name: true, parentId: true } }) : [];
  const cellsBySectorAndName = new Map(cells.map((cell) => [`${cell.parentId}|${normalize(cell.name)}`, cell]));
  const cellIds = cells.map((cell) => cell.id);
  const villages = cellIds.length ? await prisma.territory.findMany({ where: { type: 'VILLAGE', isActive: true, parentId: { in: cellIds } }, select: { id: true, name: true, parentId: true } }) : [];
  const villagesByCellAndName = new Map(villages.map((village) => [`${village.parentId}|${normalize(village.name)}`, village]));

  for (const record of parsed.records) {
    const key = `${normalize(record.provinceName)}|${normalize(record.districtName)}`;
    const district = assignedDistricts.get(key);
    if (!district) {
      parsed.errors.push({ row: record.row, key: record.agentId, reasons: ['This district is not assigned to your account. The row was not imported.'] });
      continue;
    }
    if (!record.sectorName) {
      parsed.errors.push({ row: record.row, key: record.agentId, reasons: ['Include a sector that already exists in this assigned district.'] });
      continue;
    }
    const sector = sectorsByDistrictAndName.get(`${district.id}|${normalize(record.sectorName)}`);
    if (!sector) {
      parsed.errors.push({ row: record.row, key: record.agentId, reasons: [`Sector ${record.sectorName} is not registered in ${district.name}. Ask an administrator to add the territory first.`] });
      continue;
    }
    const cell = record.cellName ? cellsBySectorAndName.get(`${sector.id}|${normalize(record.cellName)}`) : null;
    if (record.cellName && !cell) {
      parsed.errors.push({ row: record.row, key: record.agentId, reasons: [`Cell ${record.cellName} is not registered in ${record.sectorName}. Ask an administrator to add the territory first.`] });
      continue;
    }
    const village = record.villageName && cell ? villagesByCellAndName.get(`${cell.id}|${normalize(record.villageName)}`) : null;
    if (record.villageName && !village) {
      parsed.errors.push({ row: record.row, key: record.agentId, reasons: [`Village ${record.villageName} is not registered in ${record.cellName || 'the selected cell'}. Ask an administrator to add the territory first.`] });
      continue;
    }
    records.push({
      ...record,
      territoryId: district.id,
      sectorId: sector.id,
      cellId: cell?.id || null,
      villageId: village?.id || null,
      // TCs may import operational contact data, but not restricted identity details.
      nationalId: '',
      nextOfKinName: '',
      nextOfKinPhone: '',
    });
  }
  parsed.records = records;
  return parsed;
}

async function analyzeAgentImport(upload, user) {
  const parsed = parseAgentRows(upload);
  if (user?.role === 'TC') await applyTcImportScope(parsed, user.id);
  const ids = parsed.records.map((record) => record.agentId);
  const existing = ids.length ? await prisma.agent.findMany({
    where: { agentId: { in: ids, mode: 'insensitive' } },
    select: { agentId: true, name: true, address: true, phoneNumber: true, territoryId: true, nationalIdEncrypted: true, nextOfKinNameEncrypted: true, nextOfKinPhoneEncrypted: true },
  }) : [];
  const existingByCode = new Map(existing.map((item) => [normalize(item.agentId), item]));
  const ready = [];
  const enrichments = [];
  let alreadyPresent = 0;
  for (const record of parsed.records) {
    const existingRecord = existingByCode.get(normalize(record.agentId));
    if (!existingRecord) { ready.push(record); continue; }
    if (user?.role === 'TC' && existingRecord.territoryId !== record.territoryId) {
      parsed.errors.push({ row: record.row, key: record.agentId, reasons: ['This agent already exists outside your assigned district. Existing record was not changed.'] });
      continue;
    }
    if (normalize(existingRecord.name) === normalize(record.name) && normalize(existingRecord.address) === normalize(addressOf(record))) {
      alreadyPresent += 1;
      const missingFields = { agentId: existingRecord.agentId };
      if (record.phoneNumber && !String(existingRecord.phoneNumber || '').trim()) missingFields.phoneNumber = record.phoneNumber;
      if (record.nationalId && !existingRecord.nationalIdEncrypted) missingFields.nationalId = record.nationalId;
      if (record.nextOfKinName && !existingRecord.nextOfKinNameEncrypted) missingFields.nextOfKinName = record.nextOfKinName;
      if (record.nextOfKinPhone && !existingRecord.nextOfKinPhoneEncrypted) missingFields.nextOfKinPhone = record.nextOfKinPhone;
      if (Object.keys(missingFields).length > 1) enrichments.push({ ...missingFields, territoryId: existingRecord.territoryId });
    } else {
      parsed.errors.push({ row: record.row, key: record.agentId, reasons: ['Agent Code already exists with different profile data. Existing record was not changed.'] });
    }
  }
  const provinces = new Set(ready.map((record) => record.provinceName));
  const districts = new Set(ready.map((record) => `${record.provinceName}|${record.districtName}`));
  const sectors = new Set(ready.filter((record) => record.sectorName).map((record) => `${record.districtName}|${record.sectorName}`));
  const agentPhoneNumbersToAdd = ready.filter((record) => record.phoneNumber).length
    + enrichments.filter((record) => record.phoneNumber).length;
  return {
    ...parsed,
    ready,
    enrichments,
    alreadyPresent,
    summary: {
      rows: parsed.rowCount,
      importable: ready.length,
      alreadyPresent,
      enrichable: enrichments.length,
      agentPhoneNumbersToAdd,
      errors: parsed.errors.length,
      warnings: parsed.warnings.length,
      provinces: provinces.size,
      districts: districts.size,
      sectors: sectors.size,
    },
  };
}

async function createTerritories(tx, records) {
  const provinceNames = [...new Set(records.map((record) => record.provinceName))];
  const existingProvinces = await tx.territory.findMany({ where: { type: 'PROVINCE' }, select: { id: true, name: true, code: true } });
  const provinceMap = new Map();
  for (const territory of existingProvinces) {
    const canonicalName = canonicalProvince(territory.name);
    if (canonicalName && canonicalName !== territory.name) {
      await tx.territory.update({ where: { id: territory.id }, data: { name: canonicalName } });
      territory.name = canonicalName;
    }
    provinceMap.set(normalize(canonicalName || territory.name), territory);
  }
  const provincesToCreate = provinceNames.filter((name) => !provinceMap.has(normalize(name))).map((name) => ({
    name, type: 'PROVINCE', code: `PROV-${slug(name).toUpperCase()}`,
  }));
  if (provincesToCreate.length) await tx.territory.createMany({ data: provincesToCreate, skipDuplicates: true });
  for (const territory of await tx.territory.findMany({ where: { type: 'PROVINCE' }, select: { id: true, name: true, code: true } })) provinceMap.set(normalize(territory.name), territory);

  const districtPairs = new Map();
  for (const record of records) districtPairs.set(`${normalize(record.provinceName)}|${normalize(record.districtName)}`, record);
  const existingDistricts = await tx.territory.findMany({ where: { type: 'DISTRICT' }, select: { id: true, name: true, code: true, parentId: true } });
  const districtMap = new Map();
  for (const district of existingDistricts) districtMap.set(`${district.parentId}|${normalize(district.name)}`, district);
  const districtsToCreate = [];
  for (const [pair, record] of districtPairs) {
    const province = provinceMap.get(normalize(record.provinceName));
    if (!province) throw new Error(`Could not resolve province ${record.provinceName}.`);
    const mapKey = `${province.id}|${normalize(record.districtName)}`;
    if (!districtMap.has(mapKey)) districtsToCreate.push({
      name: record.districtName, type: 'DISTRICT', parentId: province.id, code: `DIST-${slug(record.districtName).toUpperCase()}`,
    });
  }
  if (districtsToCreate.length) await tx.territory.createMany({ data: districtsToCreate, skipDuplicates: true });
  for (const district of await tx.territory.findMany({ where: { type: 'DISTRICT' }, select: { id: true, name: true, code: true, parentId: true } })) districtMap.set(`${district.parentId}|${normalize(district.name)}`, district);

  const sectorPairs = new Map();
  for (const record of records) if (record.sectorName) sectorPairs.set(`${normalize(record.districtName)}|${normalize(record.sectorName)}`, record);
  const existingSectors = await tx.territory.findMany({ where: { type: 'SECTOR' }, select: { id: true, name: true, code: true, parentId: true } });
  const sectorMap = new Map();
  for (const sector of existingSectors) sectorMap.set(`${sector.parentId}|${normalize(sector.name)}`, sector);
  const sectorsToCreate = [];
  for (const record of sectorPairs.values()) {
    const province = provinceMap.get(normalize(record.provinceName));
    const district = province && districtMap.get(`${province.id}|${normalize(record.districtName)}`);
    if (!district) throw new Error(`Could not resolve district ${record.districtName}.`);
    const key = `${district.id}|${normalize(record.sectorName)}`;
    if (!sectorMap.has(key)) sectorsToCreate.push({
      name: record.sectorName, type: 'SECTOR', parentId: district.id,
      code: `SECT-${slug(record.districtName).toUpperCase()}-${slug(record.sectorName).toUpperCase()}`,
    });
  }
  if (sectorsToCreate.length) await tx.territory.createMany({ data: sectorsToCreate, skipDuplicates: true });
  for (const sector of await tx.territory.findMany({ where: { type: 'SECTOR' }, select: { id: true, name: true, parentId: true } })) sectorMap.set(`${sector.parentId}|${normalize(sector.name)}`, sector);

  const cellMap = new Map();
  const cellPairs = new Map();
  for (const record of records) if (record.sectorName && record.cellName) cellPairs.set(`${normalize(record.provinceName)}|${normalize(record.districtName)}|${normalize(record.sectorName)}|${normalize(record.cellName)}`, record);
  const existingCells = await tx.territory.findMany({ where: { type: 'CELL' }, select: { id: true, name: true, parentId: true } });
  for (const cell of existingCells) cellMap.set(`${cell.parentId}|${normalize(cell.name)}`, cell);
  const cellsToCreate = [];
  for (const record of cellPairs.values()) {
    const district = provinceMap.get(normalize(record.provinceName)) && districtMap.get(`${provinceMap.get(normalize(record.provinceName)).id}|${normalize(record.districtName)}`);
    const sector = district && sectorMap.get(`${district.id}|${normalize(record.sectorName)}`);
    if (!sector) throw new Error(`Could not resolve sector ${record.sectorName}.`);
    const key = `${sector.id}|${normalize(record.cellName)}`;
    if (!cellMap.has(key)) cellsToCreate.push({ name: record.cellName, type: 'CELL', parentId: sector.id, code: `CELL-${sector.id}-${slug(record.cellName).toUpperCase()}` });
  }
  if (cellsToCreate.length) await tx.territory.createMany({ data: cellsToCreate, skipDuplicates: true });
  for (const cell of await tx.territory.findMany({ where: { type: 'CELL' }, select: { id: true, name: true, parentId: true } })) cellMap.set(`${cell.parentId}|${normalize(cell.name)}`, cell);

  const villageMap = new Map();
  const villagePairs = new Map();
  for (const record of records) if (record.cellName && record.villageName) villagePairs.set(`${normalize(record.provinceName)}|${normalize(record.districtName)}|${normalize(record.sectorName)}|${normalize(record.cellName)}|${normalize(record.villageName)}`, record);
  const existingVillages = await tx.territory.findMany({ where: { type: 'VILLAGE' }, select: { id: true, name: true, parentId: true } });
  for (const village of existingVillages) villageMap.set(`${village.parentId}|${normalize(village.name)}`, village);
  const villagesToCreate = [];
  for (const record of villagePairs.values()) {
    const district = provinceMap.get(normalize(record.provinceName)) && districtMap.get(`${provinceMap.get(normalize(record.provinceName)).id}|${normalize(record.districtName)}`);
    const sector = district && sectorMap.get(`${district.id}|${normalize(record.sectorName)}`);
    const cell = sector && cellMap.get(`${sector.id}|${normalize(record.cellName)}`);
    if (!cell) throw new Error(`Could not resolve cell ${record.cellName}.`);
    const key = `${cell.id}|${normalize(record.villageName)}`;
    if (!villageMap.has(key)) villagesToCreate.push({ name: record.villageName, type: 'VILLAGE', parentId: cell.id, code: `VILL-${cell.id}-${slug(record.villageName).toUpperCase()}` });
  }
  if (villagesToCreate.length) await tx.territory.createMany({ data: villagesToCreate, skipDuplicates: true });
  for (const village of await tx.territory.findMany({ where: { type: 'VILLAGE' }, select: { id: true, name: true, parentId: true } })) villageMap.set(`${village.parentId}|${normalize(village.name)}`, village);

  return records.map((record) => {
    const province = provinceMap.get(normalize(record.provinceName));
    const district = province && districtMap.get(`${province.id}|${normalize(record.districtName)}`);
    const sector = district && record.sectorName ? sectorMap.get(`${district.id}|${normalize(record.sectorName)}`) : null;
    const cell = sector && record.cellName ? cellMap.get(`${sector.id}|${normalize(record.cellName)}`) : null;
    const village = cell && record.villageName ? villageMap.get(`${cell.id}|${normalize(record.villageName)}`) : null;
    if (!district) throw new Error(`Could not resolve district ${record.districtName}.`);
    if (record.sectorName && !sector) throw new Error(`Could not resolve sector ${record.sectorName}.`);
    return {
      ...record,
      territoryId: district.id,
      sectorId: sector?.id || null,
      cellId: cell?.id || null,
      villageId: village?.id || null,
      address: addressOf(record),
    };
  });
}

router.post('/preview', authenticateToken, requireRole('ADMIN', 'TC'), async (req, res) => {
  try {
    const analysis = await analyzeAgentImport(req.body, req.user);
    res.json({ summary: analysis.summary, errors: analysis.errors, warnings: analysis.warnings });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Could not read this agent spreadsheet.' });
  }
});

router.post('/', authenticateToken, requireRole('ADMIN', 'TC'), async (req, res) => {
  try {
    const analysis = await analyzeAgentImport(req.body, req.user);
    if (!analysis.ready.length && !analysis.enrichments.length) return res.status(400).json({
      error: req.user.role === 'TC'
        ? 'No new agent rows or missing phone numbers are available to import.'
        : 'No new agent rows or missing contact and personal details are available to import.',
      summary: analysis.summary,
      errors: analysis.errors,
      warnings: analysis.warnings,
    });
    const result = await prisma.$transaction(async (tx) => {
      const records = analysis.ready.length
        ? (req.user.role === 'TC' ? analysis.ready : await createTerritories(tx, analysis.ready))
        : [];
      let imported = 0;
      for (let start = 0; start < records.length; start += 400) {
        const batch = records.slice(start, start + 400).map((record) => ({
          agentId: record.agentId,
          name: record.name,
          phoneNumber: record.phoneNumber,
          address: record.address,
          territoryId: record.territoryId,
          sectorId: record.sectorId,
          cellId: record.cellId,
          villageId: record.villageId,
          nationalIdEncrypted: encryptPii(record.nationalId),
          nextOfKinNameEncrypted: encryptPii(record.nextOfKinName),
          nextOfKinPhoneEncrypted: encryptPii(record.nextOfKinPhone),
          locationVerified: false,
          createdById: req.user.id,
        }));
        const created = await tx.agent.createMany({ data: batch, skipDuplicates: true });
        imported += created.count;
      }
      let enriched = 0;
      const details = analysis.enrichments.map((record) => ({
        agentId: record.agentId,
        phoneNumber: record.phoneNumber || null,
        nationalIdEncrypted: encryptPii(record.nationalId),
        nextOfKinNameEncrypted: encryptPii(record.nextOfKinName),
        nextOfKinPhoneEncrypted: encryptPii(record.nextOfKinPhone),
      }));
      for (let start = 0; start < details.length; start += 200) {
        const batch = details.slice(start, start + 200);
        const valueRows = batch.map((_record, index) => {
          const offset = index * 6;
          return `($${offset + 1}::text, $${offset + 2}::text, $${offset + 3}::text, $${offset + 4}::text, $${offset + 5}::text, $${offset + 6}::text)`;
        }).join(',');
        const parameters = batch.flatMap((record) => [record.agentId, record.phoneNumber, record.nationalIdEncrypted, record.nextOfKinNameEncrypted, record.nextOfKinPhoneEncrypted, record.territoryId]);
        const statement = `
          UPDATE "Agent" AS agent
          SET "phoneNumber" = COALESCE(NULLIF(BTRIM(agent."phoneNumber"), ''), incoming."phoneNumber"),
              "nationalIdEncrypted" = COALESCE(agent."nationalIdEncrypted", incoming."nationalIdEncrypted"),
              "nextOfKinNameEncrypted" = COALESCE(agent."nextOfKinNameEncrypted", incoming."nextOfKinNameEncrypted"),
              "nextOfKinPhoneEncrypted" = COALESCE(agent."nextOfKinPhoneEncrypted", incoming."nextOfKinPhoneEncrypted"),
              "updatedAt" = NOW()
          FROM (VALUES ${valueRows}) AS incoming("agentId", "phoneNumber", "nationalIdEncrypted", "nextOfKinNameEncrypted", "nextOfKinPhoneEncrypted", "territoryId")
          WHERE agent."agentId" = incoming."agentId"
            AND agent."territoryId" = incoming."territoryId"::uuid
        `;
        enriched += await tx.$executeRawUnsafe(statement, ...parameters);
      }
      return { imported, enriched };
    }, { maxWait: 15000, timeout: 120000 });

    await logAction(req.user.id, 'BULK_IMPORT_AGENTS', 'Agent', null, {
      sourceFile: path.basename(String(req.body.fileName || 'agent spreadsheet')).slice(0, 160),
      imported: result.imported,
      existingAgentDetailsAdded: result.enriched,
      alreadyPresent: analysis.alreadyPresent,
      heldRows: analysis.errors.length,
      rows: analysis.rowCount,
    }, req);
    res.status(201).json({ summary: { ...analysis.summary, imported: result.imported, enriched: result.enriched }, errors: analysis.errors, warnings: analysis.warnings });
  } catch (error) {
    console.error('Bulk agent import failed:', error.code || error.name);
    res.status(400).json({ error: error.message || 'Could not import agents.' });
  }
});

module.exports = router;
