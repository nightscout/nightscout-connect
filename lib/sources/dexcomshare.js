
var qs = require('qs');
var url = require('url');

var software = require('../../package.json');
var user_agent_string = [software.name, `${software.name}@${software.version}`, '"Dexcom Share"', software.homepage].join(', ');
var debug = require('../debug');

var _known_servers = {
  ous: 'shareous1.dexcom.com',
  us: 'share2.dexcom.com'
}

var modDefaults = {
  "applicationId":"d89443d2-327c-4a6f-89e5-496bbb0317db"
// , "agent": [meta.name, meta.version].join('/')
, auth:  '/ShareWebServices/Services/General/AuthenticatePublisherAccount'
, login: '/ShareWebServices/Services/General/LoginPublisherAccountById'
, accept: 'application/json'
, mime: 'application/json'
, 'content-type': 'application/json'
, LatestGlucose: '/ShareWebServices/Services/Publisher/ReadPublisherLatestGlucoseValues'
// ?sessionID=e59c836f-5aeb-4b95-afa2-39cf2769fede&minutes=1440&maxCount=1"
};
function base_for (spec) {
  var server = spec.shareServer ? spec.shareServer : _known_servers[spec.shareRegion || 'us' ];
  var base = {
    protocol: 'https',
    host: server
  };
  return url.format(base);
}


// Map Dexcom's property values to Nightscout's.
function dex_to_entry (d) {
/*
[ { DT: '/Date(1426292016000-0700)/',
    ST: '/Date(1426295616000)/',
    Trend: 4,
    Value: 101,
    WT: '/Date(1426292039000)/' } ]
*/
  var regex = /\((.*)\)/;
  var wall = parseInt(d.WT.match(regex)[1]);
  var date = new Date(wall);
  var trend = matchTrend(d.Trend);
  
  var entry = {
    sgv: d.Value
  , date: wall
  , dateString: date.toISOString( )
  , trend: trend
  , direction: trendToDirection(trend)
  , device: 'nightscout-connect'
  , type: 'sgv'
  };
  return entry;
}

var DIRECTIONS = {
  NONE: 0
, DoubleUp: 1
, SingleUp: 2
, FortyFiveUp: 3
, Flat: 4
, FortyFiveDown: 5
, SingleDown: 6
, DoubleDown: 7
, 'NOT COMPUTABLE': 8
, 'RATE OUT OF RANGE': 9
};
function stringLowerCaseNoSpaces(str) {
  str = str.toLowerCase()
  while(str.indexOf(' ')>-1)
    str = str.replace(' ','');
  return str;
}


function copyObjectWithLowercaseKeys(obj) {
  // return a copy of obj but with each key transformed to lowercase
  // and spaces removed
  return Object.keys(obj).reduce(function (result, key)  {
    var newKey = stringLowerCaseNoSpaces(key);
    result[newKey] = obj[key];
    return result
  }, {});
}

var LCDIRECTIONS = copyObjectWithLowercaseKeys(DIRECTIONS);


function matchTrend(trend) {
  // attempt to match the trend based on
  // a) it is a number
  // b) it matches a key in DIRECTIONS
  // c) it matches a key in LCDIRECTIONS if converted to lowercase and all spaces removed

  if (typeof(trend) !== "string")
    return trend;

  if (trend in DIRECTIONS)
    return DIRECTIONS[trend];
    
  var lctrend = stringLowerCaseNoSpaces(trend);

  if (lctrend in LCDIRECTIONS) return LCDIRECTIONS[lctrend];
  return trend;
}

var Trends = (function ( ) {
  var keys = Object.keys(DIRECTIONS);
  var trends = keys.sort(function (a, b) {
    return DIRECTIONS[a] - DIRECTIONS[b];
  });
  return trends;
})( );
function directionToTrend (direction) {
  var trend = 8;
  if (direction in DIRECTIONS) {
    trend = DIRECTIONS[direction];
  }
  return trend;
}
function trendToDirection (trend) {
  return Trends[trend] || Trends[0];
}


function dexcomshareSource (opts, axios) {

  var baseURL = base_for(opts);
  var default_headers = { 'Content-Type': modDefaults.mime,
                          'User-Agent': user_agent_string,
                          'Accept': modDefaults.mime };
  var http = axios.create({ baseURL, headers: default_headers });
  var impl = {
    authFromCredentials (creds, settings) {
      var headers = { };
      // var params = { };
      var params = { applicationId: modDefaults.applicationId };
      var body = {
        "password": opts.sharePassword
      , "applicationId" : modDefaults.applicationId
      , "accountName": opts.shareAccountName
      };
      return http.post(modDefaults.auth, body, { params, headers }).then((response) => {
        return response.data;
      })
      .catch((err) => {
        debug("ERROR AUTHENTICATING ACCOUNT REQUEST", err.request);
        debug("ERROR AUTHENTICATING ACCOUNT RESPONSE", err.response.status, err.response.data);
        return err;
      });
    },
    sessionFromAuth(account, settings) {
      var body = {
        "password": opts.sharePassword
      , "applicationId" : modDefaults.applicationId
      , "accountId": account
      };
      var params = { applicationId: modDefaults.applicationId };
      var headers = { };
      return http.post(modDefaults.login, body, { params, headers }).then((response) => {
        return response.data;
      })
      .catch((err) => {
        debug("FAILED TO GET DEXCOM SHARE SESSION RESPONSE", err.response.status, err.response.headers, err.response.data);
        return { status: err.response.status, headers: err.response.headers, data: error.response.data };
      });
    },
    dataFromSesssion(session, last_known) {
      var two_days_ago = new Date( ).getTime( ) - (2 * 24 * 60 * 60 * 1000);
      // var last_mills = Math.max(two_days_ago, last_known.sgvs ? last_known.sgvs.mills : two_days_ago);
      var last_mills = Math.max(two_days_ago, (last_known && last_known.entries) ? last_known.entries.getTime( ) : two_days_ago);
      var last_glucose_at = new Date(last_mills);
      var maxCount = Math.ceil(((new Date( )).getTime( ) - last_mills) / (1000 * 60 * 5));
      var minutes = 5 * maxCount;
      var body = { };
      var params = {
        sessionID: session,
        minutes,
        maxCount,
      };
      return http.post(modDefaults.LatestGlucose, body, { params }).then((response) => {
        return response.data;
      })
      .catch((err) => {
        debug("FAILED TO GET DEXCOM SHARE SESSION RESPONSE", err.response.status, err.response.headers, err.response.data);
        return { status: err.response.status, headers: err.response.headers, data: error.response.data };
      });
    },
    transformGlucose (data) {
      // pass through
      // TODO: delete $._id
      if (!data) {
        return { entries: [ ] };
      }
      return { entries: data.map(dex_to_entry) };
    },
    align_to_glucose (last_known) {
      debug("INSIDE DEXCOM SOURCE DRIVER ALIGNMENT FOR GLUCOSE");
      if (!last_known || !last_known.entries) {
        return;
      }
      // var last_glucose_at = new Date(last_known.sgvs.mills);
      var last_glucose_at = last_known.entries;
      var missing = ((new Date( )).getTime( ) - last_glucose_at.getTime( )) / (1000 * 60 * 5)
      if (missing > 1 && missing < 3) {
        debug("READJUSTING SHOULD MAKE A DIFFERENCE MISSING", missing);

      }
      var next_due = last_glucose_at.getTime( ) + (Math.ceil(missing) * 1000 * 60 * 5);
      var buffer_lag = 18000; // 18 second buffer
      var jitter = Math.floor(Math.random( ) * 1000 * 18); // 18 second random
      var align_to = next_due + buffer_lag + jitter;
      return align_to;
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
        REFRESH_AFTER_SESSSION_DELAY: (1000 * 60 * 60 * 24 * 1) - 600000,
        EXPIRE_SESSION_DELAY: 1000 * 60 * 60 * 24 * 1,
      }
    });



    builder.register_loop('DexcomShare', {
      tracker: tracker_for,
      frame: {
        impl: impl.dataFromSesssion,
        align_schedule: impl.align_to_glucose,
        transform: impl.transformGlucose,
        backoff: {
        // wait 2.5 minutes * 2^attempt
          interval_ms: 2.5 * 60 * 1000

        },
        // only try 3 times to get data
        maxRetries: 2
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

dexcomshareSource.validate = function validate_inputs (input) {

  var baseURL = base_for(input);
  var config = { };
  var ok = false;
  var errors = [ ];
  /*
  input.shareRegion
  input.shareServer
  input.shareAccountName
  input.sharePassword
  */

  var config = {
    shareRegion: input.shareRegion,
    shareServer: input.shareServer,
    shareAccountName: input.shareAccountName,
    sharePassword: input.sharePassword,
    baseURL
  };
  if (!config.shareAccountName) {
    errors.push({desc: "Dexcom Share Account Name needed. CONNECT_SHARE_ACCOUNT_NAME must be a valid account name.", err: new Error('CONNECT_SHARE_ACCOUNT_NAME') } );
  }
  if (!config.sharePassword) {
    errors.push({desc: "Dexcom Share Password needed. CONNECT_SHARE_PASSWORD must be the password for the Dexcom Share account.", err: new Error('CONNECT_SHARE_PASSWORD') } );
  }
  ok = errors.length == 0;
  config.kind = ok ? 'dexcomshare' : 'disabled';
  return { ok, errors, config }
}

module.exports = dexcomshareSource;

