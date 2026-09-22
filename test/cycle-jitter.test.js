const assert = require('node:assert/strict');
const test = require('node:test');

const createCycle = require('../lib/machines/cycle');
const builder = require('../lib/builder');
const manage = require('../index');
const { EventEmitter } = require('node:events');

const INTERVAL = 5 * 60 * 1000;

function cycle (overrides) {
  return createCycle({ fetchMachine: null }, Object.assign({
    name: 'Test',
    expected_data_interval_ms: INTERVAL
  }, overrides));
}

// The default is "behave exactly as this did before". One actor is not a
// herd, and a self-hosted site should not wait out a problem it does not have.
test('with no jitter configured the machine is unchanged', () => {
  const m = cycle({});
  assert.equal(m.options.delays.START_JITTER_DELAY({}, {}), 0);
  assert.equal(m.options.delays.EXPECTED_DATA_INTERVAL_DELAY({ align_to: null }, {}), INTERVAL);
});

// Init used to fall straight through to Ready with no delay at all, which is
// why `run()` put every actor in a pool on the vendor in the same instant.
test('the first cycle waits on a named delay rather than falling through', () => {
  const after = cycle({}).states.Init.config.after;
  assert.deepEqual(after, [{ target: 'Ready', delay: 'START_JITTER_DELAY' }]);
});

test('start jitter lands inside the window it was given', () => {
  assert.equal(cycle({ start_jitter_ms: 60000, random: () => 0 }).options.delays.START_JITTER_DELAY({}, {}), 0);
  assert.equal(cycle({ start_jitter_ms: 60000, random: () => 0.5 }).options.delays.START_JITTER_DELAY({}, {}), 30000);
  assert.equal(cycle({ start_jitter_ms: 60000, random: () => 0.999 }).options.delays.START_JITTER_DELAY({}, {}), 59940);
});

test('interval jitter is added to the unaligned wait only', () => {
  const m = cycle({ interval_jitter_ms: 30000, random: () => 0.5 });
  assert.equal(m.options.delays.EXPECTED_DATA_INTERVAL_DELAY({ align_to: null }, {}), INTERVAL + 15000);

  // The aligned path belongs to the source: align_to already carries whatever
  // spread that driver decided on, and adding more would push the fetch past
  // the window it aimed at.
  const align_to = Date.now() + 90000;
  const aligned = m.options.delays.EXPECTED_DATA_INTERVAL_DELAY({ align_to }, {});
  assert.ok(Math.abs(aligned - 90000) < 1000, `aligned wait was ${aligned}`);
});

test('a negative or unparseable window is treated as no jitter', () => {
  for (const bad of [-1, 0, null, undefined, NaN, 'soon']) {
    assert.equal(cycle({ start_jitter_ms: bad }).options.delays.START_JITTER_DELAY({}, {}), 0,
      `start_jitter_ms=${String(bad)}`);
  }
});

// Jitter is only useful if it differs per actor. A pool built from one
// configuration must not draw one number.
test('a pool of cycles built from one config draws different start delays', () => {
  const drawn = new Set(Array.from({ length: 200 }, () =>
    cycle({ start_jitter_ms: 60000 }).options.delays.START_JITTER_DELAY({}, {})));
  assert.ok(drawn.size > 100, `only ${drawn.size} distinct delays in 200 actors`);
});

// The ceilings builder applies are stated relative to the loop's cadence, so
// they have to be read off a loop that was actually registered.
test('builder caps the frame retry at the poll interval and the cycle at six of them', () => {
  const made = builder({ output: () => Promise.resolve(), start_jitter_ms: 45000 });
  made.support_session({
    authenticate: () => Promise.resolve({}),
    authorize: () => Promise.resolve({}),
    delays: { REFRESH_AFTER_SESSSION_DELAY: 28800000, EXPIRE_SESSION_DELAY: 28800000 }
  });
  made.register_loop('Loop', {
    frame: { impl: () => Promise.resolve({}), maxRetries: 3, backoff: { interval_ms: 150000 } },
    expected_data_interval_ms: INTERVAL,
    backoff: { interval_ms: 150000 }
  });
  const poller = made();
  const cycleMachine = poller.options.services.LoopService;
  const delays = cycleMachine.options.delays;

  assert.equal(delays.MAIN_CYCLE_DELAY({ frames_missing: 40 }, {}) <= 6 * INTERVAL, true,
    'the cycle backoff is capped at six intervals');
  assert.ok(delays.MAIN_CYCLE_DELAY({ frames_missing: 40 }, {}) >= 3 * INTERVAL,
    'and jittered no lower than half of it');
  assert.ok(delays.START_JITTER_DELAY({}, {}) < 45000, 'the builder passed the start window through');
});

// The settings name is what an operator types as CONNECT_START_JITTER_MS;
// Nightscout's extended settings turn that into startJitterMs.
test('CONNECT_START_JITTER_MS reaches the cycle machine', () => {
  function connector (connect) {
    const bus = new EventEmitter();
    bus.setMaxListeners(0);
    const ctx = { bus, bootErrors: [], ddata: {}, store: {} };
    const env = { extendedSettings: { connect }, settings: {} };
    const handle = manage(env, ctx);
    const machine = handle().machine;
    const cycleMachine = machine.options.services.NightscoutEntriesService;
    const drawn = cycleMachine.options.delays.START_JITTER_DELAY({}, {});
    handle.stop();
    return drawn;
  }
  const base = {
    source: 'nightscout',
    sourceEndpoint: 'http://127.0.0.1:1/unused',
    sourceApiSecret: 'x'.repeat(24)
  };
  assert.equal(connector(base), 0, 'unset means unchanged');
  const drawn = connector(Object.assign({ startJitterMs: 60000 }, base));
  assert.ok(drawn > 0 && drawn < 60000, `drew ${drawn}`);
});

// LibreLinkUp declares its own windows (CONNECT_LINK_UP_*_JITTER_MS); the
// deployment-wide ones apply to every source. One mechanism serves both.
test('a source-declared start window is used when the deployment sets none', () => {
  const m = cycle({ startup_jitter_ms: 60000, delay_per_frame_error: () => 0, random: () => 0.5 });
  assert.equal(m.options.delays.START_JITTER_DELAY({}, {}), 30000);
  // and it is not applied a second time on the way into the first fetch
  assert.equal(m.options.delays.MAIN_CYCLE_DELAY({ runs: 0, frames_missing: 0 }, {}), 0);
});

test('where both are set the wider window wins, in either direction', () => {
  const drawn = (c) => cycle({ random: () => 0.999, ...c }).options.delays.START_JITTER_DELAY({}, {});
  assert.equal(drawn({ start_jitter_ms: 10000, startup_jitter_ms: 60000 }), 59940);
  assert.equal(drawn({ start_jitter_ms: 60000, startup_jitter_ms: 10000 }), 59940);
  const interval = (c) => cycle({ random: () => 0.5, ...c }).options.delays.EXPECTED_DATA_INTERVAL_DELAY({ align_to: null }, {});
  assert.equal(interval({ interval_jitter_ms: 10000, expected_interval_jitter_ms: 30000 }), INTERVAL + 15000);
  assert.equal(interval({ interval_jitter_ms: 30000, expected_interval_jitter_ms: 10000 }), INTERVAL + 15000);
});

test('only the source window is added on the aligned path', () => {
  const aligned = (c) => {
    const align_to = Date.now() + 90000;
    return cycle({ random: () => 0.5, ...c }).options.delays.EXPECTED_DATA_INTERVAL_DELAY({ align_to }, {});
  };
  assert.ok(Math.abs(aligned({ interval_jitter_ms: 30000 }) - 90000) < 1000, 'deployment window not added');
  assert.ok(Math.abs(aligned({ expected_interval_jitter_ms: 30000 }) - 105000) < 1000, 'source window added');
});

test('no window is longer than five minutes', () => {
  const drawn = cycle({ start_jitter_ms: 20 * 60 * 1000, random: () => 0.999 }).options.delays.START_JITTER_DELAY({}, {});
  assert.ok(drawn <= 5 * 60 * 1000, `drew ${drawn}`);
});
