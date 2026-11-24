const MIN_GPS_SAMPLES = 3;

function validateGpsEvidence(gpsCapturedAt, gpsSampleCount, {
  referenceTime = new Date(),
  maxAgeMs = 30_000,
  futureToleranceMs = 30_000,
  requireEvidence = true,
} = {}) {
  if (gpsCapturedAt == null && gpsSampleCount == null && !requireEvidence) {
    return { ok: true, legacy: true };
  }
  if (gpsCapturedAt == null || gpsSampleCount == null) {
    return { ok: false, status: 400, error: 'Collect at least three fresh GPS readings before continuing.' };
  }

  const validTimestampType = typeof gpsCapturedAt === 'string' && gpsCapturedAt.trim().length > 0
    || typeof gpsCapturedAt === 'number' && Number.isFinite(gpsCapturedAt) && gpsCapturedAt > 0;
  const capturedAt = validTimestampType ? new Date(gpsCapturedAt) : new Date(NaN);
  const sampleCount = gpsSampleCount;
  if (!Number.isFinite(capturedAt.getTime()) || !Number.isInteger(sampleCount) || sampleCount < MIN_GPS_SAMPLES || sampleCount > 20) {
    return { ok: false, status: 400, error: 'The GPS fix is incomplete. Collect at least three fresh readings and retry.' };
  }

  const referenceMs = new Date(referenceTime).getTime();
  const ageMs = referenceMs - capturedAt.getTime();
  if (!Number.isFinite(referenceMs)) {
    return { ok: false, status: 400, error: 'The GPS check-in time is invalid. Capture your location again.' };
  }
  if (ageMs < -futureToleranceMs) {
    return { ok: false, status: 400, error: 'The GPS reading time is ahead of the server. Check the device clock and capture your location again.' };
  }
  if (ageMs > maxAgeMs) {
    return { ok: false, status: 422, error: 'The GPS reading is too old. Capture your location again before continuing.' };
  }
  return { ok: true, capturedAt, sampleCount };
}

module.exports = { MIN_GPS_SAMPLES, validateGpsEvidence };
