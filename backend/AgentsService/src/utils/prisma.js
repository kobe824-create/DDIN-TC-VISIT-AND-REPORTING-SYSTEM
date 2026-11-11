const path = require('path');
// Use the root-level Prisma client (schema is at project root)
const { PrismaClient } = require(path.join(__dirname, '..', '..', '..', 'node_modules', '@prisma', 'client'));
const prisma = new PrismaClient();
module.exports = prisma;
