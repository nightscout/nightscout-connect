'use strict';

// Resolve on storage completion. An unrelated data-processed event may never
// arrive after an empty frame or a failed write.
function persistent(config, ctx) {
  let known = {};
  let knownProfiles;
  let checkpointsLoaded = false;
  const checkpoints = require('./glooko-checkpoint');
  const listCheckpoints = params => new Promise((resolve, reject) =>
    ctx.devicestatus.list(params, (err, rows) => err ? reject(err) : resolve(rows || [])));
  const prepareTreatments = require('./glooko-legacy')(
    (params) =>
      new Promise((resolve, reject) =>
        ctx.treatments.list(params, (err, data) => (err ? reject(err) : resolve(data || [])))
      )
  );
  ctx.bus.on('data-processed', function (sbx) {
    if (!sbx || !sbx.data) return;
    for (const [key, source] of [
      ['entries', 'sgvs'],
      ['treatments', 'treatments'],
      ['devicestatus', 'devicestatus']
    ]) {
      const latest = sbx.lastEntry(sbx.data[source] || []);
      if (latest && Number.isFinite(Number(latest.mills))) known[key] = new Date(latest.mills);
    }
    known.profile = sbx.lastEntry(sbx.data.profile || []);
  });
  function create(kind, rows) {
    if (!rows.length) return Promise.resolve([]);
    return new Promise((resolve, reject) =>
      ctx[kind].create(rows, (err, stored) => (err ? reject(err) : resolve(stored || rows)))
    );
  }
  async function profiles(rows) {
    if (rows.some((p) => p.identifier && p.identifier.startsWith('glooko:profile:'))) {
      if (!knownProfiles) {
        const stored = await new Promise((resolve, reject) =>
          ctx.profile.list((err, data) => (err ? reject(err) : resolve(data || [])), 1000)
        );
        knownProfiles = new Set(stored.map((p) => p.identifier).filter(Boolean));
      }
      rows = rows.filter((p) => !p.identifier || !knownProfiles.has(p.identifier));
    }
    const saved = await create('profile', rows);
    if (knownProfiles)
      rows.forEach((p) => {
        if (p.identifier) knownProfiles.add(p.identifier);
      });
    return saved;
  }
  async function persists(batch = {}) {
    console.log(
      'INTERNAL PERSISTENCE',
      (batch.entries || []).length,
      'entries,',
      (batch.treatments || []).length,
      'treatments,',
      (batch.profiles || []).length,
      'profiles,',
      (batch.devicestatus || []).length,
      'devicestatus'
    );
    let statuses = batch.devicestatus || [];
    if (statuses.length) {
      const glooko = statuses.every((d) => d.device === 'nightscout-connect-glooko');
      const find = glooko
        ? {
            device: 'nightscout-connect-glooko',
            created_at: {
              $gte: new Date(
                Math.min(...statuses.map((d) => Date.parse(d.created_at)))
              ).toISOString()
            }
          }
        : undefined;
      const stored = await new Promise((resolve, reject) =>
        ctx.devicestatus.list({ count: 1, ...(find ? { find } : {}) }, (err, data) =>
          err ? reject(err) : resolve(data || [])
        )
      );
      const latest = Math.max(
        !glooko && known.devicestatus ? known.devicestatus.getTime() : 0,
        ...stored.map((r) => Date.parse(r.created_at) || 0)
      );
      statuses = statuses.filter((r) => Date.parse(r.created_at) > latest);
    }
    const written = await Promise.all([
      create('entries', batch.entries || []),
      prepareTreatments(batch.treatments || []).then((rows) => create('treatments', rows)),
      create('devicestatus', statuses),
      profiles(batch.profiles || [])
    ]);
    await require('./glooko-pump-state')(batch.glookoSync?.pumpStateWindow,
      params => new Promise((resolve,reject)=>ctx.treatments.list(params,(err,data)=>err?reject(err):resolve(data||[]))),
      params => new Promise((resolve,reject)=>ctx.treatments.remove(params,(err,data)=>err?reject(err):resolve(data))));
    await checkpoints.save(batch.glookoSync?.state, listCheckpoints,
      rows => create('devicestatus', rows),
      params => new Promise((resolve, reject) => ctx.devicestatus.remove(params,
        (err, data) => err ? reject(err) : resolve(data))));
    for (const [i, key, field] of [
      [0, 'entries', 'dateString'],
      [1, 'treatments', 'created_at'],
      [2, 'devicestatus', 'created_at']
    ]) {
      const latest = Math.max(
        known[key] ? known[key].getTime() : 0,
        ...written[i].map((r) => Date.parse(r[field] || r.eventTime) || 0)
      );
      if (latest) known[key] = new Date(latest);
    }
    if (batch.glookoSync)
      known.glookoCursors = { ...known.glookoCursors, ...batch.glookoSync.cursors };
    if (batch.glookoSync?.state) known.glookoSyncStates = {
      ...known.glookoSyncStates, [batch.glookoSync.state.owner]: batch.glookoSync.state
    };
    console.log('INTERNAL PERSISTENCE COMPLETE');
    return known;
  }
  function safePersist(batch) {
    return persists(batch).catch((err) => {
      // Mongo errors can embed failed medical documents. Never pass those
      // objects to the connector's actor/error logger.
      const error = new Error('Nightscout internal write failed');
      error.code = err && err.code;
      throw error;
    });
  }
  safePersist.gap_for = async () => {
    if (!checkpointsLoaded && ctx.devicestatus.list) {
      known.glookoSyncStates = { ...await checkpoints.load(listCheckpoints), ...known.glookoSyncStates };
      checkpointsLoaded = true;
    }
    return known;
  };
  return safePersist;
}
module.exports = persistent;
