const assert = require('node:assert/strict');
const test = require('node:test');

const linkUpSource = require('../lib/sources/librelinkup');

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

test('LibreLinkUp validation defaults to EU and supports regional or explicit servers', () => {
  const common = {
    linkUpUsername: 'user@example.com',
    linkUpPassword: 'secret'
  };

  assert.equal(linkUpSource.validate(common).config.baseURL, 'https://api-eu.libreview.io');
  assert.equal(linkUpSource.validate({ ...common, linkUpRegion: 'us' }).config.baseURL, 'https://api-us.libreview.io');
  assert.equal(linkUpSource.validate({ ...common, linkUpRegion: 'EU2' }).config.baseURL, 'https://api-eu2.libreview.io');
  assert.equal(
    linkUpSource.validate({ ...common, linkUpServer: 'api-custom.libreview.example' }).config.baseURL,
    'https://api-custom.libreview.example'
  );
});

test('LibreLinkUp validation carries interval, version, product, and patient settings', () => {
  const result = linkUpSource.validate({
    linkUpUsername: 'user@example.com',
    linkUpPassword: 'secret',
    linkUpPatientId: 'patient-2',
    linkUpInterval: 1,
    linkUpVersion: '4.12.0',
    linkUpProduct: 'llu.android'
  });

  assert.equal(result.ok, true);
  assert.equal(result.config.linkUpPatientId, 'patient-2');
  assert.equal(result.config.linkUpInterval, 1);
  assert.equal(result.config.linkUpVersion, '4.12.0');
  assert.equal(result.config.linkUpProduct, 'llu.android');
});

test('LibreLinkUp session selects configured patient from multi-patient accounts', async () => {
  const source = linkUpSource({
    linkUpUsername: 'user@example.com',
    linkUpPassword: 'secret',
    linkUpPatientId: 'patient-2',
    baseURL: 'https://api-eu.libreview.io'
  }, fakeAxios((call) => {
    assert.equal(call.path, '/llu/connections');
    assert.equal(call.options.headers.Authorization, 'Bearer ticket-123');
    return Promise.resolve({
      status: 200,
      headers: {},
      data: { data: [{ patientId: 'patient-1' }, { patientId: 'patient-2' }] }
    });
  }));

  assert.deepEqual(await source.sessionFromAuth({
    data: { authTicket: { token: 'ticket-123' } }
  }), {
    patientId: 'patient-2',
    authTicket: { token: 'ticket-123' }
  });
});

test('LibreLinkUp session rejects unmatched configured patient IDs', async () => {
  const source = linkUpSource({
    linkUpUsername: 'user@example.com',
    linkUpPassword: 'secret',
    linkUpPatientId: 'missing-patient',
    baseURL: 'https://api-eu.libreview.io'
  }, fakeAxios(() => Promise.resolve({
    status: 200,
    headers: {},
    data: { data: [{ patientId: 'patient-1' }, { patientId: 'patient-2' }] }
  })));

  await assert.rejects(() => source.sessionFromAuth({
    data: { authTicket: { token: 'ticket-123' } }
  }), /NO MATCHING LIBRE LINKUP PATIENT ID/);
});

test('LibreLinkUp transform includes graph and current readings', () => {
  const source = linkUpSource({
    linkUpUsername: 'user@example.com',
    linkUpPassword: 'secret',
    baseURL: 'https://api-eu.libreview.io'
  }, fakeAxios(() => Promise.resolve({ data: {} })));

  const result = source.transformGlucose({
    data: {
      graphData: [{
        FactoryTimestamp: '2025-10-09T08:48:20.000Z',
        TrendArrow: 3,
        ValueInMgPerDl: 100
      }],
      connection: {
        glucoseItem: {
          FactoryTimestamp: '2025-10-09T08:53:20.000Z',
          TrendArrow: 4,
          ValueInMgPerDl: 110
        }
      }
    }
  });

  assert.deepEqual(result.entries.map((entry) => ({
    sgv: entry.sgv,
    dateString: entry.dateString,
    direction: entry.direction
  })), [
    { sgv: 100, dateString: '2025-10-09T08:48:20.000Z', direction: 'Flat' },
    { sgv: 110, dateString: '2025-10-09T08:53:20.000Z', direction: 'FortyFiveUp' }
  ]);
});

test('LibreLinkUp transform preserves local factory timestamps as UTC wall time', () => {
  const source = linkUpSource({
    linkUpUsername: 'user@example.com',
    linkUpPassword: 'secret',
    baseURL: 'https://api-eu.libreview.io'
  }, fakeAxios(() => Promise.resolve({ data: {} })));

  const result = source.transformGlucose({
    data: {
      graphData: [{
        FactoryTimestamp: '2025-10-09T08:48:20.000',
        TrendArrow: 3,
        ValueInMgPerDl: 100
      }],
      connection: {}
    }
  });

  assert.equal(result.entries[0].dateString, '2025-10-09T08:48:20.000Z');
});

test('LibreLinkUp transform tolerates missing graph and current readings', () => {
  const source = linkUpSource({
    linkUpUsername: 'user@example.com',
    linkUpPassword: 'secret',
    baseURL: 'https://api-eu.libreview.io'
  }, fakeAxios(() => Promise.resolve({ data: {} })));

  assert.deepEqual(source.transformGlucose({ data: {} }), {
    entries: [],
    treatments: [],
    devicestatus: [],
    profiles: []
  });
});
