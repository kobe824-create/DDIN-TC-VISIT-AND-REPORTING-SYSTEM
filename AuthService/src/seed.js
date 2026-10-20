const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { PrismaClient } = require(path.join(__dirname, '..', '..', 'node_modules', '@prisma', 'client'));
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

if (process.env.NODE_ENV === 'production') {
  console.error('The development seed contains known passwords and cannot run when NODE_ENV=production.');
  process.exit(1);
}

async function main() {
  console.log('Starting seed...');
  
  // 1. Create Admin
  const adminPassword = await bcrypt.hash('admin123', 10);
  const admin = await prisma.user.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      username: 'admin',
      email: 'admin@ddin.test',
      passwordHash: adminPassword,
      role: 'ADMIN',
      firstName: 'System',
      lastName: 'Administrator'
    }
  });

  // 2. Create sample territories
  const kigali = await prisma.territory.upsert({
    where: { code: 'PROV-KIGALI' },
    update: {},
    create: { name: 'Kigali City', type: 'PROVINCE', code: 'PROV-KIGALI' }
  });
  
  const gasabo = await prisma.territory.upsert({
    where: { code: 'DIST-GASABO' },
    update: {},
    create: { name: 'Gasabo', type: 'DISTRICT', code: 'DIST-GASABO', parentId: kigali.id }
  });

  const kacyiru = await prisma.territory.upsert({
    where: { code: 'SECT-KACYIRU' },
    update: {},
    create: { name: 'Kacyiru', type: 'SECTOR', code: 'SECT-KACYIRU', parentId: gasabo.id }
  });

  const kacyiruCell = await prisma.territory.upsert({
    where: { code: 'CELL-KACYIRU-CENTRAL' },
    update: {},
    create: { name: 'Kacyiru Central', type: 'CELL', code: 'CELL-KACYIRU-CENTRAL', parentId: kacyiru.id }
  });
  const kacyiruVillage = await prisma.territory.upsert({
    where: { code: 'VILL-KACYIRU-CENTRAL-A' },
    update: {},
    create: { name: 'Kacyiru A', type: 'VILLAGE', code: 'VILL-KACYIRU-CENTRAL-A', parentId: kacyiruCell.id }
  });

  // 3. Create sample TC
  const tcPassword = await bcrypt.hash('tc123', 10);
  const tc = await prisma.user.upsert({
    where: { username: 'tc001' },
    update: {},
    create: {
      username: 'tc001',
      email: 'tc001@ddin.test',
      passwordHash: tcPassword,
      role: 'TC',
      firstName: 'John',
      lastName: 'TC'
    }
  });

  // 4. Create sample Champion
  const champPassword = await bcrypt.hash('champion123', 10);
  const champion = await prisma.user.upsert({
    where: { username: 'champion001' },
    update: {},
    create: {
      username: 'champion001',
      email: 'champion001@ddin.test',
      passwordHash: champPassword,
      role: 'CHAMPION',
      firstName: 'Jane',
      lastName: 'Champion'
    }
  });

  // 5. Create sample agents
  const agent1 = await prisma.agent.upsert({
    where: { agentId: 'AGT-001' },
    update: {},
    create: {
      agentId: 'AGT-001',
      name: 'Agent One',
      phoneNumber: '250788000001',
      businessName: 'Biz One',
      territoryId: gasabo.id,
      sectorId: kacyiru.id,
      cellId: kacyiruCell.id,
      villageId: kacyiruVillage.id,
      championId: champion.id,
      registeredLatitude: -1.9441,
      registeredLongitude: 30.0619,
      gpsAccuracy: 10,
      createdById: admin.id
    }
  });

  // 6. Assign TC to territory
  await prisma.tcTerritoryAssignment.createMany({
    data: [
      { tcId: tc.id, territoryId: gasabo.id, assignedById: admin.id }
    ],
    skipDuplicates: true
  });

  // 7. System configs
  await prisma.systemConfig.upsert({
    where: { key: 'GEOFENCE_RADIUS_METERS' },
    update: {},
    create: { key: 'GEOFENCE_RADIUS_METERS', value: '100', description: 'Check-in allowed distance' }
  });

  console.log('Seed completed successfully!');
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
