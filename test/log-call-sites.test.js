'use strict';

// All connector logging goes through lib/logging.js, which prints fixed
// messages and an HTTP status, and prints debug lines only when debugging is
// on. A direct console call, or a bare xstate actions.log() that dumps
// { context, event }, bypasses both. This fails the build on either.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { codeOnly, findCallSites } = require('./support/call-sites');

const root = path.resolve(__dirname, '..');

// Files allowed to call console directly, and why.
const ALLOWED = {
  'lib/logging.js': 'the logger itself',
  'lib/trace-axios.js': 'a developer tool; its console calls are in its run-as-a-script block'
};

function walk (dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

test('connector code logs only through lib/logging.js', () => {
  const files = ['index.js', ...walk(path.join(root, 'lib')).map((f) => path.relative(root, f))];
  assert.ok(files.length > 20, 'expected to scan the whole of lib/');
  const found = [];
  for (const file of files) {
    if (ALLOWED[file]) continue;
    for (const site of findCallSites(fs.readFileSync(path.join(root, file), 'utf8'))) {
      found.push(file + ':' + site.line + ' ' + site.name);
    }
  }
  assert.deepEqual(found, [], 'use the logger passed in (log.debug/warn/error) instead');
});

test('the developer tool only logs when run as a script', () => {
  const source = fs.readFileSync(path.join(root, 'lib/trace-axios.js'), 'utf8');
  const scriptBlock = source.split('\n').findIndex((line) => /if \(!module\.parent\)/.test(line)) + 1;
  assert.ok(scriptBlock > 0);
  for (const site of findCallSites(source)) assert.ok(site.line > scriptBlock, 'lib/trace-axios.js:' + site.line);
});

test('the scan sees code and nothing else', () => {
  const sample = [
    "console.log('a');",                         // 1: found
    '// console.log(commented)',                 // 2
    '/* console.log(block)',                     // 3
    '   console.warn(still block) */',           // 4
    "var s = 'console.log(in a string)';",       // 5
    'var t = `text console.log(x) ${',           // 6
    '  console.error(inTemplateExpression)',     // 7: found
    '}`;',                                       // 8
    'actions.log()',                             // 9: found
    "actions.log('labelled')",                   // 10
    'var re = /"/; console . info (y)',          // 11: found, after a quote in a regex
    'console.debug(z)',                          // 12: found, line count intact
    'var d = total / count; console.warn(w)'     // 13: found, division is not a regex
  ].join('\n');
  assert.deepEqual(findCallSites(sample).map((s) => s.line).sort((a, b) => a - b), [1, 7, 9, 11, 12, 13]);
  assert.equal(codeOnly(sample).length, sample.length);
  assert.equal(codeOnly(sample).split('\n').length, sample.split('\n').length);
});
