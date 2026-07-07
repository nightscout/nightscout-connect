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

  assert.deepEqual(source.transformGlucose({ error: true }), { entries: [] });
});

test('Nightscout source validation accepts token URLs without source API secret', () => {
  const result = nightscoutSource.validate({
    sourceEndpoint: 'https://source.example?token=reader-token'
  });

  assert.equal(result.ok, true);
  assert.equal(result.config.kind, 'nightscout');
});
