/**
 * Connector-owned diagnostic logger. The first argument is a fixed operation
 * label; all subsequent values are untrusted data. Never replace the host's
 * console methods: Connect can be loaded inside a long-running Nightscout.
 *
 * This is a backstop, not a reason to log records or HTTP responses. Callers
 * should prefer fixed labels and explicit numeric counts/status codes.
 */
var LEVELS = ['log', 'error', 'warn', 'info', 'debug'];
var MAX_DEPTH = 6;
var MAX_ARRAY = 50;
var SAFE_FIELDS = new Set(['count', 'status', 'entries', 'treatments', 'profiles', 'devicestatus', 'retries', 'context', 'event', 'profile', 'type']);

function scrub (value, seen, depth) {
  try { return scrubValue(value, seen, depth); }
  catch (_) { return '[uninspectable]'; }
}

function scrubValue (value, seen, depth) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string' || typeof value === 'symbol' || typeof value === 'bigint') return '[redacted]';
  if (typeof value !== 'object') return '[redacted]';
  if (value instanceof Error) return '[error]';

  seen = seen || new WeakSet();
  depth = depth || 0;
  if (depth > MAX_DEPTH) return '[deep]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) return '[array ' + value.length + ']';
    return value.map(function (item) { return scrub(item, seen, depth + 1); });
  }

  // Descriptors avoid executing application getters while preparing a log.
  // A Proxy can throw even while descriptors are read; logging must not.
  var descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); }
  catch (_) { return '[uninspectable]'; }
  var out = {};
  Object.keys(descriptors).forEach(function (key) {
    if (!SAFE_FIELDS.has(key)) return;
    var descriptor = descriptors[key];
    out[key] = descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? scrub(descriptor.value, seen, depth + 1)
      : '[accessor]';
  });
  return out;
}

function createLogger (target) {
  var sink = target || console;
  var logger = {};
  LEVELS.forEach(function (level) {
    logger[level] = function (label) {
      if (typeof sink[level] !== 'function') return;
      var args = [typeof label === 'string' ? label : scrub(label)];
      for (var i = 1; i < arguments.length; i++) args.push(scrub(arguments[i]));
      return sink[level].apply(sink, args);
    };
  });
  logger.xstate = function (label) { return logger.log(label); };
  return logger;
}

module.exports = { scrub: scrub, createLogger: createLogger };
