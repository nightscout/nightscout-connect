const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

// Runs in its own process under node --test, so the global console is fresh.
const manage = require('../index');

test('loading the plugin does not wrap the host console', () => {
  assert.equal(console.__nscLogScrubInstalled, undefined);
});

test('a site without a connect source keeps its console unwrapped', () => {
  const originalLog = console.log;
  console.log = () => { };
  try {
    manage({ extendedSettings: { } }, { });
    manage({ extendedSettings: { connect: { } } }, { });
  } finally {
    console.log = originalLog;
  }
  assert.equal(console.__nscLogScrubInstalled, undefined);
});

test('configuring and stopping a source leaves the host console unchanged', async () => {
  const originalLog = console.log;
  console.log = () => { };
  const hostLog = console.log;
  try {
    const handle = manage({ extendedSettings: { connect: { source: 'dexcomshare' } } }, { bus: new EventEmitter(), bootErrors: [ ] });
    assert.equal(console.log, hostLog);
    if (handle) await handle.stop();
  } finally {
    console.log = originalLog;
  }
  assert.equal(console.log, originalLog);
  assert.equal(console.__nscLogScrubInstalled, undefined);
});
