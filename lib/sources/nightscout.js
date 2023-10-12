
// var qs = require('querystring');
var qs = require('qs');
var url = require('url');
var crypto = require('crypto');

var software = require('../../package.json');
var user_agent_string = [software.name, `${software.name}@${software.version}`, 'Nightscout API', software.homepage].join(', ');

function encode_api_secret(plain) {
  var shasum = crypto.createHash('sha1');
  shasum.update(plain);
  return shasum.digest('hex').toLowerCase( );
}


function nightscoutSource (opts, axios) {

  var endpoint = url.parse(opts.url);
  var baseURL = url.format({
    protocol: endpoint.protocol || 'https'
  , host: endpoint.host
  , pathname: endpoint.pathname
  });
  var params = qs.parse(endpoint.query);
  var apiSecret = opts.apiSecret;
  var apiHash = encode_api_secret(apiSecret);
  // TODO: token based support
  // stick data member from output of /api/v2/authorization/request/<token>
  // into Authorization: Bearer <jwt>
  // if (params.token) { }

  console.log("NIGHTSCOUT BASE URL", baseURL);
  var default_headers = {
    'User-Agent': user_agent_string
  };
  var http = axios.create({ baseURL, headers: default_headers });
  var impl = {
    authFromCredentials(creds, settings) {
      var checkURL = '/api/v1/verifyauth';
      // prefer using a token for traceability reasons
      if (params.token) return Promise.resolve(params.token);
      // check if it's already readable
      console.log("CHECKING", http, checkURL);
      return http.get(checkURL).then((resp) => {
        console.log("CHECKED", checkURL, resp);
        var checked = resp.data;
        if (checked.status == 200 && checked.message.canRead) {
          return Promise.resolve({ readable: checked });
        }

        // otherwise, it's not readable, exchange API Secret for
        // a token for traceability reasons.
        // create and record a preferred subject
        var authURL = '/api/v2/authorization/subjects';
        var headers = { 'API-SECRET': apiHash };
        return http.get(authURL, { headers }).then((resp) => {
          var body = resp.data;
          var match = body.filter((item) => item.name == 'nightscout-connect-reader').pop( );
          if (match) {
            return match.accessToken;
          }
          var subject = {
            name: 'nightscout-connect-reader',
            role: [ 'readable' ],
            notes: 'Used by nightscout-connect to read Nightscout as a source of data.'
          };
          return http.post(authURL, subject, { headers }).then((resp) => {
            // var body = res.data.pop( );
            return http.get(authURL, { headers }).then((resp) => {
              var body = resp.data;
              var match = body.filter((item) => item.name == 'nightscout-connect-reader').pop( );
              if (match) {
                params.token = match.accessToken;
                return params.token;
                // return Promise.resolve(params.token);
                // return match.accessToken;
              }
              // throw new Error("My error");
              return Promise.reject(body);
            });

          });
          console.log("resp", authURL, resp.status, resp.data);
          return resp.data
        })

      }).catch(console.log.bind(console, "CHECKED SOMETHING WRONG"));

    },
    sessionFromAuth(accessToken, settings) {
      var tokenUrl = '/api/v2/authorization/request/' + accessToken; 
      if (accessToken && accessToken.readable) {
        return Promise.resolve({ readable: accessToken.readable });
      }
      return http.get(tokenUrl, { headers }).then((resp) => {
        var body = resp.data;
        var session = {
          bearer: body.token
        , ttl: (body.exp - body.iat) * 1000
        , info: body
        }
        return session;
      });
    },
    align_to_glucose (last_known) {
      console.log("INSIDE NIGHTSCOUT SOURCE DRIVER ALIGNMENT FOR GLUCOSE");
      if (!last_known || !last_known.entries) {
        return;
      }
      // var last_glucose_at = new Date(last_known.sgvs.mills);
      var last_glucose_at = last_known.entries;
      var missing = ((new Date( )).getTime( ) - last_glucose_at.getTime( )) / (1000 * 60 * 5)
      if (missing > 1 && missing < 3) {
        console.log("READJUSTING SHOULD MAKE A DIFFERENCE MISSING", missing);

      }
      var next_due = last_glucose_at.getTime( ) + (Math.ceil(missing) * 1000 * 60 * 5);
      var buffer_lag = 18000; // 18 second buffer
      var jitter = Math.floor(Math.random( ) * 1000 * 18); // 18 second random
      var align_to = next_due + buffer_lag + jitter;
      return align_to;
      return next_due;
    },
    // TODO: need to create appopriate queries based on gap information
    dataFromSesssion(session, last_known) {
      var two_days_ago = new Date( ).getTime( ) - (2 * 24 * 60 * 60 * 1000);
      // var last_mills = Math.max(two_days_ago, last_known.sgvs ? last_known.sgvs.mills : two_days_ago);
      var last_mills = Math.max(two_days_ago, (last_known && last_known.entries) ? last_known.entries.getTime( ) : two_days_ago);
      var last_glucose_at = new Date(last_mills);
      var count = Math.ceil(((new Date( )).getTime( ) - last_mills) / (1000 * 60 * 5));
      var query = { find: { dateString: { $gt: last_glucose_at.toISOString( ) } }, count };
      var dataUrl = '/api/v1/entries.json?';
      var headers = { 'x-special-foo': 'special' };
      if (session.bearer) {
        headers['Authorization'] = ['Bearer', session.bearer].join(' ');
      }
      console.log("FETCHING GAPS FOR", last_known, dataUrl, query);
      return http.get(dataUrl, { params: query, headers }).then((resp) => {
        return resp.data;
      });
    },
    transformGlucose (data) {
      // pass through
      // TODO: delete $._id
      return { entries: data };
    }
  };
  function tracker_for ( ) {
    // var { AxiosHarTracker } = require('axios-har-tracker');
    // var tracker = new AxiosHarTracker(http);
    var AxiosTracer = require('../../trace-axios');
    var tracker = AxiosTracer(http);
    return tracker;
  }
  function generate_driver (builder) {
    builder.support_session({
      authenticate: impl.authFromCredentials,
      authorize: impl.sessionFromAuth,
      // refresh: impl.refreshSession,
      delays: {
        REFRESH_AFTER_SESSSION_DELAY: 28800000,
        EXPIRE_SESSION_DELAY: 28800000,
      }
    });



    builder.register_loop('NightscoutEntries', {
      tracker: tracker_for,
      frame: {
        impl: impl.dataFromSesssion,
        align_schedule: impl.align_to_glucose,
        transform: impl.transformGlucose,
        backoff: {
          // wait ten seconds before retrying to get data
          interval_ms: 10000

        },
        // only try 3 times to get data
        maxRetries: 3
      },
      // expect new data 5 minutes after last success
      expected_data_interval_ms: 5 * 60 * 1000,
      backoff: {
        // wait 2.5 minutes * 2^attempt
        interval_ms: 2.5 * 60 * 1000
      },
    });
    return builder;
  };
  impl.generate_driver = generate_driver;
  return impl;
}

nightscoutSource.validate = function validate_inputs (input) {
  var ok = false;
  var errors = [ ];
  var config = {
    url: input.sourceEndpoint,
    apiSecret: input.sourceApiSecret || '',
  };
  if (!config.url) {
    errors.push({desc: "Nightscout Connect source needed. CONNECT_SOURCE_ENDPOINT must be a url.", err: new Error(input.sourceEndpoint) } );
  }
  ok = errors.length == 0;
  config.kind = ok ? 'nightscout' : 'disabled';
  return { ok, errors, config }

}

module.exports = nightscoutSource;

