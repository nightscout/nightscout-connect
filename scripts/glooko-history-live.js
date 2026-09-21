#!/usr/bin/env node
'use strict';

// Opt-in, disposable-local-only validation. Never prints credentials or records.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const axios = require('axios');
const { accountsFrom } = require('./glooko-live-matrix');
const sourceFactory = require('../lib/sources/glooko');
const restFactory = require('../lib/outputs/nightscout');
const { DEVICE } = require('../lib/outputs/glooko-checkpoint');
const args = process.argv.slice(2);
const flag = (name) =>
  args.find((a) => a.startsWith('--' + name + '='))?.slice(name.length + 3);
const emit = (row) => process.stdout.write(JSON.stringify(row) + '\n');
const copy = (row) => JSON.parse(JSON.stringify(row));
async function main() {
  assert(
    args.includes('--live') && args.includes('--replace-local-data'),
    'EXPLICIT_LOCAL_OPT_IN_REQUIRED'
  );
  const endpoint = new URL(flag('nightscout'));
  const mongo = new URL(process.env.GLOOKO_TEST_MONGO_URI);
  assert(
    endpoint.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(endpoint.hostname),
    'LOCAL_ONLY'
  );
  assert(
    ['localhost', '127.0.0.1', 'glooko-validation-mongo'].includes(mongo.hostname) &&
      mongo.pathname === '/glooko_validation',
    'DISPOSABLE_DATABASE_ONLY'
  );
  assert(
    process.env.GLOOKO_TEST_API_SECRET && flag('nightscout-root'),
    'TEST_CONFIGURATION_REQUIRED'
  );
  const account = Number(flag('account'));
  assert(Number.isInteger(account) && account > 0, 'ACCOUNT_REQUIRED');
  const e = accountsFrom(fs.readFileSync(flag('env-file'), 'utf8'))[account - 1];
  assert(e, 'ACCOUNT_MISSING');
  const days = Number(flag('days') || 14);
  assert(Number.isInteger(days) && days > 2 && days <= 90, 'EXPANSION_DAYS_3_TO_90');
  const initialDays = Number(flag('initial-days') || 2);
  assert([2, days].includes(initialDays), 'INITIAL_DAYS_MUST_BE_TWO_OR_TARGET');
  console.log = console.warn = console.error = () => {};
  function source(lookback) {
    const v = sourceFactory.validate({
      glookoEmail: e.CONNECT_GLOOKO_EMAIL,
      glookoPassword: e.CONNECT_GLOOKO_PASSWORD,
      glookoEnv: e.CONNECT_GLOOKO_ENV,
      glookoTimezone: e.CONNECT_GLOOKO_TIMEZONE,
      glookoTimezoneOffset: e.CONNECT_GLOOKO_TIMEZONE_OFFSET,
      glookoAuthMode: 'api',
      glookoDataMode: 'sync',
      glookoImportProfile: true,
      glookoLookbackDays: lookback
    });
    assert(v.ok, 'INVALID_CONFIGURATION');
    return sourceFactory(v.config, {
      create: (c) => axios.create({ ...c, timeout: 30000 })
    });
  }
  const makeOutput = () =>
    restFactory(
      { url: endpoint.href, apiSecret: process.env.GLOOKO_TEST_API_SECRET },
      axios
    );
  const initialSource = source(initialDays);
  const session = await initialSource.sessionFromAuth(
    await initialSource.authFromCredentials()
  );
  // Fetch before removing the existing browser snapshot.
  const initial = initialSource.transformData(
    await initialSource.dataFromSesssion(session, null)
  );
  assert(initial.entries.length > 0, 'NO_CURRENT_GLUCOSE');
  const { MongoClient } = require(flag('nightscout-root') + '/node_modules/mongodb');
  const client = new MongoClient(mongo.href);
  await client.connect();
  const db = client.db('glooko_validation');
  const names = ['entries', 'treatments', 'devicestatus', 'profile'];
  const clear = async () => {
    for (const name of names) await db.collection(name).deleteMany({});
  };
  let successful = false;
  try {
    await clear();
    let output = makeOutput();
    let saved = await output(copy(initial));
    const expected = new Map(initial.entries.map((r) => [r.identifier, r]));
    const owner = initial.glookoSync.state.owner;
    assert.equal(saved.glookoSyncStates[owner].cgmHistory.days, initialDays);
    const expandedSource = source(days);
    let cycles = 0;
    for (; cycles < 100; cycles++) {
      // Simulate a process restart before every batch. Recovery must come from
      // the stored checkpoint, not a retained closure or the latest CGM date.
      output = makeOutput();
      const restored = await output.gap_for();
      assert.deepEqual(
        restored.glookoSyncStates[owner],
        saved.glookoSyncStates[owner],
        'CHECKPOINT_RESTORE_MISMATCH'
      );
      const frame = expandedSource.transformData(
        await expandedSource.dataFromSesssion(session, restored)
      );
      for (const row of frame.entries) expected.set(row.identifier, row);
      saved = await output(copy(frame));
      const beforeReplay = await db.collection('entries').countDocuments();
      await output(copy(frame));
      assert.equal(
        await db.collection('entries').countDocuments(),
        beforeReplay,
        'REPLAY_DUPLICATES'
      );
      assert.equal(
        await db.collection('devicestatus').countDocuments({ device: DEVICE }),
        1,
        'CHECKPOINT_NOT_BOUNDED'
      );
      const progress = saved.glookoSyncStates[owner].cgmHistory;
      emit({
        account,
        cycle: cycles + 1,
        requestedDays: days,
        entriesStored: beforeReplay,
        historyComplete: progress.complete,
        restarted: true,
        replayVerified: true
      });
      if (progress.complete) break;
    }
    assert(cycles < 100, 'HISTORY_NOT_COMPLETE');
    const actual = await db.collection('entries').find({}).toArray();
    assert.equal(actual.length, expected.size, 'COUNT_MISMATCH');
    for (const row of actual) {
      const wanted = expected.get(row.identifier);
      assert(
        wanted && row.date === wanted.date && row.sgv === wanted.sgv,
        'GLUCOSE_READBACK_MISMATCH'
      );
    }
    // A completed backfill must now use its incremental cursor.
    const incremental = expandedSource.transformData(
      await expandedSource.dataFromSesssion(session, saved)
    );
    await output(copy(incremental));
    const counts = {};
    for (const name of names)
      counts[name] = await db
        .collection(name)
        .countDocuments(name === 'devicestatus' ? { device: { $ne: DEVICE } } : {});
    const dates = actual.map((r) => r.date);
    assert(Math.min(...dates) < Date.now() - 2 * 86400000, 'NO_OLDER_GLUCOSE');
    successful = true;
    emit({
      ok: true,
      account,
      requestedDays: days,
      counts,
      incrementalEntries: incremental.entries.length,
      checkpoints: 1,
      oldestGlucoseAgeDays: Number(
        ((Date.now() - Math.min(...dates)) / 86400000).toFixed(2)
      ),
      latestGlucoseAgeMinutes: Math.round((Date.now() - Math.max(...dates)) / 60000),
      retainedForBrowser: args.includes('--keep')
    });
  } finally {
    if (!successful || !args.includes('--keep')) await clear();
    await client.close();
  }
}
if (require.main === module)
  main().catch((err) => {
    emit({
      ok: false,
      code: err.code || 'HISTORY_VALIDATION_FAILED',
      status: err.response?.status || err.status || null
    });
    process.exitCode = 1;
  });
