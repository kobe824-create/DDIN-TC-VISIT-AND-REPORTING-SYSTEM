const COMPLETED_VISIT_STATUSES = ['COMPLETED', 'FLAGGED'];
const ACCEPTED_LOCATION_STATUSES = ['VERIFIED', 'MANUAL_REVIEW_APPROVED'];

function shiftKigaliMonths(value, monthOffset) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Kigali', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  const monthIndex = Number(values.year) * 12 + Number(values.month) - 1 + monthOffset;
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex % 12 + 1;
  const day = Math.min(Number(values.day), new Date(Date.UTC(year, month, 0)).getUTCDate());
  const dateKey = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return new Date(`${dateKey}T${values.hour}:${values.minute}:${values.second}.${String(value.getMilliseconds()).padStart(3, '0')}+02:00`);
}

async function latestQualifiedVisits(client, network, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return new Map();
  const key = network === 'MOOLA_PLUS' ? 'externalAgentId' : 'agentId';
  const groups = await client.visit.groupBy({
    by: [key],
    where: {
      network,
      [key]: { in: ids },
      countsForMetrics: true,
      visitStatus: { in: COMPLETED_VISIT_STATUSES },
      locationStatus: { in: ACCEPTED_LOCATION_STATUSES },
    },
    _max: { visitDate: true },
  });
  return new Map(groups.filter((row) => row[key]).map((row) => [row[key], row._max.visitDate]));
}

function coverageState(lastQualifiedVisitAt, now = new Date()) {
  if (!lastQualifiedVisitAt) return { visitedInCoverage: false, lastQualifiedVisitAt: null, coverageEndsAt: null };
  const coverageEndsAt = shiftKigaliMonths(lastQualifiedVisitAt, 3);
  return {
    visitedInCoverage: lastQualifiedVisitAt <= now && now < coverageEndsAt,
    lastQualifiedVisitAt,
    coverageEndsAt,
  };
}

function kigaliDateKey(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Kigali', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${values.year}-${values.month}-${values.day}`;
}

module.exports = {
  ACCEPTED_LOCATION_STATUSES,
  COMPLETED_VISIT_STATUSES,
  coverageState,
  kigaliDateKey,
  latestQualifiedVisits,
  shiftKigaliMonths,
};
