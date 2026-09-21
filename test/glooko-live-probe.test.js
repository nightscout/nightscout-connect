const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

test('live Glooko probe refuses to contact the service without explicit --live', () => {
  const script = path.join(__dirname, '..', 'scripts', 'glooko-live-probe.js');
  const run = spawnSync(process.execPath, [script], {
    env: { ...process.env, CONNECT_GLOOKO_PASSWORD: 'private-password-marker' },
    encoding: 'utf8',
    timeout: 5000
  });

  assert.equal(run.status, 2);
  assert.match(run.stderr, /Read-only live Glooko probe/);
  assert.doesNotMatch(run.stdout + run.stderr, /private-password-marker/);
});
