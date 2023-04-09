
var qs = require('querystring');
var url = require('url');
var crypto = require('crypto');

function encode_api_secret(plain) {
  var shasum = crypto.createHash('sha1');
  shasum.update(plain);
  return shasum.digest('hex').toLowerCase( );
}

function nightscoutRestAPI (config, axios) {
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
    var headers = { 'API-SECRET': apiHash };
    return http.post('/api/v1/entries.json', data, { headers }).then((resp) => {
      console.log("RECORDED BATCH", resp.data);
      return resp.data;
    }).catch((err) => {
      console.log("RECORDING ERROR", err);
    });
  }
  function bookmark_glucose (data) {
    var readings = data;
    if (readings && readings.length) {
      bookmark.entries = new Date(readings[0].dateString);
    }
    return Promise.resolve(data);
    // return data;
  }

  function record_batch (batch) {
    console.log("RECORD BATCH", batch);
    return Promise.all([
        record_glucose(batch.entries).then(bookmark_glucose)
      ]).then(function update_bookmark (settled) {
        console.log("UPDATE BOOKMARK FROM I/O", bookmark, settled[0], settled);
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
        bookmark.entries = new Date(resp.data[0].dateString);
        console.log("UPDATED ENTRIES BOOKMARK", bookmark);
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

