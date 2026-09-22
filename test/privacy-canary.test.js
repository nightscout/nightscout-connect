'use strict';

// Every source, run as a real polling actor against a fake vendor whose
// credentials, tokens, cookies, bodies and errors all carry one marker. If
// the marker reaches any console method, some call site is logging a value.
// This is the check that replaces the console scrubber from #61: it fails the
// build instead of rewriting the host's log.

const assert = require('node:assert/strict');
const test = require('node:test');
const { inspect } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const realAxios = require('axios');
const { interpret } = require('xstate');
const sources = require('../lib/sources');
const builder = require('../lib/builder');
const createLogger = require('../lib/logging');

const MARK = '7f3a91c0';
const CANARY = 'CANARY-' + MARK;
const EMAIL = 'canary.' + MARK + '@example.invalid';

const SETTINGS = {
  dexcomshare: { shareAccountName: CANARY, sharePassword: CANARY, shareRegion: 'us' },
  linkup: { linkUpUsername: EMAIL, linkUpPassword: CANARY, linkUpRegion: 'US' },
  glooko: { glookoEmail: EMAIL, glookoPassword: CANARY, glookoServer: 'eu.api.glooko.com' },
  nightscout: { sourceEndpoint: 'https://' + MARK + '.example.invalid', sourceApiSecret: CANARY },
  minimedcarelink: { carelinkUsername: CANARY, carelinkPassword: CANARY, carelinkRegion: 'us', countryCode: 'us' }
};

function capture (t) {
  const calls = [];
  for (const method of ['log', 'info', 'debug', 'warn', 'error', 'trace']) {
    t.mock.method(console, method, (...args) => calls.push({ method, text: inspect(args, { depth: 20 }) }));
  }
  return calls;
}

function assertClean (calls) {
  const leak = calls.find((call) => call.text.includes(MARK));
  assert.ok(!leak, 'marker reached console.' + (leak && leak.method) + ': ' + (leak && leak.text));
}

const now = () => Date.now();
const loginForm = '<form action="/login" method="POST">\n' +
  '<input type="hidden" name="sessionID" value="' + CANARY + '">\n' +
  '<input type="hidden" name="sessionData" value="' + CANARY + '">';

// Loosely the shape each vendor returns, so the drivers get past their first
// steps; every identifying field is the marker.
function body (url) {
  const u = String(url);
  if (/Publisher(Account|LatestGlucose)|ReadPublisherLatestGlucoseValues/i.test(u)) {
    if (/Glucose/i.test(u)) return [{ WT: '/Date(' + now() + ')/', ST: '/Date(' + now() + ')/', Value: 123, Trend: 'Flat' }];
    return CANARY;
  }
  if (/\/llu\/connections\/[^/]+\/graph/.test(u)) {
    return { status: 0, data: { connection: { patientId: CANARY, firstName: CANARY, lastName: CANARY,
      sensor: { sn: CANARY, a: Math.floor(now() / 1000) - 3600 }, patientDevice: { did: CANARY },
      glucoseMeasurement: { ValueInMgPerDl: 123, Timestamp: new Date().toISOString(), TrendArrow: 3 } },
    graphData: [{ ValueInMgPerDl: 120, FactoryTimestamp: new Date(now() - 300000).toISOString() }] } };
  }
  if (/\/llu\/connections/.test(u)) {
    return { status: 0, data: [{ patientId: CANARY, firstName: CANARY, lastName: CANARY }] };
  }
  if (/login|oauth|sso/i.test(u) && /carelink|minimed/i.test(u)) return loginForm;
  return {
    status: 0,
    data: { authTicket: { token: CANARY, expires: 9999999999, duration: 1 },
      user: { id: CANARY, email: EMAIL, firstName: CANARY, lastName: CANARY } },
    token: CANARY, accessToken: CANARY, sessionID: CANARY,
    userLogin: { glookoCode: CANARY, email: EMAIL },
    message: { canRead: true, token: CANARY },
    readings: [], events: [], alarms: []
  };
}

function fakeVendor (mode) {
  const state = { requests: 0 };
  const headers = { 'set-cookie': ['session=' + CANARY + '; Path=/', 'auth_tmp_token=' + CANARY + '; Path=/'],
    'x-account': CANARY };
  const adapter = async (config) => {
    state.requests++;
    if (mode === 'reject') {
      const error = new Error('request failed for ' + EMAIL + ' with ' + CANARY);
      error.isAxiosError = true;
      error.config = config;
      error.response = { status: 401, statusText: CANARY, headers, config, data: { message: CANARY, email: EMAIL } };
      throw error;
    }
    return { status: 200, statusText: 'OK', headers, config, data: body(config.url) };
  };
  return { axios: realAxios.create({ adapter }), state };
}

async function runSource (t, kind, mode, debug) {
  const calls = capture(t);
  const log = createLogger(debug);
  const driver = sources({ kind });
  const validated = driver.validate({ source: kind, ...SETTINGS[kind] });
  assert.ok(validated.ok, kind + ' fixture settings are invalid');
  const vendor = fakeVendor(mode);
  const output = async () => ({ entries: new Date() });
  output.gap_for = async () => ({ entries: new Date(now() - 3600000) });
  const make = builder({ output, logger: log });
  driver(validated.config, vendor.axios, log).generate_driver(make);
  const actor = interpret(make());
  try {
    actor.start();
    actor.send('START');
    for (let i = 0; i < 40 && vendor.state.requests < 2; i++) await delay(5);
    await delay(20);
    // #61's case: bare xstate log actions dump { context, event }, and the
    // drivers carry session material in event.data.
    const dump = { type: 'DEBUG', data: { cookies: 'session=' + CANARY + '; Path=/',
      user: { email: EMAIL, firstName: CANARY, dateOfBirth: CANARY } } };
    actor.send(dump);
    for (const child of actor.children.values()) {
      try { child.send(dump); } catch (_) { }
    }
    await delay(5);
  } finally {
    actor.stop();
  }
  return { calls, requests: vendor.state.requests };
}

for (const kind of Object.keys(SETTINGS)) {
  for (const mode of ['accept', 'reject']) {
    for (const debug of [false, true]) {
      test(`${kind}: nothing identifying reaches the log (vendor ${mode}s, debug=${debug})`, async (t) => {
        const { calls, requests } = await runSource(t, kind, mode, debug);
        assertClean(calls);
        // Not vacuous: the source ran, and its log lines were captured.
        assert.ok(requests > 0, kind + ' made no requests');
        if (mode === 'reject') assert.ok(calls.some((call) => call.method === 'error'), kind + ' logged no error');
        if (debug) assert.ok(calls.some((call) => call.method === 'debug'), kind + ' logged no debug line');
      });
    }
  }
}

test('the check catches a leak in any form a call site could produce', (t) => {
  for (const leak of [
    ['session', { cookies: 'session=' + CANARY }],
    ['cookie was session=' + CANARY + '; path=/'],
    [{ context: { retries: 0 }, event: { data: { user: { email: EMAIL } } } }],
    [new Error('failed with ' + CANARY)]
  ]) {
    const calls = capture(t);
    console.log(...leak);
    assert.throws(() => assertClean(calls), /marker reached console/);
    t.mock.restoreAll();
  }
});
