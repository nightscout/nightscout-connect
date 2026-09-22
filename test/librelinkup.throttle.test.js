const assert = require('node:assert/strict');
const test = require('node:test');

const createCycle = require('../lib/machines/cycle');
const linkUpSource = require('../lib/sources/librelinkup');

function cycle() {
  return createCycle({ fetchMachine: null }, {
    name: 'LibreLinkUp',
    delay_per_frame_error: () => 0,
    expected_data_interval_ms: 60 * 1000,
    throttle_backoff_per_error_ms: 60 * 1000,
    throttle_monitor_enabled: true,
    startup_jitter_ms: 0,
    expected_interval_jitter_ms: 0
  });
}

test('LibreLinkUp 429 delay grows by a minute and honors Retry-After', () => {
  const machine = cycle();
  let state = machine.transition(machine.initialState, { type: 'FRAME_ERROR', status: 429, retry_after_ms: 120000 });
  assert.equal(state.context.consecutive_429, 1);
  assert.equal(machine.options.delays.MAIN_CYCLE_DELAY(state.context), 120000);

  state = machine.transition(state, { type: 'FRAME_ERROR', status: 429 });
  assert.equal(state.context.consecutive_429, 2);
  assert.equal(machine.options.delays.MAIN_CYCLE_DELAY(state.context), 120000);

  state = machine.transition(state, { type: 'FRAME_ERROR', status: 429 });
  assert.equal(state.context.consecutive_429, 3);
  assert.ok(state.context.throttle_boost_until > Date.now());
  assert.equal(machine.options.delays.MAIN_CYCLE_DELAY(state.context), 180000);
  assert.equal(machine.options.delays.EXPECTED_DATA_INTERVAL_DELAY(state.context), 120000);

  state = machine.transition(state, { type: 'FRAME_SUCCESS' });
  assert.equal(state.context.consecutive_429, 0);
  assert.equal(state.context.last_frame_error_status, null);
  assert.equal(machine.options.delays.EXPECTED_DATA_INTERVAL_DELAY(state.context), 120000);
});

test('LibreLinkUp jitter and interval settings are bounded', () => {
  const common = { linkUpUsername: 'user', linkUpPassword: 'secret' };
  assert.equal(linkUpSource.validate({ ...common, linkUpStartupJitterMs: 300001 }).ok, false);
  assert.equal(linkUpSource.validate({ ...common, linkUpIntervalJitterMs: -1 }).ok, false);
  assert.equal(linkUpSource.validate({ ...common, linkUpInterval: 0 }).ok, false);
  const accepted = linkUpSource.validate({ ...common, linkUpStartupJitterMs: 120000, linkUpIntervalJitterMs: 30000 });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.config.linkUpStartupJitterMs, 120000);
  assert.equal(accepted.config.linkUpIntervalJitterMs, 30000);
});
