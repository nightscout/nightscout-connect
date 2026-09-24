// Exponential backoff with an optional random slot, and a ceiling on the
// resulting delay rather than on the exponent.
//
// Two defects this replaces, both silent:
//
//   1. The options were merged as `{ ...config, ...defaults }`, so the
//      DEFAULTS went last and every value a caller passed was discarded.
//      Every shipped source asks for an `interval_ms` of 10 s or 2.5 min;
//      every one of them got 256 ms. A vendor outage therefore produced a
//      retry storm roughly 586x faster than the source author configured.
//   2. `exponent_ceiling` caps the exponent, not the delay. At the interval
//      the sources actually ask for, attempt 10 works out at 42 hours - so
//      honouring the caller's interval without also capping the duration
//      would trade a retry storm for a feed that never comes back.
//
// Both had to be fixed together; either alone is worse than neither.
//
// Jitter modes use the usual names: 'none' is the deterministic maximum,
// 'full' is uniform over [0, K], 'equal' is K/2 + uniform over [0, K/2].
// 'equal' is the default because actors that fail together must not retry
// together, and because 'full' can return ~0 on any attempt, which weakens
// the backoff it is there to spread.

var JITTER_MODES = ['none', 'full', 'equal'];

module.exports = function backoff (config) {
  var defaults = {
    interval_ms: 256,
    exponent_ceiling: 20,
    exponent_base: 2,
    max_interval_ms: null,
    jitter: 'equal'
  };
  var opts = { ...defaults, ...(config || { }) };

  // `use_random_slot` was the old spelling of full jitter. It was never
  // reachable - the merge order above discarded it - so nothing depends on
  // its behaviour, but a caller that sets it means what it says.
  if (opts.use_random_slot !== undefined) {
    opts.jitter = opts.use_random_slot ? 'full' : 'none';
  }
  if (JITTER_MODES.indexOf(opts.jitter) < 0) {
    throw new Error('backoff: unknown jitter mode ' + JSON.stringify(opts.jitter)
      + '; expected one of ' + JITTER_MODES.join(', '));
  }

  var I = opts.interval_ms > 0 ? opts.interval_ms : defaults.interval_ms;
  var C = opts.exponent_ceiling > 0 ? opts.exponent_ceiling : defaults.exponent_ceiling;
  var B = opts.exponent_base > 1 ? opts.exponent_base : defaults.exponent_base;
  var MAX = opts.max_interval_ms > 0 ? opts.max_interval_ms : null;
  var random = typeof opts.random === 'function' ? opts.random : Math.random;

  function spread (duration) {
    if (duration <= 0) return 0;
    if (opts.jitter === 'none') return duration;
    if (opts.jitter === 'full') return random( ) * duration;
    return (duration / 2) + (random( ) * (duration / 2));
  }

  function duration_for (attempt) {
    var n = Math.max(0, Math.min(attempt || 0, C));
    var K = Math.pow(B, n) - 1;
    var interval = I * K;
    // Cap first, then spread: a pool that has all reached the ceiling still
    // has to arrive at the vendor spread out.
    if (MAX !== null) interval = Math.min(interval, MAX);
    return Math.floor(spread(interval));
  }

  return duration_for;
};
