const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const axios = require('axios');
const sources = require('../lib/sources');

const root = path.join(__dirname, '..');

// Capture mode (`nightscout-connect capture`) is the only caller of each
// loop's `tracker`, and each source loads the HAR tracer lazily inside it, so
// a wrong require path there stays hidden until someone runs capture.
function registeredLoops (kind, driver) {
  const impl = driver({
    url: 'http://127.0.0.1:9/',
    apiSecret: 'not-a-secret',
    baseURL: 'https://127.0.0.1:9',
    shareAccountName: 'not-an-account',
    sharePassword: 'not-a-password'
  }, axios);
  const loops = [ ];
  const builder = new Proxy({ }, {
    get: (target, key) => key === 'register_loop'
      ? (name, config) => loops.push({ name, config })
      : () => { }
  });
  impl.generate_driver(builder);
  return loops;
}

test('every source that supports capture can start its HAR tracker', () => {
  const started = [ ];
  for (const [kind, driver] of Object.entries(sources.kinds)) {
    for (const { name, config } of registeredLoops(kind, driver)) {
      if (!config.tracker) continue;
      const label = kind + '/' + name;
      let tracker;
      try {
        tracker = config.tracker( );
      } catch (err) {
        err.message = label + ' tracker failed to start: ' + err.message;
        throw err;
      }
      assert.equal(typeof tracker.getGeneratedHar, 'function', label);
      assert.equal(typeof tracker.reset, 'function', label);
      started.push(kind);
    }
  }
  for (const kind of ['nightscout', 'dexcomshare', 'minimedcarelink', 'glooko', 'linkup']) {
    assert.ok(started.includes(kind), kind + ' registered no loop with a tracker');
  }
});

function jsFiles (dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory( )) return jsFiles(full);
    return entry.name.endsWith('.js') ? [full] : [ ];
  });
}

test('every relative require in lib/ and commands/ resolves', () => {
  const files = [...jsFiles(path.join(root, 'lib')), ...jsFiles(path.join(root, 'commands'))];
  const pattern = /require\(\s*(['"])(\.{1,2}\/[^'"]*)\1\s*\)/g;
  let checked = 0;
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (/^\s*\/\//.test(line)) return;
      for (const match of line.matchAll(pattern)) {
        const where = path.relative(root, file) + ':' + (index + 1) + " require('" + match[2] + "')";
        assert.doesNotThrow(() => require.resolve(path.resolve(path.dirname(file), match[2])), where);
        checked++;
      }
    });
  }
  assert.ok(checked > 20, 'only ' + checked + ' relative requires found');
});
