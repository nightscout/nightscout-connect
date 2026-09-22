#!/usr/bin/env node

// One read-only Glooko cycle. Never sends data to Nightscout or prints payloads.
const axios = require('axios');
const glookoSource = require('../lib/sources/glooko');
const { summarizeBatch } = require('./glooko-live-probe-summary');

const args = process.argv.slice(2);
const live = args.includes('--live');
const modeArg = args.find((arg) => arg.startsWith('--auth-mode='));
const authMode = modeArg ? modeArg.slice('--auth-mode='.length) : process.env.CONNECT_GLOOKO_AUTH_MODE || 'api';

if (!live || !['api', 'v3', 'web', 'auto'].includes(authMode)) {
  process.stderr.write('Read-only live Glooko probe. Use --live [--auth-mode=api|v3|web|auto] with an env file.\n');
  process.exitCode = 2;
} else {
  run().catch((error) => {
    process.stderr.write(JSON.stringify({
      ok: false,
      stage: error.stage || 'unknown',
      httpStatus: error.response && error.response.status || null,
      code: error.code || null
    }) + '\n');
    process.exitCode = 1;
  });
}

function patientCodeFor (session) {
  const user = session && session.user;
  const profile = session && session.userProfile;
  return user && (user.userLogin && user.userLogin.glookoCode || user.user && user.user.glookoCode)
    || profile && (profile.currentUser && profile.currentUser.glookoCode
      || profile.currentPatient && profile.currentPatient.glookoCode);
}

async function run () {
  const input = {
    glookoEnv: process.env.CONNECT_GLOOKO_ENV,
    glookoServer: process.env.CONNECT_GLOOKO_SERVER,
    glookoWebOrigin: process.env.CONNECT_GLOOKO_WEB_ORIGIN,
    glookoEmail: process.env.CONNECT_GLOOKO_EMAIL,
    glookoPassword: process.env.CONNECT_GLOOKO_PASSWORD,
    glookoTimezone: process.env.CONNECT_GLOOKO_TIMEZONE,
    glookoTimezoneOffset: process.env.CONNECT_GLOOKO_TIMEZONE_OFFSET,
    glookoDeviceId: process.env.CONNECT_GLOOKO_DEVICE_ID,
    glookoSerialNumber: process.env.CONNECT_GLOOKO_SERIAL_NUMBER,
    glookoUseV3Graph: process.env.CONNECT_GLOOKO_USE_V3_GRAPH,
    glookoSkipEntries: process.env.CONNECT_GLOOKO_SKIP_ENTRIES,
    glookoAuthMode: authMode
    , glookoDataMode: process.env.CONNECT_GLOOKO_DATA_MODE
    , glookoLookbackDays: process.env.CONNECT_GLOOKO_LOOKBACK_DAYS
    , glookoImportProfile: process.env.CONNECT_GLOOKO_IMPORT_PROFILE
  };
  const validated = glookoSource.validate(input);
  if (!validated.ok) {
    const error = new Error('Invalid Glooko configuration');
    error.stage = 'configuration';
    throw error;
  }

  const transport = {
    create (config) {
      return axios.create({ ...config, timeout: 20000 });
    }
  };
  const source = glookoSource(validated.config, transport);
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  let stage = 'authentication';
  try {
    const auth = await source.authFromCredentials();
    stage = 'session';
    const session = await source.sessionFromAuth(auth);
    if (!patientCodeFor(session)) {
      const error = new Error('Patient code unavailable');
      error.stage = 'patient-code';
      throw error;
    }

    stage = 'fetch';
    const batch = await source.dataFromSesssion(session, null);
    stage = 'transform';
    const transformed = source.transformData(batch);
    process.stdout.write(JSON.stringify({
      ok: true,
      authMode,
      patientCodeResolved: true,
      ...summarizeBatch(batch, transformed)
    }) + '\n');
  } catch (error) {
    error.stage = error.stage || stage;
    throw error;
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}
