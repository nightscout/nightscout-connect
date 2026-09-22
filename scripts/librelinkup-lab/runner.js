#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const axios = require('axios');
const sourceFactory = require('../../lib/sources/librelinkup');
const restFactory = require('../../lib/outputs/nightscout');
const internalFactory = require('../../lib/outputs/internal');
const { accountsFrom, sourceConfig, verifyMapping, verifyRows, mergeBatch, check, hash, clone, collections } = require('./common');
const { fixtureAxios, payload: fixturePayload } = require('./fixture');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const endpoint = 'http://127.0.0.1:1347';
const nsRoot = '/opt/app';
const device = 'nightscout-connect-librelinkup';
const filter = kind => kind === 'treatments' ? { enteredBy: 'librelinkup' } : { device };
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');

async function main(args) {
  const flag = name => args.find(a => a.startsWith('--' + name + '='))?.slice(name.length + 3);
  const fixture = args.includes('--fixture');
  check(fixture !== args.includes('--live'), 'REQUIRES_EXACTLY_ONE_OF_FIXTURE_OR_LIVE');
  check(fixture || flag('env-file'), 'REQUIRES_ENV_FILE');
  check(!args.includes('--probe') || !fixture, 'PROBE_REQUIRES_LIVE');
  check(process.env.LLU_LAB_SECRET && fs.existsSync(nsRoot + '/lib/server/server.js'), 'RUN_INSIDE_LOCAL_LAB');
  let accounts = fixture ? [{ id: 'fixture', username: 'synthetic', password: 'synthetic',
    region: 'EU2', timezone: 'UTC', sensorInfo: true, maxAge: 30 }] : accountsFrom(fs.readFileSync(flag('env-file'), 'utf8'));
  check(!flag('account') || accounts.some(a => a.id === flag('account')), 'UNKNOWN_ACCOUNT_ALIAS');
  accounts = accounts.filter(a => flag('account') ? a.id === flag('account') : a.username || a.password);
  check(accounts.length, 'NO_CONFIGURED_ACCOUNTS');
  // Account/source/storage diagnostics can include medical records or credentials.
  // Never forward exception messages, stacks, headers, child logs or raw payloads.
  console.log = console.warn = console.error = () => {};
  const { MongoClient } = require(nsRoot + '/node_modules/mongodb');
  const client = new MongoClient('mongodb://mongo:27017', { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  let server, pluginCompleted;
  async function stopServer() {
    if (!server) return;
    const child = server;
    server = null;
    if (child.exitCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  }
  async function startServer(dbName, pluginNow) {
    await stopServer();
    pluginCompleted = false;
    const env = { ...process.env, PORT: '1347', MONGO_CONNECTION: `mongodb://mongo:27017/${dbName}`,
      API_SECRET: process.env.LLU_LAB_SECRET, INSECURE_USE_HTTP: 'true', AUTH_DEFAULT_ROLES: 'readable',
      ENABLE: 'careportal sage', CONNECT_SOURCE: '', CONNECT_DEBUG: 'false', TZ: 'UTC' };
    const argv = [];
    if (pluginNow) {
      check(fixture, 'PLUGIN_PRELOAD_IS_SYNTHETIC_ONLY');
      Object.assign(env, { ENABLE: env.ENABLE + ' connect', CONNECT_SOURCE: 'linkup',
        CONNECT_LINK_UP_USERNAME: 'synthetic', CONNECT_LINK_UP_PASSWORD: 'synthetic',
        CONNECT_LINK_UP_REGION: 'EU2', CONNECT_LINK_UP_SENSOR_INFO: 'true',
        LLU_FIXTURE_NOW: String(pluginNow) });
      argv.push('--require', path.join(__dirname, 'preload.js'));
    }
    server = spawn(process.execPath, [...argv, nsRoot + '/lib/server/server.js'], {
      cwd: nsRoot, env, stdio: ['ignore', 'pipe', 'pipe']
    });
    // A streaming tail avoids missing a marker split between stdout chunks.
    let tail = '';
    server.stdout.on('data', data => {
      tail = (tail + data.toString()).slice(-8192);
      if (tail.includes('INTERNAL PERSISTENCE COMPLETE')) pluginCompleted = true;
    });
    server.stderr.on('data', () => {});
    server.on('error', () => {});
    for (let i = 0; i < 240; i++) {
      check(server.exitCode === null, 'NIGHTSCOUT_EXITED');
      try {
        if ((await axios.get(endpoint + '/api/v1/status.json', { timeout: 1000, proxy: false })).data.status === 'ok') return;
      } catch {}
      await sleep(250);
    }
    check(false, 'NIGHTSCOUT_START_TIMEOUT');
  }
  function internal(db) {
    const env = { entries_collection: 'entries', treatments_collection: 'treatments', devicestatus_collection: 'devicestatus' };
    const ctx = { bus: new EventEmitter(), store: db, ddata: require(nsRoot + '/lib/data/ddata')() };
    ctx.purifier = require(nsRoot + '/lib/server/purifier')(env, ctx);
    for (const name of collections) ctx[name] = require(nsRoot + '/lib/server/' + name)(env, ctx);
    ctx.profile = require(nsRoot + '/lib/server/profile')('profile', ctx);
    return internalFactory({}, ctx);
  }
  async function rows(db) {
    return Object.fromEntries(await Promise.all(collections.map(async kind => [kind,
      await db.collection(kind).find(filter(kind)).toArray()])));
  }
  async function verify(db, expected) {
    const saved = await rows(db);
    for (const kind of collections) {
      verifyRows(kind, expected[kind] || [], saved[kind]);
      check(saved[kind].length === (expected[kind] || []).length, 'STORED_COUNT_MISMATCH_' + kind);
    }
    return Object.fromEntries(collections.map(kind => [kind, saved[kind].length]));
  }
  async function bind(db, owner) {
    const existing = await db.collection('lab_owner').findOne({ _id: 'owner' });
    check(!existing || existing.hash === owner, 'ACCOUNT_CHANGED_USE_NEW_ALIAS');
    if (!existing) await db.collection('lab_owner').insertOne({ _id: 'owner', hash: owner });
  }
  const reports = [];
  try {
    for (const account of accounts) {
      const result = { account: account.id, mode: fixture ? 'synthetic' : 'live', requestedRegion: account.region,
        stage: 'configuration', ok: false };
      try {
        const config = sourceConfig(account);
        result.requestedHost = new URL(config.baseURL).hostname;
        const now = Math.floor(Date.now() / 60000) * 60000 - 60000;
        const transport = fixture ? fixtureAxios(now) : { create(options) {
          result.resolvedHost = new URL(options.baseURL).hostname;
          const http = axios.create(options);
          // The normal source permits the first patient. A test lab must not
          // silently select a patient from a multi-patient follower account.
          http.interceptors.response.use(response => {
            if (response.config.url === '/llu/connections' && Array.isArray(response.data?.data)) {
              result.connectionCount = response.data.data.length;
            }
            return response;
          });
          return http;
        } };
        const source = sourceFactory(config, transport);
        result.stage = 'login';
        const auth = await source.authFromCredentials();
        result.stage = 'patient-selection';
        const session = await source.sessionFromAuth(auth);
        if (!fixture) result.regionRedirected = result.resolvedHost !== result.requestedHost;
        check(account.patientId || result.connectionCount <= 1 || fixture, 'PATIENT_SELECTION_REQUIRED');
        result.stage = 'graph';
        const payload = await source.dataFromSesssion(session);
        const batch = source.transformGlucose(payload);
        result.stage = 'raw-mapping-and-freshness';
        result.mapping = verifyMapping(payload, batch, account.maxAge);
        result.metadata = { enabled: account.sensorInfo, entriesMatched: batch.entries.filter(r => r.sensorInfo?.serialNumber).length,
          entriesUnavailable: batch.entries.filter(r => r.sensorInfo?.error).length,
          sensorStartPresent: batch.treatments.length > 0, statusPresent: batch.devicestatus.length > 0 };
        if (!args.includes('--probe')) {
          const owner = hash(session.accountId + ':' + session.patientId);
          for (const mode of ['rest', 'internal']) {
            const dbName = `librelinkup_validation_${account.id}${mode === 'rest' ? '_rest' : ''}`;
            const db = client.db(dbName);
            // Only the dedicated synthetic databases are disposable. Live
            // snapshots persist across runs, container restarts and lab stop.
            if (fixture) await db.dropDatabase();
            await bind(db, owner);
            let expected = mergeBatch(await rows(db), batch);
            result.stage = mode + '-write';
            let factory;
            if (mode === 'rest') {
              await startServer(dbName);
              factory = () => restFactory({ url: endpoint, apiSecret: process.env.LLU_LAB_SECRET }, axios);
              if (fixture) {
                const bad = restFactory({ url: endpoint, apiSecret: 'deliberately-incorrect-local-secret' }, axios);
                let rejected = false;
                try { await bad(clone(batch)); } catch (error) { rejected = error.status === 401 || error.status === 403; }
                check(rejected, 'UNAUTHORIZED_WRITE_NOT_REJECTED');
                await verify(db, { entries: [], treatments: [], devicestatus: [] });
              }
            } else factory = () => internal(db);
            let output = factory();
            await output.gap_for();
            await output(clone(batch));
            result[mode] = await verify(db, expected);
            result.stage = mode + '-replay';
            await output(clone(batch));
            await verify(db, expected);
            result.stage = mode + '-restart';
            if (mode === 'rest') await startServer(dbName);
            output = factory();
            await output.gap_for();
            await output(clone(batch));
            await verify(db, expected);
            result[mode + 'ReplayAndRestart'] = true;
            if (fixture) {
              // Overlapping history + a newer current value must append exactly
              // one reading/status, while preserving the Sensor Start event.
              const next = source.transformGlucose(fixturePayload(now, true));
              verifyMapping(fixturePayload(now, true), next, 30);
              expected = mergeBatch(expected, next);
              await output(clone(next));
              await verify(db, expected);
              result[mode + 'Incremental'] = true;
            }
            await stopServer();
          }
          if (fixture) {
            const dbName = 'librelinkup_validation_fixture_plugin';
            const db = client.db(dbName);
            await db.dropDatabase();
            for (const pass of ['boot', 'restart']) {
              result.stage = 'embedded-plugin-' + pass;
              await startServer(dbName, now);
              for (let i = 0; i < 480 && !pluginCompleted; i++) {
                check(server.exitCode === null, 'PLUGIN_EXITED');
                await sleep(250);
              }
              check(pluginCompleted, 'PLUGIN_SYNC_TIMEOUT');
              await verify(db, mergeBatch({}, batch));
              await stopServer();
            }
            result.embeddedPluginBootAndRestart = true;
          }
        }
        result.ok = true;
        delete result.stage;
      } catch (error) {
        // Only internally owned codes and numeric status may leave the runner.
        result.error = { code: error.labCode || 'VALIDATION_FAILED',
          status: Number.isInteger(error.status) ? error.status : null };
        process.exitCode = 1;
      } finally { await stopServer(); }
      reports.push(result);
      emit(result);
    }
  } finally { await stopServer(); await client.close(); }
  const report = { recordedAt: new Date().toISOString(), manualReview: 'pending', results: reports };
  fs.writeFileSync(`/lab-results/${Date.now()}-${fixture ? 'synthetic' : 'live'}.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
}
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  emit({ ok: false, error: error.labCode || 'LAB_FAILED' });
  process.exitCode = 1;
});
