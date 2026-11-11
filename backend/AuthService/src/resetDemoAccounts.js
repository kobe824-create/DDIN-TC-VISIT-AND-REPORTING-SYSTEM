require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const { PrismaClient } = require(path.join(__dirname, '..', '..', 'node_modules', '@prisma', 'client'));
const { seedDemoAccountData } = require('./demoAccountData');
const prisma = new PrismaClient();

function isDemoLabel(value) {
  return /^(demo|demo[-_])/i.test(value || '');
}

async function buildScope(db) {
  const users = await db.user.findMany({
    where: { username: { startsWith: 'demo', mode: 'insensitive' } },
    select: { id: true, username: true, role: true },
  });
  const retainedAdmin = users.find((user) => user.username.toLowerCase() === 'demo-admin' && user.role === 'ADMIN');
  const demoUsers = users.filter((user) => user !== retainedAdmin);
  const demoUserIds = demoUsers.map((user) => user.id);

  const territoryRows = await db.territory.findMany({
    select: { id: true, name: true, type: true, code: true, parentId: true },
  });
  const territoryIds = new Set(
    territoryRows.filter((territory) => isDemoLabel(territory.name) || isDemoLabel(territory.code)).map((territory) => territory.id),
  );
  let grew = true;
  while (grew) {
    grew = false;
    for (const territory of territoryRows) {
      if (territory.parentId && territoryIds.has(territory.parentId) && !territoryIds.has(territory.id)) {
        territoryIds.add(territory.id);
        grew = true;
      }
    }
  }
  const demoTerritories = territoryRows.filter((territory) => territoryIds.has(territory.id));
  const territoryIdList = [...territoryIds];

  const demoAgents = await db.agent.findMany({
    where: {
      OR: [
        { agentId: { startsWith: 'DEMO-AGT-', mode: 'insensitive' } },
        { territoryId: { in: territoryIdList } },
        { sectorId: { in: territoryIdList } },
        { cellId: { in: territoryIdList } },
        { villageId: { in: territoryIdList } },
        ...(demoUserIds.length ? [{ createdById: { in: demoUserIds } }, { championId: { in: demoUserIds } }] : []),
      ],
    },
    select: { id: true, agentId: true, name: true },
  });
  const agentIds = demoAgents.map((agent) => agent.id);

  const visits = await db.visit.findMany({
    where: {
      OR: [
        ...(demoUserIds.length ? [{ tcId: { in: demoUserIds } }] : []),
        ...(agentIds.length ? [{ agentId: { in: agentIds } }] : []),
        ...(territoryIdList.length ? [{ territoryId: { in: territoryIdList } }] : []),
      ],
    },
    select: {
      id: true,
      visitId: true,
      tcId: true,
      report: { select: { id: true } },
      photos: { select: { id: true, photoUrl: true } },
    },
  });
  const visitIds = visits.map((visit) => visit.id);
  const reportIds = visits.flatMap((visit) => visit.report ? [visit.report.id] : []);
  const photos = visits.flatMap((visit) => visit.photos);
  const assignmentWhere = {
    OR: [
      ...(demoUserIds.length ? [{ tcId: { in: demoUserIds } }, { assignedById: { in: demoUserIds } }] : []),
      ...(territoryIdList.length ? [{ territoryId: { in: territoryIdList } }] : []),
    ],
  };
  const transferWhere = {
    OR: [
      ...(demoUserIds.length ? [{ requestedByTcId: { in: demoUserIds } }, { recipientTcId: { in: demoUserIds } }] : []),
      ...(agentIds.length ? [{ agentId: { in: agentIds } }] : []),
      ...(territoryIdList.length ? [{ fromTerritoryId: { in: territoryIdList } }, { toTerritoryId: { in: territoryIdList } }] : []),
    ],
  };
  const locationWhere = {
    OR: [
      ...(demoUserIds.length ? [{ recordedById: { in: demoUserIds } }] : []),
      ...(agentIds.length ? [{ agentId: { in: agentIds } }] : []),
    ],
  };
  const resourceIds = [
    ...demoUserIds,
    ...demoUsers.map((user) => user.username),
    ...demoTerritories.flatMap((territory) => [territory.id, territory.code]),
    ...demoAgents.flatMap((agent) => [agent.id, agent.agentId]),
    ...visits.flatMap((visit) => [visit.id, visit.visitId]),
    ...reportIds,
    ...photos.map((photo) => photo.id),
  ];
  const auditWhere = {
    OR: [
      ...(demoUserIds.length ? [{ userId: { in: demoUserIds } }] : []),
      ...(resourceIds.length ? [{ resourceId: { in: resourceIds } }] : []),
    ],
  };
  const externalActiveAssignmentsWhere = territoryIdList.length ? {
    territoryId: { in: territoryIdList },
    isActive: true,
    ...(demoUserIds.length ? { tcId: { notIn: demoUserIds } } : {}),
  } : null;
  const externalVisitsWhere = territoryIdList.length || agentIds.length ? {
    AND: [
      ...(demoUserIds.length ? [{ tcId: { notIn: demoUserIds } }] : []),
      { OR: [
        ...(territoryIdList.length ? [{ territoryId: { in: territoryIdList } }] : []),
        ...(agentIds.length ? [{ agentId: { in: agentIds } }] : []),
      ] },
    ],
  } : null;

  const [assignmentCount, transferCount, locationCount, auditCount, externalActiveAssignments, externalVisits, externalPhotoReferences] = await Promise.all([
    Object.keys(assignmentWhere).length ? db.tcTerritoryAssignment.count({ where: assignmentWhere }) : 0,
    Object.keys(transferWhere).length ? db.agentTransfer.count({ where: transferWhere }) : 0,
    Object.keys(locationWhere).length ? db.agentLocation.count({ where: locationWhere }) : 0,
    Object.keys(auditWhere).length ? db.auditLog.count({ where: auditWhere }) : 0,
    externalActiveAssignmentsWhere ? db.tcTerritoryAssignment.findMany({
      where: externalActiveAssignmentsWhere,
      select: { tc: { select: { username: true } }, territory: { select: { name: true, code: true } } },
    }) : [],
    externalVisitsWhere ? db.visit.findMany({
      where: externalVisitsWhere,
      select: { visitId: true, tc: { select: { username: true } } },
    }) : [],
    photos.length ? db.visitPhoto.findMany({
      where: { photoUrl: { in: [...new Set(photos.map((photo) => photo.photoUrl))] }, visitId: { notIn: visitIds } },
      select: { photoUrl: true },
    }) : [],
  ]);
  const systemConfigReferences = demoUserIds.length
    ? await db.systemConfig.count({ where: { updatedById: { in: demoUserIds } } })
    : 0;

  return {
    retainedAdmin,
    demoUsers,
    demoTerritories,
    territoryIdList,
    demoAgents,
    visits,
    visitIds,
    reportIds,
    photos,
    assignmentWhere,
    transferWhere,
    locationWhere,
    auditWhere,
    assignmentCount,
    transferCount,
    locationCount,
    auditCount,
    systemConfigReferences,
    externalActiveAssignments,
    externalVisits,
    externallyReferencedPhotoUrls: new Set(externalPhotoReferences.map((photo) => photo.photoUrl)),
  };
}

function summarize(scope) {
  return {
    retainedAdmin: scope.retainedAdmin ? scope.retainedAdmin.username : null,
    demoAccountsToReplace: scope.demoUsers.map((user) => ({ username: user.username, role: user.role })),
    territoryTree: scope.demoTerritories.map(({ name, type, code }) => ({ name, type, code })),
    agentsToRemove: scope.demoAgents.map(({ agentId, name }) => ({ agentId, name })),
    assignments: scope.assignmentCount,
    agentTransfers: scope.transferCount,
    agentLocationRows: scope.locationCount,
    visits: scope.visits.length,
    reports: scope.reportIds.length,
    photoRecords: scope.photos.length,
    uniquePhotoFiles: new Set(scope.photos.map((photo) => photo.photoUrl)).size,
    auditLogs: scope.auditCount,
    systemConfigReferencesToClear: scope.systemConfigReferences,
    externalActiveAssignments: scope.externalActiveAssignments,
    externalVisitsInDemoTerritories: scope.externalVisits,
  };
}

function uploadFilename(photoUrl) {
  const pathname = new URL(photoUrl, 'http://localhost').pathname;
  if (!pathname.startsWith('/uploads/')) {
    throw new Error('A demo photo URL is outside the expected /uploads/ path; no database changes were made.');
  }
  const filename = path.basename(pathname);
  if (!filename || filename === '.' || filename === '..') {
    throw new Error('A demo photo has an invalid stored filename; no database changes were made.');
  }
  return filename;
}

async function removePhotoFiles(scope, uploadDirectory) {
  const urlsToRemove = [...new Set(scope.photos
    .map((photo) => photo.photoUrl)
    .filter((url) => !scope.externallyReferencedPhotoUrls.has(url)))];
  let deleted = 0;
  let missing = 0;
  for (const url of urlsToRemove) {
    const fullPath = path.join(uploadDirectory, uploadFilename(url));
    try {
      await fs.promises.unlink(fullPath);
      deleted += 1;
    } catch (error) {
      if (error.code === 'ENOENT') missing += 1;
      else throw error;
    }
  }
  return { deleted, missing, sharedFilesPreserved: scope.externallyReferencedPhotoUrls.size };
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Demo account reset is blocked when NODE_ENV=production.');
  }
  if (process.env.DEMO_RESET_ENABLED !== 'true') {
    throw new Error('Set DEMO_RESET_ENABLED=true to explicitly enable the demo account reset.');
  }

  const apply = process.argv.includes('--apply');
  const scope = await buildScope(prisma);
  const plan = summarize(scope);
  console.log(JSON.stringify({ mode: apply ? 'APPLY' : 'DRY RUN', plan }, null, 2));

  if (scope.externalActiveAssignments.length || scope.externalVisits.length) {
    throw new Error('The demo territory tree is linked to other active staff or visits; review those rows before reset.');
  }
  if (!apply) return;
  if (!scope.retainedAdmin) {
    throw new Error('The existing demo-admin account was not found; reset stopped to preserve the requested admin.');
  }
  const tcPassword = process.env.TC_INITIAL_PASSWORD || '';
  if (tcPassword.length < 8) {
    throw new Error('Set TC_INITIAL_PASSWORD to a temporary TC password of at least 8 characters.');
  }
  const uploadDirectory = process.env.DEMO_PHOTO_STORAGE_DIR;
  if (scope.photos.length && !uploadDirectory) {
    throw new Error('Set DEMO_PHOTO_STORAGE_DIR to the mounted photo volume before removing demo visits.');
  }
  if (uploadDirectory && !fs.existsSync(uploadDirectory)) {
    throw new Error('DEMO_PHOTO_STORAGE_DIR does not exist; no database changes were made.');
  }

  const result = await prisma.$transaction(async (tx) => {
    const current = await buildScope(tx);
    if (current.externalActiveAssignments.length || current.externalVisits.length) {
      throw new Error('External staff assignments or visits appeared during reset; transaction cancelled.');
    }

    const userIds = current.demoUsers.map((user) => user.id);
    const agentIds = current.demoAgents.map((agent) => agent.id);
    const territoryIds = current.territoryIdList;
    const visitIds = current.visitIds;

    if (visitIds.length) {
      await tx.visitReport.deleteMany({ where: { visitId: { in: visitIds } } });
      await tx.visitPhoto.deleteMany({ where: { visitId: { in: visitIds } } });
    }
    if (Object.keys(current.locationWhere).length) {
      await tx.agentLocation.deleteMany({ where: current.locationWhere });
    }
    if (Object.keys(current.transferWhere).length) {
      await tx.agentTransfer.deleteMany({ where: current.transferWhere });
    }
    if (Object.keys(current.auditWhere).length) {
      await tx.auditLog.deleteMany({ where: current.auditWhere });
    }
    if (Object.keys(current.assignmentWhere).length) {
      await tx.tcTerritoryAssignment.deleteMany({ where: current.assignmentWhere });
    }
    if (userIds.length) {
      await tx.systemConfig.updateMany({ where: { updatedById: { in: userIds } }, data: { updatedById: null } });
      await tx.agent.updateMany({ where: { championId: { in: userIds }, id: { notIn: agentIds } }, data: { championId: null } });
    }
    if (visitIds.length) await tx.visit.deleteMany({ where: { id: { in: visitIds } } });
    if (agentIds.length) await tx.agent.deleteMany({ where: { id: { in: agentIds } } });

    const territoriesByDepth = current.demoTerritories.map((territory) => {
      let depth = 0;
      let parentId = territory.parentId;
      while (parentId && territoryIds.includes(parentId)) {
        depth += 1;
        parentId = current.demoTerritories.find((candidate) => candidate.id === parentId)?.parentId || null;
      }
      return { id: territory.id, depth };
    }).sort((left, right) => right.depth - left.depth);
    for (const territory of territoriesByDepth) {
      await tx.territory.delete({ where: { id: territory.id } });
    }
    if (userIds.length) await tx.user.deleteMany({ where: { id: { in: userIds } } });

    return {
      setup: await seedDemoAccountData(tx, { tcPassword }),
      cleanupScope: current,
    };
  }, { timeout: 120000, maxWait: 15000 });

  const photoCleanup = uploadDirectory
    ? await removePhotoFiles(result.cleanupScope, uploadDirectory)
    : { deleted: 0, missing: 0, sharedFilesPreserved: 0 };
  console.log(JSON.stringify({
    result: 'Demo data reset completed.',
    newDemoSetup: result.setup.coordinators,
    retainedAdmin: result.setup.admin.username,
    demoTcPasswordConfigured: result.setup.temporaryTcPasswordConfigured,
    photoCleanup,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error('Demo account reset failed:', error.message || error.code || error.name);
    process.exitCode = 1;
  })
  .finally(async () => { await prisma.$disconnect(); });
