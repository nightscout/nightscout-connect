const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const crypto = require('node:crypto');
const axios = require('axios');
const sourceFactory = require('../lib/sources/librelinkup');

const common = { linkUpUsername: 'synthetic', linkUpPassword: 'synthetic' };
const transport = handler => ({ create: defaults => ({
  post: (path, body, options) => handler({ path, body, options, defaults }),
  get: (path, options) => handler({ path, options, defaults })
}) });

test('shared timezone settings preserve the legacy LibreLinkUp EU starting endpoint', () => {
  for (const key of ['timezone', 'connectTimezone']) {
    for (const timezone of [undefined, '', 'Asia/Shanghai', 'Asia/Urumqi',
      'Europe/London', 'America/New_York', 'America/Toronto', 'Asia/Tokyo',
      'Europe/Moscow', 'Asia/Dubai', 'Australia/Sydney', 'Asia/Singapore',
      'America/Sao_Paulo', 'UTC', 'Invalid/Zone']) {
      const result = sourceFactory.validate({ ...common, [key]: timezone });
      assert.equal(result.ok, true, `${key}=${timezone} must not disable the source`);
      assert.equal(result.config.baseURL, 'https://api-eu.libreview.io', `${key}=${timezone}`);
    }
  }
});

test('legacy region and server overrides work independently of shared timezone settings', () => {
  for (const timezone of ['Asia/Shanghai', 'Invalid/Zone']) {
    for (const [region, host] of [['US', 'api-us.libreview.io'], ['CN', 'api-cn.myfreestyle.cn']]) {
      const result = sourceFactory.validate({ ...common, timezone, linkUpRegion: region });
      assert.equal(result.ok, true);
      assert.equal(result.config.baseURL, `https://${host}`);
    }
    const server = sourceFactory.validate({ ...common, connectTimezone: timezone,
      linkUpRegion: 'CN', linkUpServer: 'custom.example' });
    assert.equal(server.ok, true);
    assert.equal(server.config.baseURL, 'https://custom.example');
  }
});

test('a Shanghai-timezone account without a region keeps its EU to DE login route', async () => {
  const calls = [];
  const config = sourceFactory.validate({ ...common, timezone: 'Asia/Shanghai' }).config;
  const source = sourceFactory(config, transport(async call => {
    calls.push(call);
    if (call.defaults.baseURL === 'https://api-eu.libreview.io') {
      return { data: { status: 0, data: { redirect: true, region: 'DE' } } };
    }
    assert.equal(call.defaults.baseURL, 'https://api-de.libreview.io');
    return { data: { status: 0, data: { authTicket: { token: 'synthetic' }, user: { id: 'synthetic' } } } };
  }));
  assert.equal((await source.authFromCredentials()).data.authTicket.token, 'synthetic');
  assert.deepEqual(calls.map(call => call.defaults.baseURL),
    ['https://api-eu.libreview.io', 'https://api-de.libreview.io']);
});

test('TLS option preserves verification, timeout and proxy settings through redirects', async () => {
  const calls = [];
  const config = sourceFactory.validate({ ...common, linkUpStealthTls: 'true',
    linkUpProxy: 'http://proxy.example:8080', linkUpRequestTimeoutMs: 45000 }).config;
  const source = sourceFactory(config, transport(async call => {
    calls.push(call);
    return { data: calls.length === 1 ? { status: 0, data: { redirect: true, region: 'EU2' } }
      : { status: 0, data: { authTicket: { token: 'synthetic' }, user: { id: 'synthetic' } } } };
  }));
  try {
    await source.authFromCredentials();
    assert.equal(calls.length, 2);
    const agent = calls[0].defaults.httpsAgent;
    assert.ok(agent);
    assert.equal(agent.options.rejectUnauthorized, true);
    assert.equal(agent.options.minVersion, 'TLSv1.2');
    assert.deepEqual(agent.options.ciphers.split(':').sort(), crypto.constants.defaultCipherList.split(':').sort());
    assert.notEqual(agent.options.ciphers, crypto.constants.defaultCipherList);
    assert.equal(calls[1].defaults.httpsAgent, agent);
    assert.deepEqual(calls[1].defaults.proxy, calls[0].defaults.proxy);
    assert.equal(calls[1].defaults.timeout, 45000);
  } finally { calls[0]?.defaults.httpsAgent?.destroy(); }

  const defaults = sourceFactory.validate(common).config;
  assert.equal(defaults.linkUpStealthTls, false);
});

test('LibreLinkUp retry and timeout limits reject invalid settings', () => {
  for (const options of [
    { linkUpMaxRetries: -1 }, { linkUpMaxRetries: 6 }, { linkUpMaxRetries: 1.5 },
    { linkUpRetryIntervalMs: 0 }, { linkUpRetryIntervalMs: 900001 },
    { linkUpRequestTimeoutMs: 0 }, { linkUpRequestTimeoutMs: 120001 }
  ]) assert.equal(sourceFactory.validate({ ...common, ...options }).ok, false);
  assert.equal(sourceFactory.validate({ ...common, linkUpMaxRetries: 0 }).config.linkUpMaxRetries, 0);
});

test('a stalled LibreLinkUp request times out without exposing credentials', async () => {
  const server = http.createServer(() => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const source = sourceFactory({ ...common, baseURL: `http://127.0.0.1:${server.address().port}`,
      linkUpProxy: 'direct', linkUpRequestTimeoutMs: 50 }, axios);
    await assert.rejects(source.authFromCredentials(), error => {
      assert.equal(error.code, 'ECONNABORTED');
      assert.equal(error.config, undefined);
      assert.equal(error.response, undefined);
      assert.doesNotMatch(error.message, /synthetic/);
      return true;
    });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('latest-reading sensor mismatch reports metadata error and still uploads glucose', () => {
  const source = sourceFactory({ linkUpSensorInfo: true }, transport(() => {}));
  const first = { sn: 'sensor-before', a: 1750000000 };
  const second = { sn: 'sensor-after', a: 1760000000 };
  const payload = { data: {
    activeSensors: [{ sensor: first }, { sensor: second }],
    graphData: [{ FactoryTimestamp: '2025-07-01T12:00:00Z', ValueInMgPerDl: 100 }],
    connection: { sensor: first,
      glucoseMeasurement: { FactoryTimestamp: '2026-09-22T08:00:00Z', ValueInMgPerDl: 110 } }
  } };
  const result = source.transformGlucose(payload);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].sensorInfo.serialNumber, first.sn);
  assert.match(result.entries[1].sensorInfo.error, /does not match/);
  assert.equal(result.entries[1].sgv, 110);
  payload.data.connection.sensor = { ...second };
  assert.equal(source.transformGlucose(payload).entries[1].sensorInfo.serialNumber, second.sn);
  payload.data.connection.sensor.a++;
  assert.match(source.transformGlucose(payload).entries[1].sensorInfo.error, /does not match/);
});

test('rich device status preserves false and zero values and tolerates malformed optional fields', () => {
  const source = sourceFactory({ linkUpSensorInfo: true }, transport(() => {}));
  const payload = { data: { graphData: [], connection: {
    glucoseItem: { FactoryTimestamp: '2026-09-22T08:00:00Z', ValueInMgPerDl: 110 },
    sensor: { sn: 'synthetic-sensor', a: 1790000000, s: false, lj: true, pt: 0, w: 0 },
    patientDevice: { did: 'synthetic-device', dtid: 0, v: '4.16.0', alarms: false, l: false, h: true,
      ll: 70, hl: 250, u: 1790000010, fixedLowAlarmValues: { mgdl: 55, mmoll: 3, ignored: 'private' }, fixedLowThreshold: 55 }
  } } };
  const status = source.transformGlucose(payload).devicestatus[0].librelinkup;
  assert.equal(status.sensor.startedAtEpoch, 1790000000);
  assert.equal(status.sensor.state, false);
  assert.equal(status.sensor.patchType, 0);
  assert.equal(status.sensor.lastJoin, true);
  assert.equal(status.patientDevice.deviceTypeId, 0);
  assert.equal(status.patientDevice.alarms, false);
  assert.equal(status.patientDevice.lowAlarm, false);
  assert.equal(status.patientDevice.highAlarm, true);
  assert.equal(status.patientDevice.lastUpload, new Date(1790000010000).toISOString());
  assert.deepEqual(status.patientDevice.fixedLowAlarmValues, { mgdl: 55, mmoll: 3 });
  assert.equal(status.patientDevice.fixedLowThreshold, 55);
  assert.doesNotMatch(JSON.stringify(status), /synthetic-sensor|synthetic-device|private/);
  payload.data.connection.sensor.a = 1e100;
  payload.data.connection.sensor.sn = {};
  payload.data.connection.patientDevice.did = 123;
  payload.data.connection.patientDevice.u = 1e100;
  const malformed = source.transformGlucose(payload);
  assert.equal(malformed.entries.length, 1);
  assert.equal(malformed.treatments.length, 0);
  assert.equal(malformed.devicestatus[0].librelinkup.sensor.startedAt, null);
  assert.equal(malformed.devicestatus[0].librelinkup.patientDevice.lastUpload, null);
});

test('a configured patient must match even when the account has only one connection', async () => {
  const source = sourceFactory({ linkUpPatientId: 'selected-patient' }, transport(async () => ({ data: { data: [{ patientId: 'different-patient' }] } })));
  await assert.rejects(source.sessionFromAuth({ data: { user: { id: 'synthetic' }, authTicket: { token: 'synthetic' } } }),
    /NO MATCHING LIBRE LINKUP PATIENT ID/);
});

test('terms continuation follows a regional redirect and accepts the next supported step', async () => {
  const calls = [];
  const responses = [
    { status: 4, data: { step: { type: 'tou' }, authTicket: { token: 'terms-ticket' } } },
    { status: 0, data: { redirect: true, region: 'EU2' } },
    { status: 4, data: { step: { type: 'pp' }, authTicket: { token: 'privacy-ticket' } } },
    { status: 0, data: { user: { id: 'synthetic' }, authTicket: { token: 'final-ticket' } } }
  ];
  const source = sourceFactory(sourceFactory.validate({ ...common, linkUpAutoAcceptTerms: true }).config,
    transport(async call => { calls.push(call); return { data: responses.shift() }; }));
  assert.equal((await source.authFromCredentials()).data.authTicket.token, 'final-ticket');
  assert.deepEqual(calls.map(call => call.path), ['/llu/auth/login', '/auth/continue/tou', '/llu/auth/login', '/auth/continue/pp']);
  assert.equal(calls[3].defaults.baseURL, 'https://api-eu2.libreview.io');
  assert.equal(calls[3].options.headers.Authorization, 'Bearer privacy-ticket');
});
