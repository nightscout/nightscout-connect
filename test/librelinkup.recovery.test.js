const assert = require('node:assert/strict');
const test = require('node:test');
const { interpret } = require('xstate');
const { SimulatedClock } = require('xstate/lib/SimulatedClock');
const builder = require('../lib/builder');
const sourceFactory = require('../lib/sources/librelinkup');
const requestError = require('../lib/machines/request-error');

const auth = { status: 0, data: { user: { id: 'synthetic-user' }, authTicket: { token: 'synthetic-ticket' } } };
const locked = { status: 429, data: { code: 60, data: { lockout: 300 }, message: 'locked' } };

function transport(handler) {
  return { create: defaults => ({
    post: (path, body, options) => handler({ path, body, options, defaults }),
    get: (path, options) => handler({ path, options, defaults })
  }) };
}

async function settle(clock) {
  // Flush actor messages, promise services, and zero-delay transitions.
  for (let i = 0; i < 15; i++) {
    clock.increment(0);
    await new Promise(setImmediate);
  }
}

for (const phase of ['login', 'connections', 'graph']) {
  for (const responseKind of ['body', 'http']) {
    test(`LibreLinkUp ${responseKind} 429 at ${phase} waits through the full actor loop and recovers`, async () => {
      const calls = { login: 0, connections: 0, graph: 0 };
      const batches = [];
      const config = sourceFactory.validate({ linkUpUsername: 'synthetic', linkUpPassword: 'synthetic', linkUpInterval: 1 }).config;
      const source = sourceFactory(config, transport(async ({ path }) => {
        const stage = path.endsWith('/login') ? 'login' : path.endsWith('/graph') ? 'graph' : 'connections';
        calls[stage]++;
        if (stage === phase && calls[stage] === 1) {
          if (responseKind === 'body') return { data: locked };
          throw Object.assign(new Error('private payload must not escape'), {
            response: { status: 429, headers: { 'retry-after': '300' }, data: {} }
          });
        }
        return { data: stage === 'login' ? auth : stage === 'connections'
          ? { status: 0, data: [{ patientId: 'synthetic-patient' }] }
          : { status: 0, data: { graphData: [
            { FactoryTimestamp: '2026-09-22T08:00:00Z', ValueInMgPerDl: 101 },
            { FactoryTimestamp: '2026-09-22T08:05:00Z', ValueInMgPerDl: 102 }
          ] } } };
      }));
      const output = async batch => { batches.push(batch); return {}; };
      // The destination already has newer data: replay must still include gaps.
      output.gap_for = async () => ({ entries: new Date('2026-09-22T08:05:00Z') });
      const make = builder({ output });
      source.generate_driver(make);
      const clock = new SimulatedClock();
      const actor = interpret(make(), { clock, logger: () => {} }).start();
      try {
        actor.send('START');
        await settle(clock);
        assert.equal(calls[phase], 1);
        assert.equal(batches.length, 0);
        clock.increment(60000); // Polling interval, then the 300-second cooldown.
        await settle(clock);
        clock.increment(299999);
        await settle(clock);
        assert.equal(calls[phase], 1, 'must not retry inside the cooldown');
        clock.increment(1);
        await settle(clock);
        assert.equal(calls[phase], 2);
        assert.equal(batches.length, 1);
        assert.deepEqual(batches[0].entries.map(row => row.sgv), [101, 102]);
      } finally { actor.stop(); }
    });
  }
}

test('LibreLinkUp configurable retries run sequentially and resume on the next cycle', async () => {
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const config = sourceFactory.validate({ linkUpUsername: 'synthetic', linkUpPassword: 'synthetic',
    linkUpInterval: 1, linkUpMaxRetries: 1, linkUpRetryIntervalMs: 2000 }).config;
  const source = sourceFactory(config, transport(async () => {
    calls++;
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(setImmediate);
    active--;
    throw Object.assign(new Error('synthetic network failure'), { code: 'ECONNRESET' });
  }));
  const make = builder({ output: async () => ({}) });
  source.generate_driver(make);
  const clock = new SimulatedClock();
  const actor = interpret(make(), { clock, logger: () => {} }).start();
  try {
    actor.send('START');
    await settle(clock);
    assert.equal(calls, 1);
    clock.increment(1999);
    await settle(clock);
    assert.equal(calls, 1);
    clock.increment(1);
    await settle(clock);
    assert.equal(calls, 2);
    clock.increment(59999);
    await settle(clock);
    assert.equal(calls, 2, 'retry limit must end this frame');
    // A late timer callback starts one subsequent frame, without cron overlap.
    clock.increment(600000);
    await settle(clock);
    // The failed frame backs the next cycle off by the source's configured
    // 2.5 minutes (equal jitter: 75-150 s). Before BF-34 was fixed, backoff()
    // discarded that setting and this wait was about 256 ms.
    clock.increment(1000);
    await settle(clock);
    assert.equal(calls, 2, 'the next cycle honours the configured backoff');
    // It is capped at six poll intervals, here six minutes.
    clock.increment(6 * 60 * 1000);
    await settle(clock);
    assert.equal(calls, 3);
    assert.equal(maximum, 1);
  } finally { actor.stop(); }
});

test('Retry-After supports dates, invalid values and the documented limit', () => {
  const delay = requestError.retryAfterMs({ response: { headers: { 'retry-after': new Date(Date.now() + 120000).toUTCString() } } });
  assert.ok(delay >= 118000 && delay <= 120000);
  assert.equal(requestError.retryAfterMs({ response: { headers: { 'retry-after': 'invalid' } } }), 0);
  assert.equal(requestError.retryAfterMs({ retryAfterMs: 3600000 }), 900000);
  assert.equal(requestError.retryAfterMs({ retryAfterMs: -100 }), 0);
});

test('LibreLinkUp response-body errors reject instead of acknowledging an empty graph', async () => {
  const source = sourceFactory({ baseURL: 'https://example.test' }, transport(async () => ({ data: { status: 2, data: {} } })));
  await assert.rejects(source.dataFromSesssion({ patientId: 'synthetic', authTicket: { token: 'synthetic' }, accountId: 'synthetic' }),
    error => error.status === 2 && !error.response && !error.config);
});
