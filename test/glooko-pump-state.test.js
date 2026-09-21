'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { transform } = require('../lib/sources/glooko/map');
const { rectangles, DELIVERY_SERIES } = require('../lib/sources/glooko/pump-state');
const reconcile = require('../lib/outputs/glooko-pump-state');
const opts = { glookoEmail: 'synthetic@example.test', glookoTimezone: 'Europe/Berlin' };
const start = Date.parse('2026-07-01T12:00:00Z') / 1000;
function rect(from, to) {
  return [
    { x: from, y: 0 },
    { x: from, y: 1 },
    { x: to, y: 1 },
    { x: to, y: 0 },
    { x: to, y: null }
  ];
}
function batch(series = {}) {
  return {
    glookoGraphWindow: { start: '2026-07-01T00:00:00.000Z', end: '2026-07-02T00:00:00.000Z' },
    v3Graph: { series: { ...Object.fromEntries(DELIVERY_SERIES.map((k) => [k, []])), ...series } }
  };
}
test('five drawing points become one historical note, never insulin or basal', () => {
  const out = transform(batch({ basalBarAutomatedSuspend: rect(start, start + 1800) }), opts);
  assert.equal(out.treatments.length, 1);
  const row = out.treatments[0];
  assert.equal(row.eventType, 'Note');
  assert.equal(row.duration, 30);
  assert.equal(row.created_at, '2026-07-01T10:00:00.000Z');
  assert.equal(row.notes, 'Automated delivery paused');
  assert.equal(row.glookoPumpState.historical, true);
  for (const field of ['insulin', 'carbs', 'absolute', 'rate', 'percent', 'isAnnouncement'])
    assert.equal(row[field], undefined);
  assert.equal(out.devicestatus, undefined);
});
test('adjacent identical intervals merge and real gaps remain gaps', () => {
  const out = transform(
    batch({
      basalBarAutomated: [
        ...rect(start, start + 600),
        ...rect(start + 600, start + 1200),
        ...rect(start + 1800, start + 2400)
      ]
    }),
    opts
  );
  assert.deepEqual(
    out.treatments.map((r) => r.duration),
    [20, 10]
  );
});
test('suspension and maximum delivery take precedence without overlapping bars', () => {
  const out = transform(
    batch({
      basalBarAutomated: rect(start, start + 3600),
      basalBarAutomatedMax: rect(start + 600, start + 1800),
      basalBarAutomatedSuspend: rect(start + 1200, start + 2400)
    }),
    opts
  );
  assert.deepEqual(
    out.treatments.map((r) => [r.glookoPumpState.state, r.duration]),
    [
      ['automated', 10],
      ['maximum', 10],
      ['paused', 20],
      ['automated', 20]
    ]
  );
  for (let i = 1; i < out.treatments.length; i++)
    assert.ok(
      Date.parse(out.treatments[i - 1].glookoPumpState.end) <=
        Date.parse(out.treatments[i].created_at)
    );
});
test('unchanged replay and extended end time keep the same source identity', () => {
  const a = transform(batch({ basalBarAutomated: rect(start, start + 600) }), opts);
  const b = transform(batch({ basalBarAutomated: rect(start, start + 1200) }), opts);
  assert.equal(a.treatments[0].identifier, b.treatments[0].identifier);
  assert.notEqual(a.treatments[0].duration, b.treatments[0].duration);
  assert.deepEqual(a, transform(batch({ basalBarAutomated: rect(start, start + 600) }), opts));
  assert.notEqual(
    a.treatments[0].identifier,
    transform(batch({ basalBarAutomated: rect(start, start + 600) }), {
      ...opts,
      glookoEmail: 'another@example.test'
    }).treatments[0].identifier
  );
});
test('midnight slices retain identity when the fetch window advances', () => {
  const midnight = Date.parse('2026-07-02T00:00:00Z') / 1000;
  const first = batch({ basalBarAutomated: rect(midnight - 600, midnight + 600) });
  first.glookoGraphWindow.end = '2026-07-03T00:00:00.000Z';
  const second = JSON.parse(JSON.stringify(first));
  second.glookoGraphWindow.start = '2026-07-02T00:00:00.000Z';
  const a = transform(first, opts),
    b = transform(second, opts);
  assert.equal(a.treatments.length, 2);
  assert.equal(b.treatments.length, 1);
  assert.equal(a.treatments[1].identifier, b.treatments[0].identifier);
});
test('pump mode metadata is deduplicated and combined with delivery states', () => {
  const row = {
    timestamp: '2026-07-01T12:00:00Z',
    endTimestamp: '2026-07-01T13:00:00Z',
    duration: 3600
  };
  const out = transform(
    batch({ pumpOp5LimitedMode: [row, row], basalBarAutomated: rect(start + 600, start + 1200) }),
    opts
  );
  assert.equal(out.treatments.length, 3);
  assert.equal(out.treatments[1].notes, 'Automated delivery (limited mode)');
  assert.ok(out.treatments.every((r) => r.glookoSource === 'pump-state'));
});
test('malformed delivery rectangles fail explicitly instead of guessing a rate', () => {
  const valid = rect(start, start + 600);
  for (const rows of [
    valid.slice(1),
    [{ x: start, y: 4 }],
    rect(start + 600, start),
    valid.map((r, i) => (i === 2 ? { ...r, y: 2 } : r)),
    valid.map((r, i) => (i === 4 ? { ...r, x: NaN } : r))
  ]) {
    assert.throws(() => rectangles(rows), /INVALID_DELIVERY_STATE_GRAPH/);
  }
});
test('absent graph capability does not reconcile or erase historical notes', () => {
  assert.equal(transform({ v3Graph: { series: {} } }, opts).glookoSync.pumpStateWindow, undefined);
  const out = transform(batch(), opts);
  assert.deepEqual(out.glookoSync.pumpStateWindow.identifiers, []);
});
test('reconciliation only removes obsolete state identities within its scoped window', async () => {
  const window = {
    accountKey: 'synthetic-owner',
    from: '2026-07-01T00:00:00Z',
    to: '2026-07-02T00:00:00Z',
    identifiers: ['glooko:pump-state:keep']
  };
  const deletes = [];
  await reconcile(
    window,
    async (query) => {
      assert.equal(query.find.eventType, 'Note');
      assert.equal(query.find.glookoSource, 'pump-state');
      assert.equal(query.find['glookoPumpState.accountKey'], window.accountKey);
      assert.deepEqual(query.find.created_at, { $gte: window.from, $lt: window.to });
      return [
        { identifier: 'glooko:pump-state:keep' },
        { identifier: 'glooko:pump-state:obsolete' },
        { identifier: 'other-uploader' }
      ];
    },
    async (query) => deletes.push(query)
  );
  assert.equal(deletes.length, 1);
  assert.deepEqual(deletes[0].find.identifier.$in, ['glooko:pump-state:obsolete']);
  assert.equal(deletes[0].find['glookoPumpState.accountKey'], window.accountKey);
});
test('reconciliation failure is not silently acknowledged', async () => {
  const window = { identifiers: [] };
  await assert.rejects(
    reconcile(
      window,
      async () => Array.from({ length: 5000 }, () => ({})),
      async () => assert.fail('must not delete')
    ),
    /RECONCILE_LIMIT/
  );
  await assert.rejects(
    reconcile(
      window,
      async () => [{ identifier: 'glooko:pump-state:old' }],
      async () => {
        throw Error('storage failure');
      }
    ),
    /storage failure/
  );
});
