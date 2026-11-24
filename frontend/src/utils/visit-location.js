export function hasSavedMoolaLocation(agent) {
  return Boolean(agent?.locationVerified && agent.firstVisitLocationCapturedAt
    && Number.isFinite(agent.registeredLatitude) && Math.abs(agent.registeredLatitude) <= 90
    && Number.isFinite(agent.registeredLongitude) && Math.abs(agent.registeredLongitude) <= 180
    && agent.territoryId && agent.sectorId && agent.cellId && agent.villageId && String(agent.venue || '').trim());
}
