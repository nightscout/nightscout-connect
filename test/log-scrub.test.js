const assert = require('node:assert/strict');
const test = require('node:test');

const scrubber = require('../lib/log-scrub');

function captureConsole ( ) {
  const lines = [ ];
  const fake = {
    log ( ) { lines.push(Array.from(arguments)); },
    error ( ) { lines.push(Array.from(arguments)); },
    warn ( ) { lines.push(Array.from(arguments)); },
    info ( ) { lines.push(Array.from(arguments)); }
  };
  scrubber.install(fake);
  return { fake, lines };
}

test('redacts credentials and personal data from nested objects', () => {
  const { fake, lines } = captureConsole( );
  // shaped like the xstate tick that lib/machines/session.js emits
  fake.log('DEBUG', { context: { retries: 0 }, event: { type: 'AUTHENTICATED', data: {
    cookies: 'some-session=abc123; domain=example.com',
    user: { email: 'someone@example.com', firstName: 'A', dateOfBirth: '1970-01-01' }
  } } });
  const flat = JSON.stringify(lines);
  assert.ok(!flat.includes('abc123'), 'session cookie must not survive');
  assert.ok(!flat.includes('someone@example.com'), 'email must not survive');
  assert.ok(!flat.includes('1970-01-01'), 'date of birth must not survive');
  assert.ok(flat.includes('[redacted]'), 'redaction marker expected');
  assert.ok(flat.includes('AUTHENTICATED'), 'non-sensitive fields must survive');
  assert.equal(lines[0][1].context.retries, 0, 'counters must survive');
});

test('redacts session cookies embedded in plain strings', () => {
  const { fake, lines } = captureConsole( );
  fake.log('cookie was some-session=deadbeefcafe; path=/');
  assert.ok(!JSON.stringify(lines).includes('deadbeefcafe'));
  assert.ok(JSON.stringify(lines).includes('[redacted]'));
});

test('leaves ordinary payloads intact', () => {
  const { fake, lines } = captureConsole( );
  fake.log('PERSISTED', { entries: 12, treatments: 3, sgv: 154, status: 'ok' });
  assert.deepEqual(lines[0][1], { entries: 12, treatments: 3, sgv: 154, status: 'ok' });
});

test('survives circular references and deep nesting', () => {
  const { fake, lines } = captureConsole( );
  const a = { n: 1 }; a.self = a;
  fake.log('circular', a);
  assert.equal(lines[0][1].self, '[circular]');
  let deep = { }; let cur = deep;
  for (let i = 0; i < 12; i++) { cur.next = { i }; cur = cur.next; }
  assert.doesNotThrow(() => fake.log('deep', deep));
});

test('install is idempotent', () => {
  const { fake } = captureConsole( );
  scrubber.install(fake);
  scrubber.install(fake);
  fake.log('x', { password: 'p' });
  assert.ok(true);
});

test('scrub can be used directly without touching console', () => {
  const out = scrubber.scrub({ apiSecret: 'shh', nested: { token: 't', keep: 1 } });
  assert.equal(out.apiSecret, '[redacted]');
  assert.equal(out.nested.token, '[redacted]');
  assert.equal(out.nested.keep, 1);
});
