const assert = require('node:assert/strict');
const test = require('node:test');
const {inspect} = require('node:util');
const axios = require('axios');
const carelink = require('../lib/sources/minimedcarelink');

const secret = 'owned-minimed-private-marker';
const options = {carelinkServer: 'carelink.example.invalid', carelinkUsername: secret + '-user', carelinkPassword: secret + '-password', countryCode: 'gb', languageCode: 'en'};
const form = '<form action="/owned-login" method="POST">\n<input type="hidden" name="sessionID" value="' + secret + '-session">\n<input type="hidden" name="sessionData" value="' + secret + '-data">';

function capture(t) {
  const lines = [];
  for (const method of ['log', 'error', 'warn', 'debug']) t.mock.method(console, method, (...args) => lines.push(inspect(args, {depth: 20})));
  return () => assert.ok(!lines.join('\n').includes(secret), 'MiniMed logs exposed a fixture credential, cookie or payload');
}

// Exercise the real Axios instance and provider methods with an owned adapter.
// No vendor requests, credentials or global TLS changes are involved.
function fixture(failPath, guardian = false, carepartner = false) {
  const calls = [];
  const failure = new Error(secret + '-error');
  failure.response = {status: 401, headers: {'set-cookie': secret}, data: secret};
  failure.config = {data: secret, headers: {Authorization: secret}};
  const client = axios.create({adapter: async config => {
    calls.push(config);
    if (config.url === failPath) throw failure;
    let data;
    switch (config.url) {
      case '/patient/sso/login': data = form; break;
      case '/owned-login': data = form.replace('/owned-login', '/owned-consent'); break;
      case '/patient/users/me': data = {role: carepartner ? 'CAREPARTNER' : 'PATIENT', private: secret}; break;
      case '/patient/m2m/links/patients': data = [{username: secret}]; break;
      case '/patient/m2m/connect/data/gc/patients/' + secret: data = {sgs: [], markers: [], private: secret}; break;
      case '/patient/users/me/profile': data = {username: secret}; break;
      case '/patient/countries/settings': data = {blePereodicDataEndpoint: '/owned-ble', private: secret}; break;
      case '/patient/configuration/system/personal.cp.m2m.enabled': data = {value: true, private: secret}; break;
      case '/patient/monitor/data': data = {deviceFamily: guardian ? 'GUARDIAN' : 'MINIMED', private: secret}; break;
      case '/patient/dataUpload/recentUploads': data = {private: secret}; break;
      case '/owned-ble': data = {sgs: [], markers: [], private: secret}; break;
      default: data = {private: secret};
    }
    config.jar.setCookieSync('auth_tmp_token=' + secret + '-token; Path=/', config.baseURL);
    config.jar.setCookieSync('c_token_valid_to=' + secret + '-expiry; Path=/', config.baseURL);
    return {data, status: 200, statusText: 'OK', config, headers: {'set-cookie': [secret + '=cookie; Path=/'], private: secret}};
  }});
  return {source: carelink(options, client), calls, failure};
}

test('MiniMed authentication, session, data and refresh preserve results without raw logging across two lifecycles', async t => {
  const verify = capture(t);
  for (let cycle = 0; cycle < 2; cycle++) {
    const {source, calls} = fixture();
    const auth = await source.authFromCredentials();
    assert.equal(auth.token, secret + '-token');
    assert.equal(calls.filter(call => call.method === 'post').length, 2);
    assert.ok(calls.find(call => call.method === 'post').data.includes(encodeURIComponent(options.carelinkPassword)));
    const session = await source.sessionFromAuth(auth);
    assert.equal(session.patientUsername, secret);
    const data = await source.dataFromSesssion(session);
    assert.deepEqual(data.sgs, []);
    assert.equal(data.private, secret);
    assert.equal(await source.refreshSession(auth, session), session);
    assert.equal(session.token, secret + '-token');
    verify();
  }
});

for (const path of ['/patient/sso/login', '/owned-login', '/owned-consent', '/patient/users/me', '/patient/users/me/profile', '/patient/countries/settings', '/patient/configuration/system/personal.cp.m2m.enabled', '/patient/monitor/data', '/owned-ble', '/patient/sso/reauth']) {
  test('MiniMed failure logging excludes raw error fields at ' + path, async t => {
    const verify = capture(t);
    const {source, failure} = fixture(path);
    if (path === '/patient/sso/login' || path === '/owned-login' || path === '/owned-consent') {
      await assert.rejects(source.authFromCredentials(), error => error === failure);
    } else {
      const auth = await source.authFromCredentials();
      if (['/patient/users/me', '/patient/users/me/profile', '/patient/countries/settings', '/patient/configuration/system/personal.cp.m2m.enabled'].includes(path)) {
        await assert.rejects(source.sessionFromAuth(auth));
      } else {
        const session = await source.sessionFromAuth(auth);
        if (path === '/patient/sso/reauth') await assert.rejects(source.refreshSession(auth, session), error => error === failure);
        else await assert.rejects(source.dataFromSesssion(session));
      }
    }
    verify();
  });
}

for (const guardian of [false, true]) {
  test('MiniMed carepartner patient list and ' + (guardian ? 'Guardian' : 'pump') + ' data stay out of logs', async t => {
    const verify = capture(t);
    const {source} = fixture(undefined, guardian, true);
    const session = await source.sessionFromAuth(await source.authFromCredentials());
    assert.equal(session.isPatient, false);
    assert.equal(session.patientUsername, secret);
    const data = await source.dataFromSesssion(session);
    assert.equal(data.private, secret);
    verify();
  });
}

test('MiniMed payload transformation does not log glucose or pump data', t => {
  const verify = capture(t);
  const {source} = fixture();
  const timestamp = '2026-09-01T12:00:00Z';
  const data = {lastMedicalDeviceDataUpdateServerTime: Date.parse(timestamp), medicalDeviceFamily: 'MINIMED', private: secret, sgs: [{datetime: timestamp, sg: 123}], markers: [], lastSG: {sg: 123}, lastSGTrend: 'FLAT', sMedicalDeviceTime: timestamp, medicalDeviceBatteryLevelPercent: 80, reservoirRemainingUnits: 100, activeInsulin: {amount: 1.2}};
  const output = source.transformPayload(data, {});
  assert.equal(output.entries[0].sgv, 123);
  assert.equal(output.devicestatus[0].pump.reservoir, 100);
  assert.equal(output.devicestatus[0].pump.bolusiob, 1.2);
  verify();
});
