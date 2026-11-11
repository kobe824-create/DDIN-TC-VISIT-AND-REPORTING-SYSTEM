#!/usr/bin/env node
// Reconcile official PDF cell/village data against existing districts/sectors.
// Defaults to a read-only preview. Pass --apply to commit the import.
const fs = require('fs');
const path = require('path');
if (!process.env.DATABASE_URL) {
  const environmentFile = [path.join(__dirname, '..', '.env'), path.join(__dirname, '..', '..', '.env')]
    .find((file) => fs.existsSync(file));
  if (environmentFile) {
    const databaseLine = fs.readFileSync(environmentFile, 'utf8').split(/\r?\n/)
      .find((line) => /^\s*(?:export\s+)?DATABASE_URL\s*=/.test(line));
    if (databaseLine) {
      let value = databaseLine.replace(/^\s*(?:export\s+)?DATABASE_URL\s*=\s*/, '').trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      process.env.DATABASE_URL = value;
    }
  }
}
const prisma = require('../AgentsService/src/utils/prisma');

const catalogPath = path.join(__dirname, '..', 'data', 'rwanda-territory-catalog.json');
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const apply = process.argv.includes('--apply');
const fakeNames = new Set(['jermaine cole', 'jane champion', 'john tc']);
const sectorAliases = new Map([
  [normalize('Nyamagabe:Kibilizi'), ['Kibirizi']],
  [normalize('Burera:Rugengabali'), ['Rugengabari']],
  [normalize('Burera:Rusarabuye'), ['Rusarabuge']],
  [normalize('Rwamagana:Gishali'), ['Gishari']],
  [normalize('Rwamagana:Mwulire'), ['Mwurire']],
  [normalize('Kirehe:Nasho'), ['Ntasho']],
  [normalize('Bugesera:Ngeruka'), ['Ngeruke']],
]);

function normalize(value) {
  return String(value || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[right.length];
}

function mapBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function batches(items, size = 250) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

async function updateManyChunks(client, model, field, mappings) {
  const groups = new Map();
  for (const [oldId, targetId] of mappings) {
    if (oldId === targetId) continue;
    if (!groups.has(targetId)) groups.set(targetId, []);
    groups.get(targetId).push(oldId);
  }
  for (const [targetId, ids] of groups) {
    for (const idBatch of batches(ids, 500)) {
      await client[model].updateMany({
        where: { [field]: { in: idBatch } },
        data: { [field]: targetId },
      });
    }
  }
}

async function updateRows(client, rows) {
  for (const chunk of batches(rows, 80)) {
    await Promise.all(chunk.map(({ id, data }) => client.territory.update({ where: { id }, data })));
  }
}

async function analyze(client) {
  const [districtRows, sectorRows, users, assignments] = await Promise.all([
    client.territory.findMany({ where: { type: 'DISTRICT' }, select: { id: true, name: true } }),
    client.territory.findMany({ where: { type: 'SECTOR' }, select: { id: true, name: true, code: true, parentId: true, isActive: true } }),
    client.user.findMany({ select: { id: true, username: true, firstName: true, lastName: true, role: true, isActive: true } }),
    client.tcTerritoryAssignment.findMany({ where: { isActive: true, tc: { is: { role: 'TC', isActive: true } }, territory: { is: { type: 'DISTRICT', isActive: true } } }, select: { territoryId: true } }),
  ]);
  const districtsByName = mapBy(districtRows, (item) => normalize(item.name));
  const sectorByDistrictAndName = mapBy(sectorRows, (item) => `${item.parentId}:${normalize(item.name)}`);
  const expectedSectors = [];
  const unmatchedDistricts = [];
  const unmatchedSectors = [];
  const matchedSectorIds = new Set();
  const assignedDistrictIds = new Set(assignments.map(({ territoryId }) => territoryId));
  const sectorRowsToRename = [];
  const sectorRowsToCreate = [];
  for (const district of catalog.districts) {
    const districtMatch = districtsByName.get(normalize(district.name)) || [];
    if (!districtMatch.length) {
      unmatchedDistricts.push(district.name);
      continue;
    }
    for (const sector of district.sectors) {
      let match = sectorByDistrictAndName.get(`${districtMatch[0].id}:${normalize(sector.name)}`) || [];
      let aliasMatch = false;
      if (!match.length) {
        const aliases = sectorAliases.get(normalize(`${district.name}:${sector.name}`)) || [];
        const aliasRows = aliases.flatMap((alias) => sectorByDistrictAndName.get(`${districtMatch[0].id}:${normalize(alias)}`) || []);
        if (aliasRows.length > 1) throw new Error(`Multiple sector aliases match ${district.name} / ${sector.name}. No changes were made.`);
        if (aliasRows.length === 1) { match = aliasRows; aliasMatch = true; }
      }
      if (!match.length) {
        unmatchedSectors.push({ district: district.name, sector: sector.name, sourceCode: sector.sourceCode });
        const code = `RW-SECTOR-${sector.sourceCode}`;
        sectorRowsToCreate.push({ name: sector.name, code, parentId: districtMatch[0].id, type: 'SECTOR', isActive: true });
        expectedSectors.push({ ...sector, districtName: district.name, districtId: districtMatch[0].id, sectorId: null, createCode: code, districtAssignedToTc: assignedDistrictIds.has(districtMatch[0].id) });
        continue;
      }
      if (match.length > 1) {
        throw new Error(`Duplicate existing sector rows match ${district.name} / ${sector.name}. Resolve the duplicate sectors first.`);
      }
      matchedSectorIds.add(match[0].id);
      if (aliasMatch) sectorRowsToRename.push({ id: match[0].id, data: { name: sector.name } });
      expectedSectors.push({ ...sector, districtName: district.name, districtId: districtMatch[0].id, sectorId: match[0].id, aliasMatch, districtAssignedToTc: assignedDistrictIds.has(districtMatch[0].id) });
    }
  }
  if (!expectedSectors.length) throw new Error('No PDF sectors matched the existing territory hierarchy. No changes were made.');
  if (unmatchedDistricts.length) throw new Error(`PDF districts missing from the system: ${unmatchedDistricts.join(', ')}. No changes were made.`);

  const sectorCreateCodes = sectorRowsToCreate.map(({ code }) => code);
  const conflictingSectorCodes = sectorCreateCodes.length ? await client.territory.findMany({ where: { code: { in: sectorCreateCodes } }, select: { code: true, name: true } }) : [];
  if (conflictingSectorCodes.length) throw new Error(`Official sector code ${conflictingSectorCodes[0].code} already belongs to ${conflictingSectorCodes[0].name}. No changes were made.`);
  if (apply) {
    await updateRows(client, sectorRowsToRename);
    for (const batch of batches(sectorRowsToCreate)) await client.territory.createMany({ data: batch });
    const createdRows = sectorRowsToCreate.length ? await client.territory.findMany({ where: { code: { in: sectorCreateCodes } }, select: { id: true, code: true } }) : [];
    const createdIdByCode = new Map(createdRows.map((row) => [row.code, row.id]));
    for (const sector of expectedSectors) if (!sector.sectorId && sector.createCode) sector.sectorId = createdIdByCode.get(sector.createCode);
    if (expectedSectors.some(({ sectorId }) => !sectorId)) throw new Error('Some official sectors could not be created. The transaction will be rolled back.');
  }

  const districtNameById = new Map(districtRows.map((district) => [district.id, district.name]));
  const unmatchedExistingSectors = sectorRows.filter(({ id }) => !matchedSectorIds.has(id)).map((sector) => ({ district: districtNameById.get(sector.parentId) || 'Unknown district', sector: sector.name, code: sector.code, isActive: sector.isActive }));
  const fuzzySectorSuggestions = unmatchedSectors.map((source) => {
    const candidates = unmatchedExistingSectors.filter((existing) => normalize(existing.district) === normalize(source.district))
      .map((existing) => ({ ...existing, distance: editDistance(normalize(existing.sector), normalize(source.sector)) }))
      .sort((a, b) => a.distance - b.distance || a.sector.localeCompare(b.sector));
    return { ...source, candidates: candidates.filter(({ distance }) => distance <= 4).slice(0, 3) };
  }).filter(({ candidates }) => candidates.length);

  const existingCells = await client.territory.findMany({
    where: { type: 'CELL' },
    select: { id: true, name: true, code: true, parentId: true, type: true, isActive: true },
  });
  const oldCellIds = existingCells.map(({ id }) => id);
  const existingVillages = oldCellIds.length ? await client.territory.findMany({
    where: { type: 'VILLAGE', parentId: { in: oldCellIds } },
    select: { id: true, name: true, code: true, parentId: true, type: true, isActive: true },
  }) : [];

  const cells = [];
  const cellByCode = new Map();
  for (const sector of expectedSectors) {
    for (const cell of sector.cells) {
      const code = `RW-CELL-${cell.sourceCode}`;
      const node = { ...cell, code, parentId: sector.sectorId, districtName: sector.districtName, sectorName: sector.name };
      cells.push(node);
      cellByCode.set(code, node);
    }
  }
  const villages = [];
  for (const cell of cells) {
    for (const village of cell.villages) {
      const code = `RW-VILLAGE-${village.sourceCodes.join('-')}`;
      villages.push({ ...village, code, cellCode: cell.code, cellName: cell.name, sectorId: cell.parentId, districtName: cell.districtName, sectorName: cell.sectorName });
    }
  }
  const targetCodes = [...cells, ...villages].map(({ code }) => code);
  const codeRows = targetCodes.length ? await client.territory.findMany({ where: { code: { in: targetCodes } }, select: { id: true, name: true, code: true, type: true, parentId: true, isActive: true } }) : [];
  const existingByCode = new Map(codeRows.map((row) => [row.code, row]));
  const existingCellIds = new Set(existingCells.map(({ id }) => id));
  const existingVillageIds = new Set(existingVillages.map(({ id }) => id));
  for (const cell of cells) {
    const row = existingByCode.get(cell.code);
    if (row && (row.type !== 'CELL' || (!existingCellIds.has(row.id) && row.parentId !== cell.parentId))) {
      throw new Error(`Territory code ${cell.code} is already used by a different record. No changes were made.`);
    }
  }
  for (const village of villages) {
    const row = existingByCode.get(village.code);
    if (row && (row.type !== 'VILLAGE' || (!existingVillageIds.has(row.id) && !existingCellIds.has(row.parentId)))) {
      throw new Error(`Territory code ${village.code} is already used by a different record. No changes were made.`);
    }
  }

  const cellsByParentAndName = mapBy(existingCells, (row) => `${row.parentId}:${normalize(row.name)}`);
  const cellPlan = [];
  const cellOldToTarget = new Map();
  const oldCellToSourceCode = new Map();
  const cellRowsToUpdate = [];
  const newCellRows = [];
  for (const cell of cells) {
    const sameName = cellsByParentAndName.get(`${cell.parentId}:${normalize(cell.name)}`) || [];
    const byCode = existingByCode.get(cell.code);
    const candidates = [...new Map([...sameName, ...(byCode ? [byCode] : [])].map((row) => [row.id, row])).values()];
    const canonical = candidates.find((row) => row.code === cell.code) || candidates[0] || null;
    cellPlan.push({ ...cell, canonical });
    if (canonical) cellRowsToUpdate.push({ id: canonical.id, data: { name: cell.name, code: cell.code, parentId: cell.parentId, type: 'CELL', isActive: true } });
    else newCellRows.push({ name: cell.name, code: cell.code, parentId: cell.parentId, type: 'CELL', isActive: true });
    for (const duplicate of candidates) {
      if (canonical) {
        cellOldToTarget.set(duplicate.id, duplicate.id === canonical.id ? canonical.id : canonical.id);
        oldCellToSourceCode.set(duplicate.id, cell.sourceCode);
      }
    }
  }
  if (apply) {
    await updateRows(client, cellRowsToUpdate);
    for (const batch of batches(newCellRows)) await client.territory.createMany({ data: batch, skipDuplicates: true });
  }

  const resolvedCells = apply
    ? await client.territory.findMany({ where: { code: { in: cells.map(({ code }) => code) } }, select: { id: true, code: true } })
    : [];
  const cellIdByCode = new Map();
  for (const row of resolvedCells) cellIdByCode.set(row.code, row.id);
  const expectedCellKeyById = new Map();
  const cellTargetIdByCode = new Map();
  for (const plan of cellPlan) {
    const cellId = apply ? cellIdByCode.get(plan.code) : plan.canonical?.id;
    if (cellId) {
      cellTargetIdByCode.set(plan.code, cellId);
      expectedCellKeyById.set(cellId, plan.code);
    }
  }
  for (const row of existingCells) {
    const candidateCode = oldCellToSourceCode.get(row.id);
    if (candidateCode) expectedCellKeyById.set(row.id, `RW-CELL-${candidateCode}`);
  }

  const villageRowsToUpdate = [];
  const newVillageRows = [];
  const villageOldToTarget = new Map();
  const oldVillageByCellCodeAndName = new Map();
  for (const village of existingVillages) {
    const parentCell = existingCells.find(({ id }) => id === village.parentId);
    const parentCode = parentCell && oldCellToSourceCode.has(parentCell.id) ? `RW-CELL-${oldCellToSourceCode.get(parentCell.id)}` : null;
    if (!parentCode) continue;
    const key = `${parentCode}:${normalize(village.name)}`;
    if (!oldVillageByCellCodeAndName.has(key)) oldVillageByCellCodeAndName.set(key, []);
    oldVillageByCellCodeAndName.get(key).push(village);
  }
  const villagePlan = [];
  for (const village of villages) {
    const cellId = apply ? cellTargetIdByCode.get(village.cellCode) : cellPlan.find(({ code }) => code === village.cellCode)?.canonical?.id;
    const nameMatches = oldVillageByCellCodeAndName.get(`${village.cellCode}:${normalize(village.name)}`) || [];
    const byCode = existingByCode.get(village.code);
    const candidates = [...new Map([...nameMatches, ...(byCode ? [byCode] : [])].map((row) => [row.id, row])).values()];
    const canonical = candidates.find((row) => row.code === village.code) || candidates[0] || null;
    villagePlan.push({ ...village, canonical, cellId });
    if (canonical) {
      villageRowsToUpdate.push({ id: canonical.id, data: { name: village.name, code: village.code, parentId: cellId || canonical.parentId, type: 'VILLAGE', isActive: true } });
    } else if (apply && cellId) {
      newVillageRows.push({ name: village.name, code: village.code, parentId: cellId, type: 'VILLAGE', isActive: true });
    }
    if (canonical) for (const duplicate of candidates) villageOldToTarget.set(duplicate.id, canonical.id);
  }
  if (apply) {
    await updateRows(client, villageRowsToUpdate);
    for (const batch of batches(newVillageRows)) await client.territory.createMany({ data: batch, skipDuplicates: true });
  }

  const resolvedVillages = apply
    ? await client.territory.findMany({ where: { code: { in: villages.map(({ code }) => code) } }, select: { id: true, code: true } })
    : [];
  const villageIdByCode = new Map(resolvedVillages.map((row) => [row.code, row.id]));
  for (const plan of villagePlan) {
    const villageId = apply ? villageIdByCode.get(plan.code) : plan.canonical?.id;
    if (villageId) for (const oldRow of oldVillageByCellCodeAndName.get(`${plan.cellCode}:${normalize(plan.name)}`) || []) villageOldToTarget.set(oldRow.id, villageId);
  }

  const staleCellIds = existingCells.filter((row) => ![...cellPlan].some((plan) => plan.canonical?.id === row.id)).map(({ id }) => id);
  const staleVillageIds = existingVillages.filter((row) => ![...villagePlan].some((plan) => plan.canonical?.id === row.id)).map(({ id }) => id);
  for (const id of staleCellIds) if (!cellOldToTarget.has(id)) cellOldToTarget.set(id, null);
  for (const id of staleVillageIds) if (!villageOldToTarget.has(id)) villageOldToTarget.set(id, null);

  const cellById = new Map(existingCells.map((row) => [row.id, row]));
  const planTerritoryMappings = [];
  for (const id of staleCellIds) {
    const targetId = cellOldToTarget.get(id) || cellById.get(id)?.parentId;
    if (targetId) planTerritoryMappings.push([id, targetId]);
  }
  for (const id of staleVillageIds) {
    const targetId = villageOldToTarget.get(id) || cellById.get(existingVillages.find((row) => row.id === id)?.parentId)?.parentId || existingVillages.find((row) => row.id === id)?.parentId;
    if (targetId) planTerritoryMappings.push([id, targetId]);
  }

  const matchingFakeUsers = users.filter((user) => user.role === 'TC' && fakeNames.has(normalize(`${user.firstName} ${user.lastName}`)));
  const plan = {
    counts: {
      matchedSectors: expectedSectors.length,
      sourceSectors: catalog.sectorCount,
      unmatchedSectors: unmatchedSectors.length,
      officialSectorsToCreate: sectorRowsToCreate.length,
      sectorNamesToStandardize: sectorRowsToRename.length,
      matchedSectorsInTcAssignedDistricts: expectedSectors.filter(({ districtAssignedToTc }) => districtAssignedToTc).length,
      unmatchedPdfSectorsInTcAssignedDistricts: unmatchedSectors.filter((entry) => assignedDistrictIds.has(districtsByName.get(normalize(entry.district))?.[0]?.id)).length,
      activeTcDistrictAssignments: assignedDistrictIds.size,
      unmatchedExistingSectors: unmatchedExistingSectors.length,
      cellsToCreate: cellPlan.filter(({ canonical }) => !canonical).length,
      villagesToCreate: villagePlan.filter(({ canonical }) => !canonical).length,
      duplicateCellsToMerge: [...cellOldToTarget].filter(([id, target]) => target && id !== target).length,
      duplicateVillagesToMerge: [...villageOldToTarget].filter(([id, target]) => target && id !== target).length,
      staleCellsToRemove: staleCellIds.length,
      staleVillagesToRemove: staleVillageIds.length,
      fakeAccountsMatched: matchingFakeUsers.length,
      activeFakeAccountsToDeactivate: matchingFakeUsers.filter(({ isActive }) => isActive).length,
    },
    unmatchedDistricts,
    unmatchedSectors: unmatchedSectors.slice(0, 80),
    fuzzySectorSuggestions: fuzzySectorSuggestions.slice(0, 80),
    unmatchedExistingSectors: unmatchedExistingSectors.slice(0, 80),
    similarlyNamedDemoAccounts: users.filter((user) => user.role === 'TC' && /jane|champion|jermaine|cole|john|tc/i.test(`${user.firstName} ${user.lastName}`)).map(({ username, firstName, lastName, role, isActive }) => ({ username, name: `${firstName} ${lastName}`, role, isActive })),
    fakeAccounts: matchingFakeUsers.map(({ id, username, firstName, lastName, role, isActive }) => ({ id, username, name: `${firstName} ${lastName}`, role, isActive })),
    apply,
  };

  if (apply) {
    await updateManyChunks(client, 'agent', 'cellId', cellOldToTarget);
    await updateManyChunks(client, 'agent', 'villageId', villageOldToTarget);
    await updateManyChunks(client, 'visitPlan', 'territoryId', planTerritoryMappings);
    if (staleVillageIds.length) await client.territory.deleteMany({ where: { id: { in: staleVillageIds } } });
    if (staleCellIds.length) await client.territory.deleteMany({ where: { id: { in: staleCellIds } } });
    const fakeIds = matchingFakeUsers.map(({ id }) => id);
    const activeFakeIds = matchingFakeUsers.filter(({ isActive }) => isActive).map(({ id }) => id);
    if (activeFakeIds.length) {
      await client.user.updateMany({ where: { id: { in: activeFakeIds }, isActive: true }, data: { isActive: false, tokenVersion: { increment: 1 } } });
    }
    if (fakeIds.length) await client.tcTerritoryAssignment.updateMany({ where: { tcId: { in: fakeIds }, isActive: true }, data: { isActive: false, endDate: new Date() } });
    await client.auditLog.create({ data: {
      action: 'IMPORT_OFFICIAL_RWA_TERRITORIES', resourceType: 'TerritoryCatalog',
      details: {
        source: 'Our current sectors\' cells and villages.pdf',
        matchedSectors: expectedSectors.length,
        createdOfficialSectors: sectorRowsToCreate.length,
        standardizedSectorNames: sectorRowsToRename.length,
        importedCells: cellPlan.length,
        importedVillages: villagePlan.length,
        removedTestCells: staleCellIds.length,
        removedTestVillages: staleVillageIds.length,
        deactivatedDemoTcAccounts: activeFakeIds.length,
      },
    } });
  }
  return plan;
}

async function main() {
  try {
    const plan = apply
      ? await prisma.$transaction((tx) => analyze(tx), { maxWait: 10000, timeout: 120000 })
      : await analyze(prisma);
    console.log(JSON.stringify(plan, null, 2));
    if (!apply) console.log('\nPreview only. Re-run with --apply to commit these changes.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`Territory import failed: ${error.message || error.code || error.name}`);
  process.exitCode = 1;
});
