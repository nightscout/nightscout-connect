function persistent (config, ctx) {
  var known = null;
  var closed = false;
  var pending = new Set();

  function updateKnown (sbx) {
    if (closed || sbx.data.sgvs.length == 0) return;
    function mills_or (thing, other) {
      var entry = sbx.lastEntry(thing);
      return entry ? entry.mills : other;
    }
    known = {
      entries: new Date(mills_or(sbx.data.sgvs, 0)),
      sgvs: sbx.lastEntry(sbx.data.sgvs),
      treatments: new Date(mills_or(sbx.data.treatments, 0)),
      devicestatus: new Date(mills_or(sbx.data.devicestatus, 0)),
      profile: sbx.lastEntry(sbx.data.profile)
    };
    console.log('Connect internal output: data processed');
  }
  ctx.bus.on('data-processed', updateKnown);

  function record_collection (kind, candidates) {
    if (closed || !candidates.length) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      ctx[kind].create(candidates, function (err, stored) {
        if (err) return reject(err);
        resolve(stored);
      });
    });
  }

  function waitForProcessed () {
    var cancel;
    var promise = new Promise(function (resolve) {
      function then () {
        ctx.bus.removeListener('data-processed', then);
        pending.delete(cancel);
        resolve(closed ? null : known);
      }
      cancel = function () {
        ctx.bus.removeListener('data-processed', then);
        pending.delete(cancel);
        resolve(null);
      };
      pending.add(cancel);
      ctx.bus.once('data-processed', then);
    });
    return {promise: promise, cancel: cancel};
  }

  function persists (batch) {
    if (closed) return Promise.resolve(null);
    console.log('Connect internal output: persisting batch');
    var {entries, treatments, profiles, devicestatus} = batch;
    entries = entries || [];
    treatments = treatments || [];
    profiles = profiles || [];
    devicestatus = devicestatus || [];
    if (!entries.length && !treatments.length && !profiles.length && !devicestatus.length) {
      return Promise.resolve(known);
    }
    var processed = waitForProcessed();
    var cancel;
    var stopped = new Promise(function (resolve) {
      cancel = function () {resolve(null);};
      pending.add(cancel);
    });
    var recorded = Promise.all([
      record_collection('entries', entries),
      record_collection('treatments', treatments),
      record_collection('devicestatus', devicestatus),
      record_collection('profile', profiles),
      processed.promise
    ]).then(function () {
      console.log('Connect internal output: batch settled');
      return closed ? null : known;
    }).catch(function () {
      console.log('Connect internal output: persistence failed');
      return closed ? null : known;
    });
    // Storage operations already issued cannot be cancelled here. Settle the
    // output wait on stop and ignore late results without retaining bookmarks.
    return Promise.race([recorded, stopped]).finally(function () {
      processed.cancel();
      pending.delete(cancel);
    });
  }

  persists.gap_for = function () {
    if (closed) return Promise.resolve(null);
    if (known) return Promise.resolve(known);
    return waitForProcessed().promise;
  };

  persists.close = function () {
    if (closed) return;
    closed = true;
    known = null;
    ctx.bus.removeListener('data-processed', updateKnown);
    Array.from(pending).forEach(function (cancel) {cancel();});
    pending.clear();
  };

  return persists;
}
module.exports = persistent;
