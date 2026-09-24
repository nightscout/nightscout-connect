const assert = require('node:assert/strict');
const test = require('node:test');
const { plan } = require('../scripts/release-version');

test('a full release must match package.json exactly', () => {
  assert.deepEqual(plan('v0.1.0', '0.1.0'), { version: '0.1.0', distTag: 'latest', stamp: false });
  assert.throws(() => plan('v0.1.0', '0.0.14'), /must match exactly/);
  assert.throws(() => plan('v0.0.14', '0.1.0'), /must match exactly/);
});

test('a prerelease of the version package.json declares needs no bump commit', () => {
  assert.deepEqual(plan('v0.1.0-dev.1', '0.1.0'), { version: '0.1.0-dev.1', distTag: 'next', stamp: true });
  assert.deepEqual(plan('v0.1.0-dev.2', '0.1.0'), { version: '0.1.0-dev.2', distTag: 'next', stamp: true });
  assert.deepEqual(plan('v0.1.0-rc.1', '0.1.0'), { version: '0.1.0-rc.1', distTag: 'next', stamp: true });
});

test('a prerelease of any other version is refused', () => {
  // dev still declares 0.0.14: a 0.1.0 prerelease needs package.json to say 0.1.0 first
  assert.throws(() => plan('v0.1.0-dev.1', '0.0.14'), /not a prerelease of package.json version 0.0.14/);
  // dev declares 0.1.0: neither an older nor a newer line can be prereleased from it
  assert.throws(() => plan('v0.0.16-dev.1', '0.1.0'), /not a prerelease of package.json version 0.1.0/);
  assert.throws(() => plan('v0.2.0-dev.1', '0.1.0'), /not a prerelease of package.json version 0.1.0/);
  assert.throws(() => plan('v0.1.1-dev.1', '0.1.0'), /not a prerelease of package.json version 0.1.0/);
});

test('a prerelease that package.json already declares is not stamped', () => {
  assert.deepEqual(plan('v0.1.0-dev.1', '0.1.0-dev.1'), { version: '0.1.0-dev.1', distTag: 'next', stamp: false });
});

test('only well-formed version tags are accepted', () => {
  for (const tag of ['0.1.0', 'v0.1', 'v0.1.0.1', 'v01.0.0', 'v0.1.0-', 'v0.1.0-dev..1',
    'v0.1.0-dev.01', 'v0.1.0+build.1', 'v0.1.0-dev.1+build', 'vnext', undefined]) {
    assert.throws(() => plan(tag, '0.0.14'), /does not start with|is not a version/, String(tag));
  }
  assert.throws(() => plan('v0.1.0', 'banana'), /package.json version banana is not a version/);
});

test('nothing is published that would sort at or below npm latest', () => {
  assert.throws(() => plan('v0.0.14-dev.1', '0.0.14', '0.0.14'), /must lead the latest release/);
  assert.throws(() => plan('v0.0.13', '0.0.13', '0.0.14'), /move latest backwards/);
  assert.throws(() => plan('v0.0.14', '0.0.14', '0.0.14'), /move latest backwards/);
  assert.deepEqual(plan('v0.1.0-dev.1', '0.1.0', '0.0.12'), { version: '0.1.0-dev.1', distTag: 'next', stamp: true });
  // 0.1.0 already released and package.json not moved on: no more 0.1.0 prereleases
  assert.throws(() => plan('v0.1.0-dev.3', '0.1.0', '0.1.0'), /must lead the latest release/);
  assert.deepEqual(plan('v0.1.0', '0.1.0', '0.0.12'), { version: '0.1.0', distTag: 'latest', stamp: false });
  // never published: no latest to compare against
  assert.deepEqual(plan('v0.1.0', '0.1.0', ''), { version: '0.1.0', distTag: 'latest', stamp: false });
  assert.throws(() => plan('v0.1.0', '0.1.0', 'garbage'), /npm latest version garbage is not a version/);
});
