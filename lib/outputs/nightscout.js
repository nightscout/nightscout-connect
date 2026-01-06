
var qs = require('querystring');
var url = require('url');
var crypto = require('crypto');

function encode_api_secret(plain) {
  var shasum = crypto.createHash('sha1');
  shasum.update(plain);
  return shasum.digest('hex').toLowerCase( );
}

function nightscoutRestAPI (config, axios) {
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

  function record_treatments (data) {
    if (!data.length) {
      return Promise.resolve( );
    }
    var headers = { 'API-SECRET': apiHash };
    return http.post('/api/v1/treatments.json', data, { headers }).then((resp) => {
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
    
    // Split into smaller batches to avoid 413 Payload Too Large
    // Devicestatus records can be large due to OpenAPS predictions
    var batchSize = 50; // Conservative batch size
    var batches = [];
    
    for (var i = 0; i < data.length; i += batchSize) {
      batches.push(data.slice(i, i + batchSize));
    }
    
    console.log("UPLOADING DEVICESTATUS in", batches.length, "batches");
    
    var headers = { 'API-SECRET': apiHash };
    var uploaded = 0;
    
    // Upload batches sequentially to avoid overwhelming the server
    return batches.reduce(function(promise, batch) {
      return promise.then(function() {
        return http.post('/api/v1/devicestatus.json', batch, { headers }).then((resp) => {
          uploaded += resp.data.length;
          console.log("RECORDED DEVICESTATUS BATCH:", resp.data.length, "records (", uploaded, "/", data.length, ")");
          return resp.data;
        }).catch((err) => {
          console.log("RECORDING DEVICESTATUS ERROR for batch:", err.message);
          // Continue with other batches even if one fails
          return [];
        });
      });
    }, Promise.resolve()).then(function() {
      console.log("COMPLETED DEVICESTATUS UPLOAD:", uploaded, "total records");
      return data;
    });
  }

  function bookmark_glucose (data) {
    var readings = data;
    if (readings && readings.length) {
      var dateValue = readings[0].dateString || readings[0].date;
      if (dateValue) {
        bookmark.entries = new Date(dateValue);
      }
    }
    return Promise.resolve(data);
    // return data;
  }

  function record_batch (batch) {
    console.log("RECORD BATCH with", batch.entries.length, 'entries,', batch.treatments.length, 'treatments, and', (batch.devicestatus || []).length, 'devicestatus');
    var { entries, treatments, profiles, devicestatus } = batch;
    entries = entries || [ ];
    treatments = treatments || [ ];
    profiles = profiles || [ ];
    devicestatus = devicestatus || [ ];
    /*
    if (!batch.entries.length) {
      return Promise.resolve(bookmark);
    }
    */
    return Promise.all([
        record_glucose(entries).then(bookmark_glucose),
        record_treatments(treatments),
        record_devicestatus(devicestatus)
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
    return http.get('/api/v1/entries.json', { params: query, headers }).then((resp) => {
      if (resp.data && resp.data.length) {
        var dateValue = resp.data[0].dateString || resp.data[0].date;
        if (dateValue) {
          bookmark.entries = new Date(dateValue);
          console.log("UPDATED ENTRIES BOOKMARK", bookmark);
        } else {
          console.log("WARNING: No dateString or date field in entry", resp.data[0]);
        }
      }
    }).catch((err) => {
      console.log("FAILED TO DETERMINE GAP", err.request, err.response.status, err.response.data);
    })
    .then(( ) => {
      console.log("FINAL GAP", bookmark);
      return bookmark;
    });;

  }
  return record_batch;

}
module.exports = nightscoutRestAPI;

