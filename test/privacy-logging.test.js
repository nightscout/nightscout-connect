const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const manage = require('../index');
const internalOutput = require('../lib/outputs/internal');

function captureLogs (run) {
  const originalLog = console.log;
  const logged = [];
  console.log = (...args) => logged.push(args.map((arg) =>
    typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '));
  try {
    return { result: run(), logged };
  } finally {
    console.log = originalLog;
  }
}

test('plugin configuration logs omit source credentials', () => {
  const ctx = { bootErrors: [], bus: new EventEmitter() };
  const { logged } = captureLogs(() => manage({
    extendedSettings: { connect: { source: 'glooko', glookoPassword: 'private-password-marker' } }
  }, ctx));

  assert.doesNotMatch(logged.join('\n'), /private-password-marker/);
});

test('internal output logs counts instead of raw medical batches', async () => {
  const ctx = { bus: new EventEmitter() };
  // The counts are debug output, so turn debugging on to see them.
  const output = internalOutput({ debug: true }, ctx);
  const originalLog = console.log;
  const originalDebug = console.debug;
  const logged = [];
  console.log = console.debug = (...args) => logged.push(args.map((arg) =>
    typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '));

  try {
    await output({ entries: [], treatments: [], profiles: [], devicestatus: [], privateMarker: 'private-batch-marker' });
    ctx.bus.emit('data-processed', {
      data: { sgvs: [{ mills: 1000, privateMarker: 'private-glucose-marker' }], treatments: [], devicestatus: [], profile: [] },
      lastEntry: (items) => items[0]
    });
  } finally {
    console.log = originalLog;
    console.debug = originalDebug;
  }

  assert.doesNotMatch(logged.join('\n'), /private-batch-marker|private-glucose-marker/);
  assert.match(logged.join('\n'), /0 entries/);
  assert.match(logged.join('\n'), /0 treatments/);
});
