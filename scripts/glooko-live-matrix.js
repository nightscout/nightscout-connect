#!/usr/bin/env node
'use strict';

// Explicitly opted-in integration runner. Patient records stay in memory and
// in the disposable local database; only aggregate results leave the process.
const fs = require('node:fs');
const { parseEnv } = require('node:util');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const axios = require('axios');
const sourceFactory = require('../lib/sources/glooko');
const restFactory = require('../lib/outputs/nightscout');
const internalFactory = require('../lib/outputs/internal');
const { toGlookoTime } = require('../lib/sources/glooko/timezone');
const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith('--' + name + '='))?.slice(name.length + 3);
const check = (condition, code) => {
  if (!condition) throw Object.assign(new Error(code), { code });
};
const emit = (data) => process.stdout.write(JSON.stringify(data) + '\n');
const copy = (value) => JSON.parse(JSON.stringify(value));
const counts = (batch) =>
  Object.fromEntries(
    ['entries', 'treatments', 'devicestatus', 'profiles'].map((k) => [k, (batch[k] || []).length])
  );

function accountsFrom(text) {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((block) => parseEnv(block.replace(/^\s*#\s*(CONNECT_)/gm, '$1')))
    .filter((e) => e.CONNECT_GLOOKO_EMAIL);
}
function configFrom(e) {
  const v = sourceFactory.validate({
    glookoEmail: e.CONNECT_GLOOKO_EMAIL,
    glookoPassword: e.CONNECT_GLOOKO_PASSWORD,
    glookoEnv: e.CONNECT_GLOOKO_ENV,
    glookoTimezone: e.CONNECT_GLOOKO_TIMEZONE,
    glookoTimezoneOffset: e.CONNECT_GLOOKO_TIMEZONE_OFFSET,
    glookoAuthMode: flag('auth-mode') || 'api',
    glookoDataMode: 'sync',
    glookoImportProfile: true
  });
  check(v.ok, 'INVALID_CONFIGURATION');
  return v.config;
}
async function main() {
  check(args.includes('--live') && flag('env-file'), 'REQUIRES_LIVE_AND_ENV_FILE');
  const accounts = accountsFrom(fs.readFileSync(flag('env-file'), 'utf8'));
  check(accounts.length > 0, 'NO_ACCOUNTS');
  let client, db;
  const endpoint = flag('nightscout');
  const nsRoot = flag('nightscout-root');
  let server;
  let pluginCompleted = false;
  async function stopServer() {
    if (!server) return;
    const child = server;
    server = null;
    if (child.exitCode !== null) return;
    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    });
  }
  async function startServer(account) {
    await stopServer();
    pluginCompleted = false;
    const childEnv = {
      ...process.env,
      PORT: String(new URL(endpoint).port),
      MONGO_CONNECTION: process.env.GLOOKO_TEST_MONGO_URI,
      API_SECRET: process.env.GLOOKO_TEST_API_SECRET,
      INSECURE_USE_HTTP: 'true',
      AUTH_DEFAULT_ROLES: 'readable',
      ENABLE: 'careportal iob cob basal pump cage sage iage',
      CONNECT_SOURCE: '',
      CONNECT_DEBUG: 'false'
    };
    if (account)
      Object.assign(childEnv, account, {
        CONNECT_SOURCE: 'glooko',
        CONNECT_GLOOKO_DATA_MODE: 'sync',
        CONNECT_GLOOKO_AUTH_MODE: flag('auth-mode') || 'api',
        CONNECT_GLOOKO_IMPORT_PROFILE: 'true',
        CONNECT_GLOOKO_SKIP_ENTRIES: 'false',
        ENABLE: childEnv.ENABLE + ' connect'
      });
    server = spawn(process.execPath, [nsRoot + '/lib/server/server.js'], {
      cwd: nsRoot,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', (data) => {
      if (data.toString().includes('INTERNAL PERSISTENCE COMPLETE')) pluginCompleted = true;
    });
    server.stderr.on('data', () => {});
    for (let i = 0; i < 120; i++) {
      check(server.exitCode === null, 'NIGHTSCOUT_EXITED');
      try {
        if (
          (await axios.get(endpoint + '/api/v1/status.json', { timeout: 1000 })).data.status ===
          'ok'
        )
          return;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    throw Object.assign(new Error('NIGHTSCOUT_START_TIMEOUT'), {
      code: 'NIGHTSCOUT_START_TIMEOUT'
    });
  }
  if (endpoint) {
    const url = new URL(endpoint),
      mongo = new URL(process.env.GLOOKO_TEST_MONGO_URI || '');
    check(
      ['127.0.0.1', 'localhost'].includes(url.hostname) && url.protocol === 'http:',
      'LOCAL_NIGHTSCOUT_ONLY'
    );
    check(
      ['127.0.0.1', 'localhost', 'glooko-validation-mongo'].includes(mongo.hostname) &&
        mongo.pathname === '/glooko_validation',
      'DISPOSABLE_DATABASE_ONLY'
    );
    check(nsRoot && process.env.GLOOKO_TEST_API_SECRET, 'REQUIRES_NIGHTSCOUT_ROOT_AND_SECRET');
    const { MongoClient } = require(nsRoot + '/node_modules/mongodb');
    client = new MongoClient(mongo.href);
    await client.connect();
    db = client.db('glooko_validation');
  }
  // Suppress source/storage diagnostics, including third-party error objects.
  console.log = console.warn = console.error = () => {};
  async function clear() {
    if (!db) return;
    for (const name of ['entries', 'treatments', 'devicestatus', 'profile'])
      await db.collection(name).deleteMany({});
    check(
      Object.values(await storedCounts()).every((n) => n === 0),
      'DATABASE_NOT_CLEARED'
    );
  }
  async function storedCounts() {
    const result = {};
    for (const [key, name] of [
      ['entries', 'entries'],
      ['treatments', 'treatments'],
      ['devicestatus', 'devicestatus'],
      ['profiles', 'profile']
    ])
      result[key] = await db.collection(name).countDocuments(name === 'devicestatus'
        ? { device: { $ne: 'nightscout-connect-glooko-sync' } } : {});
    return result;
  }
  async function verify(batch) {
    const actual = await storedCounts(),
      expected = counts(batch);
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw Object.assign(new Error('STORED_COUNTS_MISMATCH'), {
        code: 'STORED_COUNTS_MISMATCH',
        detail: { actual, expected }
      });
    for (const [key, name] of [
      ['entries', 'entries'],
      ['treatments', 'treatments'],
      ['profiles', 'profile']
    ]) {
      const docs = await db.collection(name).find({}).toArray();
      const byId = new Map(docs.map((r) => [r.identifier || r.glookoIdentifier, r]));
      check(byId.size === docs.length, 'DUPLICATE_IDENTIFIERS');
      for (const row of batch[key] || []) {
        const saved = byId.get(row.identifier);
        check(saved, 'MISSING_RECORD');
        if (key === 'profiles')
          check(
            JSON.stringify(saved.store) === JSON.stringify(row.store),
            'PROFILE_SETTINGS_MISMATCH'
          );
        for (const field of [
          'sgv',
          'date',
          'dateString',
          'direction',
          'eventType',
          'created_at',
          'insulin',
          'carbs',
          'absolute',
          'duration',
          'glucose',
          'relative',
          'enteredinsulin'
        ]) {
          if (row[field] !== undefined && row[field] !== 0)
            check(saved[field] === row[field], 'FIELD_MISMATCH_' + field);
          if (field === 'absolute' && row.absolute === 0)
            check(saved.absolute === 0, 'ZERO_BASAL_LOST');
        }
      }
    }
    for (const row of batch.devicestatus || []) {
      const saved = await db
        .collection('devicestatus')
        .findOne({ device: row.device, created_at: row.created_at });
      check(
        saved &&
          saved.pump?.iob?.iob === row.pump?.iob?.iob &&
          saved.pump?.iob?.timestamp === row.pump?.iob?.timestamp,
        'PUMP_IOB_MISMATCH'
      );
    }
    return actual;
  }
  function mergeFrames(first, next) {
    const out = {};
    const window = next.glookoSync?.pumpStateWindow;
    for (const key of ['entries', 'treatments', 'profiles'])
      out[key] = [
        ...new Map(
          [
            ...(first[key] || []).filter(
              (row) =>
                !(
                  key === 'treatments' &&
                  window &&
                  row.glookoPumpState?.accountKey === window.accountKey &&
                  row.created_at >= window.from &&
                  row.created_at < window.to
                )
            ),
            ...(next[key] || [])
          ].map((row) => [row.identifier, row])
        ).values()
      ];
    const latest = Math.max(
      0,
      ...(first.devicestatus || []).map((row) => Date.parse(row.created_at))
    );
    out.devicestatus = [
      ...(first.devicestatus || []),
      ...(next.devicestatus || []).filter((row) => Date.parse(row.created_at) > latest)
    ];
    return out;
  }
  async function seedLegacy(batch) {
    const sample = (batch.treatments || [])
      .filter((r) => r.glookoGuid)
      .slice(0, 2)
      .map((r) => {
        const row = copy(r);
        delete row.identifier;
        delete row.enteredBy;
        return row;
      });
    if (sample.length) await db.collection('treatments').insertMany(sample);
    return sample.map((r) => r._id);
  }
  async function verifyLegacy(ids) {
    check(
      (await db
        .collection('treatments')
        .countDocuments({ _id: { $in: ids }, glookoIdentifier: { $exists: true } })) === ids.length,
      'LEGACY_IDENTITY_LOST'
    );
  }
  function internal() {
    const env = {
      entries_collection: 'entries',
      treatments_collection: 'treatments',
      devicestatus_collection: 'devicestatus'
    };
    const ctx = {
      bus: new EventEmitter(),
      store: db,
      ddata: require(nsRoot + '/lib/data/ddata')()
    };
    ctx.purifier = require(nsRoot + '/lib/server/purifier')(env, ctx);
    for (const name of ['entries', 'treatments', 'devicestatus'])
      ctx[name] = require(nsRoot + '/lib/server/' + name)(env, ctx);
    ctx.profile = require(nsRoot + '/lib/server/profile')('profile', ctx);
    return internalFactory({}, ctx);
  }
  try {
    for (const [index, e] of accounts.entries()) {
      if (flag('account') && Number(flag('account')) !== index + 1) continue;
      await clear();
      const result = {
        account: index + 1,
        region: e.CONNECT_GLOOKO_ENV,
        timezone: e.CONNECT_GLOOKO_TIMEZONE
      };
      try {
        const opts = configFrom(e),
          source = sourceFactory(opts, { create: (c) => axios.create({ ...c, timeout: 30000 }) });
        const session = await source.sessionFromAuth(await source.authFromCredentials());
        const batch = await source.dataFromSesssion(session, null);
        const mapped = source.transformData(batch);
        result.source = batch.diagnostics;
        result.unavailable = Object.entries(batch.diagnostics || {})
          .filter(([, v]) => v.unavailable)
          .map(([key]) => key);
        result.mapped = counts(mapped);
        result.warnings = mapped.glookoSync.warnings;
        check(mapped.entries.length > 0, 'NO_CGM_ENTRIES');
        // Independent graph cross-check of the granular feed's raw value/time.
        const code =
          session.user?.userLogin?.glookoCode || session.userProfile?.currentUser?.glookoCode;
        const graph = (
          await axios.get(opts.baseURL + '/api/v3/graph/data', {
            timeout: 30000,
            headers: { Cookie: session.cookies },
            params: {
              patient: code,
              startDate: toGlookoTime(
                new Date(Date.now() - 2 * 86400000),
                opts.glookoTimezoneOffset,
                opts.glookoTimezone
              ).toISOString(),
              endDate: toGlookoTime(
                new Date(),
                opts.glookoTimezoneOffset,
                opts.glookoTimezone
              ).toISOString(),
              'series[]': ['cgmNormal', 'cgmHigh', 'cgmLow'],
              splitByDay: false
            }
          })
        ).data;
        const raw = new Map(
          (batch.egvs || [])
            .filter((r) => !r.calculated && !r.softDeleted)
            .map((r) => [Date.parse(r.displayTime), r.glucoseValue])
        );
        let matched = 0,
          mismatched = 0;
        for (const point of ['cgmNormal', 'cgmHigh', 'cgmLow']
          .flatMap((k) => graph.series?.[k] || [])
          .filter((r) => !r.calculated)) {
          if (!raw.has(point.x * 1000)) continue;
          if (raw.get(point.x * 1000) === point.value) matched++;
          else mismatched++;
        }
        result.graphParity = { matched, mismatched };
        check(matched > 0 && mismatched === 0, 'GRAPH_PARITY_FAILED');
        if (endpoint) {
          const factory = () =>
            restFactory({ url: endpoint, apiSecret: process.env.GLOOKO_TEST_API_SECRET }, axios);
          await startServer();
          const restLegacy = await seedLegacy(mapped);
          let output = factory();
          await output.gap_for();
          const bookmark = await output(copy(mapped));
          result.rest = await verify(mapped);
          await verifyLegacy(restLegacy);
          result.legacyRest = true;
          result.stage = 'rest-replay';
          await output(copy(mapped));
          await verify(mapped);
          output = factory();
          const restarted = await output.gap_for();
          if (mapped.devicestatus?.length)
            result.restartStatusDeltaMs = restarted.devicestatus
              ? Date.parse(mapped.devicestatus[0].created_at) - restarted.devicestatus.getTime()
              : null;
          result.stage = 'rest-restart';
          await output(copy(mapped));
          await verify(mapped);
          result.restReplayAndRestart = true;
          const incremental = await source.dataFromSesssion(session, bookmark);
          const delta = source.transformData(incremental);
          result.incremental = counts(delta);
          await output(copy(delta));
          await verify(mergeFrames(mapped, delta));
          await clear();
          const internalLegacy = await seedLegacy(mapped);
          output = internal();
          await output(copy(mapped));
          result.internal = await verify(mapped);
          await verifyLegacy(internalLegacy);
          result.legacyInternal = true;
          await output(copy(mapped));
          await verify(mapped);
          output = internal();
          await output(copy(mapped));
          await verify(mapped);
          result.internalReplayAndRestart = true;
          await output(copy(delta));
          await verify(mergeFrames(mapped, delta));
          result.incrementalWrites = true;
          if (args.includes('--plugin-boot')) {
            await stopServer();
            await clear();
            await startServer(e);
            for (let i = 0; i < 480 && !pluginCompleted; i++) {
              check(server.exitCode === null, 'PLUGIN_SERVER_EXITED');
              await new Promise((r) => setTimeout(r, 250));
            }
            check(pluginCompleted, 'PLUGIN_SYNC_TIMEOUT');
            result.plugin = await storedCounts();
            check(result.plugin.entries > 0, 'PLUGIN_NO_ENTRIES');
            const docs = await db.collection('entries').find({}).toArray();
            check(
              new Set(docs.map((r) => r.identifier)).size === docs.length,
              'PLUGIN_DUPLICATE_ENTRIES'
            );
            const previous = new Map(mapped.entries.map((r) => [r.identifier, r]));
            let common = 0;
            for (const row of docs) {
              const p = previous.get(row.identifier);
              if (p) {
                common++;
                check(p.sgv === row.sgv && p.date === row.date, 'PLUGIN_FIELD_MISMATCH');
              }
            }
            check(common > 0, 'PLUGIN_NO_COMMON_RECORDS');
            result.pluginCommonEntries = common;
            await stopServer();
            const beforeRestart = await db
              .collection('treatments')
              .find({}, { projection: { identifier: 1 } })
              .toArray();
            await startServer(e);
            for (let i = 0; i < 480 && !pluginCompleted; i++) {
              check(server.exitCode === null, 'PLUGIN_SERVER_EXITED');
              await new Promise((r) => setTimeout(r, 250));
            }
            check(pluginCompleted, 'PLUGIN_RESTART_TIMEOUT');
            for (const name of ['entries', 'treatments', 'profile']) {
              const persisted = await db
                .collection(name)
                .find({}, { projection: { identifier: 1 } })
                .toArray();
              check(
                new Set(persisted.map((r) => r.identifier)).size === persisted.length,
                'PLUGIN_RESTART_DUPLICATES'
              );
            }
            const statuses = await db
              .collection('devicestatus')
              .find({}, { projection: { created_at: 1 } })
              .toArray();
            check(
              new Set(statuses.map((r) => r.created_at)).size === statuses.length,
              'PLUGIN_RESTART_STATUS_DUPLICATES'
            );
            const afterRestart = new Set(
              (
                await db
                  .collection('treatments')
                  .find({}, { projection: { identifier: 1 } })
                  .toArray()
              ).map((r) => r.identifier)
            );
            check(
              beforeRestart.every((r) => afterRestart.has(r.identifier)),
              'PLUGIN_RESTART_LOST_TREATMENTS'
            );
            result.pluginRestart = true;
          }
        }
        result.ok = true;
        delete result.stage;
      } catch (error) {
        result.ok = false;
        result.error = {
          code: error.code || 'VALIDATION_ERROR',
          status: error.response?.status || error.status || null,
          ...(error.detail ? { detail: error.detail } : {})
        };
        process.exitCode = 1;
      } finally {
        await stopServer();
        await clear();
      }
      if (db) result.databaseCleared = true;
      if (args.includes('--compact')) delete result.source;
      emit(result);
    }
  } finally {
    await stopServer();
    await clear();
    if (client) await client.close();
  }
}
if (require.main === module)
  main().catch((e) => {
    emit({ ok: false, code: e.code || 'RUNNER_ERROR', status: e.response?.status || null });
    process.exitCode = 1;
  });
module.exports = { accountsFrom };
