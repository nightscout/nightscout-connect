'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const nightscoutSource = require('../lib/sources/nightscout');
const internal = require('../lib/outputs/internal');
const nightscoutOutput = require('../lib/outputs/nightscout');

const HOUR = 3600 * 1000;

// The source's first window is now - 2 days by the process clock, as for the
// other collections. Tests that build a site around a fixed `now` freeze the
// clock there, so the result does not depend on the time the suite runs.
function fixClock (t, iso) {
  const now = Date.parse(iso);
  t.mock.timers.enable({ apis: ['Date'], now });
  return now;
}
const DAY = 24 * HOUR;

// A source Nightscout's profile endpoints, as Nightscout 14 and later answer
// them (read from lib/api/profile/index.js, lib/server/profile.js and
// lib/server/query.js, and measured against a lab source):
// - /api/v1/profile.json ignores `find`; newest `count` by startDate, then _id.
// - /api/v1/profiles.json applies `find` (created_at, startDate with $gt,
//   $gte, $lt) and, when the query neither names startDate nor _id, adds
//   startDate >= now - 4 days. `count` defaults to 10.
function profileSite (now, { profilesRoute = true } = {}) {
  const docs = [];
  const calls = [];
  const sort = (a, b) => (b.startDate > a.startDate ? 1 : b.startDate < a.startDate ? -1 : b._id > a._id ? 1 : -1);
  const match = (value, cond) => Object.entries(cond).every(([op, v]) =>
    op === '$gt' ? value > v : op === '$gte' ? value >= v : op === '$lt' ? value < v : false);
  function respond (call) {
    calls.push(call);
    const params = (call.options && call.options.params) || {};
    let data;
    if (call.path === '/api/v1/profile.json') {
      data = docs.slice().sort(sort).slice(0, Number(params.count || 10));
    } else if (call.path === '/api/v1/profiles.json' && profilesRoute) {
      const find = { ...(params.find || {}) };
      if (!find.startDate && !find._id) find.startDate = { $gte: new Date(now() - 4 * DAY).toISOString() };
      data = docs.filter((d) => Object.entries(find).every(([field, cond]) => match(d[field], cond)))
        .sort(sort).slice(0, Number(params.count || 10));
    } else if (/^\/api\/v1\/(entries|treatments|devicestatus)\.json$/.test(call.path)) {
      data = [];
    } else {
      const err = new Error('Request failed with status code 404');
      err.response = { status: 404 };
      return Promise.reject(err);
    }
    data = JSON.parse(JSON.stringify(data));
    call.bytes = JSON.stringify(data).length;
    return Promise.resolve({ data });
  }
  const axios = { create () { return { get: (path, options) => respond({ method: 'get', path, options }), post () { throw new Error('the source is read-only'); } }; } };
  return { docs, calls, axios };
}

let seq = 0;
function syntheticProfile (startMs, createdMs, dia = 5) {
  seq += 1;
  const hex = seq.toString(16).padStart(8, '0');
  const basal = Array.from({ length: 24 }, (_, h) => ({ time: String(h).padStart(2, '0') + ':00', value: 0.8, timeAsSeconds: h * 3600 }));
  return {
    _id: '66f0c0ff' + hex + '00000000',
    defaultProfile: 'Synthetic',
    startDate: new Date(startMs).toISOString(),
    created_at: new Date(createdMs).toISOString(),
    store: { Synthetic: { dia, units: 'mg/dl', basal } }
  };
}

// 500 profiles, one every 20 hours, the newest 20 hours old; created_at is a
// second after startDate, as when each was uploaded at the time it started.
function seededSite (now) {
  const site = profileSite(() => now);
  for (let i = 500; i >= 1; i--) {
    const start = now - i * 20 * HOUR;
    site.docs.push(syntheticProfile(start, start + 1000));
  }
  return site;
}

function sourceFor (site, log) {
  return nightscoutSource({ url: 'https://source.example?token=t', apiSecret: '' }, site.axios, log);
}

const clone = (p) => JSON.parse(JSON.stringify(p));
const profileCalls = (site) => site.calls.filter((c) => /profiles?\.json$/.test(c.path));
const bytes = (calls) => calls.reduce((sum, c) => sum + (c.bytes || 0), 0);

test('source: without a profile bookmark only the profiles for the first window are read', async (t) => {
  const now = fixClock(t, '2026-09-23T12:00:00.000Z');
  const site = seededSite(now);
  const source = sourceFor(site);
  const data = await source.dataFromSesssion({}, null);
  const windowStart = now - 2 * DAY;
  // every profile starting in the last 2 days, and the one in effect when that window starts
  const want = site.docs.filter((d) => Date.parse(d.startDate) >= windowStart);
  want.push(site.docs.filter((d) => Date.parse(d.startDate) < windowStart).pop());
  assert.deepEqual(data.profiles.map((p) => p._id).sort(), want.map((p) => p._id).sort());
  assert.equal(data.profiles.length, 3);
  const calls = profileCalls(site);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.path === '/api/v1/profiles.json' && c.options.params.find.startDate));
  assert.ok(bytes(calls) < JSON.stringify(site.docs).length / 100, 'less than 1% of the source profiles');
});

test('source: with a bookmark a poll reads the profiles changed since it and the newest one', async (t) => {
  const now = fixClock(t, '2026-09-23T12:00:00.000Z');
  const site = seededSite(now);
  const source = sourceFor(site);
  const newest = site.docs[site.docs.length - 1];
  const data = await source.dataFromSesssion({}, { profiles: new Date(newest.created_at) });
  assert.deepEqual(data.profiles.map((p) => p._id), [newest._id]);
  const calls = profileCalls(site);
  assert.deepEqual(calls.map((c) => c.path), ['/api/v1/profiles.json', '/api/v1/profile.json']);
  assert.equal(calls[0].options.params.find.created_at.$gt, newest.created_at);
  assert.equal(calls[1].options.params.count, 1);
  assert.equal(bytes(calls), '[]'.length + JSON.stringify([newest]).length);
});

test('source: a profile saved in the editor is read whatever its startDate', async (t) => {
  const now = fixClock(t, '2026-09-23T12:00:00.000Z');
  const site = seededSite(now);
  const source = sourceFor(site);
  const newest = site.docs[site.docs.length - 1];
  // the editor saves an 80-day-old record: same _id, created_at set to now
  const old = site.docs[400];
  assert.ok(Date.parse(old.startDate) < now - 80 * DAY);
  old.store.Synthetic.dia = 7;
  old.created_at = new Date(now - 60 * 1000).toISOString();
  const data = await source.dataFromSesssion({}, { profiles: new Date(newest.created_at) });
  assert.deepEqual(data.profiles.map((p) => p._id).sort(), [old._id, newest._id].sort());
  assert.equal(data.profiles.find((p) => p._id === old._id).store.Synthetic.dia, 7);
});

test('source: a new profile is read, and a profile both new and newest is returned once', async (t) => {
  const now = fixClock(t, '2026-09-23T12:00:00.000Z');
  const site = seededSite(now);
  const source = sourceFor(site);
  const bookmark = site.docs[site.docs.length - 1].created_at;
  const added = syntheticProfile(now - HOUR, now - HOUR);
  site.docs.push(added);
  const data = await source.dataFromSesssion({}, { profiles: bookmark });
  assert.deepEqual(data.profiles.map((p) => p._id), [added._id]);
});

test('source: a source without /api/v1/profiles is read as before, and said once', async (t) => {
  const now = fixClock(t, '2026-09-23T12:00:00.000Z');
  const site = profileSite(() => now, { profilesRoute: false });
  site.docs.push(syntheticProfile(now - DAY, now - DAY));
  const warnings = [];
  const log = { debug () {}, error () {}, warn (m) { warnings.push(m); } };
  const source = sourceFor(site, log);
  for (let i = 0; i < 3; i++) {
    const data = await source.dataFromSesssion({}, i ? { profiles: new Date(now - DAY) } : null);
    assert.equal(data.profiles.length, 1);
  }
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /https?:|token/);
  const calls = profileCalls(site);
  // the first poll's two first-window reads, and none after
  assert.equal(calls.filter((c) => c.path === '/api/v1/profiles.json').length, 2, 'not retried every poll');
  assert.deepEqual(calls.filter((c) => c.path === '/api/v1/profile.json').map((c) => c.options.params.count), [1000, 1000, 1000]);
});

test('source: other read failures still fail the poll', async () => {
  const axios = { create () { return { get (path) {
    if (path === '/api/v1/profiles.json') { const err = new Error('Request failed with status code 500'); err.response = { status: 500 }; return Promise.reject(err); }
    return Promise.resolve({ data: [] });
  } }; } };
  const source = nightscoutSource({ url: 'https://source.example?token=t', apiSecret: '' }, axios);
  await assert.rejects(source.dataFromSesssion({}, null), /500/);
});

function internalSink (stored = []) {
  const bus = new EventEmitter();
  const rows = stored.map((d) => ({ ...d }));
  const ctx = { bus };
  for (const c of ['entries', 'treatments', 'devicestatus']) {
    ctx[c] = { create (items, cb) { cb(null, items); }, list (...args) { args.find((a) => typeof a === 'function')(null, []); }, remove (p, cb) { cb(null, []); } };
  }
  ctx.profile = {
    create (items, cb) {
      for (const d of items) if (rows.some((r) => String(r._id) === String(d._id))) { const e = new Error('E11000'); e.code = 11000; return cb(e); }
      items.forEach((d) => rows.push({ ...d }));
      cb(null, items);
    },
    list (cb, count) { cb(null, rows.slice(0, count)); }
  };
  return { rows, output: internal({}, ctx), close () { bus.removeAllListeners(); } };
}

test('internal output: the profile bookmark is the newest created_at stored or handled', async (t) => {
  t.mock.method(console, 'error', () => {});
  const now = fixClock(t, '2026-09-23T12:00:00.000Z');
  const stored = [syntheticProfile(now - 3 * DAY, now - 3 * DAY), syntheticProfile(now - 2 * DAY, now - 2 * DAY)];
  const sink = internalSink(stored);
  try {
    // after a restart: every row already stored, the bookmark comes from storage
    let known = await sink.output({ profiles: [JSON.parse(JSON.stringify(stored[0]))] });
    assert.equal(known.profiles.toISOString(), stored[1].created_at);
    // a row that is skipped still moves it forward
    const edited = { ...stored[0], created_at: new Date(now - HOUR).toISOString() };
    known = await sink.output({ profiles: [edited] });
    assert.equal(known.profiles.toISOString(), edited.created_at);
    assert.equal(sink.rows.length, 2);
    // a new row is stored and moves it forward
    const added = syntheticProfile(now, now);
    known = await sink.output({ profiles: [added] });
    assert.equal(known.profiles.toISOString(), added.created_at);
    assert.equal(sink.rows.length, 3);
    // no profiles: unchanged
    known = await sink.output({ profiles: [] });
    assert.equal(known.profiles.toISOString(), added.created_at);
  } finally { sink.close(); }
});

test('internal output: a failed profile write does not move the bookmark', async (t) => {
  t.mock.method(console, 'error', () => {});
  const now = fixClock(t, '2026-09-23T12:00:00.000Z');
  const first = syntheticProfile(now - DAY, now - DAY);
  const sink = internalSink([first]);
  try {
    await sink.output({ profiles: [JSON.parse(JSON.stringify(first))] });
    const later = syntheticProfile(now, now);
    // another writer stores it between the check and the insert
    sink.rows.push({ ...later });
    await assert.rejects(sink.output({ profiles: [later] }), /Nightscout internal write failed/);
    const known = await sink.output.gap_for();
    assert.equal(known.profiles.toISOString(), first.created_at);
  } finally { sink.close(); }
});

test('REST output: the profile bookmark moves over profiles already stored', async (t) => {
  const now = fixClock(t, '2026-09-23T12:00:00.000Z');
  const stored = syntheticProfile(now - DAY, now - DAY);
  const posts = [];
  const axios = { create () { return {
    get (path) { return Promise.resolve({ data: path === '/api/v1/profile.json' ? [stored] : [] }); },
    post (path, body) { posts.push(path); return Promise.resolve({ data: body }); },
    delete () { return Promise.resolve({ data: {} }); }
  }; } };
  const output = nightscoutOutput({ url: 'https://sink.example', apiSecret: 'lab-secret' }, axios);
  const edited = { ...stored, created_at: new Date(now - HOUR).toISOString() };
  const bookmark = await output({ profiles: [edited] });
  assert.equal(bookmark.profiles.toISOString(), edited.created_at);
  assert.deepEqual(posts, []);
});

test('REST output: the profile bookmark does not move back when a poll brings an older profile', async (t) => {
  const now = fixClock(t, '2026-09-23T12:00:00.000Z');
  const newestByStart = syntheticProfile(now - DAY, now - DAY);
  const savedLater = syntheticProfile(now - 80 * DAY, now - HOUR);
  const axios = { create () { return {
    get (path) { return Promise.resolve({ data: path === '/api/v1/profile.json' ? [newestByStart] : [] }); },
    post (path, body) { return Promise.resolve({ data: body }); },
    delete () { return Promise.resolve({ data: {} }); }
  }; } };
  const output = nightscoutOutput({ url: 'https://sink.example', apiSecret: 'lab-secret' }, axios);
  await output.gap_for();
  let bookmark = await output({ profiles: [clone(savedLater), clone(newestByStart)] });
  assert.equal(bookmark.profiles.toISOString(), savedLater.created_at);
  // the next poll hands back only the newest by startDate, created earlier
  bookmark = await output({ profiles: [clone(newestByStart)] });
  assert.equal(bookmark.profiles.toISOString(), savedLater.created_at);
});

test('source and internal output: a fresh sink gets the first-window profiles, then only changes', async (t) => {
  t.mock.method(console, 'error', () => {});
  const now = fixClock(t, '2026-09-23T12:00:00.000Z');
  const site = seededSite(now);
  const source = sourceFor(site);
  const sink = internalSink();
  try {
    let known = await sink.output.gap_for();
    known = await sink.output(await source.dataFromSesssion({}, known));
    assert.equal(sink.rows.length, 3);
    const firstBytes = bytes(profileCalls(site));
    site.calls.length = 0;
    for (let i = 0; i < 3; i++) known = await sink.output(await source.dataFromSesssion({}, known));
    assert.equal(sink.rows.length, 3);
    const perPoll = bytes(profileCalls(site)) / 3;
    assert.equal(perPoll, '[]'.length + JSON.stringify([site.docs[site.docs.length - 1]]).length, 'one profile per poll');
    assert.ok(firstBytes < JSON.stringify(site.docs).length / 100);
    // an editor save of an old profile is read once
    site.calls.length = 0;
    site.docs[100].created_at = new Date(now + 60 * 1000).toISOString();
    const data = await source.dataFromSesssion({}, known);
    assert.ok(data.profiles.some((p) => p._id === site.docs[100]._id));
    known = await sink.output(data);
    site.calls.length = 0;
    const next = await source.dataFromSesssion({}, known);
    assert.deepEqual(next.profiles.map((p) => p._id), [site.docs[site.docs.length - 1]._id]);
  } finally { sink.close(); }
});
