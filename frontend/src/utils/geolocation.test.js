import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireBestLocation, distanceMeters, stableGpsFix } from './geolocation.js';
import { hasSavedMoolaLocation } from './visit-location.js';

const NOW = Date.UTC(2026, 10, 24, 10);
const coords = { latitude: -1.94, longitude: 30.06, accuracy: 12 };
const reading = (timestamp, overrides = {}) => ({ timestamp, coords: { ...coords, ...overrides } });
const stable = (overrides = {}) => [-2000, -1000, 0].map((offset) => reading(NOW + offset, overrides));

function mockGps(t, oneShot = (success) => success(reading(Date.now()))) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const state = { requests: 0, cleared: [], progress: [], watch: null, watchError: null };
  const geolocation = {
    watchPosition(success, error, options) { state.watch = success; state.watchError = error; assert.equal(options.maximumAge, 0); return 7; },
    clearWatch(id) { state.cleared.push(id); },
    getCurrentPosition(success, error, options) {
      state.requests += 1;
      assert.deepEqual(options, { enableHighAccuracy: true, maximumAge: 0, timeout: 8000 });
      oneShot(success, error, state.requests);
    },
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { geolocation } });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else delete globalThis.navigator;
  });
  return { state, geolocation };
}

function advance(t, seconds) {
  for (let index = 0; index < seconds; index += 1) t.mock.timers.tick(1000);
}

test('combines three fresh stationary fixes without claiming better accuracy', () => {
  const fix = stableGpsFix(stable(), { now: NOW });
  assert.equal(fix.sampleCount, 3);
  assert.equal(fix.timestamp, new Date(NOW).toISOString());
  assert.equal(fix.coords.latitude, coords.latitude);
  assert.equal(fix.coords.accuracy, coords.accuracy);
});

test('rejects stale, future, inaccurate, invalid and duplicate evidence', () => {
  for (const readings of [
    stable().map((item) => ({ ...item, timestamp: item.timestamp - 16000 })),
    stable().map((item) => ({ ...item, timestamp: item.timestamp + 10000 })),
    stable({ accuracy: 51 }), stable({ accuracy: 0 }), stable({ latitude: 91 }), stable({ longitude: NaN }),
    [reading(NOW), reading(NOW), reading(NOW)],
    [reading(NOW - 500), reading(NOW - 250), reading(NOW)],
  ]) assert.equal(stableGpsFix(readings, { now: NOW }), null);
});

test('excludes a distant accurate-looking outlier from a stable cluster', () => {
  const fix = stableGpsFix([...stable(), reading(NOW - 3000, { latitude: -1.9, accuracy: 1 })], { now: NOW });
  assert.equal(fix.sampleCount, 3);
  assert.equal(fix.coords.latitude, coords.latitude);
  assert.equal(stableGpsFix([reading(NOW - 2000, { latitude: -1.9 }), reading(NOW - 1000), reading(NOW, { latitude: -1.98 })], { now: NOW }), null);
});

test('first capture requires 20m accuracy even though ordinary check-in allows 50m', () => {
  assert.equal(stableGpsFix(stable({ accuracy: 30 }), { now: NOW, maxAccuracyMeters: 20 }), null);
  assert.ok(stableGpsFix(stable({ accuracy: 30 }), { now: NOW, maxAccuracyMeters: 50 }));
});

test('requests fresh readings while the stationary watcher stays silent and stops on success', async (t) => {
  const { state } = mockGps(t);
  const result = acquireBestLocation({ onProgress: (count) => state.progress.push(count) });
  advance(t, 2);
  const fix = await result;
  assert.equal(fix.sampleCount, 3);
  assert.deepEqual(state.progress, [1, 2, 3]);
  assert.deepEqual(state.cleared, [7]);
  advance(t, 60);
  assert.equal(state.requests, 3);
});

test('recovers from temporary GPS unavailability and watcher timeout', async (t) => {
  const { state } = mockGps(t, (success, error, count) => count === 1 ? error({ code: 2 }) : success(reading(Date.now())));
  const result = acquireBestLocation();
  state.watchError({ code: 3 });
  advance(t, 3);
  assert.equal((await result).sampleCount, 3);
});

test('fails within 60 seconds if the device never responds and ignores late results', async (t) => {
  let late;
  const { state } = mockGps(t, (success) => { late = success; });
  const result = acquireBestLocation();
  const rejected = assert.rejects(result, /within 60 seconds/);
  advance(t, 60);
  await rejected;
  const requests = state.requests;
  late(reading(Date.now()));
  advance(t, 20);
  assert.equal(state.requests, requests);
  assert.deepEqual(state.cleared, [7]);
});

test('cached timestamps do not masquerade as three new GPS readings', async (t) => {
  const { state } = mockGps(t, (success) => success(reading(NOW)));
  const result = acquireBestLocation({ durationMs: 6000 });
  const rejected = assert.rejects(result, /1\/3 recent readings/);
  advance(t, 6);
  await rejected;
  assert.deepEqual(state.cleared, [7]);
});

test('permission denial ends immediately without continuing requests', async (t) => {
  const { state } = mockGps(t, (_success, error) => error({ code: 1 }));
  await assert.rejects(acquireBestLocation(), /Location access was denied/);
  advance(t, 60);
  assert.equal(state.requests, 1);
  assert.deepEqual(state.cleared, [7]);
});

test('cancellation clears the watcher and scheduled requests', async (t) => {
  const { state } = mockGps(t);
  const controller = new AbortController();
  const result = acquireBestLocation({ signal: controller.signal });
  const rejected = assert.rejects(result, { name: 'AbortError' });
  controller.abort();
  await rejected;
  state.watch(reading(Date.now()));
  advance(t, 60);
  assert.equal(state.requests, 1);
  assert.deepEqual(state.cleared, [7]);
});

test('keeps collecting after early drift outside the radius and accepts a later stable fix', async (t) => {
  const { state } = mockGps(t, (success, _error, count) => success(reading(Date.now(), count <= 3 ? { latitude: -1.95 } : {})));
  const result = acquireBestLocation({ target: { ...coords, radiusMeters: 100 } });
  advance(t, 5);
  const fix = await result;
  assert.ok(distanceMeters(fix.coords, coords) <= 100);
  assert.equal(state.requests, 6);
});

test('a consistently outside fix is denied without an endless wait', async (t) => {
  mockGps(t);
  const result = acquireBestLocation({ durationMs: 6000, target: { latitude: -1.95, longitude: coords.longitude, radiusMeters: 100 } });
  const rejected = assert.rejects(result, /allowed radius is 100 m/);
  advance(t, 6);
  await rejected;
});

test('Moola Plus readiness depends on a saved capture and saved area, not unsaved form inputs', () => {
  const saved = { locationVerified: true, firstVisitLocationCapturedAt: new Date(NOW).toISOString(), registeredLatitude: coords.latitude, registeredLongitude: coords.longitude, territoryId: 'district', sectorId: 'sector', cellId: 'cell', villageId: 'village', venue: 'Market' };
  assert.equal(hasSavedMoolaLocation(saved), true);
  for (const key of Object.keys(saved)) assert.equal(hasSavedMoolaLocation({ ...saved, [key]: null }), false, key);
  assert.equal(hasSavedMoolaLocation({ ...saved, venue: '   ' }), false);
  assert.equal(hasSavedMoolaLocation({ ...saved, registeredLatitude: NaN }), false);
  assert.equal(hasSavedMoolaLocation({ ...saved, registeredLatitude: 91 }), false);
  assert.equal(hasSavedMoolaLocation({ ...saved, registeredLongitude: 181 }), false);
});
