const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const internal = require('../lib/outputs/internal');
const nightscoutOutput = require('../lib/outputs/nightscout');

// A Nightscout source serves every profile, with its _id, on every poll.
// Nightscout's profile storage inserts (insertMany), so storing the same _id a
// second time fails with MongoDB's duplicate-key error.
function duplicateKeyError (id) {
  const err = new Error('E11000 duplicate key error collection: nightscout.profile index: _id_ dup key: { _id: "' + id + '" }');
  err.code = 11000;
  return err;
}

function profileStore () {
  const rows = [];
  let down = false;
  return {
    rows,
    setDown (value) { down = value; },
    insert (docs) {
      if (down) {
        const err = new Error('connection refused');
        err.code = 'ECONNREFUSED';
        throw err;
      }
      // ordered insertMany: stop at the first duplicate
      for (const doc of docs) {
        if (doc._id && rows.some((row) => String(row._id) === String(doc._id))) throw duplicateKeyError(doc._id);
        rows.push({ ...doc });
      }
      return docs;
    },
    list (count) {
      if (down) {
        const err = new Error('connection refused');
        err.code = 'ECONNREFUSED';
        throw err;
      }
      return rows.slice(0, count || rows.length).map((row) => ({ ...row }));
    }
  };
}

function internalCtx (store) {
  const bus = new EventEmitter();
  const ctx = { bus };
  for (const collection of ['entries', 'treatments', 'devicestatus']) {
    ctx[collection] = {
      create (items, callback) { callback(null, items); },
      list (...args) { args.find((arg) => typeof arg === 'function')(null, []); },
      remove (params, callback) { callback(null, []); }
    };
  }
  ctx.profile = {
    creates: 0,
    create (items, callback) {
      ctx.profile.creates++;
      try { callback(null, store.insert(items)); } catch (err) { callback(err); }
    },
    list (callback, count) {
      try { callback(null, store.list(count)); } catch (err) { callback(err); }
    }
  };
  return ctx;
}

function httpTransport (store) {
  const calls = [];
  const fail = (status, code) => {
    const err = new Error('Request failed with status code ' + status);
    err.code = code;
    err.response = { status, data: { status, message: 'Mongo Error' } };
    return Promise.reject(err);
  };
  return {
    calls,
    create () {
      return {
        get (path, options) {
          calls.push({ method: 'get', path, options });
          if (path === '/api/v1/profile.json') {
            try { return Promise.resolve({ data: store.list(options && options.params && options.params.count) }); } catch (err) { return fail(500, err.code); }
          }
          return Promise.resolve({ data: [] });
        },
        post (path, body, options) {
          calls.push({ method: 'post', path, body, options });
          if (path === '/api/v1/profile.json') {
            // Nightscout answers a failed profile insert with HTTP 500 'Mongo Error'.
            try { return Promise.resolve({ data: store.insert(body) }); } catch (err) { return fail(500, 'ERR_BAD_RESPONSE'); }
          }
          return Promise.resolve({ data: body });
        },
        delete () { return Promise.resolve({ data: {} }); }
      };
    }
  };
}

const SOURCE_PROFILE = {
  _id: '66f0c0ffee0000000000abcd',
  defaultProfile: 'Default',
  startDate: '2026-09-21T00:00:00.000Z',
  created_at: '2026-09-21T00:00:00.000Z',
  store: { Default: { dia: 4, units: 'mg/dl' } }
};
const NEW_PROFILE = {
  _id: '66f0c0ffee0000000000beef',
  defaultProfile: 'Default',
  startDate: '2026-09-22T00:00:00.000Z',
  created_at: '2026-09-22T00:00:00.000Z',
  store: { Default: { dia: 5, units: 'mg/dl' } }
};
const poll = (...profiles) => ({
  entries: [{ dateString: '2026-09-23T00:00:00.000Z', sgv: 120 }],
  profiles: profiles.map((p) => JSON.parse(JSON.stringify(p)))
});

function outputs () {
  return [
    ['internal', (store) => {
      const ctx = internalCtx(store);
      return { output: internal({}, ctx), close () { ctx.bus.removeAllListeners(); }, writes: () => ctx.profile.creates };
    }],
    ['nightscout', (store) => {
      const transport = httpTransport(store);
      return {
        output: nightscoutOutput({ url: 'https://sink.example.test', apiSecret: 'lab-secret' }, transport),
        close () {},
        writes: () => transport.calls.filter((c) => c.method === 'post' && c.path === '/api/v1/profile.json').length
      };
    }]
  ];
}

for (const [name, make] of outputs()) {
  test(name + ' output: a second poll carrying an already-stored source profile succeeds', async (t) => {
    t.mock.method(console, 'error', () => {});
    const store = profileStore();
    const sink = make(store);
    try {
      await sink.output(poll(SOURCE_PROFILE));
      await sink.output(poll(SOURCE_PROFILE));
      await sink.output(poll(SOURCE_PROFILE));
      assert.equal(store.rows.length, 1);
      assert.equal(sink.writes(), 1);
    } finally { sink.close(); }
  });

  test(name + ' output: an already-stored profile is skipped after a restart too', async (t) => {
    t.mock.method(console, 'error', () => {});
    const store = profileStore();
    store.insert([JSON.parse(JSON.stringify(SOURCE_PROFILE))]);
    const sink = make(store);
    try {
      await sink.output(poll(SOURCE_PROFILE));
      assert.equal(store.rows.length, 1);
      assert.equal(sink.writes(), 0);
    } finally { sink.close(); }
  });

  test(name + ' output: a new source profile is still stored next to a known one', async (t) => {
    t.mock.method(console, 'error', () => {});
    const store = profileStore();
    const sink = make(store);
    try {
      await sink.output(poll(SOURCE_PROFILE));
      await sink.output(poll(NEW_PROFILE, SOURCE_PROFILE));
      assert.deepEqual(store.rows.map((p) => p._id).sort(), [SOURCE_PROFILE._id, NEW_PROFILE._id].sort());
    } finally { sink.close(); }
  });

  test(name + ' output: a source edit to a stored profile (same _id) does not overwrite the sink copy', async (t) => {
    t.mock.method(console, 'error', () => {});
    const store = profileStore();
    const sink = make(store);
    try {
      await sink.output(poll(SOURCE_PROFILE));
      const edited = { ...SOURCE_PROFILE, store: { Default: { dia: 6, units: 'mg/dl' } } };
      await sink.output(poll(edited));
      assert.equal(store.rows.length, 1);
      assert.equal(store.rows[0].store.Default.dia, 4);
    } finally { sink.close(); }
  });

  test(name + ' output: a profile write that really fails still fails the poll', async (t) => {
    t.mock.method(console, 'error', () => {});
    const store = profileStore();
    const sink = make(store);
    try {
      await sink.output(poll(SOURCE_PROFILE));
      store.setDown(true);
      await assert.rejects(sink.output(poll(NEW_PROFILE, SOURCE_PROFILE)), /Nightscout (internal )?write failed/);
      store.setDown(false);
      // not recorded as stored: the next poll writes it
      await sink.output(poll(NEW_PROFILE, SOURCE_PROFILE));
      assert.deepEqual(store.rows.map((p) => p._id).sort(), [SOURCE_PROFILE._id, NEW_PROFILE._id].sort());
    } finally { sink.close(); }
  });

  test(name + ' output: a duplicate-key failure the connector did not predict still fails the poll', async (t) => {
    t.mock.method(console, 'error', () => {});
    const store = profileStore();
    const sink = make(store);
    try {
      await sink.output(poll(SOURCE_PROFILE));
      // another writer stores the new profile between the connector's check and its insert
      const insert = store.insert;
      store.insert = (docs) => { insert([JSON.parse(JSON.stringify(NEW_PROFILE))]); store.insert = insert; return insert(docs); };
      await assert.rejects(sink.output(poll(NEW_PROFILE, SOURCE_PROFILE)), /Nightscout (internal )?write failed/);
      // after a failed profile write the connector re-reads what is stored, so the next poll recovers
      await sink.output(poll(NEW_PROFILE, SOURCE_PROFILE));
      assert.equal(store.rows.length, 2);
    } finally { sink.close(); }
  });
}
