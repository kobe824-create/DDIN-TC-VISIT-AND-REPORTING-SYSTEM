const path = require('path');
const { PrismaClient } = require(path.join(__dirname, '..', '..', '..', 'node_modules', '@prisma', 'client'));
const prisma = new PrismaClient();
module.exports = prisma;
