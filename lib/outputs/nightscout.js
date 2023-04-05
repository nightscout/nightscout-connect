
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

  function gap_for (kind, dt) {

  }

  function record_kind (kind, data, dt) {
  }

  function record_batch (batch) {
    console.log("RECORD BATCH", batch);
    // return axios.post().then( );
    return Promise.resolve(batch);

  }
  return record_batch;

}
module.exports = nightscoutRestAPI;

