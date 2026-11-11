const { normalize } = require('./import-normalization');

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

module.exports = { cleanTerritoryName, findChildTerritory };
