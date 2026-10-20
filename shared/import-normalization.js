function clean(value) {
  return String(value ?? '').replace(/\u00a0/g, ' ').trim().replace(/\s+/g, ' ');
}

function normalize(value) {
  return clean(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
}

function slug(value) {
  return normalize(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

const PROVINCE_ALIASES = new Map([
  ['east', 'Eastern Province'],
  ['iburasirazuba', 'Eastern Province'],
  ['eastern province', 'Eastern Province'],
  ['west', 'Western Province'],
  ['iburengerazuba', 'Western Province'],
  ['western province', 'Western Province'],
  ['north', 'Northern Province'],
  ['northern', 'Northern Province'],
  ['amajyaruguru', 'Northern Province'],
  ['nothern province', 'Northern Province'],
  ['northern province', 'Northern Province'],
  ['south', 'Southern Province'],
  ['southern', 'Southern Province'],
  ['amajyepfo', 'Southern Province'],
  ['amagepfo', 'Southern Province'],
  ['southern province', 'Southern Province'],
  ['kigali', 'Kigali City'],
  ['kigali city', 'Kigali City'],
  ['umugi wa kigali', 'Kigali City'],
]);

function canonicalProvince(value) {
  return PROVINCE_ALIASES.get(normalize(value)) || null;
}

const DISTRICT_ALIASES = new Map([
  ['gastibo', 'Gatsibo'],
  ['gatsibo', 'Gatsibo'],
]);

// The supplied roster has a few rows where the district is valid but the
// province column disagrees with the majority of rows for that district.
const DISTRICT_PROVINCES = new Map([
  ['huye', 'Southern Province'],
  ['kamonyi', 'Southern Province'],
  ['musanze', 'Northern Province'],
  ['nyabihu', 'Western Province'],
  ['nyanza', 'Southern Province'],
]);

function canonicalDistrict(value) {
  const cleaned = clean(value);
  if (!cleaned) return '';
  return DISTRICT_ALIASES.get(normalize(cleaned)) || cleaned.toLocaleLowerCase().replace(/(^|\s)\p{L}/gu, (letter) => letter.toLocaleUpperCase());
}

function canonicalProvinceForDistrict(value) {
  return DISTRICT_PROVINCES.get(normalize(canonicalDistrict(value))) || null;
}

function headerKey(value) {
  return normalize(value).replace(/[^a-z0-9]+/g, ' ').trim();
}

function findHeader(headers, aliases) {
  const keys = new Set(aliases.map(headerKey));
  return headers.findIndex((header) => keys.has(headerKey(header)));
}

module.exports = { canonicalDistrict, canonicalProvince, canonicalProvinceForDistrict, clean, findHeader, headerKey, normalize, slug };
