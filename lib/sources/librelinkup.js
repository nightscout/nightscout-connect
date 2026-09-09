var createLogger = require('../logging');

var qs = require('qs');
var url = require('url');

const _LluApiEndpoints = {
    AE: "api-ae.libreview.io",
    AP: "api-ap.libreview.io",
    AU: "api-au.libreview.io",
    CA: "api-ca.libreview.io",
    DE: "api-de.libreview.io",
    EU: "api-eu.libreview.io",
    EU2: "api-eu2.libreview.io",
    FR: "api-fr.libreview.io",
    JP: "api-jp.libreview.io",
    US: "api-us.libreview.io",
}

var Defaults = {
  Login: '/llu/auth/login',
  Connections: '/llu/connections',
  Graph: '/llu/connections/',
  mime: 'application/json',
  Version: '4.7.0',
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
  var server = spec.linkUpServer ? spec.linkUpServer : (_LluApiEndpoints[region] || _LluApiEndpoints.EU);
  var base = {
    protocol: 'https',
    host: server
  };
  return url.format(base);
}
function linkUpSource (opts, axios, log) {
  log = log || createLogger(opts.debug);
  var default_headers = { 'Content-Type': Defaults.mime,
                          'Accept': Defaults.mime,
                          'Accept-Encoding': "gzip, deflate, br",
                          'version': opts.linkUpVersion,
                          'User-Agent': user_agent_string,
                          'product': opts.linkUpProduct
                        };
  var baseURL = opts.baseURL;
  var http = axios.create({ baseURL, headers: default_headers });
  var impl = {
    authFromCredentials ( ) {
      var payload = {
        email: opts.linkUpUsername,
        password: opts.linkUpPassword
      };
      return http.post(Defaults.Login, payload).then((response) => {
        log.debug("LibreLinkUp authentication completed");
        return response.data;

      });
    },
    sessionFromAuth (auth) {
      function isPatient (elem) {
        return elem.patientId == opts.linkUpPatientId;
      }
      var token = auth.data.authTicket.token;
      var headers = {
        'Authorization': [ 'Bearer', token ].join(' ')
      };
      return http.get(Defaults.Connections, { headers }).then((resp) => {
        log.debug("LibreLinkUp connections fetched");
        var connections = resp.data.data;

        if (connections.length == 0) {
          var err = new Error("NO CONNECTION WITH LIBRE LINKUP AVAILABLE");
          log.error("No LibreLinkUp connection available");
          throw err;
        }
        if (connections.length > 1 && opts.linkUpPatientId) {
          connections = connections.filter(isPatient);
          if (!connections.length) {
            throw new Error("NO MATCHING LIBRE LINKUP PATIENT ID AVAILABLE");
          }
        }
        if (connections.length > 1) {
          log.warn("Multiple LibreLinkUp patients: set CONNECT_LINK_UP_PATIENT_ID to select a patient")
        }
        var result = connections[0];
        result.authTicket = auth.data.authTicket;
        log.debug("LibreLinkUp session established");
        return result;

      });
      // return Promise.resolve(auth.data.authTicket);
    },
    dataFromSesssion (session, last_known) {
      var two_days_ago = new Date( ).getTime( ) - (2 * 24 * 60 * 60 * 1000);
      var last_mills = Math.max(two_days_ago, (last_known && last_known.entries) ? last_known.entries.getTime( ) : two_days_ago);
      var last_glucose_at = new Date(last_mills);
      var maxCount = Math.ceil(((new Date( )).getTime( ) - last_mills) / (1000 * 60 * 5));
      var minutes = 5 * maxCount;
      var lastUpdatedAt = last_glucose_at.toISOString( );
      var graph_url = [Defaults.Graph, session.patientId, '/graph'].join('');
      var token = session.authTicket.token;
      var headers = {
        'Authorization': `Bearer ${token}`
      };
      return http.get(graph_url, { headers }).then((resp) => {
        log.debug("LibreLinkUp graph fetched");
        return resp.data;
      });
    },
    transformGlucose (payload, last_known) {
      var { status, data, ticket } = payload;
      var batch = data;
      // TODO: TRANSFORM
      var last_updated = (last_known && last_known.entries) ? last_known.entries : null;
      function is_newer (elem) {
        if (!last_known) { return true; };
        return last_known.entries < new Date(elem.dateString);
      }

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
      log.debug("LibreLinkUp data transformed");
      return { entries, treatments, devicestatus, profiles };
    },
    align_to_glucose (last_known) {
      log.debug("Aligning LibreLinkUp polling schedule");
      if (!last_known || !last_known.entries) {
        return;
      }
      // var last_glucose_at = new Date(last_known.sgvs.mills);
      var last_glucose_at = last_known.entries;
      var missing = ((new Date( )).getTime( ) - last_glucose_at.getTime( )) / (1000 * 60 * opts.linkUpInterval)
      if (missing > 1 && missing < 3) {
        log.debug("LibreLinkUp polling schedule adjusted");

      }
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
        maxRetries: 2
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
  var baseURL = base_for(input);
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
  var errors = [ ];
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
