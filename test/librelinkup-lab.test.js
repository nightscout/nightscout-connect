'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { accountsFrom, sourceConfig, verifyMapping, rawTime, verifyRows, clone, safeFailure } = require('../scripts/librelinkup-lab/common');
const { payload, fixtureAxios } = require('../scripts/librelinkup-lab/fixture');
const sourceFactory = require('../lib/sources/librelinkup');
const now = Date.parse('2026-09-22T08:00:00Z');
const account = { username: 'synthetic', password: 'synthetic', region: 'UK', sensorInfo: true };

test('live failure summaries distinguish account and network failures without disclosing source errors', () => {
  assert.equal(safeFailure(new Error('NO MATCHING LIBRE LINKUP PATIENT ID AVAILABLE')).code, 'PATIENT_ID_NOT_FOUND');
  assert.equal(safeFailure(new Error('LibreLinkUp login returned no auth ticket (status 2).')).code, 'NO_AUTH_TICKET');
  assert.equal(safeFailure(new Error('LibreLinkUp account action required (tou); private data')).code, 'ACCOUNT_ACTION_REQUIRED');
  assert.equal(safeFailure(Object.assign(new Error('private response'), { code: 'ENOTFOUND' })).networkCode, 'ENOTFOUND');
  assert.deepEqual(safeFailure(Object.assign(new Error('secret-token user@example.test'), { code: 'secret-token', response: { data: 'private-data' } })),
    { code: 'VALIDATION_FAILED', status: null });
});

test('lab template covers all 13 endpoints with isolated ports and explicit DE/FR choices', () => {
  const accounts = accountsFrom(require('node:fs').readFileSync(path.resolve(__dirname, '../docs/librelinkup-lab.env.example'), 'utf8'));
  const hosts = { EU2: 'api-eu2.libreview.io', EU: 'api-eu.libreview.io', US: 'api-us.libreview.io',
    CA: 'api-ca.libreview.io', AU: 'api-au.libreview.io', AP: 'api-ap.libreview.io', AE: 'api-ae.libreview.io',
    LA: 'api-la.libreview.io', RU: 'api.libreview.ru', JP: 'api-jp.libreview.io', CN: 'api-cn.myfreestyle.cn',
    DE: 'api-de.libreview.io', FR: 'api-fr.libreview.io' };
  assert.deepEqual(accounts.map(a => a.region).sort(), Object.keys(hosts).sort());
  assert.equal(new Set(accounts.map(a => a.port)).size, 13);
  assert.deepEqual(accounts.map(a => a.port), Array.from({ length: 13 }, (_, i) => 1350 + i));
  assert.ok(accounts.every(a => a.port !== 1369));
  for (const a of accounts) {
    assert.equal(a.endpoint, 'https://' + hosts[a.region]);
    assert.equal(sourceConfig({ ...a, username: 'synthetic', password: 'synthetic' }).baseURL, a.endpoint);
  }
  assert.throws(() => accountsFrom('LLU_TEST_ACCOUNTS=' + Array.from({ length: 14 }, (_, i) => 'account' + i).join(',')), /TOO_MANY_ACCOUNTS/);
});

test('lab env uses explicit aliases and never activates commented credentials', () => {
  const accounts = accountsFrom('LLU_TEST_ACCOUNTS=uk,us\n# LLU_UK_USERNAME=private\nLLU_US_REGION=US\nLLU_US_USERNAME="test#user"\nLLU_US_PASSWORD="with # and ="\n');
  assert.equal(accounts[0].username, undefined);
  assert.equal(accounts[1].username, 'test#user');
  assert.equal(accounts[1].password, 'with # and =');
  assert.equal(accounts[1].port, 1351);
  assert.throws(() => sourceConfig(accounts[0]), /MISSING_CREDENTIALS/);
  for (const aliases of ['uk,uk', 'fixture', 'mongo', 'runner', '../live', 'a-b', ''])
    assert.throws(() => accountsFrom('LLU_TEST_ACCOUNTS=' + aliases));
  assert.throws(() => accountsFrom('LLU_TEST_ACCOUNTS=uk\nLLU_UK_REGION=unknown'), /INVALID_REGION/);
  assert.throws(() => accountsFrom('LLU_TEST_ACCOUNTS=uk\nLLU_UK_TIMEZONE=Invalid/Zone'), /INVALID_REGION_OR_TIMEZONE/);
  assert.throws(() => accountsFrom('LLU_TEST_ACCOUNTS=uk\nLLU_UK_MAX_AGE_MINUTES=-1'), /INVALID_MAX_AGE/);
});

test('live runner refuses implicit live access and conflicting modes', () => {
  for (const args of [[], ['--live'], ['--fixture', '--live']]) {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/librelinkup-lab/runner.js'), ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /REQUIRES/);
    assert.doesNotMatch(result.stdout + result.stderr, /password|Bearer|at main/);
  }
});

test('independent timestamp oracle handles regional wall times and explicit offsets', () => {
  assert.equal(rawTime('9/22/2026 8:00:00 AM'), now);
  assert.equal(rawTime('9/22/2026 8:00:00 PM'), now + 12 * 3600000);
  assert.equal(rawTime('2026-09-22T08:00:00'), now);
  assert.equal(rawTime('2026-09-22T10:00:00+02:00'), now);
  assert.ok(Number.isNaN(rawTime('invalid')));
});

test('synthetic v4 flow and independent oracle catch lost latest values, units, time and trends', async () => {
  const source = sourceFactory(sourceConfig(account), fixtureAxios(now));
  const session = await source.sessionFromAuth(await source.authFromCredentials());
  const raw = await source.dataFromSesssion(session);
  const batch = source.transformGlucose(raw);
  verifyMapping(raw, batch, 30, now);
  assert.deepEqual(batch.entries.map(row => row.sgv), [90, 108, 126, 135]);
  assert.equal(batch.entries[0].sensorInfo.serialNumber, 'SYNTHETIC-OLD');
  assert.equal(batch.entries[3].sensorInfo.serialNumber, 'SYNTHETIC-NEW');
  for (const mutate of [b => b.entries.pop(), b => { b.entries[0].sgv /= 18; },
    b => { b.entries[0].date += 3600000; }, b => { b.entries[3].direction = 'Flat'; }]) {
    const broken = clone(batch);
    mutate(broken);
    assert.throws(() => verifyMapping(raw, broken, 30, now), /MISMATCH/);
  }
  assert.throws(() => verifyMapping(raw, batch, 30, now + 31 * 60000), /STALE/);
  assert.throws(() => verifyMapping({ data: {} }, { entries: [] }, 30, now), /NO_GLUCOSE/);
});

test('storage oracle detects missing, duplicate and corrupted persisted records', () => {
  const source = sourceFactory(sourceConfig(account), fixtureAxios(now));
  const batch = source.transformGlucose(payload(now));
  for (const kind of ['entries', 'treatments', 'devicestatus']) {
    verifyRows(kind, batch[kind], clone(batch[kind]));
    assert.throws(() => verifyRows(kind, batch[kind], []), /MISSING/);
    assert.throws(() => verifyRows(kind, batch[kind], [...batch[kind], batch[kind][0]]), /DUPLICATE/);
  }
  const entries = clone(batch.entries);
  delete entries[0].sensorInfo;
  assert.throws(() => verifyRows('entries', batch.entries, entries), /METADATA_MISMATCH/);
  const statuses = clone(batch.devicestatus);
  statuses[0].librelinkup.patientDevice.lowAlarmThresholdMgDl = 99;
  assert.throws(() => verifyRows('devicestatus', batch.devicestatus, statuses), /METADATA_MISMATCH/);
});
