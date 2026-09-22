const assert = require('node:assert/strict');
const test = require('node:test');
const { createLogger, scrub } = require('../lib/log-scrub');

function capture () {
  const calls = [];
  const target = Object.fromEntries(['log', 'error', 'warn', 'info', 'debug'].map(level =>
    [level, (...args) => calls.push({ level, args })]));
  const originals = { ...target };
  return { target, originals, calls, logger: createLogger(target) };
}

test('connector logger never replaces host console methods', () => {
  const { target, originals, logger } = capture();
  logger.log('Connect operation', { count: 3 });
  for (const level of Object.keys(originals)) assert.equal(target[level], originals[level]);
  assert.equal(target.__nscLogScrubInstalled, undefined);
});

test('untrusted positional strings, errors, URLs and serialized values do not reach the sink', () => {
  const { calls, logger } = capture();
  const secret = 'patient@example.invalid';
  const error = new Error('https://example.invalid/?token=' + secret);
  error.config = { headers: { Authorization: secret } };
  logger.error('Connect request failed', secret, error, 'https://example.invalid/?token=' + secret,
    JSON.stringify({ profile: { name: secret } }), { count: 2, freeText: secret });
  assert.doesNotMatch(JSON.stringify(calls), /patient@example|token=|Authorization/);
  assert.deepEqual(calls[0].args.slice(1, 5), ['[redacted]', '[error]', '[redacted]', '[redacted]']);
  assert.deepEqual(calls[0].args[5], { count: 2 });
});

test('hostile accessors and proxies cannot break a diagnostic call', () => {
  const { calls, logger } = capture();
  const hostile = { count: 1 };
  Object.defineProperty(hostile, 'status', { enumerable: true, get () { throw Error('secret'); } });
  const proxy = new Proxy({}, { ownKeys () { throw Error('secret'); } });
  const prototypeProxy = new Proxy({}, { getPrototypeOf () { throw Error('secret'); } });
  assert.doesNotThrow(() => logger.warn('Connect diagnostic', hostile, proxy, prototypeProxy));
  assert.deepEqual(calls[0].args[1], { count: 1, status: '[accessor]' });
  assert.equal(calls[0].args[2], '[uninspectable]');
  assert.equal(calls[0].args[3], '[uninspectable]');
});

test('nested values, circular structures and arrays are bounded', () => {
  const value = { count: 1, event: { profile: { name: 'Alice' } }, 'patient@example.invalid': 'secret' };
  value.event.context = value;
  const result = scrub(value);
  assert.equal(result.count, 1);
  assert.deepEqual(result.event.profile, {});
  assert.equal(result.event.context, '[circular]');
  assert.doesNotMatch(JSON.stringify(result), /patient@example|Alice/);
  assert.equal(scrub(new Array(51).fill('secret')), '[array 51]');
});

test('XState logger accepts only a fixed label', () => {
  const { calls, logger } = capture();
  logger.xstate('Connect authentication failed', { event: { password: 'secret' } });
  assert.deepEqual(calls[0].args, ['Connect authentication failed']);
});
