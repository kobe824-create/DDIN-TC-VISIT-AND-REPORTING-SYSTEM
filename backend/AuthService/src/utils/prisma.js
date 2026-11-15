const path = require('path');
const { PrismaClient } = require(path.join(__dirname, '..', '..', '..', 'node_modules', '@prisma', 'client'));

const datasourceUrl = process.env.DATABASE_URL;
let prismaDatasourceUrl = datasourceUrl;
if (prismaDatasourceUrl) {
  const url = new URL(prismaDatasourceUrl);
  // Hosted PostgreSQL may need a few seconds to wake from an idle period.
  if (!url.searchParams.has('connect_timeout')) {
    url.searchParams.set('connect_timeout', '15');
  }
  prismaDatasourceUrl = url.toString();
}

const prisma = new PrismaClient(
  datasourceUrl
    ? { datasources: { db: { url: prismaDatasourceUrl } } }
    : undefined
);
module.exports = prisma;
