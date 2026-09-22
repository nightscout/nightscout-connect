'use strict';

const { parseEnv } = require('node:util');
const crypto = require('node:crypto');
const source = require('../../lib/sources/librelinkup');
const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { labCode: code }); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const collections = ['entries', 'treatments', 'devicestatus'];

function safeFailure(error) {
  let code = error.labCode || 'VALIDATION_FAILED';
  const message = typeof error.message === 'string' ? error.message : '';
  if (message === 'NO MATCHING LIBRE LINKUP PATIENT ID AVAILABLE') code = 'PATIENT_ID_NOT_FOUND';
  else if (message === 'NO CONNECTION WITH LIBRE LINKUP AVAILABLE') code = 'NO_CONNECTIONS';
  else if (message.startsWith('LibreLinkUp login returned no auth ticket')) code = 'NO_AUTH_TICKET';
  else if (message.startsWith('LibreLinkUp account action required')) code = 'ACCOUNT_ACTION_REQUIRED';
  else if (message.startsWith('LibreLinkUp login could not follow region')) code = 'REGION_REDIRECT_FAILED';
  const networkCodes = ['ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNABORTED', 'ECONNRESET', 'ECONNREFUSED',
    'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'EPROTO'];
  return { code, status: Number.isInteger(error.status) ? error.status : null,
    ...(networkCodes.includes(error.code) ? { networkCode: error.code } : {}) };
}

function accountsFrom(text) {
  const env = parseEnv(text);
  const ids = (env.LLU_TEST_ACCOUNTS || '').split(',').map(x => x.trim());
  check(ids.length > 0 && ids.every(id => /^[a-z][a-z0-9]{0,15}$/.test(id) && !['fixture', 'mongo', 'runner'].includes(id)), 'INVALID_ACCOUNT_ALIASES');
  check(new Set(ids).size === ids.length && ids.length <= 13, 'DUPLICATE_OR_TOO_MANY_ACCOUNTS');
  return ids.map((id, index) => {
    const get = key => env[`LLU_${id.toUpperCase()}_${key}`];
    const units = get('UNITS') || 'mmol';
    check(['mmol', 'mg/dl'].includes(units), 'INVALID_DISPLAY_UNITS');
    const maxAge = Number(get('MAX_AGE_MINUTES') || 30);
    check(Number.isFinite(maxAge) && maxAge >= 1 && maxAge <= 1440, 'INVALID_MAX_AGE');
    const region = get('REGION') || 'EU';
    const timezone = get('TIMEZONE') || 'UTC';
    const validation = source.validate({ linkUpUsername: get('USERNAME') || 'placeholder',
      linkUpPassword: get('PASSWORD') || 'placeholder', linkUpRegion: region, connectTimezone: timezone });
    check(validation.ok, 'INVALID_REGION_OR_TIMEZONE');
    return { id, port: 1350 + index, units, maxAge, region, timezone, endpoint: validation.config.baseURL,
      username: get('USERNAME'), password: get('PASSWORD'), patientId: get('PATIENT_ID'),
      sensorInfo: get('SENSOR_INFO') !== 'false', stealthTls: get('STEALTH_TLS') === 'true' };
  });
}

function sourceConfig(account) {
  check(account.username && account.password, 'MISSING_CREDENTIALS');
  const result = source.validate({ linkUpUsername: account.username, linkUpPassword: account.password,
    linkUpRegion: account.region, connectTimezone: account.timezone, linkUpPatientId: account.patientId,
    linkUpSensorInfo: account.sensorInfo, linkUpStealthTls: account.stealthTls,
    linkUpProxy: 'direct', linkUpAutoAcceptTerms: false, linkUpMaxRetries: 0 });
  check(result.ok, 'INVALID_SOURCE_CONFIGURATION');
  return result.config;
}

// Independent timestamp oracle: zone-less factory times describe UTC, including
// the US-formatted strings returned by the v4 service. Do not call the source parser.
function rawTime(value) {
  if (typeof value !== 'string') return NaN;
  if (/(?:z|[+-]\d{2}:?\d{2})$/i.test(value)) return Date.parse(value);
  const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(value);
  if (iso) return Date.UTC(+iso[1], +iso[2] - 1, +iso[3], +iso[4], +iso[5], +iso[6], +(iso[7] || '').padEnd(3, '0').slice(0, 3));
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4}),? (\d{1,2}):(\d{2}):(\d{2})(?: (AM|PM))?$/i.exec(value);
  if (us) return Date.UTC(+us[3], +us[1] - 1, +us[2], us[7] ? (+us[4] % 12) + (us[7].toUpperCase() === 'PM' ? 12 : 0) : +us[4], +us[5], +us[6]);
  return NaN;
}

function verifyMapping(payload, batch, maxAge, now = Date.now()) {
  const data = payload.data || {};
  const current = data.connection?.glucoseMeasurement || data.connection?.glucoseItem;
  const raw = [...(Array.isArray(data.graphData) ? data.graphData : []), ...(current ? [current] : [])];
  const expected = raw.filter(Boolean).map(row => ({ date: rawTime(row.FactoryTimestamp || row.Timestamp),
    sgv: typeof row.ValueInMgPerDl === 'number' ? row.ValueInMgPerDl : row.Value,
    direction: ['NOT COMPUTABLE', 'SingleDown', 'FortyFiveDown', 'Flat', 'FortyFiveUp', 'SingleUp'][row.TrendArrow] || 'NOT COMPUTABLE'
  })).filter(row => Number.isFinite(row.date) && Number.isFinite(row.sgv));
  check(expected.length > 0, 'NO_GLUCOSE_READINGS');
  check(batch.entries.length === expected.length, 'MAPPED_COUNT_MISMATCH');
  expected.forEach((row, i) => {
    const actual = batch.entries[i];
    check(actual.date === row.date && actual.dateString === new Date(row.date).toISOString() &&
      actual.sgv === row.sgv && actual.direction === row.direction && actual.type === 'sgv', 'RAW_MAPPING_MISMATCH');
  });
  const age = (now - Math.max(...expected.map(row => row.date))) / 60000;
  check(age >= -5 && age <= maxAge, 'STALE_OR_FUTURE_GLUCOSE');
  return { readings: expected.length, currentReadingPresent: !!current, freshnessPassed: true };
}

function key(kind, row) {
  return kind === 'entries' ? `${row.device}:${row.date}` : kind === 'treatments'
    ? `${row.enteredBy}:${row.eventType}:${row.created_at}` : `${row.device}:${row.created_at}`;
}
function mergeBatch(first, next) {
  return Object.fromEntries(collections.map(kind => [kind,
    [...new Map([...(first[kind] || []), ...(next[kind] || [])].map(row => [key(kind, row), row])).values()]]));
}

function verifyRows(kind, expected, saved) {
  const byKey = new Map(saved.map(row => [key(kind, row), row]));
  check(byKey.size === saved.length, 'DUPLICATE_' + kind.toUpperCase());
  for (const row of expected) {
    const actual = byKey.get(key(kind, row));
    check(actual, 'MISSING_' + kind.toUpperCase());
    for (const field of ['date', 'sgv', 'direction', 'type', 'eventType', 'enteredBy', 'identifier', 'notes']) {
      if (row[field] !== undefined) check(actual[field] === row[field], 'STORED_FIELD_MISMATCH_' + field);
    }
    for (const field of ['dateString', 'created_at']) {
      if (row[field]) check(Date.parse(actual[field]) === Date.parse(row[field]), 'STORED_TIME_MISMATCH');
    }
    for (const field of ['sensorInfo', 'librelinkup']) {
      if (row[field]) check(require('node:util').isDeepStrictEqual(actual[field], row[field]), 'STORED_METADATA_MISMATCH_' + field);
    }
  }
}
module.exports = { accountsFrom, sourceConfig, verifyMapping, rawTime, verifyRows, mergeBatch, safeFailure,
  key, check, hash, clone, collections };
