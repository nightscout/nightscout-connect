const assert = require('node:assert/strict');
const test = require('node:test');
const nightscoutSource = require('../lib/sources/nightscout');
const nightscoutOutput = require('../lib/outputs/nightscout');

// Synthetic records only. These contract tests are not proof that legacy
// Nightscout storage fields, pagination or credential-free sites work; see
// docs/pr-52-review.md for the live-server findings that still block merging.
function fixture(options = {}) {
  const calls = [];
  const at = Date.now() - 60000;
  const rows = {
    entries: [{ identifier: 'entry-1', date: at, sgv: 110, type: 'sgv' }],
    treatments: [{ identifier: 'treatment-1', date: at, eventType: 'Note', notes: 'Synthetic' }],
    devicestatus: [{ identifier: 'status-1', date: at, device: 'synthetic' }],
    profile: [{ defaultProfile: 'Synthetic', store: {} }]
  };
  const http = {
    async get(path, config = {}) {
      calls.push({ path, config });
      if (path === '/api/v3/version') return { data: { result: { apiVersion: '3.0.5' } } };
      if (path === '/api/v2/authorization/request/reader') return { data: { token: 'synthetic-jwt', exp: 20, iat: 10 } };
      assert.equal(config.headers.Authorization, 'Bearer synthetic-jwt');
      if (options.fail === path) throw Object.assign(new Error('Synthetic HTTP failure'), { response: { status: 401 } });
      if (path === '/api/v1/profile.json') return { data: rows.profile };
      assert.match(path, /^\/api\/v3\/(entries|treatments|devicestatus)$/);
      return { data: { result: rows[path.split('/').pop()] } };
    }
  };
  const source = nightscoutSource({ url: 'https://source.example?token=reader', apiSecret: '', ...options }, { create: () => http });
  return { source, calls, rows, at };
}

test('API v3 detection and reader-token exchange use separate endpoints', async () => {
  const { source, calls } = fixture();
  const session = await source.sessionFromAuth(await source.authFromCredentials());
  assert.equal(session.bearer, 'synthetic-jwt');
  assert.equal(session.ttl, 10000);
  assert.deepEqual(calls.map(c => c.path), ['/api/v3/version', '/api/v2/authorization/request/reader']);
});

test('API v3 capability detection is shared between concurrent authentication calls', async () => {
  const { source, calls } = fixture();
  assert.deepEqual(await Promise.all([source.authFromCredentials(), source.authFromCredentials()]), ['reader', 'reader']);
  assert.equal(calls.filter(c => c.path === '/api/v3/version').length, 1);
});

test('API v3 preserves the all-collection frame contract and v1 profile compatibility', async () => {
  const { source, rows, at } = fixture();
  const session = await source.sessionFromAuth(await source.authFromCredentials());
  const frame = source.transformGlucose(await source.dataFromSesssion(session, {}));
  assert.deepEqual(Object.keys(frame).sort(), ['devicestatus', 'entries', 'profiles', 'treatments']);
  assert.equal(frame.entries[0].dateString, new Date(at).toISOString());
  assert.equal(frame.treatments[0].created_at, new Date(at).toISOString());
  assert.equal(frame.treatments[0]._id, 'treatment-1');
  assert.equal(frame.devicestatus[0]._id, 'status-1');
  assert.deepEqual(frame.profiles, rows.profile);
});

test('API v3 honours collection selection without fetching disabled feeds', async () => {
  const { source, calls } = fixture({ sourceCollections: 'entries' });
  const session = await source.sessionFromAuth(await source.authFromCredentials());
  const frame = await source.dataFromSesssion(session, {});
  assert.equal(frame.entries.length, 1);
  assert.deepEqual(frame.treatments, []);
  assert.deepEqual(frame.devicestatus, []);
  assert.deepEqual(frame.profiles, []);
  assert.deepEqual(calls.slice(2).map(c => c.path), ['/api/v3/entries']);
});

test('API v3 rejects a failed clinical feed instead of acknowledging a partial frame', async () => {
  const { source } = fixture({ fail: '/api/v3/treatments' });
  const session = await source.sessionFromAuth(await source.authFromCredentials());
  await assert.rejects(source.dataFromSesssion(session, {}), /Synthetic HTTP failure/);
});

test('API v3 driver registers one aggregate loop, avoiding duplicate collection writes', () => {
  const { source } = fixture();
  const loops = [];
  source.generate_driver({ support_session() {}, register_loop(name, config) { loops.push({ name, config }); } });
  assert.equal(loops.length, 1);
  assert.equal(loops[0].config.frame.impl, source.dataFromSesssion);
});

function outputFixture(failAt) {
  const sizes = [];
  const output = nightscoutOutput({ url: 'https://destination.example', apiSecret: 'synthetic-secret' }, {
    create: () => ({
      async post(path, rows) {
        assert.equal(path, '/api/v1/devicestatus.json');
        sizes.push(rows.length);
        if (sizes.length === failAt) throw new Error('Synthetic write failure');
        return { data: rows };
      }
    })
  });
  const rows = Array.from({ length: 121 }, (_, i) => ({ device: 'synthetic', created_at: new Date(1000 + i).toISOString() }));
  return { output, rows, sizes };
}

test('REST output splits device-status records into bounded sequential uploads', async () => {
  const { output, rows, sizes } = outputFixture();
  const bookmark = await output({ devicestatus: rows });
  assert.deepEqual(sizes, [50, 50, 21]);
  assert.equal(bookmark.devicestatus.getTime(), 1120);
});

test('REST output rejects a failed device-status chunk and stops subsequent uploads', async () => {
  const { output, rows, sizes } = outputFixture(2);
  await assert.rejects(output({ devicestatus: rows }), /Nightscout write failed/);
  assert.deepEqual(sizes, [50, 50]);
});
