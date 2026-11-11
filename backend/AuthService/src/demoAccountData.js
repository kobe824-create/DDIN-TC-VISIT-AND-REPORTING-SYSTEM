const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const COORDINATORS = [
  {
    username: 'demo-tc-1',
    email: 'demo-tc-1@ddin.test',
    firstName: 'Demo',
    lastName: 'Coordinator North',
    region: 'NORTH',
    agentId: 'DEMO-AGT-101',
    agentName: 'Demo Agent North',
    businessName: 'Demo Shop North',
    latitude: -1.9441,
    longitude: 30.0619,
  },
  {
    username: 'demo-tc-2',
    email: 'demo-tc-2@ddin.test',
    firstName: 'Demo',
    lastName: 'Coordinator South',
    region: 'SOUTH',
    agentId: 'DEMO-AGT-202',
    agentName: 'Demo Agent South',
    businessName: 'Demo Shop South',
    latitude: -1.9536,
    longitude: 30.0914,
  },
];

function randomPassword() {
  return crypto.randomBytes(18).toString('base64url');
}

async function getOrCreateUser(tx, definition, password, expiresAt) {
  const existing = await tx.user.findUnique({ where: { username: definition.username } });
  if (existing) {
    if (existing.role !== definition.role) {
      throw new Error(`Cannot seed ${definition.username}: the existing account has a different role.`);
    }
    return { user: existing, created: false, password: null };
  }

  const conflictingEmail = await tx.user.findUnique({ where: { email: definition.email } });
  if (conflictingEmail) {
    throw new Error(`Cannot create ${definition.username}: its email is already assigned to another account.`);
  }

  const user = await tx.user.create({
    data: {
      ...definition,
      passwordHash: await bcrypt.hash(password, 12),
      mustChangePassword: true,
      passwordResetExpiresAt: expiresAt,
      isActive: true,
    },
  });
  return { user, created: true, password };
}

async function getOrCreateTerritory(tx, { name, type, parentId = null, code }) {
  const existing = await tx.territory.findUnique({ where: { code } });
  if (existing) {
    if (existing.type !== type || existing.parentId !== parentId) {
      throw new Error(`Cannot seed territory ${code}: its existing hierarchy does not match the demo setup.`);
    }
    if (!existing.isActive) {
      return tx.territory.update({ where: { id: existing.id }, data: { isActive: true, name } });
    }
    return existing;
  }
  return tx.territory.create({ data: { name, type, parentId, code } });
}

async function seedDemoAccountData(tx, { tcPassword }) {
  if (typeof tcPassword !== 'string' || tcPassword.length < 8) {
    throw new Error('Set TC_INITIAL_PASSWORD to a temporary TC password of at least 8 characters.');
  }

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const admin = await getOrCreateUser(tx, {
    username: 'demo-admin',
    email: 'demo-admin@ddin.test',
    role: 'ADMIN',
    firstName: 'Demo',
    lastName: 'Administrator',
  }, randomPassword(), expiresAt);

  const province = await getOrCreateTerritory(tx, {
    name: 'Demo Province', type: 'PROVINCE', code: 'DEMO-PROV',
  });

  const seeded = [];
  for (const coordinator of COORDINATORS) {
    const suffix = coordinator.region;
    const district = await getOrCreateTerritory(tx, {
      name: `Demo District ${suffix}`,
      type: 'DISTRICT',
      parentId: province.id,
      code: `DEMO-DIST-${suffix}`,
    });
    const sector = await getOrCreateTerritory(tx, {
      name: `Demo Sector ${suffix}`,
      type: 'SECTOR',
      parentId: district.id,
      code: `DEMO-SECT-${suffix}`,
    });
    const cell = await getOrCreateTerritory(tx, {
      name: `Demo Cell ${suffix}`,
      type: 'CELL',
      parentId: sector.id,
      code: `DEMO-CELL-${suffix}`,
    });
    const village = await getOrCreateTerritory(tx, {
      name: `Demo Village ${suffix}`,
      type: 'VILLAGE',
      parentId: cell.id,
      code: `DEMO-VILLAGE-${suffix}`,
    });

    const tc = await getOrCreateUser(tx, {
      username: coordinator.username,
      email: coordinator.email,
      role: 'TC',
      firstName: coordinator.firstName,
      lastName: coordinator.lastName,
    }, tcPassword, expiresAt);

    const assignment = await tx.tcTerritoryAssignment.findFirst({
      where: { tcId: tc.user.id, territoryId: district.id, isActive: true },
    });
    if (!assignment) {
      await tx.tcTerritoryAssignment.create({
        data: { tcId: tc.user.id, territoryId: district.id, assignedById: admin.user.id },
      });
    }

    const address = `Demo Province, Demo District ${suffix}, Demo Sector ${suffix}`;
    const agentData = {
      name: coordinator.agentName,
      businessName: coordinator.businessName,
      address,
      territoryId: district.id,
      sectorId: sector.id,
      cellId: cell.id,
      villageId: village.id,
      registeredLatitude: coordinator.latitude,
      registeredLongitude: coordinator.longitude,
      gpsAccuracy: 10,
      locationVerified: true,
      createdById: admin.user.id,
    };
    const agent = await tx.agent.upsert({
      where: { agentId: coordinator.agentId },
      update: agentData,
      create: { agentId: coordinator.agentId, ...agentData },
    });

    const locationHistory = await tx.agentLocation.findFirst({
      where: { agentId: agent.id, reason: 'DEMO_SEED' },
    });
    if (!locationHistory) {
      await tx.agentLocation.create({
        data: {
          agentId: agent.id,
          latitude: coordinator.latitude,
          longitude: coordinator.longitude,
          accuracy: 10,
          recordedById: admin.user.id,
          reason: 'DEMO_SEED',
        },
      });
    }

    seeded.push({
      coordinator: { username: tc.user.username, created: tc.created },
      territory: district.name,
      agent: { agentId: agent.agentId, name: agent.name },
    });
  }

  await tx.systemConfig.upsert({
    where: { key: 'GEOFENCE_RADIUS_METERS' },
    update: {},
    create: { key: 'GEOFENCE_RADIUS_METERS', value: '100', description: 'Check-in allowed distance' },
  });

  return {
    admin: { username: admin.user.username, created: admin.created, initialPassword: admin.password },
    coordinators: seeded,
    temporaryTcPasswordConfigured: true,
    passwordExpiresAt: expiresAt.toISOString(),
  };
}

module.exports = { seedDemoAccountData };
