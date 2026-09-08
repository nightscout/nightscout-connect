
/**
 * Redact credentials and personal data from anything written to the console.
 *
 * xstate's `actions.log()` with no arguments logs `{ context, event }`. The
 * machines in lib/machines use that form in 31 places, and the source drivers
 * carry session cookies and account profiles in `event.data` because the
 * machine has to hand a session from the authenticate step to the fetch step.
 * Neither side is wrong on its own; together they write live credentials and
 * personal data to the process log.
 *
 * Scrubbing at the console boundary covers every call site at once, including
 * ones added later, and does not require the machines to know which of a
 * driver's fields are sensitive.
 */

var SENSITIVE = /(cookie|password|secret|token|apikey|api_key|authorization|bearer|email|dateofbirth|firstname|lastname|glookocode|accountid|sessionid|serialnumber|deviceid)/i;

// Session cookies also appear inside plain strings, not just as object values.
var COOKIE_IN_STRING = /((?:^|[;\s])[A-Za-z0-9_.-]*(?:session|sid|token)[A-Za-z0-9_.-]*=)[^;\s]+/gi;

var MAX_DEPTH = 6;
var MAX_ARRAY = 50;

function scrub (value, seen, depth) {
  seen = seen || new WeakSet( );
  depth = depth || 0;

  if (typeof value === 'string') {
    return value.replace(COOKIE_IN_STRING, '$1[redacted]');
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth > MAX_DEPTH) { return '[deep]'; }
  if (seen.has(value)) { return '[circular]'; }
  seen.add(value);

  if (value instanceof Error) { return value; }
  if (Array.isArray(value)) {
    return value.length > MAX_ARRAY
      ? '[array ' + value.length + ']'
      : value.map(function (item) { return scrub(item, seen, depth + 1); });
  }

  var out = { };
  Object.keys(value).forEach(function (key) {
    out[key] = SENSITIVE.test(key) ? '[redacted]' : scrub(value[key], seen, depth + 1);
  });
  return out;
}

/**
 * Wrap console methods on `target` (defaults to the global console).
 * Idempotent: calling it twice does not double-wrap.
 */
function install (target) {
  var con = target || console;
  if (con.__nscLogScrubInstalled) { return con; }

  ['log', 'error', 'warn', 'info'].forEach(function (level) {
    if (typeof con[level] !== 'function') { return; }
    var original = con[level].bind(con);
    con[level] = function ( ) {
      var args = Array.prototype.map.call(arguments, function (arg) {
        return scrub(arg);
      });
      return original.apply(null, args);
    };
  });

  con.__nscLogScrubInstalled = true;
  return con;
}

module.exports = { scrub: scrub, install: install, SENSITIVE: SENSITIVE };
