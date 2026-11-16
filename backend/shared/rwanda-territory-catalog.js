const catalog = require('../data/rwanda-territory-catalog.json');

const normalize = (value) => String(value || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');

function isOfficialTerritoryPath(path = []) {
  const names = path.filter((area) => area?.type !== 'PROVINCE').map((area) => normalize(area?.name)).filter(Boolean);
  if (!names.length) return false;
  let current = catalog.districts.find((district) => normalize(district.name) === names[0]);
  if (!current) return false;
  const childKeys = { SECTOR: 'sectors', CELL: 'cells', VILLAGE: 'villages' };
  for (let index = 1; index < names.length; index += 1) {
    const type = path.filter((area) => area?.type !== 'PROVINCE')[index]?.type;
    const children = current[childKeys[type]];
    current = Array.isArray(children) ? children.find((child) => normalize(child.name) === names[index]) : null;
    if (!current) return false;
  }
  return true;
}

module.exports = { isOfficialTerritoryPath };
