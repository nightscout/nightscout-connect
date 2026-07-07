const assert = require('node:assert/strict');
const test = require('node:test');

const dexcomshareSource = require('../lib/sources/dexcomshare');

function fakeAxios (handler) {
  return {
    create (defaults) {
      return {
        post (path, body, options) {
          return handler({ method: 'post', path, body, options, defaults });
        }
      };
    }
  };
}

test('Dexcom Share auth normalizes accountId response objects', async () => {
  const source = dexcomshareSource({
    shareAccountName: 'user@example.com',
    sharePassword: 'secret',
    shareRegion: 'ous'
  }, fakeAxios(() => Promise.resolve({ data: { accountId: 'account-123' } })));

  assert.equal(await source.authFromCredentials(), 'account-123');
});

test('Dexcom Share auth rejects upstream failures', async () => {
  const err = new Error('AccountPasswordInvalid');
  err.response = { status: 401, data: { Code: 'AccountPasswordInvalid' } };
  const source = dexcomshareSource({
    shareAccountName: 'user@example.com',
    sharePassword: 'secret',
    shareRegion: 'ous'
  }, fakeAxios(() => Promise.reject(err)));

  await assert.rejects(() => source.authFromCredentials(), /AccountPasswordInvalid/);
});

test('Dexcom Share transform ignores non-array payloads', () => {
  const source = dexcomshareSource({
    shareAccountName: 'user@example.com',
    sharePassword: 'secret',
    shareRegion: 'ous'
  }, fakeAxios(() => Promise.resolve({ data: [] })));

  assert.deepEqual(source.transformGlucose({ status: 500 }), { entries: [] });
});
