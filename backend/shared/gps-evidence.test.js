const test = require('node:test');
const assert = require('node:assert/strict');
const { validateGpsEvidence } = require('./gps-evidence');

const referenceTime = new Date('2026-11-24T10:00:00.000Z');
const secondsFromReference = (seconds) => new Date(referenceTime.getTime() + seconds * 1000).toISOString();
const validate = (capturedAt, sampleCount, options = {}) => validateGpsEvidence(capturedAt, sampleCount, { referenceTime, ...options });

test('accepts fresh multiple-reading evidence and normalizes the captured time', () => {
  const result = validate(secondsFromReference(-5), 3);
  assert.equal(result.ok, true);
  assert.equal(result.capturedAt.toISOString(), secondsFromReference(-5));
  assert.equal(result.sampleCount, 3);
  assert.equal(validate(referenceTime.getTime(), 5).ok, true);
});

test('rejects readings older than the freshness limit', () => {
  assert.equal(validate(secondsFromReference(-30), 3).ok, true);
  const result = validate(secondsFromReference(-31), 3);
  assert.equal(result.ok, false);
  assert.equal(result.status, 422);
  assert.match(result.error, /too old/);
});

test('rejects future readings beyond clock tolerance', () => {
  assert.equal(validate(secondsFromReference(30), 3).ok, true);
  const result = validate(secondsFromReference(31), 3);
  assert.equal(result.ok, false);
  assert.match(result.error, /ahead of the server/);
});

test('requires both metadata fields for online evidence', () => {
  for (const [capturedAt, count] of [[undefined, undefined], [undefined, 3], [secondsFromReference(-1), undefined]]) {
    assert.equal(validate(capturedAt, count).ok, false);
  }
});

test('rejects malformed timestamps and coerced or incomplete sample counts', () => {
  for (const timestamp of ['', 'not-a-time', true, false, [], {}, NaN, Infinity, 0]) {
    assert.equal(validate(timestamp, 3).ok, false, `timestamp ${String(timestamp)}`);
  }
  for (const count of [0, 2, 3.5, 21, '3', true, [3], {}, NaN, Infinity]) {
    assert.equal(validate(secondsFromReference(-1), count).ok, false, `sample count ${String(count)}`);
  }
});

test('accepts genuinely absent legacy offline evidence but rejects partial evidence', () => {
  assert.deepEqual(validate(undefined, undefined, { requireEvidence: false }), { ok: true, legacy: true });
  assert.deepEqual(validate(null, null, { requireEvidence: false }), { ok: true, legacy: true });
  for (const [capturedAt, count] of [[undefined, 3], [secondsFromReference(-1), undefined], [null, 3], [secondsFromReference(-1), null]]) {
    assert.equal(validate(capturedAt, count, { requireEvidence: false }).ok, false);
  }
  assert.equal(validate('invalid', 3, { requireEvidence: false }).ok, false);
  assert.equal(validate(secondsFromReference(-31), 3, { requireEvidence: false }).ok, false);
});

test('checks offline readings against original check-in time rather than sync time', () => {
  const offlineCheckIn = new Date('2026-11-20T07:00:00.000Z');
  const capturedAt = new Date(offlineCheckIn.getTime() - 5000).toISOString();
  assert.equal(validate(capturedAt, 3, { referenceTime: offlineCheckIn }).ok, true);
  assert.equal(validate(capturedAt, 3).ok, false);
  assert.equal(validate(capturedAt, 3, { referenceTime: 'invalid' }).ok, false);
});
