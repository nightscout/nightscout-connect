const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');

const linkUpSource = require('../lib/sources/librelinkup');
const createFetch = require('../lib/machines/fetch');

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
  assert.equal(linkUpSource.validate({ ...common, linkUpRegion: 'UK' }).config.baseURL, 'https://api-eu2.libreview.io');
  assert.equal(linkUpSource.validate({ ...common, linkUpRegion: 'GB' }).config.baseURL, 'https://api-eu2.libreview.io');
  assert.equal(linkUpSource.validate({ ...common, linkUpRegion: 'RU' }).config.baseURL, 'https://api.libreview.ru');
  assert.equal(linkUpSource.validate({ ...common, linkUpRegion: 'CN' }).config.baseURL, 'https://api-cn.myfreestyle.cn');
  assert.equal(linkUpSource.validate({ ...common, linkUpRegion: 'LA' }).config.baseURL, 'https://api-la.libreview.io');
  assert.equal(linkUpSource.validate({ ...common, linkUpRegion: 'unknown' }).ok, false);
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
    assert.equal(call.options.headers['Account-Id'], crypto.createHash('sha256').update('user-123').digest('hex'));
    return Promise.resolve({
      status: 200,
      headers: {},
      data: { data: [{ patientId: 'patient-1' }, { patientId: 'patient-2' }] }
    });
  }));

  assert.deepEqual(await source.sessionFromAuth({
    data: { authTicket: { token: 'ticket-123' }, user: { id: 'user-123' } }
  }), {
    patientId: 'patient-2',
    authTicket: { token: 'ticket-123' },
    accountId: crypto.createHash('sha256').update('user-123').digest('hex')
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
    data: { authTicket: { token: 'ticket-123' }, user: { id: 'user-123' } }
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

test('LibreLinkUp transform accepts the glucoseMeasurement current-reading shape', () => {
  const source = linkUpSource({ baseURL: 'https://api-eu.libreview.io' }, fakeAxios(() => {}));
  const result = source.transformGlucose({ data: {
    graphData: [{ FactoryTimestamp: '2026-09-22T07:55:00.000Z', ValueInMgPerDl: 101 }],
    connection: { glucoseMeasurement: {
      FactoryTimestamp: '2026-09-22T08:00:00.000Z', TrendArrow: 3, ValueInMgPerDl: 105
    } }
  } });
  assert.deepEqual(result.entries.map((entry) => entry.sgv), [101, 105]);
});

test('LibreLinkUp transform skips malformed readings while retaining valid ones', () => {
  const source = linkUpSource({ baseURL: 'https://api-eu.libreview.io' }, fakeAxios(() => {}));
  const result = source.transformGlucose({ data: {
    graphData: [null, { FactoryTimestamp: 'invalid', ValueInMgPerDl: 99 },
      { FactoryTimestamp: '2026-09-22T07:55:00.000Z', Value: 101 }],
    connection: { glucoseItem: { FactoryTimestamp: '2026-09-22T08:00:00.000Z' } }
  } });
  assert.deepEqual(result.entries.map((entry) => entry.sgv), [101]);
});

test('LibreLinkUp opt-in metadata attributes readings across a sensor change', () => {
  const startA = Date.parse('2026-09-01T00:00:00Z') / 1000;
  const startB = Date.parse('2026-09-22T07:00:00Z') / 1000;
  const validated = linkUpSource.validate({
    linkUpUsername: 'follower', linkUpPassword: 'secret', linkUpSensorInfo: true
  });
  const source = linkUpSource(validated.config, fakeAxios(() => {}));
  const batch = { data: {
    activeSensors: [
      { sensor: { sn: 'SENSOR-A', a: startA } },
      { sensor: { sn: 'SENSOR-B', a: startB } }
    ],
    graphData: [{ FactoryTimestamp: '2026-09-22T06:55:00Z', ValueInMgPerDl: 98 }],
    connection: {
      glucoseMeasurement: { FactoryTimestamp: '2026-09-22T07:05:00Z', ValueInMgPerDl: 105 },
      sensor: { sn: 'SENSOR-B', a: startB, w: 60 },
      patientDevice: { did: 'device-private', v: '4.16.0', ll: 70, hl: 250 }
    }
  } };
  const result = source.transformGlucose(batch, {});
  assert.deepEqual(result.entries.map(row => row.sensorInfo.serialNumber), ['SENSOR-A', 'SENSOR-B']);
  assert.equal(result.treatments.length, 1);
  assert.equal(result.treatments[0].eventType, 'Sensor Start');
  assert.equal(result.treatments[0].created_at, new Date(startB * 1000).toISOString());
  assert.equal(result.devicestatus.length, 1);
  assert.equal(result.devicestatus[0].librelinkup.sensor.serialHash,
    crypto.createHash('sha256').update('SENSOR-B').digest('hex'));
  assert.equal(result.devicestatus[0].librelinkup.patientDevice.deviceIdHash,
    crypto.createHash('sha256').update('device-private').digest('hex'));

  const cursor = { sensorStart: new Date(startB * 1000), librelinkupStatus: new Date('2026-09-22T07:05:00Z') };
  const later = source.transformGlucose(batch, cursor);
  assert.equal(later.treatments.length, 0);
  assert.equal(later.devicestatus.length, 0);
});

test('LibreLinkUp sensor metadata is off by default and missing sensor data never blocks glucose', () => {
  const payload = { data: { graphData: [
    { FactoryTimestamp: '2026-09-22T08:00:00Z', ValueInMgPerDl: 101 }
  ] } };
  const off = linkUpSource({ baseURL: 'https://api-eu.libreview.io' }, fakeAxios(() => {}));
  assert.equal(off.transformGlucose(payload).entries[0].sensorInfo, undefined);
  const on = linkUpSource({ baseURL: 'https://api-eu.libreview.io', linkUpSensorInfo: true }, fakeAxios(() => {}));
  assert.equal(on.transformGlucose(payload).entries[0].sensorInfo.error, 'No sensor matched reading time');
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

test('LibreLinkUp login follows a region redirect and limits redirects', async () => {
  const calls = [];
  const axios = fakeAxios((call) => {
    calls.push(call);
    return Promise.resolve({ data: calls.length === 1
      ? { status: 0, data: { redirect: true, region: 'EU2' } }
      : { status: 0, data: { authTicket: { token: 'ticket' }, user: { id: 'user' } } } });
  });
  const source = linkUpSource({ linkUpUsername: 'user', linkUpPassword: 'secret', baseURL: 'https://api-eu.libreview.io' }, axios);
  assert.equal((await source.authFromCredentials()).data.authTicket.token, 'ticket');
  assert.equal(calls[1].defaults.baseURL, 'https://api-eu2.libreview.io');

  const looping = linkUpSource({ linkUpUsername: 'user', linkUpPassword: 'secret', baseURL: 'https://api-eu.libreview.io' },
    fakeAxios(() => Promise.resolve({ data: { status: 0, data: { redirect: true, region: 'EU2' } } })));
  await assert.rejects(looping.authFromCredentials(), /could not follow region/);
});

test('LibreLinkUp login reports required account action without leaking credentials', async () => {
  const source = linkUpSource({ linkUpUsername: 'user', linkUpPassword: 'secret', baseURL: 'https://api-eu.libreview.io' },
    fakeAxios(() => Promise.resolve({ data: { status: 4, data: { step: { type: 'tou' }, authTicket: { token: 'private-token' } } } })));
  await assert.rejects(source.authFromCredentials(), (error) => {
    assert.match(error.message, /account action required \(tou\)/);
    assert.doesNotMatch(error.message, /secret|private-token/);
    return true;
  });
});

test('LibreLinkUp accepts terms only when explicitly enabled and limits continue steps', async () => {
  const calls = [];
  const pending = { status: 4, data: { step: { type: 'tou' }, authTicket: { token: 'private-token' } } };
  const source = linkUpSource({ linkUpUsername: 'user', linkUpPassword: 'secret',
    linkUpAutoAcceptTerms: true, baseURL: 'https://api-eu.libreview.io' }, fakeAxios(call => {
    calls.push(call);
    if (call.path === '/llu/auth/login') return Promise.resolve({ data: pending });
    assert.equal(call.path, '/auth/continue/tou');
    assert.equal(call.options.headers.Authorization, 'Bearer private-token');
    return Promise.resolve({ data: { status: 0, data: { authTicket: { token: 'new-token' }, user: { id: 'user' } } } });
  }));
  assert.equal((await source.authFromCredentials()).data.authTicket.token, 'new-token');
  assert.equal(calls.length, 2);

  const looping = linkUpSource({ linkUpUsername: 'user', linkUpPassword: 'secret',
    linkUpAutoAcceptTerms: true, baseURL: 'https://api-eu.libreview.io' },
    fakeAxios(() => Promise.resolve({ data: pending })));
  await assert.rejects(looping.authFromCredentials(), /too many terms steps/);
});

test('LibreLinkUp proxy settings survive region redirects and reject malformed URLs', async () => {
  const common = { linkUpUsername: 'user', linkUpPassword: 'secret' };
  assert.equal(linkUpSource.validate({ ...common, linkUpProxy: 'socks5://proxy.test:1080' }).ok, false);
  assert.equal(linkUpSource.validate({ ...common, linkUpProxy: 'direct' }).ok, true);
  const validated = linkUpSource.validate({ ...common, linkUpProxy: 'http://name:secret@proxy.test:8080' });
  assert.equal(validated.ok, true);
  const calls = [];
  const source = linkUpSource(validated.config, fakeAxios(call => {
    calls.push(call);
    return Promise.resolve({ data: calls.length === 1
      ? { status: 0, data: { redirect: true, region: 'EU2' } }
      : { status: 0, data: { authTicket: { token: 'ticket' }, user: { id: 'user' } } } });
  }));
  await source.authFromCredentials();
  assert.deepEqual(calls.map(call => call.defaults.proxy), [
    { protocol: 'http', host: 'proxy.test', port: 8080, auth: { username: 'name', password: 'secret' } },
    { protocol: 'http', host: 'proxy.test', port: 8080, auth: { username: 'name', password: 'secret' } }
  ]);
});

test('LibreLinkUp rejects a missing user ID before requesting connections', () => {
  const source = linkUpSource({ baseURL: 'https://api-eu.libreview.io' },
    fakeAxios(() => { throw new Error('Unexpected request'); }));
  assert.throws(() => source.sessionFromAuth({ data: { authTicket: { token: 'ticket' } } }), /missing auth ticket or user ID/);
});

test('LibreLinkUp graph request carries the account ID', async () => {
  const source = linkUpSource({ baseURL: 'https://api-eu.libreview.io' }, fakeAxios((call) => {
    assert.equal(call.path, '/llu/connections/patient-1/graph');
    assert.equal(call.options.headers['Account-Id'], 'account-id');
    return Promise.resolve({ data: { data: { graphData: [] } } });
  }));
  await source.dataFromSesssion({ patientId: 'patient-1', authTicket: { token: 'ticket' }, accountId: 'account-id' });
});

test('LibreLinkUp v4 login, connections and graph produce current glucose', async () => {
  const calls = [];
  const validation = linkUpSource.validate({
    linkUpUsername: 'follower@example.com',
    linkUpPassword: 'secret',
    linkUpRegion: 'UK'
  });
  const axios = fakeAxios((call) => {
    calls.push(call);
    if (call.path === '/llu/auth/login') {
      return Promise.resolve({ data: { status: 0, data: { user: { id: 'follower-id' }, authTicket: { token: 'ticket' } } } });
    }
    if (call.path === '/llu/connections') {
      return Promise.resolve({ data: { data: [{ patientId: 'patient-1' }] } });
    }
    return Promise.resolve({ data: { data: {
      graphData: [],
      connection: { glucoseItem: {
        FactoryTimestamp: '2026-09-22T08:00:00.000Z',
        TrendArrow: 3,
        ValueInMgPerDl: 105
      } }
    } } });
  });
  const source = linkUpSource(validation.config, axios);
  const auth = await source.authFromCredentials();
  const session = await source.sessionFromAuth(auth);
  const payload = await source.dataFromSesssion(session);
  const entries = source.transformGlucose(payload).entries;

  assert.equal(validation.config.baseURL, 'https://api-eu2.libreview.io');
  assert.equal(calls[0].defaults.headers.version, '4.16.0');
  assert.equal(calls[0].defaults.headers.product, 'llu.ios');
  assert.match(calls[0].defaults.headers['User-Agent'], /iPhone/);
  assert.equal(calls[0].defaults.headers['Content-Type'], 'application/json;charset=UTF-8');
  assert.equal(calls[1].options.headers['Account-Id'], session.accountId);
  assert.equal(calls[2].options.headers['Account-Id'], session.accountId);
  assert.deepEqual(entries.map(({ sgv, dateString }) => ({ sgv, dateString })), [
    { sgv: 105, dateString: '2026-09-22T08:00:00.000Z' }
  ]);
});

test('LibreLinkUp driver skips rapid retries for 429', () => {
  const source = linkUpSource({ baseURL: 'https://api-eu.libreview.io', linkUpInterval: 5 }, fakeAxios(() => {}));
  let frame;
  const builder = {
    support_session () { return this; },
    register_loop (name, cfg) { frame = cfg.frame; return this; }
  };
  source.generate_driver(builder);
  assert.deepEqual(frame.noRetryStatuses, [429]);
  const fetch = createFetch({}, {
    maxRetries: frame.maxRetries,
    noRetryStatuses: frame.noRetryStatuses,
    frame_retry_duration: () => 0
  });
  const shouldRetry = fetch.options.guards.shouldRetry;
  assert.equal(shouldRetry({ retries: 0, last_error_status: 429 }), false);
  assert.equal(shouldRetry({ retries: 0, last_error_status: 503 }), true);
  assert.equal(shouldRetry({ retries: 2, last_error_status: 503 }), false);
});
