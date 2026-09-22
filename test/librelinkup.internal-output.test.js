const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const internalOutput = require('../lib/outputs/internal');

test('internal output deduplicates LibreLinkUp sensor records after restart', async () => {
  const stored = { treatments: [], devicestatus: [] };
  const ctx = { bus: new EventEmitter() };
  for (const kind of ['entries', 'treatments', 'devicestatus', 'profile']) {
    ctx[kind] = {
      list: (params, cb) => {
        const rows = stored[kind] || [];
        cb(null, rows.slice(-1));
      },
      create: (rows, cb) => {
        if (stored[kind]) stored[kind].push(...rows);
        cb(null, rows);
      }
    };
  }
  const batch = {
    treatments: [{ eventType: 'Sensor Start', enteredBy: 'librelinkup', created_at: '2026-09-22T07:00:00Z' }],
    devicestatus: [{ device: 'nightscout-connect-librelinkup', created_at: '2026-09-22T07:05:00Z' }]
  };
  await internalOutput({}, ctx)(batch);
  await internalOutput({}, ctx)(batch);
  assert.equal(stored.treatments.length, 1);
  assert.equal(stored.devicestatus.length, 1);
});
