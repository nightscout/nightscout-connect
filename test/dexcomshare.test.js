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

test('Dexcom Share validates US, OUS, and explicit server targets', () => {
  const common = {
    shareAccountName: 'user@example.com',
    sharePassword: 'secret'
  };

  assert.equal(dexcomshareSource.validate(common).config.baseURL, 'https://share2.dexcom.com');
  assert.equal(dexcomshareSource.validate({ ...common, shareRegion: 'ous' }).config.baseURL, 'https://shareous1.dexcom.com');
  assert.equal(
    dexcomshareSource.validate({ ...common, shareRegion: 'us', shareServer: 'custom.dexcom.example' }).config.baseURL,
    'https://custom.dexcom.example'
  );
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

test('Dexcom Share auth rejects non-HTTP failures without crashing catch path', async () => {
  const source = dexcomshareSource({
    shareAccountName: 'user@example.com',
    sharePassword: 'secret',
    shareRegion: 'ous'
  }, fakeAxios(() => Promise.reject(new Error('ENOTFOUND shareous1.dexcom.com'))));

  await assert.rejects(() => source.authFromCredentials(), /ENOTFOUND/);
});

test('Dexcom Share session accepts accountId wrapper objects defensively', async () => {
  const calls = [];
  const source = dexcomshareSource({
    shareAccountName: 'user@example.com',
    sharePassword: 'secret',
    shareRegion: 'ous'
  }, fakeAxios((call) => {
    calls.push(call);
    return Promise.resolve({ data: 'session-123' });
  }));

  assert.equal(await source.sessionFromAuth({ accountId: 'account-123' }), 'session-123');
  assert.equal(calls[0].body.accountId, 'account-123');
});

test('Dexcom Share data fetch rejects non-HTTP failures without crashing catch path', async () => {
  const source = dexcomshareSource({
    shareAccountName: 'user@example.com',
    sharePassword: 'secret',
    shareRegion: 'ous'
  }, fakeAxios(() => Promise.reject(new Error('ECONNRESET'))));

  await assert.rejects(() => source.dataFromSesssion('session-123', null), /ECONNRESET/);
});

test('Dexcom Share transform ignores non-array payloads', () => {
  const source = dexcomshareSource({
    shareAccountName: 'user@example.com',
    sharePassword: 'secret',
    shareRegion: 'ous'
  }, fakeAxios(() => Promise.resolve({ data: [] })));

  assert.deepEqual(source.transformGlucose({ status: 500 }), { entries: [] });
});

test('Dexcom Share transform maps Dexcom timestamps and string trend directions', () => {
  const source = dexcomshareSource({
    shareAccountName: 'user@example.com',
    sharePassword: 'secret',
    shareRegion: 'ous'
  }, fakeAxios(() => Promise.resolve({ data: [] })));

  assert.deepEqual(source.transformGlucose([{
    WT: '/Date(1760000000000)/',
    Trend: 'Forty Five Up',
    Value: 123
  }]), {
    entries: [{
      sgv: 123,
      date: 1760000000000,
      dateString: '2025-10-09T08:53:20.000Z',
      trend: 3,
      direction: 'FortyFiveUp',
      device: 'nightscout-connect',
      type: 'sgv'
    }]
  });
});
