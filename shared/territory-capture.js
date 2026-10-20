const { randomUUID } = require('crypto');
const { normalize, slug } = require('./import-normalization');

function cleanTerritoryName(value) {
  return String(value ?? '').replace(/\u00a0/g, ' ').trim().replace(/\s+/g, ' ');
}

async function findChildTerritory(client, { name, type, parentId }) {
  const cleanedName = cleanTerritoryName(name);
  if (!cleanedName || !parentId) return null;
  return client.territory.findFirst({
    where: { type, parentId, isActive: true, name: { equals: cleanedName, mode: 'insensitive' } },
    select: { id: true, name: true, type: true, parentId: true, isActive: true },
  });
}

async function findOrCreateChildTerritory(client, { name, type, parentId }) {
  const cleanedName = cleanTerritoryName(name);
  if (!cleanedName || cleanedName.length > 100) throw new Error(`Enter a ${type.toLowerCase()} name using at most 100 characters.`);
  if (!parentId) throw new Error(`Choose the parent area for this ${type.toLowerCase()}.`);

  const existing = await findChildTerritory(client, { name: cleanedName, type, parentId });
  if (existing) return existing;

  const baseCode = `${type}-${parentId}-${slug(cleanedName).toUpperCase()}`;
  const codeMatch = await client.territory.findUnique({ where: { code: baseCode }, select: { id: true, name: true, type: true, parentId: true, isActive: true } });
  const code = codeMatch && (!codeMatch.isActive || codeMatch.type !== type || codeMatch.parentId !== parentId || normalize(codeMatch.name) !== normalize(cleanedName))
    ? `${baseCode}-${randomUUID().slice(0, 8).toUpperCase()}`
    : baseCode;

  return client.territory.upsert({
    where: { code },
    update: { name: cleanedName, isActive: true },
    create: { name: cleanedName, type, parentId, code },
  });
}

module.exports = { cleanTerritoryName, findChildTerritory, findOrCreateChildTerritory };
