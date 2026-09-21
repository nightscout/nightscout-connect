'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { collect, fetchPages, RESOURCES } = require('../lib/sources/glooko/sync');
const { transform } = require('../lib/sources/glooko/map');
const checkpoints = require('../lib/outputs/glooko-checkpoint');
const restOutput = require('../lib/outputs/nightscout');
const internalOutput = require('../lib/outputs/internal');
const now = new Date('2026-07-01T12:00:00Z');
const opts = {
  glookoEmail: 'synthetic@example.test',
  baseURL: 'https://example.test',
  glookoTimezone: 'UTC'
};
const session = { user: { userLogin: { glookoCode: 'synthetic' } } };
const emptyGraph = () => ({
  series: { cgmHigh: [], cgmNormal: [], cgmLow: [] }
});
function fakeFeed(total = 2501) {
  const calls = [];
  const get = async (path, params) => {
    calls.push({ path, params });
    if (path.includes('/graph/')) return emptyGraph();
    const [key, , property = key] = RESOURCES.find((r) => r[1] === path);
    if (key !== 'egvs')
      return {
        [property]: [],
        lastPage: true,
        lastUpdatedAt: now.toISOString(),
        lastGuid: key
      };
    const start = params.lastGuid.startsWith('egv-')
      ? Number(params.lastGuid.slice(4))
      : 0;
    const recent = Date.parse(params.startDate) >= now - 2 * 86400000 && start === 0;
    const end = Math.min(total, start + 500);
    const egvs = recent
      ? [
          {
            guid: 'recent',
            displayTime: now.toISOString(),
            glucoseValue: 12000
          }
        ]
      : Array.from({ length: end - start }, (_, i) => ({
          guid: 'row-' + (start + i),
          displayTime: new Date(now - 14 * 86400000 + (start + i) * 300000).toISOString(),
          glucoseValue: 12000
        }));
    return {
      egvs,
      lastPage: recent || end === total,
      lastUpdatedAt: now.toISOString(),
      lastGuid: 'egv-' + (recent ? total : end)
    };
  };
  return { calls, get };
}
const bookmark = (batch) => ({
  glookoSyncStates: { [batch.glookoSyncState.owner]: batch.glookoSyncState }
});

test('historical CGM yields four pages, includes recent data, and resumes without moving the pump-state window', async () => {
  const feed = fakeFeed();
  const first = await collect(feed.get, session, opts, {}, now);
  assert.equal(first.diagnostics.egvs.pages, 4);
  assert.equal(first.glookoSyncState.cgmHistory.complete, false);
  assert.equal(first.glookoCursors.egvs.lastGuid, 'egv-2000');
  assert.equal(first.egvs.length, 2001);
  assert(first.egvs.some((r) => r.guid === 'recent'));
  assert.equal(first.glookoGraphWindow.start, '2026-06-29T00:00:00.000Z');
  const second = await collect(feed.get, session, opts, bookmark(first), now);
  assert.equal(second.egvs.length, 501);
  assert.equal(second.glookoSyncState.cgmHistory.complete, true);
  assert.equal(second.glookoCursors.egvs.lastGuid, 'egv-2501');
  const third = await collect(feed.get, session, opts, bookmark(second), now);
  assert.equal(third.egvs.length, 0);
  assert.equal(third.diagnostics.egvs.pages, 1);
  assert.equal(
    transform(first, opts).glookoSync.state.owner,
    first.glookoSyncState.owner
  );
});

test('lookback changes backfill the new window and account/timezone changes isolate cursors', async () => {
  const feed = fakeFeed(1);
  const first = await collect(
    feed.get,
    session,
    { ...opts, glookoLookbackDays: 2 },
    {},
    now
  );
  for (const days of [14, 90]) {
    const expanded = await collect(
      feed.get,
      session,
      { ...opts, glookoLookbackDays: days },
      bookmark(first),
      now
    );
    assert.equal(
      expanded.glookoSyncState.cgmHistory.floor,
      new Date(now - days * 86400000).toISOString()
    );
    assert.equal(expanded.glookoSyncState.cgmHistory.days, days);
    const reduced = await collect(
      feed.get,
      session,
      { ...opts, glookoLookbackDays: 1 },
      bookmark(expanded),
      now
    );
    assert.equal(reduced.glookoSyncState.cgmHistory.days, 1);
    const increasedAgain = await collect(
      feed.get,
      session,
      { ...opts, glookoLookbackDays: days },
      bookmark(reduced),
      now
    );
    assert.equal(increasedAgain.glookoSyncState.cgmHistory.days, days);
    assert.equal(
      increasedAgain.glookoSyncState.cgmHistory.floor,
      new Date(now - days * 86400000).toISOString()
    );
  }
  for (const changed of [
    { glookoEmail: 'other@example.test' },
    { glookoTimezone: 'Europe/Rome' }
  ]) {
    const isolated = await collect(
      feed.get,
      session,
      { ...opts, ...changed },
      bookmark(first),
      now
    );
    assert.notEqual(isolated.glookoSyncState.owner, first.glookoSyncState.owner);
    assert.equal(isolated.glookoSyncState.cgmHistory.days, 14);
  }
});

test('skip entries makes no CGM or historical graph requests and preserves existing history', async () => {
  const feed = fakeFeed(1);
  const first = await collect(feed.get, session, opts, {}, now);
  feed.calls.length = 0;
  const skipped = await collect(
    feed.get,
    session,
    { ...opts, glookoSkipEntries: true },
    bookmark(first),
    now
  );
  assert(
    !feed.calls.some(
      (c) => c.path.endsWith('/egvs') || c.params['series[]']?.includes('cgmNormal')
    )
  );
  assert.deepEqual(skipped.glookoSyncState.cgmHistory, first.glookoSyncState.cgmHistory);
});

test('failed history pages do not mutate the committed checkpoint', async () => {
  const feed = fakeFeed();
  const first = await collect(feed.get, session, opts, {}, now);
  const saved = bookmark(first),
    original = JSON.stringify(saved);
  await assert.rejects(
    collect(
      async (path, p) => {
        if (path.endsWith('/egvs'))
          throw Object.assign(new Error('synthetic'), {
            response: { status: 500 }
          });
        return feed.get(path, p);
      },
      session,
      opts,
      saved,
      now
    )
  );
  assert.equal(JSON.stringify(saved), original);
});

test('bounded pagination still rejects stalled cursors instead of acknowledging incomplete data', async () => {
  await assert.rejects(
    fetchPages(
      async () => ({
        rows: [{ guid: 'a' }],
        lastPage: false,
        lastGuid: 'same',
        lastUpdatedAt: now.toISOString()
      }),
      '/x',
      'rows',
      { limit: 500, lastGuid: 'same', lastUpdatedAt: now.toISOString() },
      4,
      true
    ),
    /PAGINATION_STALLED/
  );
});

test('graph-only historical fallback walks two-day slices independently and resumes to completion', async () => {
  const feed = fakeFeed(0),
    calls = [];
  const get = async (path, p) => {
    if (path.endsWith('/egvs'))
      throw Object.assign(new Error('unavailable'), {
        response: { status: 404 }
      });
    if (path.includes('/graph/') && p['series[]'].length === 3) {
      calls.push(p);
      return {
        series: {
          cgmHigh: [],
          cgmLow: [],
          cgmNormal: [{ timestamp: p.startDate, value: 12000 }]
        }
      };
    }
    return feed.get(path, p);
  };
  let saved = {},
    last;
  for (let i = 0; i < 7; i++) {
    last = await collect(get, session, opts, saved, now);
    assert.equal(transform(last, opts).entries.length, 1);
    saved = bookmark(last);
    assert.equal(last.glookoGraphWindow.start, '2026-06-29T00:00:00.000Z');
  }
  assert.equal(last.glookoSyncState.cgmHistory.complete, true);
  assert.equal(calls.length, 7);
  assert.equal(calls[6].startDate, '2026-06-17T12:00:00.000Z');
  await collect(get, session, opts, saved, now);
  assert.equal(calls.length, 7);
  for (const p of calls)
    assert(Date.parse(p.endDate) - Date.parse(p.startDate) <= 2 * 86400000);
});

test('malformed historical graph never acknowledges completed history', async () => {
  const feed = fakeFeed(0);
  await assert.rejects(
    collect(
      async (path, p) => {
        if (path.endsWith('/egvs'))
          throw Object.assign(new Error('unavailable'), {
            response: { status: 422 }
          });
        if (p['series[]']?.length === 3) return { series: {} };
        return feed.get(path, p);
      },
      session,
      opts,
      {},
      now
    ),
    /INVALID_RESPONSE_SHAPE/
  );
});

function checkpointStore() {
  let docs = [],
    id = 0;
  const list = async ({ find }) =>
    docs
      .filter(
        (d) =>
          d.device === find.device &&
          (!find['glookoSyncState.owner'] ||
            d.glookoSyncState.owner === find['glookoSyncState.owner'])
      )
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const create = async (rows) => {
    docs.push(...structuredClone(rows).map((r) => ({ ...r, _id: String(++id) })));
    return rows;
  };
  const remove = async ({ find }) => {
    assert.equal(find.device, checkpoints.DEVICE);
    assert.match(find['glookoSyncState.owner'], /^[a-f0-9]{64}$/);
    docs = docs.filter(
      (d) =>
        !(
          d.device === find.device &&
          d.glookoSyncState.owner === find['glookoSyncState.owner'] &&
          find._id.$in.includes(d._id)
        )
    );
  };
  return { list, create, remove, docs: () => docs };
}
test('durable checkpoints survive restart, deduplicate replay and isolate other owners', async () => {
  const store = checkpointStore();
  const a = {
    version: 1,
    owner: 'a'.repeat(64),
    cursors: { egvs: { lastGuid: 'one' } }
  };
  const b = { ...a, owner: 'b'.repeat(64) };
  await checkpoints.save(a, store.list, store.create, store.remove);
  await checkpoints.save(b, store.list, store.create, store.remove);
  await checkpoints.save(a, store.list, store.create, store.remove);
  assert.equal(store.docs().length, 2);
  const next = { ...a, cursors: { egvs: { lastGuid: 'two' } } };
  await checkpoints.save(next, store.list, store.create, store.remove);
  assert.equal(store.docs().length, 2);
  const loaded = await checkpoints.load(store.list);
  assert.deepEqual(loaded[a.owner], next);
  assert.deepEqual(loaded[b.owner], b);
  assert(store.docs().every((d) => !d.pump && !d.insulin && !d.openaps));
  await assert.rejects(
    checkpoints.save({ ...a, owner: 'bad' }, store.list, store.create, store.remove),
    /INVALID_CHECKPOINT/
  );
  await assert.rejects(
    checkpoints.load(async () => Array(100).fill({})),
    /CHECKPOINT_LIMIT/
  );
});

test('REST checkpoint loading retries after a temporary read failure', async () => {
  let fail = true,
    reads = 0;
  const output = restOutput(
    { url: 'http://localhost', apiSecret: 'synthetic' },
    {
      create: () => ({
        get: async (path, { params }) => {
          if (params.find?.device === checkpoints.DEVICE) {
            reads++;
            if (fail) throw new Error('temporary failure');
          }
          return { data: [] };
        }
      })
    }
  );
  await assert.rejects(output.gap_for());
  fail = false;
  assert.deepEqual((await output.gap_for()).glookoSyncStates, {});
  assert.equal(reads, 2);
});

test('checkpoint cleanup failure retains the new checkpoint and is recoverable on retry', async () => {
  const store = checkpointStore();
  const first = {
    version: 1,
    owner: 'a'.repeat(64),
    cursors: { egvs: { lastGuid: 'one' } }
  };
  const next = { ...first, cursors: { egvs: { lastGuid: 'two' } } };
  await checkpoints.save(first, store.list, store.create, store.remove);
  await assert.rejects(
    checkpoints.save(next, store.list, store.create, async () => {
      throw new Error('temporary failure');
    })
  );
  assert.equal(store.docs().length, 2);
  assert.deepEqual((await checkpoints.load(store.list))[next.owner], next);
  await checkpoints.save(next, store.list, store.create, store.remove);
  assert.equal(store.docs().length, 1);
});

for (const kind of ['REST', 'internal'])
  test(
    kind + ' checkpoints follow successful writes and restore on output restart',
    async () => {
      const store = checkpointStore();
      let failWrites = false,
        failCheckpoint = false;
      const state = {
        version: 1,
        owner: 'c'.repeat(64),
        cursors: { egvs: { lastGuid: 'one' } }
      };
      function output() {
        if (kind === 'REST')
          return restOutput(
            { url: 'http://localhost', apiSecret: 'synthetic' },
            {
              create: () => ({
                get: async (path, { params }) => ({
                  data:
                    params.find?.device === checkpoints.DEVICE
                      ? await store.list(params)
                      : []
                }),
                post: async (path, rows) => {
                  if (rows[0]?.device === checkpoints.DEVICE) {
                    if (failCheckpoint) throw new Error('synthetic');
                    await store.create(rows);
                  } else if (failWrites) throw new Error('synthetic');
                  return { data: rows };
                },
                delete: async (path, { params }) => store.remove(params)
              })
            }
          );
        const ctx = { bus: new EventEmitter() };
        for (const name of ['entries', 'treatments', 'profile', 'devicestatus'])
          ctx[name] = {
            create: (rows, cb) => {
              if (rows[0]?.device === checkpoints.DEVICE) {
                if (failCheckpoint) return cb(new Error('synthetic'));
                store.create(rows).then((r) => cb(null, r));
              } else cb(failWrites ? new Error('synthetic') : null, rows);
            },
            list: (params, cb) => store.list(params).then((r) => cb(null, r)),
            remove: (params, cb) => store.remove(params).then((r) => cb(null, r))
          };
        return internalOutput({}, ctx);
      }
      const first = output();
      const frame = {
        entries: [{ dateString: now.toISOString() }],
        glookoSync: { state, cursors: state.cursors }
      };
      failWrites = true;
      await assert.rejects(first(frame));
      assert.equal(store.docs().length, 0);
      failWrites = false;
      failCheckpoint = true;
      await assert.rejects(first(frame));
      assert.equal(store.docs().length, 0);
      failCheckpoint = false;
      await first(frame);
      assert.equal(store.docs().length, 1);
      const restart = output(),
        restored = await restart.gap_for();
      assert.deepEqual(restored.glookoSyncStates[state.owner], state);
      await restart(frame);
      assert.equal(store.docs().length, 1);
    }
  );
