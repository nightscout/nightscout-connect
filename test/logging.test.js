'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { inspect } = require('node:util');
const { setImmediate: immediate, setTimeout: delay } = require('node:timers/promises');
const { interpret } = require('xstate');
const createLogger = require('../lib/logging');
const connect = require('../');
const builder = require('../lib/builder');
const dexcom = require('../lib/sources/dexcomshare');
const internal = require('../lib/outputs/internal');

const secret = 'private-credential-and-patient-marker';
const credentials = { source: 'dexcomshare', shareAccountName: secret, sharePassword: secret };
function capture(t) {
  const calls = [];
  for (const method of ['log', 'info', 'debug', 'warn', 'error']) {
    t.mock.method(console, method, (...args) => calls.push({ method, text: inspect(args, { depth: 20 }) }));
  }
  return calls;
}
function safe(calls) {
  assert.ok(!calls.some(call => call.text.includes(secret)), 'private data reached a log');
}
function failure() {
  const error = new Error(secret);
  error.response = { status: 401, data: secret, headers: { Authorization: secret } };
  error.config = { data: secret };
  return error;
}

for (const value of [undefined, false, 'false', 'off', '', 'invalid', '1', 1, true, 'true', 'ON', ' true ']) {
  test('debug setting is opt-in: ' + JSON.stringify(value), t => {
    const calls = capture(t);
    const log = createLogger(value);
    log.debug('Data loaded');
    const expected = [true, 'true', 'ON', ' true '].includes(value);
    assert.equal(calls.length, expected ? 1 : 0);
    log.warn('Configuration needs attention');
    log.error('Authentication failed', failure());
    assert.equal(calls.at(-2).method, 'warn');
    assert.match(calls.at(-1).text, /Authentication failed.*HTTP 401/);
    safe(calls);
  });
}

test('non-numeric remote status is not printed', t => {
  const calls = capture(t);
  const error = failure();
  error.response.status = secret;
  createLogger(true).error('Request failed', error);
  safe(calls);
  assert.equal(calls.length, 1);
});

for (const [globalDebug, override, expected] of [
  [undefined, undefined, false], [true, undefined, true],
  [false, true, true], [true, false, false], [true, 'invalid', false]
]) {
  test(`connector startup and data-loaded honor global=${globalDebug}, override=${override}`, async t => {
    const calls = capture(t);
    const ctx = { bus: new EventEmitter(), bootErrors: [] };
    const settings = { ...credentials };
    if (override !== undefined) settings.debug = override;
    const handle = connect({ debug: { logging: globalDebug }, extendedSettings: { connect: settings } }, ctx);
    try {
      // Keep the real internal output listener, but don't start vendor I/O.
      ctx.bus.removeListener('data-processed', handle.run);
      const sg = { mills: Date.now(), sgv: 123, private: secret };
      const sbx = { data: { sgvs: [sg], treatments: [], devicestatus: [], profile: [] }, lastEntry: items => items.at(-1) };
      for (let i = 0; i < 10; i++) {
        ctx.bus.emit('tick', { private: secret });
        ctx.bus.emit('data-processed', sbx);
      }
      assert.equal(ctx.bus.listenerCount('tick'), 0);
      assert.equal(calls.filter(call => call.text.includes('data-loaded')).length, expected ? 10 : 0);
      assert.equal(calls.length > 0, expected);
      safe(calls);
      await handle.stop();
      for (const event of ['tick', 'data-processed', 'tearDown', 'teardown']) {
        assert.equal(ctx.bus.listenerCount(event), 0, event);
      }
      const stoppedCalls = calls.length;
      ctx.bus.emit('tick', { private: secret });
      ctx.bus.emit('data-processed', sbx);
      await handle.run();
      assert.equal(handle().status, 2);
      assert.equal(calls.length, stoppedCalls);
    } finally { await handle.stop(); ctx.bus.removeAllListeners(); }
  });
}

for (const debug of [false, true]) {
  test(`internal persistence still writes and returns bookmarks with debug=${debug}`, async t => {
    const calls = capture(t);
    const bus = new EventEmitter();
    const sg = { mills: Date.now(), sgv: 123, private: secret };
    const sbx = { data: { sgvs: [sg], treatments: [], devicestatus: [], profile: [] }, lastEntry: items => items.at(-1) };
    const written = {};
    const ctx = { bus };
    for (const kind of ['entries', 'treatments', 'devicestatus', 'profile']) {
      ctx[kind] = { create(items, cb) { written[kind] = items; cb(null, items); setImmediate(() => bus.emit('data-processed', sbx)); } };
    }
    const output = internal({ debug }, ctx);
    try {
      const gap = output.gap_for();
      bus.emit('data-processed', sbx);
      assert.equal((await gap).sgvs, sg);
      const batch = { entries: [sg], treatments: [{ private: secret }], devicestatus: [{ private: secret }], profiles: [{ private: secret }] };
      assert.equal((await output(batch)).sgvs, sg);
      for (const kind of ['entries', 'treatments', 'devicestatus']) assert.equal(written[kind], batch[kind]);
      assert.equal(written.profile, batch.profiles);
      await immediate();
      assert.equal(calls.length > 0, debug);
      safe(calls);
      ctx.entries.create = (items, cb) => cb(failure());
      await output({ entries: [sg] });
      assert.ok(calls.some(call => call.method === 'error' && call.text.includes('Internal persistence failed')));
    } finally { bus.removeAllListeners(); }
  });

  for (const fail of [false, true]) {
    test(`real polling actors preserve success/failure with debug=${debug}, failure=${fail}`, async t => {
      const calls = capture(t);
      let persisted = 0;
      let rejected = 0;
      const log = createLogger(debug);
      const post = async url => {
        if (fail) { rejected++; throw failure(); }
        if (url.includes('Authenticate')) return { data: { accountId: secret } };
        if (url.includes('Login')) return { data: secret };
        return { data: [{ WT: `/Date(${Date.now()})/`, Value: 123, Trend: 4 }] };
      };
      const output = async batch => { assert.equal(batch.entries[0].sgv, 123); persisted++; return { entries: new Date() }; };
      output.gap_for = async () => ({ entries: new Date(Date.now() - 300000) });
      const make = builder({ output, logger: log });
      dexcom(credentials, { create: () => ({ post }) }, log).generate_driver(make);
      const actor = interpret(make());
      try {
        actor.start(); actor.send('START');
        for (let i = 0; i < 100 && !(fail ? rejected : persisted); i++) await delay(5);
        await immediate();
        assert.ok(fail ? rejected : persisted);
        actor.send({ type: 'DEBUG', data: secret });
        actor.children.get('Session').send({ type: 'DEBUG', data: secret });
        assert.equal(calls.some(call => call.method === 'debug'), debug);
        assert.equal(calls.some(call => call.method === 'error'), fail);
        if (!debug && !fail) assert.equal(calls.length, 0, inspect(calls));
        assert.equal(fail ? actor.state.context.authentication_errors : actor.state.context.sessions, 1);
        safe(calls);
      } finally { actor.stop(); }
    });
  }
}

test('invalid configuration remains visible without debugging', t => {
  const calls = capture(t);
  const ctx = { bus: new EventEmitter(), bootErrors: [] };
  try {
    assert.equal(connect({ extendedSettings: { connect: { source: 'dexcomshare', sharePassword: secret } } }, ctx), undefined);
    assert.ok(ctx.bootErrors.length > 0);
    assert.ok(calls.some(call => call.method === 'error' && call.text.includes('Invalid configuration')));
    safe(calls);
  } finally { ctx.bus.removeAllListeners(); }
});

for (const debug of [false, true]) {
  test(`provider summaries protect authentication/session payloads with debug=${debug}`, async t => {
    const calls = capture(t);
    const log = createLogger(debug);
    const libre = require('../lib/sources/librelinkup')({}, {
      create: () => ({
        post: async () => ({ data: { data: { authTicket: { token: secret } } }, headers: { private: secret } }),
        get: async () => ({ data: { data: [{ patientId: secret }] }, headers: { private: secret } })
      })
    }, log);
    const auth = await libre.authFromCredentials();
    const session = await libre.sessionFromAuth(auth);
    assert.equal(session.patientId, secret);
    assert.equal(session.authTicket.token, secret);
    const glooko = require('../lib/sources/glooko')({ baseURL: 'https://example.invalid', glookoServer: 'example.invalid', glookoAuthMode: 'api' }, {
      create: () => ({ post: async () => ({ data: { user: secret }, headers: { 'set-cookie': [secret] } }) })
    }, log);
    assert.equal((await glooko.authFromCredentials()).user.user, secret);
    const nightscout = require('../lib/sources/nightscout')({ url: 'https://example.invalid', apiSecret: secret }, {
      create: () => ({ get: async () => ({ data: { status: 200, message: { canRead: true, private: secret } } }) })
    }, log);
    assert.equal((await nightscout.authFromCredentials()).readable.message.private, secret);
    assert.equal(calls.some(call => call.method === 'debug'), debug);
    if (!debug) assert.equal(calls.length, 0);
    safe(calls);
  });

  test(`CareLink login and refresh retain results with debug=${debug}`, async t => {
    const calls = capture(t);
    const axios = require('axios');
    const form = '<form action="/login" method="POST">\n<input type="hidden" name="sessionID" value="' + secret + '">\n<input type="hidden" name="sessionData" value="' + secret + '">';
    const client = axios.create({ adapter: async config => {
      config.jar.setCookieSync('auth_tmp_token=' + secret + '; Path=/', config.baseURL);
      config.jar.setCookieSync('c_token_valid_to=' + secret + '; Path=/', config.baseURL);
      return { data: form, status: 200, statusText: 'OK', config, headers: { private: secret, 'set-cookie': [secret + '=cookie; Path=/'] } };
    } });
    const source = require('../lib/sources/minimedcarelink')({
      carelinkServer: 'example.invalid', carelinkUsername: secret, carelinkPassword: secret
    }, client, createLogger(debug));
    const auth = await source.authFromCredentials();
    assert.equal(auth.token, secret);
    const session = { token: secret };
    assert.equal(await source.refreshSession(auth, session), session);
    assert.equal(session.expires, secret);
    assert.equal(calls.some(call => call.method === 'debug'), debug);
    if (!debug) assert.equal(calls.length, 0);
    safe(calls);
  });
}
