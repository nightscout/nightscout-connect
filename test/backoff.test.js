const assert = require('node:assert/strict');
const test = require('node:test');

const backoff = require('../lib/backoff');

// The option merge used to read `{ ...config, ...defaults }`, which put the
// defaults last and threw away everything the caller asked for. Every shipped
// source configures an interval of 10 s or 2.5 min; every one of them got the
// 256 ms default. This is the assertion that fails if that order comes back.
test('backoff honours the interval the caller asked for', () => {
  const delay = backoff({ interval_ms: 150000, jitter: 'none' });
  assert.equal(delay(0), 0);
  assert.equal(delay(1), 150000);
  assert.equal(delay(2), 450000);
  assert.equal(delay(3), 1050000);
});

test('backoff falls back to its own default when the caller says nothing', () => {
  const delay = backoff({ jitter: 'none' });
  assert.equal(delay(1), 256);
  assert.equal(delay(2), 768);
});

test('backoff accepts no configuration at all', () => {
  const delay = backoff();
  assert.equal(delay(0), 0);
  assert.ok(delay(3) > 0);
});

// exponent_ceiling caps the exponent, not the delay, so on its own it is no
// protection: 2^20 intervals of 2.5 minutes is five years. The duration cap is
// what keeps a feed from going dark for days after a long outage.
test('max_interval_ms caps the delay, which exponent_ceiling never did', () => {
  const uncapped = backoff({ interval_ms: 150000, jitter: 'none' });
  assert.ok(uncapped(12) > 6 * 3600 * 1000, 'the uncapped delay is hours, which is the hazard');

  const capped = backoff({ interval_ms: 150000, max_interval_ms: 1800000, jitter: 'none' });
  assert.equal(capped(12), 1800000);
  assert.equal(capped(40), 1800000);
  assert.equal(capped(2), 450000, 'the cap does not disturb attempts below it');
});

test('jitter none reproduces the deterministic maximum', () => {
  const delay = backoff({ interval_ms: 1000, jitter: 'none', random: () => 0.9 });
  assert.equal(delay(3), 7000);
});

test('jitter full spreads over the whole interval', () => {
  const low = backoff({ interval_ms: 1000, jitter: 'full', random: () => 0 });
  const high = backoff({ interval_ms: 1000, jitter: 'full', random: () => 0.999 });
  assert.equal(low(3), 0);
  assert.equal(high(3), 6993);
});

test('jitter equal keeps half the delay and spreads the rest, and is the default', () => {
  const low = backoff({ interval_ms: 1000, jitter: 'equal', random: () => 0 });
  const high = backoff({ interval_ms: 1000, jitter: 'equal', random: () => 0.999 });
  assert.equal(low(3), 3500, 'never below half: full jitter can return ~0, which is the reason for the default');
  assert.equal(high(3), 6996);

  const dflt = backoff({ interval_ms: 1000, random: () => 0 });
  assert.equal(dflt(3), 3500);
});

test('the first attempt is immediate under every jitter mode', () => {
  for (const jitter of ['none', 'full', 'equal']) {
    const delay = backoff({ interval_ms: 150000, jitter, random: () => 0.75 });
    assert.equal(delay(0), 0, `attempt 0 under ${jitter}`);
  }
});

// use_random_slot was the old spelling. It was unreachable for the same reason
// interval_ms was, so nothing depends on its behaviour - but a caller that
// sets it deliberately should get what it named.
test('use_random_slot still selects full jitter, and false still selects none', () => {
  const on = backoff({ interval_ms: 1000, use_random_slot: true, random: () => 0 });
  assert.equal(on(3), 0);
  const off = backoff({ interval_ms: 1000, use_random_slot: false, random: () => 0 });
  assert.equal(off(3), 7000);
});

test('an unknown jitter mode is refused at construction, not at the first retry', () => {
  assert.throws(() => backoff({ jitter: 'some' }), /unknown jitter mode/);
});

// A pool that fails together must not retry together. With the deterministic
// maximum every actor picks the same millisecond; with jitter they do not.
test('jitter decorrelates a pool that reached the same attempt together', () => {
  const pool = (jitter) => new Set(Array.from({ length: 200 }, () =>
    backoff({ interval_ms: 150000, jitter })(4)));
  assert.equal(pool('none').size, 1, 'the deterministic maximum is one value for the whole pool');
  assert.ok(pool('equal').size > 100, 'equal jitter spreads the same pool over many distinct delays');
});
