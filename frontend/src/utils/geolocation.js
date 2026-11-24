export const GPS_MAX_FIX_AGE_MS = 15_000;
const MIN_SAMPLES = 3;
const MIN_SAMPLE_SPAN_MS = 2_000;

export function distanceMeters(a, b) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const latitudeDelta = radians(b.latitude - a.latitude);
  const longitudeDelta = radians(b.longitude - a.longitude);
  const value = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(Math.max(0, 1 - value)));
}

function eligibleReadings(readings, maxAccuracyMeters, now) {
  const seen = new Set();
  return readings.filter(({ coords, timestamp }) => {
    if (!Number.isFinite(timestamp) || timestamp <= 0 || now - timestamp > GPS_MAX_FIX_AGE_MS || timestamp - now > 5_000
      || ![coords?.latitude, coords?.longitude, coords?.accuracy].every(Number.isFinite)
      || Math.abs(coords.latitude) > 90 || Math.abs(coords.longitude) > 180
      || coords.accuracy <= 0 || coords.accuracy > maxAccuracyMeters || seen.has(timestamp)) return false;
    seen.add(timestamp);
    return true;
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function stableGpsFix(readings, { maxAccuracyMeters = 50, now = Date.now() } = {}) {
  const fresh = eligibleReadings(readings, maxAccuracyMeters, now);
  const fixes = [];
  for (const anchor of fresh) {
    // A lone accurate-looking outlier must not move a consistent cluster.
    const cluster = fresh.filter((reading) => distanceMeters(anchor.coords, reading.coords) <= maxAccuracyMeters)
      .sort((a, b) => b.timestamp - a.timestamp).slice(0, 5);
    if (cluster.length < MIN_SAMPLES) continue;
    const timestamps = cluster.map(({ timestamp }) => timestamp);
    if (Math.max(...timestamps) - Math.min(...timestamps) < MIN_SAMPLE_SPAN_MS) continue;
    const latitude = median(cluster.map(({ coords }) => coords.latitude));
    const longitude = median(cluster.map(({ coords }) => coords.longitude));
    const accuracy = Math.ceil(Math.max(...cluster.map(({ coords }) => Math.max(coords.accuracy, distanceMeters(coords, { latitude, longitude })))));
    if (accuracy > maxAccuracyMeters) continue;
    fixes.push({ coords: { latitude, longitude, accuracy }, timestamp: new Date(Math.max(...timestamps)).toISOString(), sampleCount: cluster.length });
  }
  return fixes.sort((a, b) => b.sampleCount - a.sampleCount || a.coords.accuracy - b.coords.accuracy || Date.parse(b.timestamp) - Date.parse(a.timestamp))[0] || null;
}

export function acquireBestLocation({ durationMs = 60_000, maxAccuracyMeters = 50, onProgress, target, signal } = {}) {
  return new Promise((resolve, reject) => {
    const geolocation = globalThis.navigator?.geolocation;
    if (!geolocation?.getCurrentPosition) { reject(new Error('This browser does not provide GPS readings.')); return; }
    if (signal?.aborted) { reject(new DOMException('GPS collection cancelled.', 'AbortError')); return; }
    const readings = [];
    let finished = false;
    let watchId = null;
    let deadlineTimer;
    let pollTimer;
    let requestTimer;
    let requestSequence = 0;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadlineTimer);
      clearTimeout(pollTimer);
      clearTimeout(requestTimer);
      if (watchId != null) geolocation.clearWatch(watchId);
      signal?.removeEventListener('abort', cancel);
      if (error) reject(error);
      else resolve(result);
    };
    const cancel = () => finish(new DOMException('GPS collection cancelled.', 'AbortError'));
    const receive = (position) => {
      if (finished) return;
      const reading = { timestamp: position?.timestamp, coords: {
        latitude: position?.coords?.latitude, longitude: position?.coords?.longitude, accuracy: position?.coords?.accuracy,
      } };
      if (!eligibleReadings([reading], maxAccuracyMeters, Date.now()).length) return;
      if (readings.some(({ timestamp }) => Math.abs(timestamp - reading.timestamp) < 750)) return;
      readings.push(reading);
      const fresh = eligibleReadings(readings, maxAccuracyMeters, Date.now()).sort((a, b) => a.timestamp - b.timestamp).slice(-20);
      readings.splice(0, readings.length, ...fresh);
      onProgress?.(Math.min(MIN_SAMPLES, readings.length));
      const fix = stableGpsFix(readings, { maxAccuracyMeters });
      // Keep collecting if the first stable fix still drifts outside the saved radius.
      if (fix && (!target || distanceMeters(fix.coords, target) <= target.radiusMeters)) finish(null, fix);
    };
    const handleError = (error) => {
      if (!finished && error.code === 1) finish(new Error('Location access was denied. Allow location access in browser settings, then try again.'));
    };
    const poll = () => {
      if (finished) return;
      const sequence = ++requestSequence;
      let settled = false;
      const next = () => {
        if (settled || finished || sequence !== requestSequence) return;
        settled = true;
        clearTimeout(requestTimer);
        pollTimer = setTimeout(poll, 1_000);
      };
      // Some devices do not send watch updates while stationary. Request new fixes too.
      requestTimer = setTimeout(next, 8_000);
      try {
        geolocation.getCurrentPosition((position) => {
          if (settled || sequence !== requestSequence || finished) return;
          receive(position);
          next();
        }, (error) => { handleError(error); next(); }, { enableHighAccuracy: true, maximumAge: 0, timeout: 8_000 });
      } catch (error) { finish(error); }
    };
    signal?.addEventListener('abort', cancel, { once: true });
    deadlineTimer = setTimeout(() => {
      const fix = stableGpsFix(readings, { maxAccuracyMeters });
      if (fix && target && distanceMeters(fix.coords, target) > target.radiusMeters) {
        finish(new Error(`GPS places you ${Math.round(distanceMeters(fix.coords, target))} m from the saved agent location; the allowed radius is ${target.radiusMeters} m. Move closer, or ask an administrator to check the saved location if you are already with the agent.`));
        return;
      }
      const count = eligibleReadings(readings, maxAccuracyMeters, Date.now()).length;
      finish(new Error(`Could not verify your location within ${Math.ceil(durationMs / 1000)} seconds (${Math.min(count, MIN_SAMPLES)}/3 recent readings; accuracy must be ±${maxAccuracyMeters} m or better). Keep location enabled, stay near an open window or outdoors, and retry.`));
    }, durationMs);
    if (geolocation.watchPosition) {
      try {
        watchId = geolocation.watchPosition(receive, handleError, { enableHighAccuracy: true, maximumAge: 0, timeout: 8_000 });
        if (finished) geolocation.clearWatch(watchId);
      } catch { /* One-shot requests remain available when watching is unsupported. */ }
    }
    poll();
  });
}
