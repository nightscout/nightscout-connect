

function persistent (config, ctx) {

  var known = null;
  ctx.bus.on('data-processed', function (sbx) {
    var last = {
      entries: new Date(sbx.lastEntry(sbx.data.sgvs).mills),
      sgvs: sbx.lastEntry(sbx.data.sgvs),
      treatments: sbx.lastEntry(sbx.data.treatments),
      devicestatus: sbx.lastEntry(sbx.data.devicestatus),
      profile: sbx.lastEntry(sbx.data.profile)

    };

    known = last;
    console.log("DEBUG nightscout-connect", 'data-loaded',
      // Object.keys(sbx.data),
      last
    
    );
  });

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
    console.log("INTERNAL PERSISTENCE", batch);
    if (!batch.entries.length) {
      return Promise.resolve(known);
    }
    function processed (resolve, reject) {
      function then ( ) {
        resolve(known);
      }
      ctx.bus.once('data-processed', then);
    }

    var recorded = new Promise(processed);

    return Promise.all([ record_entries(batch.entries), recorded]).then(function (settled) {
      console.log("ALL SETTLED INTERNAL PERSIST", settled, arguments);
      return known;

    }).catch(( ) => {
      console.log("PERSISTED INTERNAL ERRORED", arguments);
      return known;
    });

    return Promise.resolve(batch);

  }
  persists.gap_for = function ( ) {
    console.log("GAP FOR");
    if (known) {
      return Promise.resolve(known);
    }

    function wait (resolve, reject) {
      ctx.bus.once('data-processed', then);
      
      function then ( ) {
        console.log("EVENTUALLY FOUND", known);
        return resolve(known);
      }

    }
    console.log("WAITING FOR data-processed");
    return new Promise(wait);

  }

  return persists;

}

module.exports = persistent;
