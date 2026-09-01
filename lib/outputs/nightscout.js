
var qs = require('querystring');
var url = require('url');
var crypto = require('crypto');

function encode_api_secret(plain) {
  var shasum = crypto.createHash('sha1');
  shasum.update(plain);
  return shasum.digest('hex').toLowerCase( );
}

function nightscoutRestAPI (config, axios) {
  if (!config || !config.url) {
    throw new Error('Nightscout output requires CONNECT_NIGHTSCOUT_ENDPOINT or --nightscoutEndpoint.');
  }
  if (!config.apiSecret) {
    throw new Error('Nightscout output requires CONNECT_API_SECRET or --apiSecret.');
  }
  // TODO change this, exposes secret in logs
  console.log("SETTING UP nightscoutRestAPI", config);
  var endpoint = url.parse(config.url);
  var baseURL = url.format({
    protocol: endpoint.protocol
  , host: endpoint.host
  , pathname: endpoint.pathname
  });
  var params = qs.parse(endpoint.query);
  var apiSecret = config.apiSecret;
  var apiHash = encode_api_secret(apiSecret);
  var http = axios.create({ baseURL });

  // function gap_for (kind, dt) { }
  // function record_kind (kind, data, dt) { }
  var bookmark = null;

  function record_glucose (data) {
    if (!data.length) {
      return Promise.resolve( );
    }
    var headers = { 'API-SECRET': apiHash };
    return http.post('/api/v1/entries.json', data, { headers }).then((resp) => {
      console.log("RECORDED BATCH, total entries", resp.data.length);
      return resp.data;
    }).catch((err) => {
      console.log("RECORDING ERROR", err);
    });
  }

  // Deduplicating on Glooko's own guid instead of a timestamp: an event that
  // fires before a bolus but syncs after it would otherwise fall behind the
  // cursor and be skipped for good.
  function remember_guids (data) {
    if (!bookmark) return;
    // Only carried on the bookmark when a source actually uses guids, so the
    // persisted shape is unchanged for sources that do not.
    (data || []).forEach(function (t) {
      if (!t || !t.glookoGuid) { return; }
      if (!bookmark.seenGuids) { bookmark.seenGuids = [ ]; }
      if (bookmark.seenGuids.indexOf(t.glookoGuid) < 0) {
        bookmark.seenGuids.push(t.glookoGuid);
      }
    });
  }

  function record_treatments (data) {
    if (!data.length) {
      return Promise.resolve( );
    }
    var headers = { 'API-SECRET': apiHash };
    return http.post('/api/v1/treatments.json', data, { headers }).then((resp) => {
      remember_guids(data);
      console.log("RECORDED BATCH, total treatments", resp.data.length);
      return resp.data;
    }).catch((err) => {
      console.log("RECORDING ERROR", err);
    });
  }
  function record_devicestatus (data) {
    if (!data.length) {
      return Promise.resolve( );
    }
    // Nightscout does not deduplicate devicestatus, and the Glooko source
    // re-derives IOB from the same newest bolus on every cycle - so without
    // this the identical record is appended every poll, forever. Skip
    // anything not strictly newer than what we last sent.
    // bookmark.devicestatus already tracks the newest created_at we have seen:
    // it is seeded on startup and refreshed after each post, so no extra
    // watermark is needed.
    if (bookmark.devicestatus) {
      var mark = new Date(bookmark.devicestatus).getTime( );
      data = data.filter(function (d) {
        return d && d.created_at && new Date(d.created_at).getTime( ) > mark;
      });
      if (!data.length) {
        return Promise.resolve( );
      }
    }
    var headers = { 'API-SECRET': apiHash };
    return http.post('/api/v1/devicestatus.json', data, { headers }).then((resp) => {
      console.log("RECORDED BATCH, total devicestatus", resp.data.length);
      return resp.data;
    }).catch((err) => {
      console.log("RECORDING ERROR", err);
    });
  }

  function record_profiles (data) {
    if (!data.length) {
      return Promise.resolve( );
    }
    var headers = { 'API-SECRET': apiHash };
    return http.post('/api/v1/profile.json', data, { headers }).then((resp) => {
      console.log("RECORDED BATCH, total profiles", resp.data.length);
      return resp.data;
    }).catch((err) => {
      console.log("RECORDING ERROR", err);
    });
  }

  function newestDate (data, field) {
    if (!data || !data.length) {
      return null;
    }
    return data
      .map((item) => item && item[field] ? new Date(item[field]) : null)
      .filter(Boolean)
      .sort((a, b) => b.getTime( ) - a.getTime( ))
      .shift( );
  }

  function bookmark_collection (collection, field, data) {
    var newest = newestDate(data, field);
    if (newest) {
      bookmark[collection] = newest;
    }
    return Promise.resolve(data);
  }

  function record_batch (batch) {
    batch = batch || { };
    bookmark = bookmark || { };
    var { entries, treatments, profiles, devicestatus } = batch;
    entries = entries || [ ];
    treatments = treatments || [ ];
    profiles = profiles || [ ];
    devicestatus = devicestatus || [ ];
    console.log("RECORD BATCH with", entries.length, 'entries,', treatments.length, 'treatments,', devicestatus.length, 'devicestatus,', profiles.length, 'profiles');
    /*
    if (!batch.entries.length) {
      return Promise.resolve(bookmark);
    }
    */
    return Promise.all([
        record_glucose(entries).then(bookmark_collection.bind(null, 'entries', 'dateString')),
        record_treatments(treatments).then(bookmark_collection.bind(null, 'treatments', 'created_at')),
        record_devicestatus(devicestatus).then(bookmark_collection.bind(null, 'devicestatus', 'created_at')),
        record_profiles(profiles).then(bookmark_collection.bind(null, 'profiles', 'created_at'))
      ]).then(function update_bookmark (settled) {
        console.log("UPDATE BOOKMARK FROM I/O", bookmark, settled[0], settled.length);
        return bookmark;
    });
    // return Promise.resolve(batch);

  }
  record_batch.gap_for = function ( ) {
    console.log("FETCHING GAPS INFORMATION");
    if (bookmark) {
      return Promise.resolve(bookmark);
    }
    bookmark = { };
    var headers = { 'API-SECRET': apiHash };
    var query = { count: 1 };
    return Promise.all([
      http.get('/api/v1/entries.json', { params: query, headers }).then((resp) => {
        bookmark.entries = newestDate(resp.data, 'dateString') || bookmark.entries;
      }),
      http.get('/api/v1/treatments.json', { params: query, headers }).then((resp) => {
        bookmark.treatments = newestDate(resp.data, 'created_at') || bookmark.treatments;
      }),
      http.get('/api/v1/devicestatus.json', { params: query, headers }).then((resp) => {
        bookmark.devicestatus = newestDate(resp.data, 'created_at') || bookmark.devicestatus;
      }),
      http.get('/api/v1/profile.json', { params: query, headers }).then((resp) => {
        bookmark.profiles = newestDate(resp.data, 'created_at') || bookmark.profiles;
      }),
      // Seed the guid set from what is already stored. Without this a restart
      // would re-import every pump event inside the fetch window.
      http.get('/api/v1/treatments.json', {
        params: {
          count: 500,
          'find[created_at][$gte]': new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString()
        }, headers
      }).then((resp) => {
        var guids = (resp.data || [])
          .map(function (t) { return t.glookoGuid; })
          .filter(Boolean);
        if (guids.length) {
          bookmark.seenGuids = guids;
          console.log("SEEDED", guids.length, "known source guids");
        }
      }).catch(function ( ) { }),
    ]).then(( ) => {
      console.log("UPDATED BOOKMARKS", bookmark);
    }).catch((err) => {
      var status = err && err.response && err.response.status;
      var data = err && err.response && err.response.data;
      console.log("FAILED TO DETERMINE GAP", err && err.request, status, data);
    })
    .then(( ) => {
      console.log("FINAL GAP", bookmark);
      return bookmark;
    });;

  }
  return record_batch;

}
module.exports = nightscoutRestAPI;
