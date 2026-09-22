const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { inspect } = require('node:util');
const { setImmediate: immediate, setTimeout: delay } = require('node:timers/promises');
const { interpret } = require('xstate');
const connect = require('../');
const builder = require('../lib/builder');
const dexcom = require('../lib/sources/dexcomshare');

const secrets = ['owned-user@example.invalid', 'owned-password-marker', 'owned-account-marker', 'owned-session-marker'];
const credentials = { source: 'dexcomshare', shareAccountName: secrets[0], sharePassword: secrets[1] };

function capture(t) {
  const calls = [];
  for (const method of ['log', 'error', 'warn', 'debug']) {
    t.mock.method(console, method, (...args) => calls.push(inspect(args, { depth: 15 })));
  }
  const verify = () => {
    const output = calls.join('\n');
    for (const secret of secrets) assert.ok(!output.includes(secret), `logged fixture secret: ${secret}`);
    return output;
  };
  verify.logger = (...args) => calls.push(inspect(args, { depth: 15 }));
  return verify;
}

for (const invalid of [false, true]) {
  test(`startup and tick logging protects ${invalid ? 'invalid' : 'valid'} Dexcom configuration`, async t => {
    const logs = capture(t);
    const bus = new EventEmitter();
    const config = { ...credentials };
    if (invalid) delete config.shareAccountName;
    const ctx = { bus, bootErrors: [] };
    const handle = connect({ extendedSettings: { connect: config } }, ctx);
    try {
      bus.emit('tick', { password: secrets[1], session: secrets[3] });
      assert.equal(Boolean(handle), !invalid);
      assert.equal(ctx.bootErrors.length > 0, invalid);
      logs();
    } finally {
      if (handle) await handle.stop();
      bus.removeAllListeners();
    }
  });
}

function upstreamError() {
  const error = new Error(secrets.join(' '));
  error.config = { data: credentials, params: { sessionID: secrets[3] } };
  error.response = { status: 401, data: { echoed: secrets } };
  return error;
}

for (const method of ['authFromCredentials', 'sessionFromAuth', 'dataFromSesssion']) {
  test(`${method} retains rejection and HTTP status without logging sensitive error fields`, async t => {
    const logs = capture(t);
    const error = upstreamError();
    const source = dexcom(credentials, { create: () => ({ post: () => Promise.reject(error) }) });
    await assert.rejects(source[method](secrets[3]), actual => actual === error);
    assert.match(logs(), /401/);
  });
}

async function until(predicate) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail('owned actor did not reach expected state');
}

for (const failure of [null, 'Authenticate', 'Login', 'ReadPublisher']) {
  test(`actual Dexcom poller protects auth/session/error data: ${failure || 'success'}`, async t => {
    const logs = capture(t);
    for (let cycle = 0; cycle < 2; cycle++) {
      let persisted = 0;
      let failed = 0;
      const post = async (url, body, options) => {
        if (failure && url.includes(failure)) { failed++; throw upstreamError(); }
        if (url.includes('Authenticate')) {
          assert.equal(body.password, secrets[1]);
          return { data: { accountId: secrets[2] } };
        }
        if (url.includes('Login')) {
          assert.equal(body.accountId, secrets[2]);
          return { data: secrets[3] };
        }
        assert.equal(options.params.sessionID, secrets[3]);
        return { data: [{ WT: `/Date(${Date.now()})/`, Value: 123, Trend: 4 }] };
      };
      const output = async batch => {
        assert.equal(batch.entries[0].sgv, 123);
        persisted++;
        return { entries: new Date() };
      };
      output.gap_for = async () => ({ entries: new Date(Date.now() - 300000) });
      const make = builder({ output });
      dexcom(credentials, { create: () => ({ post }) }).generate_driver(make);
      const actor = interpret(make(), { logger: logs.logger });
      try {
        actor.start();
        actor.send('START');
        await until(() => failure ? failed > 0 : persisted > 0);
        await immediate();
        await immediate();
        actor.send({ type: 'DEBUG', data: secrets });
        actor.children.get('Session').send({ type: 'DEBUG', data: secrets });
        logs();
        if (!failure) assert.equal(actor.state.context.sessions, 1);
        if (failure === 'Authenticate') assert.equal(actor.state.context.authentication_errors, 1);
        if (failure === 'Login') assert.equal(actor.state.context.authorization_errors, 1);
      } finally {
        actor.stop();
      }
    }
  });
}
