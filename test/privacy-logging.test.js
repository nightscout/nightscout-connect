const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const manage = require('../index');
const internalOutput = require('../lib/outputs/internal');

function captureLogs (run) {
  const originalLog = console.log;
  const logged = [];
  console.log = (...args) => logged.push(args.map((arg) => {
    if (typeof arg === 'string') return arg;
    try { return JSON.stringify(arg); } catch (_) { return String(arg); }
  }).join(' '));

  try {
    return { result: run(), logged };
  } finally {
    console.log = originalLog;
  }
}

test('configuration logs omit source credentials', () => {
  const ctx = {
    bootErrors: [],
    bus: new EventEmitter()
  };

  const { logged } = captureLogs(() => manage({
    extendedSettings: {
      connect: {
        source: 'glooko',
        glookoPassword: 'private-password-marker'
      }
    }
  }, ctx));

  assert.doesNotMatch(logged.join('\n'), /private-password-marker/);
});

test('internal output logs collection counts instead of raw batches', async () => {
  const ctx = { bus: new EventEmitter() };
  const output = internalOutput({}, ctx);
  const originalLog = console.log;
  const logged = [];
  console.log = (...args) => logged.push(args.map((arg) => {
    if (typeof arg === 'string') return arg;
    try { return JSON.stringify(arg); } catch (_) { return String(arg); }
  }).join(' '));

  try {
    await output({
      entries: [],
      treatments: [],
      profiles: [],
      devicestatus: [],
      privateMarker: 'private-medical-batch-marker'
    });
  } finally {
    console.log = originalLog;
  }

  assert.doesNotMatch(logged.join('\n'), /private-medical-batch-marker/);
  assert.match(logged.join('\n'), /0 entries/);
  assert.match(logged.join('\n'), /0 treatments/);
});
