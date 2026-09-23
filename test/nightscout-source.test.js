const assert = require('node:assert/strict');
const test = require('node:test');

const nightscoutSource = require('../lib/sources/nightscout');

function fakeAxios (handler) {
  return {
    create (defaults) {
      return {
        get (path, options) {
          return handler({ method: 'get', path, options, defaults });
        },
        post (path, body, options) {
          return handler({ method: 'post', path, body, options, defaults });
        }
      };
    }
  };
}

test('Nightscout source session exchanges access token with headers object', async () => {
  const calls = [];
  const source = nightscoutSource({
    url: 'https://source.example',
    apiSecret: 'secret'
  }, fakeAxios((call) => {
    calls.push(call);
    assert.deepEqual(call.options.headers, {});
    return Promise.resolve({ data: { token: 'jwt-token', exp: 20, iat: 10 } });
  }));

  const session = await source.sessionFromAuth('access-token');

  assert.equal(session.bearer, 'jwt-token');
  assert.equal(session.ttl, 10000);
  assert.equal(calls[0].path, '/api/v2/authorization/request/access-token');
});

test('Nightscout source falls back to token creation after unreadable verifyauth failure', async () => {
  const calls = [];
  const source = nightscoutSource({
    url: 'https://source.example',
    apiSecret: 'secret'
  }, fakeAxios((call) => {
    calls.push(call);
    if (call.path === '/api/v1/verifyauth') {
      return Promise.reject(new Error('unauthorized'));
    }
    if (call.path === '/api/v2/authorization/subjects' && call.method === 'get') {
      return Promise.resolve({ data: [{ name: 'nightscout-connect-reader', accessToken: 'reader-token' }] });
    }
    throw new Error('unexpected call ' + call.path);
  }));

  assert.equal(await source.authFromCredentials(), 'reader-token');
  assert.deepEqual(calls.map((call) => call.path), [
    '/api/v1/verifyauth',
    '/api/v2/authorization/subjects'
  ]);
});

test('Nightscout source transform ignores non-array payloads', () => {
  const source = nightscoutSource({
    url: 'https://source.example',
    apiSecret: 'secret'
  }, fakeAxios(() => Promise.resolve({ data: [] })));

  assert.deepEqual(source.transformGlucose({ error: true }), { entries: [], treatments: [], devicestatus: [], profiles: [] });
});

test('Nightscout source validation accepts token URLs without source API secret', () => {
  const result = nightscoutSource.validate({
    sourceEndpoint: 'https://source.example?token=reader-token'
  });

  assert.equal(result.ok, true);
  assert.equal(result.config.kind, 'nightscout');
});

test('Nightscout source transforms all collection arrays', () => {
  const source = nightscoutSource({
    url: 'https://source.example',
    apiSecret: 'secret'
  }, fakeAxios(() => Promise.resolve({ data: [] })));
  const batch = {
    entries: [{ sgv: 100 }],
    treatments: [{ eventType: 'Correction Bolus' }],
    devicestatus: [{ device: 'loop' }],
    profiles: [{ defaultProfile: 'Default' }]
  };

  assert.deepEqual(source.transformGlucose(batch), batch);
});

test('Nightscout source creates its reader subject with a readable role', async () => {
  // Nightscout reads a subject's roles from the plural `roles` field; a
  // subject without it only gets AUTH_DEFAULT_ROLES, so on a
  // `denied` site the reader token cannot read.
  const posted = [];
  const source = nightscoutSource({
    url: 'https://source.example',
    apiSecret: 'secret'
  }, fakeAxios((call) => {
    if (call.path === '/api/v1/verifyauth') {
      return Promise.resolve({ data: { status: 200, message: { canRead: false } } });
    }
    if (call.path === '/api/v2/authorization/subjects' && call.method === 'get') {
      const data = posted.length ? [{ name: 'nightscout-connect-reader', accessToken: 'reader-token' }] : [];
      return Promise.resolve({ data });
    }
    if (call.path === '/api/v2/authorization/subjects' && call.method === 'post') {
      posted.push(call.body);
      return Promise.resolve({ data: call.body });
    }
    throw new Error('unexpected call ' + call.method + ' ' + call.path);
  }));

  assert.equal(await source.authFromCredentials(), 'reader-token');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].name, 'nightscout-connect-reader');
  assert.deepEqual(posted[0].roles, [ 'readable' ]);
  assert.equal(Object.prototype.hasOwnProperty.call(posted[0], 'role'), false);
});

// BF-98: a nightscout-connect-reader subject created by an earlier connector
// has `role` instead of `roles`; the source reuses it by name and every read
// is refused. The source must say once how to fix it, and never change the
// source site.
function readerSite ({ subject, readStatus }) {
  const calls = [];
  const warnings = [];
  const log = { debug () {}, error () {}, warn (message) { warnings.push(message); } };
  const reject = (status) => {
    const err = new Error('Request failed with status code ' + status);
    err.response = { status, config: { url: 'https://source.example/api/v1/entries.json?token=reader-token-SECRET' } };
    return Promise.reject(err);
  };
  const source = nightscoutSource({ url: 'https://source.example', apiSecret: 'api-secret-SECRET' }, fakeAxios((call) => {
    calls.push(call);
    if (call.path === '/api/v1/verifyauth') {
      return Promise.resolve({ data: { status: 200, message: { canRead: false } } });
    }
    if (call.path === '/api/v2/authorization/subjects' && call.method === 'get') {
      return Promise.resolve({ data: [{ _id: 'subject-id', name: 'nightscout-connect-reader', accessToken: 'reader-token-SECRET', ...subject }] });
    }
    if (call.method === 'get' && /^\/api\/v1\/(entries|treatments|devicestatus|profiles?)\.json$/.test(call.path)) {
      return readStatus === 200 ? Promise.resolve({ data: [] }) : reject(readStatus);
    }
    throw new Error('unexpected call ' + call.method + ' ' + call.path);
  }), log);
  async function poll () {
    const token = await source.authFromCredentials();
    const session = { bearer: 'jwt-SECRET' };
    assert.equal(token, 'reader-token-SECRET');
    return source.dataFromSesssion(session, {}).catch((err) => err);
  }
  return { calls, warnings, poll };
}

function assertReaderWarning (message) {
  assert.match(message, /nightscout-connect-reader/);
  assert.match(message, /add the "readable" role/);
  assert.match(message, /delete nightscout-connect-reader so nightscout-connect creates it again/);
  assert.doesNotMatch(message, /SECRET|https?:|token=/);
}

test('Nightscout source warns when the reader subject it reuses has no roles', async () => {
  const site = readerSite({ subject: { role: [ 'readable' ] }, readStatus: 401 });
  await site.poll();
  assert.equal(site.warnings.length, 1);
  assert.match(site.warnings[0], /has no roles/);
  assertReaderWarning(site.warnings[0]);
  // nothing is written to the source site
  assert.deepEqual(site.calls.filter((call) => call.method !== 'get'), []);
});

test('Nightscout source warns when reads with a reused reader subject are refused', async () => {
  const site = readerSite({ subject: { roles: [ 'careportal' ] }, readStatus: 401 });
  const result = await site.poll();
  assert.equal(result.response.status, 401, 'the refused read still fails the poll');
  assert.equal(site.warnings.length, 1);
  assert.match(site.warnings[0], /refused .*\(HTTP 401\)/);
  assertReaderWarning(site.warnings[0]);
  assert.deepEqual(site.calls.filter((call) => call.method !== 'get'), []);
});

test('Nightscout source gives each reader-subject warning once, not once per poll', async () => {
  for (const subject of [{ role: [ 'readable' ] }, { roles: [ 'careportal' ] }]) {
    const site = readerSite({ subject, readStatus: 401 });
    for (let i = 0; i < 5; i++) await site.poll();
    assert.equal(site.calls.filter((call) => call.path === '/api/v1/entries.json').length, 5);
    assert.equal(site.warnings.length, 1, JSON.stringify(subject));
  }
});

test('Nightscout source does not warn about a reused reader subject that can read', async () => {
  const site = readerSite({ subject: { roles: [ 'readable' ] }, readStatus: 200 });
  await site.poll();
  await site.poll();
  assert.deepEqual(site.warnings, []);
});
