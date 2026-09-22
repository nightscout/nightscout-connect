
var url = require('url');
var crypto = require('crypto');

const _LluApiEndpoints = {
    AE: "api-ae.libreview.io",
    AP: "api-ap.libreview.io",
    AU: "api-au.libreview.io",
    CA: "api-ca.libreview.io",
    CN: "api-cn.myfreestyle.cn",
    DE: "api-de.libreview.io",
    EU: "api-eu.libreview.io",
    EU2: "api-eu2.libreview.io",
    GB: "api-eu2.libreview.io",
    UK: "api-eu2.libreview.io",
    FR: "api-fr.libreview.io",
    JP: "api-jp.libreview.io",
    LA: "api-la.libreview.io",
    RU: "api.libreview.ru",
    US: "api-us.libreview.io",
}

var Defaults = {
  Login: '/llu/auth/login',
  Connections: '/llu/connections',
  Graph: '/llu/connections/',
  mime: 'application/json',
  contentType: 'application/json;charset=UTF-8',
  userAgent: 'Mozilla/5.0 (iPhone; CPU OS 17_4.1 like Mac OS X) AppleWebKit/536.26 (KHTML, like Gecko) Version/17.4.1 Mobile/10A5355d Safari/8536.25',
  Version: '4.16.0',
  Product: 'llu.ios',

};
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
  if (!timestamp) {
    return null;
  }
  var dateTime = new Date(timestamp);
  if (!Number.isFinite(dateTime.getTime())) {
    return null;
  }
  var hasExplicitZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(timestamp);
  if (!hasExplicitZone) {
    var offset = dateTime.getTimezoneOffset( ) * 60 * 1000;
    dateTime.setTime(dateTime.getTime( ) - offset);
  }
  return dateTime;
}

function sensorForReading(batch, millis) {
  var active = Array.isArray(batch.activeSensors) ? batch.activeSensors
    .map((item) => item && item.sensor)
    .filter((sensor) => sensor && sensor.sn && Number.isFinite(sensor.a) && sensor.a * 1000 <= millis)
    .sort((a, b) => b.a - a.a) : [ ];
  if (active.length) return active[0];
  var current = batch.connection && batch.connection.sensor;
  return current && current.sn && Number.isFinite(current.a) && current.a * 1000 <= millis ? current : null;
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
function proxyFor (setting) {
  if (!setting || setting === 'env') return undefined;
  if (setting === 'direct') return false;
  var parsed;
  try { parsed = new URL(setting); } catch (_) { throw new Error('Invalid CONNECT_LINK_UP_PROXY setting'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Invalid CONNECT_LINK_UP_PROXY setting');
  }
  return {
    protocol: parsed.protocol.slice(0, -1),
    host: parsed.hostname,
    port: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)),
    ...(parsed.username ? { auth: {
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password)
    } } : {})
  };
}
function linkUpSource (opts, axios) {
  var default_headers = { 'Content-Type': Defaults.contentType,
                          'Accept': Defaults.mime,
                          'Accept-Encoding': "gzip, deflate, br",
                          'version': opts.linkUpVersion,
                          'User-Agent': opts.linkUpUserAgent || Defaults.userAgent,
                          'product': opts.linkUpProduct
                        };
  var proxy = proxyFor(opts.linkUpProxy);
  var clientOptions = (baseURL) => ({ baseURL, headers: default_headers, ...(proxy !== undefined ? { proxy } : {}) });
  var http = axios.create(clientOptions(opts.baseURL));
  var activeRegion = (opts.linkUpRegion || 'EU').toUpperCase();
  var redirectCount = 0;
  function resolveAuth(auth, steps) {
    if (auth && auth.status === 4) {
      var step = auth.data && auth.data.step && auth.data.step.type;
      var token = auth.data && auth.data.authTicket && auth.data.authTicket.token;
      if (opts.linkUpAutoAcceptTerms && ['tou', 'pp'].includes(step) && token) {
        if (steps >= 4) throw new Error('LibreLinkUp account action required; too many terms steps.');
        return http.post(`/auth/continue/${encodeURIComponent(step)}`, null, {
          headers: { Authorization: `Bearer ${token}` }
        }).then((response) => resolveAuth(response.data, steps + 1));
      }
      var actionMessage = `LibreLinkUp account action required${step ? ` (${step})` : ''}; sign in to LibreLinkUp to continue.`;
      console.warn(actionMessage);
      throw new Error(actionMessage);
    }
    if (!auth || !auth.data || !auth.data.authTicket || !auth.data.authTicket.token) {
      throw new Error(`LibreLinkUp login returned no auth ticket${auth && auth.status !== undefined ? ` (status ${auth.status})` : ''}. Check the account, password and region.`);
    }
    return auth;
  }
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
        http = axios.create(clientOptions(base_for({ linkUpRegion: nextRegion })));
        return login();
      }
      return resolveAuth(auth, 0);
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
        if (!elem) {
          return null;
        }
        var dateTime = parseFactoryTimestamp(elem.FactoryTimestamp || elem.Timestamp);
        var sgv = typeof elem.ValueInMgPerDl === 'number' ? elem.ValueInMgPerDl : elem.Value;
        if (!dateTime || !Number.isFinite(sgv)) {
          return null;
        }
        var entry = {
          type: 'sgv',
          device: 'nightscout-connect-librelinkup',
          dateString: dateTime.toISOString( ),
          date: dateTime.getTime( ),
          direction: mapArrowTrend(elem.TrendArrow),
          sgv,
        };
        if (opts.linkUpSensorInfo) {
          var sensor = sensorForReading(batch, dateTime.getTime());
          entry.sensorInfo = sensor
            ? { serialNumber: sensor.sn, activationTimeEpoch: sensor.a }
            : { error: 'No sensor matched reading time' };
        }
        return entry;
      }

      var graphData = Array.isArray(batch.graphData) ? batch.graphData : [ ];
      var currentReading = batch.connection && (batch.connection.glucoseMeasurement || batch.connection.glucoseItem);
      var current = currentReading ? [ currentReading ] : [ ];
      // add current value to the list to avoid 20min delay, remove filtering since NS automatically removes duplicates
      var entries = graphData.concat(current).map(to_ns_sgv).filter(Boolean);
      var treatments = [ ];
      var devicestatus = [ ];
      var profiles = [ ];
      if (opts.linkUpSensorInfo) {
        var connection = batch.connection || { };
        var sensor = connection.sensor;
        var device = connection.patientDevice;
        var startedAt = sensor && Number.isFinite(sensor.a) && sensor.a > 0 ? new Date(sensor.a * 1000) : null;
        var lastSensorStart = last_known && last_known.sensorStart instanceof Date
          ? last_known.sensorStart.getTime() : 0;
        if (startedAt && Number.isFinite(startedAt.getTime()) && startedAt.getTime() > lastSensorStart) {
          treatments.push({
            eventType: 'Sensor Start',
            created_at: startedAt.toISOString(),
            enteredBy: 'librelinkup',
            identifier: `librelinkup:sensor-start:${crypto.createHash('sha256').update(`${sensor.sn || ''}:${sensor.a}`).digest('hex')}`,
            notes: sensor.sn ? `LibreLinkUp sensor start (SN ${sensor.sn})` : 'LibreLinkUp sensor start'
          });
        }
        var newest = entries.reduce((time, entry) => Math.max(time, entry.date), 0);
        var lastStatus = last_known && last_known.librelinkupStatus instanceof Date
          ? last_known.librelinkupStatus.getTime() : 0;
        if (newest > lastStatus && (sensor || device)) {
          devicestatus.push({
            device: 'nightscout-connect-librelinkup',
            created_at: new Date(newest).toISOString(),
            librelinkup: {
              ...(sensor ? { sensor: {
                serialHash: sensor.sn ? crypto.createHash('sha256').update(sensor.sn).digest('hex') : null,
                startedAt: startedAt ? startedAt.toISOString() : null,
                ageSeconds: startedAt ? Math.max(0, Math.floor(newest / 1000 - sensor.a)) : null,
                warmupMinutes: Number.isFinite(sensor.w) ? sensor.w : null
              } } : {}),
              ...(device ? { patientDevice: {
                deviceIdHash: device.did ? crypto.createHash('sha256').update(device.did).digest('hex') : null,
                appVersion: device.v || null,
                lowAlarmThresholdMgDl: Number.isFinite(device.ll) ? device.ll : null,
                highAlarmThresholdMgDl: Number.isFinite(device.hl) ? device.hl : null
              } } : {})
            }
          });
        }
      }
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
      throttle_backoff_per_error_ms: 60 * 1000,
      throttle_monitor_enabled: true,
      startup_jitter_ms: opts.linkUpStartupJitterMs,
      expected_interval_jitter_ms: opts.linkUpIntervalJitterMs,
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
  try { proxyFor(input.linkUpProxy); } catch (err) {
    errors.push({ desc: 'CONNECT_LINK_UP_PROXY must be env, direct, or an HTTP(S) proxy URL', err });
  }
  function nonNegativeMs(value, name, maximum) {
    if (value === undefined || value === null || value === '') return 0;
    var number = Number(value);
    if (!Number.isInteger(number) || number < 0 || number > maximum) {
      errors.push({ desc: `${name} must be an integer from 0 to ${maximum}`, err: new Error(name) });
      return 0;
    }
    return number;
  }
  var interval = input.linkUpInterval === undefined || input.linkUpInterval === null || input.linkUpInterval === ''
    ? 5 : Number(input.linkUpInterval);
  if (!Number.isInteger(interval) || interval < 1 || interval > 60) {
    errors.push({ desc: 'CONNECT_LINK_UP_INTERVAL must be an integer from 1 to 60 minutes', err: new Error('CONNECT_LINK_UP_INTERVAL') });
  }
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
    linkUpInterval: interval,
    linkUpStartupJitterMs: nonNegativeMs(input.linkUpStartupJitterMs, 'CONNECT_LINK_UP_STARTUP_JITTER_MS', 300000),
    linkUpIntervalJitterMs: nonNegativeMs(input.linkUpIntervalJitterMs, 'CONNECT_LINK_UP_INTERVAL_JITTER_MS', 30000),
    linkUpVersion: input.linkUpVersion || Defaults.Version,
    linkUpProduct: input.linkUpProduct || Defaults.Product,
    linkUpUserAgent: input.linkUpUserAgent || Defaults.userAgent,
    linkUpSensorInfo: input.linkUpSensorInfo === true || input.linkUpSensorInfo === 'true' || input.linkUpSensorInfo === '1',
    linkUpAutoAcceptTerms: input.linkUpAutoAcceptTerms === true || input.linkUpAutoAcceptTerms === 'true' || input.linkUpAutoAcceptTerms === '1',
    linkUpProxy: input.linkUpProxy,
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
