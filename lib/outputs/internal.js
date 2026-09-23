'use strict';

const createLogger = require('../logging');

// Resolve on storage completion. An unrelated data-processed event may never
// arrive after an empty frame or a failed write.
function persistent(config, ctx) {
  const log = config.logger || createLogger(config.debug);
  let known = {};
  let knownProfiles;
  let checkpointsLoaded = false;
  let closed = false;
  const pending = new Set();
  const checkpoints = require('./glooko-checkpoint');
  const listCheckpoints = params => new Promise((resolve, reject) =>
    ctx.devicestatus.list(params, (err, rows) => err ? reject(err) : resolve(rows || [])));
  const prepareTreatments = require('./glooko-legacy')(
    (params) =>
      new Promise((resolve, reject) =>
        ctx.treatments.list(params, (err, data) => (err ? reject(err) : resolve(data || [])))
      )
  );
  function updateKnown(sbx) {
    if (closed || !sbx || !sbx.data) return;
    for (const [key, source] of [
      ['entries', 'sgvs'],
      ['treatments', 'treatments'],
      ['devicestatus', 'devicestatus']
    ]) {
      const latest = sbx.lastEntry(sbx.data[source] || []);
      if (latest && Number.isFinite(Number(latest.mills))) known[key] = new Date(latest.mills);
    }
    known.profile = sbx.lastEntry(sbx.data.profile || []);
    log.debug('data-loaded');
  }
  ctx.bus.on('data-processed', updateKnown);
  function create(kind, rows) {
    if (!rows.length) return Promise.resolve([]);
    return new Promise((resolve, reject) =>
      ctx[kind].create(rows, (err, stored) => (err ? reject(err) : resolve(stored || rows)))
    );
  }
  // Nightscout stores profiles with insertMany, so a profile that is already
  // stored must not be sent again. The Nightscout source re-reads every
  // profile, with its _id, on every poll; Glooko profiles carry an identifier.
  // A profile already stored is skipped, not updated.
  const profileKeys = (p) => [p.identifier, p._id == null ? null : 'id:' + String(p._id)].filter(Boolean);
  // The profile bookmark is the newest created_at of the profiles stored here
  // or already handled; the Nightscout source reads profiles changed after it.
  // It is set from storage the first time profiles arrive, so after a restart
  // the source's first poll reads only its first-window profiles.
  function advanceProfiles(rows) {
    const latest = Math.max(known.profiles ? known.profiles.getTime() : 0,
      ...rows.map((p) => Date.parse(p && p.created_at) || 0));
    if (latest) known.profiles = new Date(latest);
  }
  async function loadProfiles() {
    const stored = await new Promise((resolve, reject) =>
      ctx.profile.list((err, data) => (err ? reject(err) : resolve(data || [])), 1000)
    );
    knownProfiles = new Set(stored.flatMap(profileKeys));
    advanceProfiles(stored);
  }
  async function profiles(rows) {
    const handled = rows;
    if (rows.some((p) => profileKeys(p).length)) {
      if (!knownProfiles) await loadProfiles();
      rows = rows.filter((p) => !profileKeys(p).some((key) => knownProfiles.has(key)));
    }
    let saved;
    try {
      saved = await create('profile', rows);
    } catch (err) {
      // Re-read what is stored before the next attempt.
      knownProfiles = undefined;
      throw err;
    }
    if (knownProfiles)
      rows.forEach((p) => profileKeys(p).forEach((key) => knownProfiles.add(key)));
    advanceProfiles(handled);
    return saved;
  }
  async function persists(batch = {}) {
    log.debug('Internal persistence: ' +
      (batch.entries || []).length + ' entries, ' +
      (batch.treatments || []).length + ' treatments, ' +
      (batch.profiles || []).length + ' profiles, ' +
      (batch.devicestatus || []).length + ' devicestatus');
    let treatments = batch.treatments || [];
    if (treatments.some(row => row.enteredBy === 'librelinkup' && row.eventType === 'Sensor Start')) {
      if (!known.librelinkupSensorStartLoaded) {
        const existing = await new Promise((resolve, reject) =>
          ctx.treatments.list({ count: 1, find: { enteredBy: 'librelinkup', eventType: 'Sensor Start' } },
            (err, rows) => err ? reject(err) : resolve(rows || [])));
        const latest = Math.max(0, ...existing.map(row => Date.parse(row.created_at) || 0));
        if (latest) known.sensorStart = new Date(latest);
        known.librelinkupSensorStartLoaded = true;
      }
      if (known.sensorStart) treatments = treatments.filter(row =>
        row.enteredBy !== 'librelinkup' || row.eventType !== 'Sensor Start' ||
        Date.parse(row.created_at) > known.sensorStart.getTime());
    }
    let statuses = batch.devicestatus || [];
    if (statuses.length) {
      const glooko = statuses.every((d) => d.device === 'nightscout-connect-glooko');
      const libre = statuses.every((d) => d.device === 'nightscout-connect-librelinkup');
      const find = glooko
        ? {
            device: 'nightscout-connect-glooko',
            created_at: {
              $gte: new Date(
                Math.min(...statuses.map((d) => Date.parse(d.created_at)))
              ).toISOString()
            }
          }
        : libre ? { device: 'nightscout-connect-librelinkup' } : undefined;
      const stored = await new Promise((resolve, reject) =>
        ctx.devicestatus.list({ count: 1, ...(find ? { find } : {}) }, (err, data) =>
          err ? reject(err) : resolve(data || [])
        )
      );
      const latest = Math.max(
        !glooko && !libre && known.devicestatus ? known.devicestatus.getTime() : 0,
        ...stored.map((r) => Date.parse(r.created_at) || 0)
      );
      statuses = statuses.filter((r) => Date.parse(r.created_at) > latest);
    }
    const written = await Promise.all([
      create('entries', batch.entries || []),
      prepareTreatments(treatments).then((rows) => create('treatments', rows)),
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
    const sensorStarts = written[1].filter(row => row.enteredBy === 'librelinkup' && row.eventType === 'Sensor Start');
    const latestSensorStart = Math.max(0, ...sensorStarts.map(row => Date.parse(row.created_at) || 0));
    if (latestSensorStart) known.sensorStart = new Date(latestSensorStart);
    const libreStatuses = written[2].filter(row => row.device === 'nightscout-connect-librelinkup');
    const latestLibreStatus = Math.max(0, ...libreStatuses.map(row => Date.parse(row.created_at) || 0));
    if (latestLibreStatus) known.librelinkupStatus = new Date(latestLibreStatus);
    if (batch.glookoSync)
      known.glookoCursors = { ...known.glookoCursors, ...batch.glookoSync.cursors };
    if (batch.glookoSync?.state) known.glookoSyncStates = {
      ...known.glookoSyncStates, [batch.glookoSync.state.owner]: batch.glookoSync.state
    };
    log.debug('Internal persistence complete');
    return known;
  }
  // Settle the caller's wait when the output is closed. Storage operations
  // already issued cannot be cancelled here; their late results are ignored.
  function untilClosed(promise) {
    let cancel;
    const stopped = new Promise((resolve) => {
      cancel = () => resolve(null);
      pending.add(cancel);
    });
    const settled = promise.then((result) => (closed ? null : result));
    return Promise.race([settled, stopped]).finally(() => pending.delete(cancel));
  }
  function safePersist(batch) {
    if (closed) return Promise.resolve(null);
    return untilClosed(persists(batch).catch((err) => {
      if (closed) return null;
      log.error('Internal persistence failed', err);
      // Mongo errors can embed failed medical documents. Never pass those
      // objects to the connector's actor/error logger.
      const error = new Error('Nightscout internal write failed');
      error.code = err && err.code;
      throw error;
    }));
  }
  safePersist.gap_for = () => {
    if (closed) return Promise.resolve(null);
    return untilClosed((async () => {
      if (!checkpointsLoaded && ctx.devicestatus.list) {
        known.glookoSyncStates = { ...await checkpoints.load(listCheckpoints), ...known.glookoSyncStates };
        checkpointsLoaded = true;
      }
      return known;
    })());
  };
  safePersist.close = () => {
    if (closed) return;
    closed = true;
    ctx.bus.removeListener('data-processed', updateKnown);
    Array.from(pending).forEach((cancel) => cancel());
    pending.clear();
  };
  return safePersist;
}
module.exports = persistent;
