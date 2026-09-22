
var url = require('url');
var crypto = require('crypto');

const _LluApiEndpoints = {
    AE: "api-ae.libreview.io",
    AP: "api-ap.libreview.io",
    AU: "api-au.libreview.io",
    CA: "api-ca.libreview.io",
    DE: "api-de.libreview.io",
    EU: "api-eu.libreview.io",
    EU2: "api-eu2.libreview.io",
    GB: "api-eu2.libreview.io",
    UK: "api-eu2.libreview.io",
    FR: "api-fr.libreview.io",
    JP: "api-jp.libreview.io",
    US: "api-us.libreview.io",
}

var Defaults = {
  Login: '/llu/auth/login',
  Connections: '/llu/connections',
  Graph: '/llu/connections/',
  mime: 'application/json',
  Version: '4.16.0',
  Product: 'llu.ios',

};
var software = require('../../package.json');
var user_agent_string = [software.name, `${software.name}@${software.version}`, `LibreView@${Defaults.Version}`, software.homepage].join(', ');

function mapArrowTrend (trend) {
  return mapArrowTrend.map[trend] || mapArrowTrend.map.default;
}
mapArrowTrend.map = {
  1: 'SingleDown',
  2: 'FortyFiveDown',
  3: 'Flat',
  4: 'FortyFiveUp',
  5: 'SingleUp',
  default: 'NOT COMPUTABLE'
};

function parseFactoryTimestamp (timestamp) {
  var dateTime = new Date(timestamp);
  var hasExplicitZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(timestamp);
  if (!hasExplicitZone) {
    var offset = dateTime.getTimezoneOffset( ) * 60 * 1000;
    dateTime.setTime(dateTime.getTime( ) - offset);
  }
  return dateTime;
}

function base_for (spec) {
  var region = (spec.linkUpRegion || 'EU').toUpperCase( );
  var server = spec.linkUpServer ? spec.linkUpServer : _LluApiEndpoints[region];
  if (!server) {
    throw new Error(`Unsupported LibreLinkUp region ${region}`);
  }
  var base = {
    protocol: 'https',
    host: server
  };
  return url.format(base);
}
function linkUpSource (opts, axios) {
  var default_headers = { 'Content-Type': Defaults.mime,
                          'Accept': Defaults.mime,
                          'Accept-Encoding': "gzip, deflate, br",
                          'version': opts.linkUpVersion,
                          'User-Agent': user_agent_string,
                          'product': opts.linkUpProduct
                        };
  var http = axios.create({ baseURL: opts.baseURL, headers: default_headers });
  var activeRegion = (opts.linkUpRegion || 'EU').toUpperCase();
  var redirectCount = 0;
  function login () {
    return http.post(Defaults.Login, {
      email: opts.linkUpUsername,
      password: opts.linkUpPassword
    }).then((response) => {
      var auth = response.data;
      var redirect = auth && auth.data && auth.data.redirect && auth.data.region;
      if (redirect) {
        var nextRegion = String(redirect).toUpperCase();
        if (!_LluApiEndpoints[nextRegion] || redirectCount >= 2 || nextRegion === activeRegion) {
          throw new Error(`LibreLinkUp login could not follow region ${nextRegion}`);
        }
        redirectCount += 1;
        activeRegion = nextRegion;
        http = axios.create({ baseURL: base_for({ linkUpRegion: nextRegion }), headers: default_headers });
        return login();
      }
      if (auth && auth.status === 4) {
        var step = auth.data && auth.data.step && auth.data.step.type;
        var actionMessage = `LibreLinkUp account action required${step ? ` (${step})` : ''}; sign in to LibreLinkUp to continue.`;
        console.warn(actionMessage);
        throw new Error(actionMessage);
      }
      if (!auth || !auth.data || !auth.data.authTicket || !auth.data.authTicket.token) {
        throw new Error(`LibreLinkUp login returned no auth ticket${auth && auth.status !== undefined ? ` (status ${auth.status})` : ''}. Check the account, password and region.`);
      }
      return auth;
    });
  }
  var impl = {
    authFromCredentials ( ) {
      redirectCount = 0;
      return login();
    },
    sessionFromAuth (auth) {
      function isPatient (elem) {
        return elem.patientId == opts.linkUpPatientId;
      }
      var token = auth && auth.data && auth.data.authTicket && auth.data.authTicket.token;
      var userId = auth && auth.data && auth.data.user && auth.data.user.id;
      if (!token || typeof userId !== 'string' || !userId) {
        throw new Error('LibreLinkUp login response missing auth ticket or user ID.');
      }
      var accountId = crypto.createHash('sha256').update(userId).digest('hex');
      var headers = {
        'Authorization': [ 'Bearer', token ].join(' '),
        'Account-Id': accountId
      };
      return http.get(Defaults.Connections, { headers }).then((resp) => {
        var connections = resp && resp.data && resp.data.data;
        if (!Array.isArray(connections)) {
          throw new Error('LibreLinkUp connections response is invalid.');
        }

        if (connections.length == 0) {
          var err = new Error("NO CONNECTION WITH LIBRE LINKUP AVAILABLE");
          throw err;
        }
        if (connections.length > 1 && opts.linkUpPatientId) {
          connections = connections.filter(isPatient);
          if (!connections.length) {
            throw new Error("NO MATCHING LIBRE LINKUP PATIENT ID AVAILABLE");
          }
        }
        if (connections.length > 1) {
          console.warn("Multiple LibreLinkUp patients available; set CONNECT_LINK_UP_PATIENT_ID to select one.")
        }
        var result = connections[0];
        result.authTicket = auth.data.authTicket;
        result.accountId = accountId;
        return result;

      });
      // return Promise.resolve(auth.data.authTicket);
    },
    dataFromSesssion (session, last_known) {
      var graph_url = [Defaults.Graph, session.patientId, '/graph'].join('');
      var token = session && session.authTicket && session.authTicket.token;
      var accountId = session && session.accountId;
      if (!token || !accountId) {
        throw new Error('LibreLinkUp session missing auth ticket or account ID.');
      }
      var headers = {
        'Authorization': `Bearer ${token}`,
        'Account-Id': accountId
      };
      return http.get(graph_url, { headers }).then((resp) => {
        return resp.data;
      });
    },
    transformGlucose (payload, last_known) {
      var batch = payload && payload.data ? payload.data : {};

      function to_ns_sgv (elem) {
        var dateTime = parseFactoryTimestamp(elem.FactoryTimestamp);
        return {
          type: 'sgv',
          device: 'nightscout-connect-librelinkup',
          dateString: dateTime.toISOString( ),
          date: dateTime.getTime( ),
          direction: mapArrowTrend(elem.TrendArrow),
          sgv: elem.ValueInMgPerDl,
        };
      }

      var graphData = Array.isArray(batch.graphData) ? batch.graphData : [ ];
      var current = batch.connection && batch.connection.glucoseItem ? [ batch.connection.glucoseItem ] : [ ];
      // add current value to the list to avoid 20min delay, remove filtering since NS automatically removes duplicates
      var entries = graphData.concat(current).map(to_ns_sgv);
      var treatments = [ ];
      var devicestatus = [ ];
      var profiles = [ ];
      return { entries, treatments, devicestatus, profiles };
    },
    align_to_glucose (last_known) {
      if (!last_known || !last_known.entries) {
        return;
      }
      // var last_glucose_at = new Date(last_known.sgvs.mills);
      var last_glucose_at = last_known.entries;
      var missing = ((new Date( )).getTime( ) - last_glucose_at.getTime( )) / (1000 * 60 * opts.linkUpInterval)
      var next_due = last_glucose_at.getTime( ) + (Math.ceil(missing) * 1000 * 60 * opts.linkUpInterval);
      var buffer_lag = 18000; // 18 second buffer
      var jitter = Math.floor(Math.random( ) * 1000 * 18); // 18 second random
      var align_to = next_due + buffer_lag + jitter;
      return align_to;
    }
  };
  function tracker_for ( ) {
    var AxiosTracer = require('../trace-axios');
    var tracker = AxiosTracer(http);
    return tracker;
  }
  function generate_driver (builder) {
    builder.support_session({
      authenticate: impl.authFromCredentials,
      authorize: impl.sessionFromAuth,
      // refresh: impl.refreshSession,
      delays: {
        REFRESH_AFTER_SESSSION_DELAY: 3600000 - 600000,
        EXPIRE_SESSION_DELAY: 3600000
      }
    });



    builder.register_loop('LibreLinkUp', {
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
        maxRetries: 2,
        noRetryStatuses: [429]
      },
      // expect new data 5 minutes after last success
      expected_data_interval_ms: opts.linkUpInterval * 60 * 1000,
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
linkUpSource.validate = function validate_inputs (input) {
  var ok = false;
  var baseURL;
  var errors = [ ];
  try {
    baseURL = base_for(input);
  } catch (err) {
    errors.push({ desc: err.message, err });
  }
  var config = {
    linkUpRegion: input.linkUpRegion,
    linkUpServer: input.linkUpServer,
    linkUpUsername: input.linkUpUsername,
    linkUpPassword: input.linkUpPassword,
    linkUpPatientId: input.linkUpPatientId,
    linkUpInterval: input.linkUpInterval || 5,
    linkUpVersion: input.linkUpVersion || Defaults.Version,
    linkUpProduct: input.linkUpProduct || Defaults.Product,
    baseURL
  };
  if (!config.linkUpUsername) {
    errors.push({desc: "The LibreLinkUp Username is required.. CONNECT_LINK_UP_USERNAME must be an active LibreLinkUp User to log in.", err: new Error('CONNECT_LINK_UP_USERNAME') } );
  }
  if (!config.linkUpPassword) {
    errors.push({desc: "LibreLinkUp Password is required. CONNECT_LINK_UP_PASSWORD must be the password for the LibreLinkUp User in order to login.", err: new Error('CONNECT_LINK_UP_PASSWORD') } );
  }
  ok = errors.length == 0;
  config.kind = ok ? 'linkUp' : 'disabled';
  return { ok, errors, config };
}
module.exports = linkUpSource;
