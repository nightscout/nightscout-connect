'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const internal = require('../lib/outputs/internal');
const nightscoutOutput = require('../lib/outputs/nightscout');
const sync = require('../lib/outputs/profile-sync');

// Nightscout's profile storage, keyed the way MongoDB keys _id: the 24-hex
// string and the ObjectId with the same hex are two different values.
//
// 'unfixed' is dev 1f9a9d10 and 15.0.8 (read from lib/server/profile.js and
// lib/server/query.js there; BF-99): create stores the _id as given, so a
// copied profile keeps a string _id; save upserts the ObjectId form; find by
// _id matches only the ObjectId form.
// 'fixed' is bf/profile-object-id 9b8cc2f9: create stores a hex string as the
// ObjectId unless that string is already stored; save upserts the ObjectId
// form and removes the string form; find by _id matches both.
function profileStorage (variant) {
  const docs = [];
  const calls = { save: 0, find: 0 };
  const hex = (id) => String(id).toLowerCase();
  const has = (type, id) => docs.some((d) => d.type === type && d.hex === hex(id));
  let failSave = false;
  return {
    docs,
    calls,
    setFailSave (v) { failSave = v; },
    forms (id) { return docs.filter((d) => d.hex === hex(id)).map((d) => d.type).sort(); },
    doc (id) { return docs.find((d) => d.hex === hex(id) && d.type === 'oid') || docs.find((d) => d.hex === hex(id)); },
    seed (p, type) { docs.push({ type, hex: hex(p._id), body: JSON.parse(JSON.stringify(p)) }); },
    create (items) {
      for (const p of items) {
        let type = typeof p._id === 'string' ? 'string' : 'oid';
        if (variant === 'fixed' && type === 'string' && /^[0-9a-f]{24}$/i.test(p._id) && !has('string', p._id)) type = 'oid';
        if (has(type, p._id)) { const err = new Error('E11000 duplicate key'); err.code = 11000; throw err; }
        docs.push({ type, hex: hex(p._id), body: JSON.parse(JSON.stringify(p)) });
      }
      return items;
    },
    save (p) {
      calls.save++;
      if (failSave) { const err = new Error('connection refused'); err.code = 'ECONNREFUSED'; throw err; }
      const body = JSON.parse(JSON.stringify(p));
      const i = docs.findIndex((d) => d.type === 'oid' && d.hex === hex(p._id));
      if (i >= 0) docs[i].body = body; else docs.push({ type: 'oid', hex: hex(p._id), body });
      if (variant === 'fixed') {
        for (let k = docs.length - 1; k >= 0; k--) if (docs[k].type === 'string' && docs[k].hex === hex(p._id)) docs.splice(k, 1);
      }
      return p;
    },
    findById (id) {
      calls.find++;
      return docs.filter((d) => d.hex === hex(id) && (variant === 'fixed' || d.type === 'oid')).map((d) => ({ ...d.body, _id: d.hex }));
    },
    list (count) { return docs.slice(0, count || docs.length).map((d) => ({ ...d.body, _id: d.hex })); }
  };
}

function internalSink (store, logger) {
  const bus = new EventEmitter();
  const ctx = { bus };
  for (const c of ['entries', 'treatments', 'devicestatus']) {
    ctx[c] = { create (items, cb) { cb(null, items); }, list (...args) { args.find((a) => typeof a === 'function')(null, []); }, remove (p, cb) { cb(null, []); } };
  }
  const wrap = (fn) => { try { return [null, fn()]; } catch (err) { return [err]; } };
  ctx.profile = {
    create (items, cb) { const [err, r] = wrap(() => store.create(items)); cb(err, r); },
    save (obj, cb) { const [err, r] = wrap(() => store.save(obj)); cb(err, r); },
    list (cb, count) { cb(null, store.list(count)); },
    list_query (opts, cb) { cb(null, store.findById(opts.find._id)); }
  };
  return { output: internal({ logger }, ctx), close () { bus.removeAllListeners(); } };
}

function restSink (store, logger) {
  const fail = (status) => { const err = new Error('Request failed with status code ' + status); err.response = { status }; return Promise.reject(err); };
  const axios = { create () { return {
    get (path, options) {
      const params = options.params || {};
      if (path === '/api/v1/profile.json') return Promise.resolve({ data: store.list(params.count) });
      if (path === '/api/v1/profiles.json') return Promise.resolve({ data: store.findById(params.find._id) });
      return Promise.resolve({ data: [] });
    },
    post (path, body) {
      if (path !== '/api/v1/profile.json') return Promise.resolve({ data: body });
      try { return Promise.resolve({ data: store.create(body) }); } catch (err) { return fail(500); }
    },
    put (path, body) {
      assert.equal(path, '/api/v1/profile.json');
      try { return Promise.resolve({ data: store.save(body) }); } catch (err) { return fail(500); }
    },
    delete () { return Promise.resolve({ data: {} }); }
  }; } };
  return { output: nightscoutOutput({ url: 'https://sink.example', apiSecret: 'lab-secret', logger }, axios), close () {} };
}

const SOURCE = {
  _id: '66f0c0ffee0000000000abcd',
  defaultProfile: 'Synthetic',
  startDate: '2026-09-21T00:00:00.000Z',
  created_at: '2026-09-21T00:00:01.000Z',
  store: { Synthetic: { dia: 5, units: 'mg/dl', basal: [{ time: '00:00', value: 0.8, timeAsSeconds: 0 }] } }
};
const clone = (p) => JSON.parse(JSON.stringify(p));
const edited = (p, dia, created_at) => {
  const e = clone(p);
  e.store.Synthetic.dia = dia;
  if (created_at) e.created_at = created_at;
  return e;
};
const logger = () => {
  const warnings = [];
  return { warnings, debug () {}, error () {}, warn (m) { warnings.push(m); } };
};

for (const [name, sink] of [['internal', internalSink], ['REST', restSink]]) {
  test(name + ' output, fixed Nightscout: an edit replaces a profile stored with a string _id, leaving one', async () => {
    const store = profileStorage('fixed');
    store.seed(SOURCE, 'string'); // copied by an earlier connector before the fix
    const log = logger();
    const s = sink(store, log);
    try {
      // API-style PUT on the source: content changed, created_at not
      await s.output({ profiles: [edited(SOURCE, 6)] });
      assert.deepEqual(store.forms(SOURCE._id), ['oid']);
      assert.equal(store.doc(SOURCE._id).body.store.Synthetic.dia, 6);
      // editor-style save: created_at set
      await s.output({ profiles: [edited(SOURCE, 7, '2026-09-23T10:00:00.000Z')] });
      assert.deepEqual(store.forms(SOURCE._id), ['oid']);
      assert.equal(store.doc(SOURCE._id).body.store.Synthetic.dia, 7);
      assert.equal(store.doc(SOURCE._id).body.created_at, '2026-09-23T10:00:00.000Z');
      assert.equal(store.calls.save, 2);
      assert.deepEqual(log.warnings, []);
    } finally { s.close(); }
  });

  test(name + ' output, fixed Nightscout: a profile first copied there is stored as ObjectId and later edits replace it', async () => {
    const store = profileStorage('fixed');
    const s = sink(store, logger());
    try {
      await s.output({ profiles: [clone(SOURCE)] });
      assert.deepEqual(store.forms(SOURCE._id), ['oid']);
      await s.output({ profiles: [edited(SOURCE, 6)] });
      assert.deepEqual(store.forms(SOURCE._id), ['oid']);
      assert.equal(store.doc(SOURCE._id).body.store.Synthetic.dia, 6);
    } finally { s.close(); }
  });

  test(name + ' output, unfixed Nightscout: an edit to a string-_id profile is not copied, adds no twin, and is said once', async () => {
    const store = profileStorage('unfixed');
    const log = logger();
    const s = sink(store, log);
    try {
      await s.output({ profiles: [clone(SOURCE)] });
      assert.deepEqual(store.forms(SOURCE._id), ['string']);
      for (const dia of [6, 6, 7]) await s.output({ profiles: [edited(SOURCE, dia)] });
      assert.deepEqual(store.forms(SOURCE._id), ['string'], 'no ObjectId twin');
      assert.equal(store.doc(SOURCE._id).body.store.Synthetic.dia, 5);
      assert.equal(store.calls.save, 0);
      // each new version is checked once: dia 6, then dia 7
      assert.equal(store.calls.find, 2);
      assert.equal(log.warnings.length, 1);
      assert.match(log.warnings[0], /not copied/);
      assert.doesNotMatch(log.warnings[0], /abcd|https?:|secret/i);
    } finally { s.close(); }
  });

  test(name + ' output, unfixed Nightscout: a profile stored with an ObjectId _id is replaced in place', async () => {
    const store = profileStorage('unfixed');
    store.seed(SOURCE, 'oid');
    const s = sink(store, logger());
    try {
      await s.output({ profiles: [edited(SOURCE, 6)] });
      assert.deepEqual(store.forms(SOURCE._id), ['oid']);
      assert.equal(store.doc(SOURCE._id).body.store.Synthetic.dia, 6);
    } finally { s.close(); }
  });

  test(name + ' output: an unchanged profile is neither checked nor saved, also after a restart', async () => {
    const store = profileStorage('fixed');
    store.seed(SOURCE, 'string');
    for (let restart = 0; restart < 2; restart++) {
      const s = sink(store, logger());
      try {
        for (let i = 0; i < 3; i++) await s.output({ profiles: [clone(SOURCE)] });
      } finally { s.close(); }
    }
    assert.deepEqual(store.calls, { save: 0, find: 0 });
    assert.deepEqual(store.forms(SOURCE._id), ['string']);
  });

  test(name + ' output: a failed replace fails the poll, and the next poll replaces it', async (t) => {
    t.mock.method(console, 'error', () => {});
    const store = profileStorage('fixed');
    store.seed(SOURCE, 'oid');
    const s = sink(store, logger());
    try {
      await s.output({ profiles: [clone(SOURCE)] });
      store.setFailSave(true);
      await assert.rejects(s.output({ profiles: [edited(SOURCE, 6)] }), /Nightscout (internal )?write failed/);
      store.setFailSave(false);
      await s.output({ profiles: [edited(SOURCE, 6)] });
      assert.equal(store.doc(SOURCE._id).body.store.Synthetic.dia, 6);
      assert.deepEqual(store.forms(SOURCE._id), ['oid']);
    } finally { s.close(); }
  });

  test(name + ' output: a Glooko profile matched by identifier is still skipped, not replaced', async () => {
    const store = profileStorage('fixed');
    const glooko = { identifier: 'glooko:profile:1', defaultProfile: 'Glooko', startDate: '2026-09-21T00:00:00.000Z', created_at: '2026-09-21T00:00:00.000Z', store: { Glooko: { dia: 4 } } };
    const s = sink(store, logger());
    try {
      await s.output({ profiles: [clone(glooko)] });
      await s.output({ profiles: [{ ...glooko, store: { Glooko: { dia: 5 } } }] });
      assert.equal(store.calls.save, 0);
      assert.equal(store.calls.find, 0);
    } finally { s.close(); }
  });
}

test('profile fingerprint ignores server-added fields and key order, not content or created_at', () => {
  const a = clone(SOURCE);
  const b = { srvModified: 1, created_at: a.created_at, store: a.store, startDate: a.startDate, defaultProfile: a.defaultProfile, _id: 'other', srvCreated: 2 };
  assert.equal(sync.fingerprint(a), sync.fingerprint(b));
  assert.notEqual(sync.fingerprint(a), sync.fingerprint(edited(SOURCE, 6)));
  assert.notEqual(sync.fingerprint(a), sync.fingerprint({ ...a, created_at: '2026-09-23T00:00:00.000Z' }));
  // a nested field named like a server field is content
  assert.notEqual(sync.fingerprint(a), sync.fingerprint({ ...a, store: { Synthetic: { ...a.store.Synthetic, srvModified: 1 } } }));
});
