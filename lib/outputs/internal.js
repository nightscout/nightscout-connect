
var debug = require('../debug');

function persistent (config, ctx) {

  var known = null;
  ctx.bus.on('data-processed', function (sbx) {
    if (sbx.data.sgvs.length == 0) {
      return;
    }

    function mills_or(thing, other) {
      var entry = sbx.lastEntry(thing);
      return entry
        ? entry.mills
        : other
        ;
    }

    var last = {
      entries: new Date(mills_or(sbx.data.sgvs, 0)),
      sgvs: sbx.lastEntry(sbx.data.sgvs),
      treatments: new Date(mills_or(sbx.data.treatments, 0)),
      devicestatus: new Date(mills_or(sbx.data.devicestatus, 0)),
      profile: sbx.lastEntry(sbx.data.profile)

    };

    known = last;
    debug('data-loaded',
      // Object.keys(sbx.data),
      last
    
    );
  });

  function record_collection (kind, candidates) {
    if (!candidates.length) {
      return Promise.resolve( );
    }

    function record (resolve, reject) {

      ctx[kind].create(candidates, (err, stored) => {
        if (err) {
          return reject(err);
        }
        return resolve(stored);
      });
    }

    return new Promise(record);
  }
  function record_treatments (candidates) {
    if (!candidates.length) {
      return Promise.resolve( );
    }
    function record (resolve, reject) {

      ctx.treatments.create(candidates, (err, stored) => {
        if (err) {
          return reject(err);
        }
        return resolve(stored);
      });
    }

    return new Promise(record);
  }

  function record_entries (candidates) {
    if (!candidates.length) {
      return Promise.resolve( );
    }
    function record (resolve, reject) {

      ctx.entries.create(candidates, (err, stored) => {
        if (err) {
          return reject(err);
        }
        return resolve(stored);
      });
    }

    return new Promise(record);
  }

  function persists (batch) {
    debug("INTERNAL PERSISTENCE", batch);
    var { entries, treatments, profiles, devicestatus } = batch;
    entries = entries || [ ];
    treatments = treatments || [ ];
    profiles = profiles || [ ];
    devicestatus = devicestatus || [ ];
    /*
    if (!batch.entries.length) {
      return Promise.resolve(known);
    }
    */
    function processed (resolve, reject) {
      if (entries.length == 0 && treatments.length == 0 && profiles.length == 0 && devicestatus.length == 0) {
        // nothing to update, there may not be a signal for a long time.
        return resolve(known);
      }
      function then ( ) {
        resolve(known);
      }
      ctx.bus.once('data-processed', then);
    }

    var recorded = new Promise(processed);

    return Promise.all([
      record_entries(entries),
      record_treatments(treatments),
      record_collection('devicestatus', devicestatus),
      record_collection('profile', profiles),
      recorded]).then(function (settled) {
      debug("ALL SETTLED INTERNAL PERSIST", settled, arguments);
      return known;

    }).catch(( ) => {
      debug("PERSISTED INTERNAL ERRORED", arguments);
      return known;
    });

    return Promise.resolve(batch);

  }
  persists.gap_for = function ( ) {
    debug("GAP FOR");
    if (known) {
      return Promise.resolve(known);
    }

    function wait (resolve, reject) {
      ctx.bus.once('data-processed', then);
      
      function then ( ) {
        debug("EVENTUALLY FOUND", known);
        return resolve(known);
      }

    }
    debug("WAITING FOR data-processed");
    return new Promise(wait);

  }

  return persists;

}

module.exports = persistent;
