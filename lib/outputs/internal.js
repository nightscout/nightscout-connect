

function persistent (config, ctx) {

  var known = null;
  ctx.bus.on('data-processed', function (sbx) {
    var last = {
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
    function resolved (data) {
      return data;
    }
    function rejected (err) {
      return err;
    }
    ctx.entries.create(candidates, (err, stored) => {
      if (err) {
        return rejected(err);
      }
      return resolved(stored);
    });
    return new Promise(resolved, rejected);
  }

  function persists (batch) {
    console.log("INTERNAL PERSISTENCE", batch);
    return Promise.all([ record_entries(batch.entries) ]);
    return Promise.resolve(batch);

  }
  persists.gap_for = function ( ) {
    console.log("GAP FOR");
    if (known) {
      return Promise.resolve(known);
    }

    function resolved ( ) {
      console.log("EVENTUALLY FOUND", known);
      return known;
    }
    ctx.bus.once('data-processed', resolved);

    console.log("WAITING FOR data-processed");
    return new Promise(resolved);

  }

  return persists;

}

module.exports = persistent;
