require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const path = require('path');
const { PrismaClient } = require(path.join(__dirname, '..', '..', 'node_modules', '@prisma', 'client'));
const { seedDemoAccountData } = require('./demoAccountData');
const prisma = new PrismaClient();

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Demo accounts cannot be seeded when NODE_ENV=production.');
  }
  if (process.env.DEMO_SEED_ENABLED !== 'true') {
    throw new Error('Set DEMO_SEED_ENABLED=true to explicitly enable demo-account creation.');
  }

  const result = await seedDemoAccountData(prisma, { tcPassword: process.env.TC_INITIAL_PASSWORD || '' });
  console.log(JSON.stringify({
    ...result,
    adminInitialPassword: result.admin.initialPassword || undefined,
    admin: { username: result.admin.username, created: result.admin.created },
    note: 'Both demo TCs use the configured TC_INITIAL_PASSWORD and must change it at first sign-in.',
  }, null, 2));
}

main()
  .catch((error) => {
    console.error('Demo account setup failed:', error.message || error.code || error.name);
    process.exitCode = 1;
  })
  .finally(async () => { await prisma.$disconnect(); });
