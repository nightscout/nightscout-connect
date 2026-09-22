const assert = require('node:assert/strict');
const test = require('node:test');

const nightscoutOutput = require('../lib/outputs/nightscout');

function fakeAxios () {
  const calls = [];
  return {
    calls,
    create () {
      return {
        get (path, options) {
          calls.push({ method: 'get', path, options });
          return Promise.resolve({ data: [] });
        },
        post (path, body, options) {
          calls.push({ method: 'post', path, body, options });
          return Promise.resolve({ data: [] });
        }
      };
    }
  };
}

test('Nightscout output requires an endpoint', () => {
  assert.throws(() => nightscoutOutput({ apiSecret: 'secret' }, fakeAxios()), /CONNECT_NIGHTSCOUT_ENDPOINT/);
});

test('Nightscout output requires an API secret', () => {
  assert.throws(() => nightscoutOutput({ url: 'https://example.test' }, fakeAxios()), /CONNECT_API_SECRET/);
});

test('Nightscout output tolerates batches with omitted collections', async () => {
  const output = nightscoutOutput({ url: 'https://example.test', apiSecret: 'secret' }, fakeAxios());

  assert.deepEqual(await output({}), {});
});

test('Nightscout output records all supported collections', async () => {
  const transport = fakeAxios();
  const output = nightscoutOutput({ url: 'https://example.test', apiSecret: 'secret' }, transport);

  await output({
    entries: [{ dateString: '2025-10-09T08:53:20.000Z' }],
    treatments: [{ created_at: '2025-10-09T08:54:20.000Z' }],
    devicestatus: [{ created_at: '2025-10-09T08:55:20.000Z' }],
    profiles: [{ created_at: '2025-10-09T08:56:20.000Z' }]
  });

  assert.deepEqual(transport.calls.filter((call) => call.method === 'post').map((call) => call.path), [
    '/api/v1/entries.json',
    '/api/v1/treatments.json',
    '/api/v1/devicestatus.json',
    '/api/v1/profile.json'
  ]);
});

test('Nightscout output does not repost an unchanged device-status snapshot', async () => {
  const transport = fakeAxios();
  const output = nightscoutOutput({ url: 'https://example.test', apiSecret: 'secret' }, transport);
  const batch = { devicestatus: [{ created_at: '2026-07-15T06:53:20.000Z' }] };

  await output(batch);
  await output(batch);

  assert.equal(transport.calls.filter((call) => call.method === 'post' && call.path === '/api/v1/devicestatus.json').length, 1);
});

test('LibreLinkUp sensor and status records are deduplicated across output restarts', async () => {
  const calls = [];
  const stored = { treatments: [], devicestatus: [] };
  const transport = { create: () => ({
    get: async (path, options) => {
      calls.push({ method: 'get', path, options });
      const rows = path.includes('treatments') ? stored.treatments : stored.devicestatus;
      return { data: rows.slice(-1) };
    },
    post: async (path, body) => {
      calls.push({ method: 'post', path, body });
      if (path.includes('treatments')) stored.treatments.push(...body);
      if (path.includes('devicestatus')) stored.devicestatus.push(...body);
      return { data: body };
    }
  }) };
  const batch = {
    treatments: [{ eventType: 'Sensor Start', enteredBy: 'librelinkup', created_at: '2026-09-22T07:00:00Z' }],
    devicestatus: [{ device: 'nightscout-connect-librelinkup', created_at: '2026-09-22T07:05:00Z' }]
  };
  const config = { url: 'https://example.test', apiSecret: 'secret' };
  await nightscoutOutput(config, transport)(batch);
  await nightscoutOutput(config, transport)(batch);
  assert.equal(stored.treatments.length, 1);
  assert.equal(stored.devicestatus.length, 1);
  assert.ok(calls.some(call => call.method === 'get' && call.options.params?.['find[enteredBy]'] === 'librelinkup'));
  assert.ok(calls.some(call => call.method === 'get' && call.options.params?.['find[device]'] === 'nightscout-connect-librelinkup'));
});
