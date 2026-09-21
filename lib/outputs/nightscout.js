
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
  console.log("SETTING UP nightscoutRestAPI");
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
  var knownProfiles = null;
  var checkpointsLoaded = false;
  const checkpoints = require('./glooko-checkpoint');
  const checkpointOptions = params => ({ headers: { 'API-SECRET': apiHash }, params,
    paramsSerializer: p => require('qs').stringify(p) });
  const listCheckpoints = async params => (await http.get('/api/v1/devicestatus.json', checkpointOptions(params))
    .catch(recordingError)).data;
  const prepareTreatments = require('./glooko-legacy')(async params => {
    const response = await http.get('/api/v1/treatments.json', {
      headers: { 'API-SECRET': apiHash }, params,
      paramsSerializer: p => require('qs').stringify(p)
    }).catch(recordingError);
    return response.data;
  });
  function recordingError(err) {
    // Axios errors contain request headers, secrets and the submitted records.
    var error = new Error('Nightscout write failed');
    error.code = err && err.code;
    error.status = err && err.response && err.response.status;
    throw error;
  }

  function record_glucose (data) {
    if (!data.length) {
      return Promise.resolve( );
    }
    var headers = { 'API-SECRET': apiHash };
    return http.post('/api/v1/entries.json', data, { headers }).then((resp) => {
      console.log("RECORDED BATCH, total entries", resp.data.length);
      return resp.data;
    }).catch(recordingError);
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
      if ((t.identifier || t.glookoIdentifier || '').startsWith('glooko:')) { return; }
      if (!bookmark.seenGuids) { bookmark.seenGuids = [ ]; }
      if (bookmark.seenGuids.indexOf(t.glookoGuid) < 0) {
        bookmark.seenGuids.push(t.glookoGuid);
      }
    });
  }

  async function record_treatments (data) {
    if (!data.length) {
      return Promise.resolve( );
    }
    var headers = { 'API-SECRET': apiHash };
    if (data.some(row => row.glookoGuid && row.identifier?.startsWith('glooko:'))) {
      data = await prepareTreatments(data);
    }
    return http.post('/api/v1/treatments.json', data, { headers }).then((resp) => {
      remember_guids(data);
      console.log("RECORDED BATCH, total treatments", resp.data.length);
      return resp.data;
    }).catch(recordingError);
  }
  async function record_devicestatus (data) {
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
    var statusBookmark = bookmark.devicestatus;
    if (data.every(d => d.device === 'nightscout-connect-glooko')) {
      // Nightscout's unfiltered endpoint may serve a stale runtime cache.
      // A device filter reads storage and does not confuse another uploader's
      // newer snapshot with this pump's last successfully stored snapshot.
      const previous = await http.get('/api/v1/devicestatus.json', {
        headers: { 'API-SECRET': apiHash }, params: {
          count: 1, 'find[device]': 'nightscout-connect-glooko',
          'find[created_at][$gte]': new Date(Math.min(...data.map(d => Date.parse(d.created_at)))).toISOString()
        }
      }).catch(recordingError);
      statusBookmark = newestDate(previous.data, 'created_at');
    }
    if (statusBookmark) {
      var mark = new Date(statusBookmark).getTime( );
      data = data.filter(function (d) {
        return d && d.created_at && new Date(d.created_at).getTime( ) > mark;
      });
      if (!data.length) {
        return Promise.resolve( );
      }
    }
    var headers = { 'API-SECRET': apiHash };
    // Preserve PR #52's bounded uploads without swallowing failed chunks or
    // acknowledging records that the destination has not stored.
    for (let offset = 0; offset < data.length; offset += 50) {
      const chunk = data.slice(offset, offset + 50);
      await http.post('/api/v1/devicestatus.json', chunk, { headers }).catch(recordingError);
    }
    console.log("RECORDED BATCH, total devicestatus", data.length);
    return data;
  }

  async function record_profiles (data) {
    if (!data.length) {
      return Promise.resolve( );
    }
    var headers = { 'API-SECRET': apiHash };
    if (data.some(p => p.identifier && p.identifier.startsWith('glooko:profile:'))) {
      if (!knownProfiles) {
        var previous = await http.get('/api/v1/profile.json', { headers, params: { count: 1000 } }).catch(recordingError);
        knownProfiles = new Set((previous.data || []).map(p => p.identifier).filter(Boolean));
      }
      data = data.filter(p => !p.identifier || !knownProfiles.has(p.identifier));
      if (!data.length) return [];
    }
    return http.post('/api/v1/profile.json', data, { headers }).then((resp) => {
      if (knownProfiles) data.forEach(p => { if (p.identifier) knownProfiles.add(p.identifier); });
      console.log("RECORDED BATCH, total profiles", resp.data.length);
      return resp.data;
    }).catch(recordingError);
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
    ]).then(async function update_bookmark (settled) {
        const stateQueryOptions = params => ({
          headers: { 'API-SECRET': apiHash }, params,
          paramsSerializer: p => require('qs').stringify(p)
        });
        await require('./glooko-pump-state')(
          batch.glookoSync && batch.glookoSync.pumpStateWindow,
          async params => (await http.get('/api/v1/treatments.json', stateQueryOptions(params))
            .catch(recordingError)).data,
          params => http.delete('/api/v1/treatments.json', stateQueryOptions(params))
            .catch(recordingError)
        );
        await checkpoints.save(batch.glookoSync?.state, listCheckpoints,
          rows => http.post('/api/v1/devicestatus.json', rows, { headers: { 'API-SECRET': apiHash } }).catch(recordingError),
          params => http.delete('/api/v1/devicestatus.json', checkpointOptions(params)).catch(recordingError));
        if (batch.glookoSync?.state) bookmark.glookoSyncStates = {
          ...bookmark.glookoSyncStates, [batch.glookoSync.state.owner]: batch.glookoSync.state
        };
        if (batch.glookoSync) bookmark.glookoCursors = { ...bookmark.glookoCursors, ...batch.glookoSync.cursors };
        console.log("UPDATE BOOKMARK FROM I/O", { collections: settled.length });
        return bookmark;
    });
    // return Promise.resolve(batch);

  }
  record_batch.gap_for = function ( ) {
    console.log("FETCHING GAPS INFORMATION");
    if (bookmark && checkpointsLoaded) {
      return Promise.resolve(bookmark);
    }
    bookmark = bookmark || { };
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
      console.log("UPDATED BOOKMARKS");
    }).catch((err) => {
      var status = err && err.response && err.response.status;
      console.log("FAILED TO DETERMINE GAP", { status });
    })
    .then(async ( ) => {
      bookmark.glookoSyncStates = await checkpoints.load(listCheckpoints);
      checkpointsLoaded = true;
      console.log("FINAL GAP");
      return bookmark;
    });;

  }
  return record_batch;

}
module.exports = nightscoutRestAPI;
