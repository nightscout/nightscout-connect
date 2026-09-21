const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { summarizeBatch } = require('../scripts/glooko-live-probe-summary');

test('live Glooko probe refuses to contact the service without explicit --live', () => {
  const script = path.join(__dirname, '..', 'scripts', 'glooko-live-probe.js');
  const run = spawnSync(process.execPath, [script], {
    env: { ...process.env, CONNECT_GLOOKO_PASSWORD: 'private-password-marker' },
    encoding: 'utf8',
    timeout: 5000
  });

  assert.equal(run.status, 2);
  assert.match(run.stderr, /Read-only live Glooko probe/);
  assert.doesNotMatch(run.stdout + run.stderr, /private-password-marker/);
});

test('live Glooko summary flags incompatible v2 readings and a capped basal response', () => {
  const summary = summarizeBatch({
    readings: [{ display_time: '2025-10-09T08:53:20.000Z', bg_value: 123 }],
    v3Graph: { series: { cgmNormal: [{ x: 1760000000, value: 12345 }] } },
    wideBasals: Array.from({ length: 1000 }, () => ({}))
  }, { entries: [{}], treatments: [{}] });

  assert.equal(summary.sourceCounts.v2Readings, 1);
  assert.equal(summary.sourceCounts.v3Readings, 1);
  assert.equal(summary.transformedCounts.entries, 1);
  assert.deepEqual(summary.warnings, [
    'v2_readings_unusable_v3_fallback',
    'scheduled_basals_at_request_limit'
  ]);
});

test('live Glooko summary leaves ordinary uncapped responses unflagged', () => {
  const summary = summarizeBatch({ readings: [], wideBasals: [] }, { entries: [], treatments: [] });
  assert.deepEqual(summary.warnings, []);
});
