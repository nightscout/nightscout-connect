var createLogger = require('../logging');

var url = require('url');
var crypto = require('crypto');
var requestError = require('../machines/request-error');
var transportOptions = require('./librelinkup-options');

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

function sensorInfoForReading(batch, millis, isCurrent) {
  var valid = (sensor) => sensor && typeof sensor.sn === 'string' && sensor.sn &&
    Number.isFinite(sensor.a) && sensor.a > 0;
  var active = Array.isArray(batch.activeSensors) ? batch.activeSensors
    .map((item) => item && item.sensor)
    .filter(valid)
    .sort((a, b) => b.a - a.a) : [ ];
  var current = batch.connection && batch.connection.sensor;
  if (isCurrent && active.length && (!valid(current) ||
    active[0].sn !== current.sn || active[0].a !== current.a)) {
    return { error: 'Current sensor does not match active sensor metadata' };
  }
  var sensor = active.find((item) => item.a * 1000 <= millis);
  if (!active.length && valid(current) && current.a * 1000 <= millis) sensor = current;
  return sensor ? { serialNumber: sensor.sn, activationTimeEpoch: sensor.a }
    : { error: 'No sensor matched reading time' };
}

function epochDate(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  var date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date : null;
}

function idHash(value) {
  return typeof value === 'string' && value ? crypto.createHash('sha256').update(value).digest('hex') : null;
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
function linkUpSource (opts, axios, log) {
  log = log || createLogger(opts.debug);
  var default_headers = { 'Content-Type': Defaults.contentType,
                          'Accept': Defaults.mime,
                          'Accept-Encoding': "gzip, deflate, br",
                          'version': opts.linkUpVersion,
                          'User-Agent': opts.linkUpUserAgent || Defaults.userAgent,
                          'product': opts.linkUpProduct
                        };
  var proxy = proxyFor(opts.linkUpProxy);
  var httpsAgent = opts.linkUpStealthTls ? transportOptions.tlsAgent() : undefined;
  var clientOptions = (baseURL) => ({ baseURL, headers: default_headers,
    timeout: opts.linkUpRequestTimeoutMs || 30000,
    ...(httpsAgent ? { httpsAgent } : {}), ...(proxy !== undefined ? { proxy } : {}) });
  var http = axios.create(clientOptions(opts.baseURL));
  var activeRegion = (opts.linkUpRegion || 'EU').toUpperCase();
  var redirectCount = 0;
  function apiError(response, cause) {
    var body = response && response.data;
    var bodyStatus = Number(body && body.status);
    var status = bodyStatus === 429 ? 429 : requestError.status(cause) ||
      (response && response.status >= 400 ? response.status : bodyStatus || null);
    var error = new Error(status === 429 ? 'LibreLinkUp temporarily throttled; waiting before retry.'
      : `LibreLinkUp request failed${status ? ` (status ${status})` : ''}.`);
    error.status = status;
    error.code = cause && typeof cause.code === 'string' ? cause.code : undefined;
    var lockout = body && body.data && body.data.data && body.data.data.lockout;
    error.retryAfterMs = requestError.retryAfterMs({ response,
      retryAfterMs: status === 429 && Number.isFinite(Number(lockout)) ? Number(lockout) * 1000 : 0 });
    return error;
  }
  async function request(method, path, ...args) {
    var response;
    try { response = await http[method](path, ...args); }
    catch (error) { throw apiError(error.response, error); }
    if (Number(response && response.data && response.data.status) === 429) throw apiError(response);
    return response;
  }
  function resolveAuth(auth, steps) {
    var redirect = auth && auth.data && auth.data.redirect && auth.data.region;
    if (redirect) {
      var nextRegion = String(redirect).toUpperCase();
      if (!_LluApiEndpoints[nextRegion] || redirectCount >= 2 || nextRegion === activeRegion) {
        throw new Error(`LibreLinkUp login could not follow region ${nextRegion}`);
      }
      redirectCount += 1;
      activeRegion = nextRegion;
      log.warn(`LibreLinkUp selected region ${nextRegion}; set CONNECT_LINK_UP_REGION=${nextRegion} to start there.`);
      http = axios.create(clientOptions(base_for({ linkUpRegion: nextRegion })));
      return login(steps);
    }
    if (auth && auth.status === 4) {
      var step = auth.data && auth.data.step && auth.data.step.type;
      var token = auth.data && auth.data.authTicket && auth.data.authTicket.token;
      if (opts.linkUpAutoAcceptTerms && ['tou', 'pp'].includes(step) && token) {
        if (steps >= 4) throw new Error('LibreLinkUp account action required; too many terms steps.');
        return request('post', `/auth/continue/${encodeURIComponent(step)}`, null, {
          headers: { Authorization: `Bearer ${token}` }
        }).then((response) => resolveAuth(response.data, steps + 1));
      }
      var actionMessage = `LibreLinkUp account action required${step ? ` (${step})` : ''}; sign in to LibreLinkUp to continue.`;
      log.warn(actionMessage);
      throw new Error(actionMessage);
    }
    if (!auth || (auth.status !== undefined && auth.status !== 0) || !auth.data || !auth.data.authTicket || !auth.data.authTicket.token) {
      throw new Error(`LibreLinkUp login returned no auth ticket${auth && auth.status !== undefined ? ` (status ${auth.status})` : ''}. Check the account, password and region.`);
    }
    return auth;
  }
  function login (steps = 0) {
    return request('post', Defaults.Login, {
      email: opts.linkUpUsername,
      password: opts.linkUpPassword
    }).then((response) => {
      var auth = response.data;
      log.debug('LibreLinkUp authentication completed');
      return resolveAuth(auth, steps);
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
      return request('get', Defaults.Connections, { headers }).then((resp) => {
        if (resp.data && resp.data.status !== undefined && resp.data.status !== 0) throw apiError(resp);
        log.debug('LibreLinkUp connections fetched');
        var connections = resp && resp.data && resp.data.data;
        if (!Array.isArray(connections)) {
          throw new Error('LibreLinkUp connections response is invalid.');
        }

        if (connections.length == 0) {
          var err = new Error("NO CONNECTION WITH LIBRE LINKUP AVAILABLE");
          throw err;
        }
        if (opts.linkUpPatientId) {
          connections = connections.filter(isPatient);
          if (!connections.length) {
            throw new Error("NO MATCHING LIBRE LINKUP PATIENT ID AVAILABLE");
          }
        }
        if (connections.length > 1) {
          log.warn("Multiple LibreLinkUp patients available; set CONNECT_LINK_UP_PATIENT_ID to select one.")
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
      return request('get', graph_url, { headers }).then((resp) => {
        if (resp.data && resp.data.status !== undefined && resp.data.status !== 0) throw apiError(resp);
        if (!resp.data || !resp.data.data || typeof resp.data.data !== 'object' || Array.isArray(resp.data.data)) {
          throw new Error('LibreLinkUp graph response is invalid.');
        }
        return resp.data;
      });
    },
    transformGlucose (payload, last_known) {
      var batch = payload && payload.data ? payload.data : {};

      function to_ns_sgv (elem, isCurrent) {
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
          entry.sensorInfo = sensorInfoForReading(batch, dateTime.getTime(), isCurrent);
        }
        return entry;
      }

      var graphData = Array.isArray(batch.graphData) ? batch.graphData : [ ];
      var currentReading = batch.connection && (batch.connection.glucoseMeasurement || batch.connection.glucoseItem);
      var current = currentReading ? [ currentReading ] : [ ];
      // add current value to the list to avoid 20min delay, remove filtering since NS automatically removes duplicates
      var entries = graphData.map((row) => to_ns_sgv(row, false))
        .concat(current.map((row) => to_ns_sgv(row, true))).filter(Boolean);
      var treatments = [ ];
      var devicestatus = [ ];
      var profiles = [ ];
      if (opts.linkUpSensorInfo) {
        var connection = batch.connection || { };
        var sensor = connection.sensor;
        var device = connection.patientDevice;
        var startedAt = sensor ? epochDate(sensor.a) : null;
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
                serialHash: idHash(sensor.sn),
                startedAt: startedAt ? startedAt.toISOString() : null,
                startedAtEpoch: startedAt ? sensor.a : null,
                ageSeconds: startedAt ? Math.max(0, Math.floor(newest / 1000 - sensor.a)) : null,
                warmupMinutes: Number.isFinite(sensor.w) ? sensor.w : null,
                state: typeof sensor.s === 'boolean' ? sensor.s : null,
                lastJoin: typeof sensor.lj === 'boolean' ? sensor.lj : null,
                patchType: Number.isFinite(sensor.pt) ? sensor.pt : null
              } } : {}),
              ...(device ? { patientDevice: {
                deviceIdHash: idHash(device.did),
                deviceTypeId: Number.isFinite(device.dtid) ? device.dtid : null,
                appVersion: typeof device.v === 'string' ? device.v : null,
                alarms: typeof device.alarms === 'boolean' ? device.alarms : null,
                lowAlarm: typeof device.l === 'boolean' ? device.l : null,
                highAlarm: typeof device.h === 'boolean' ? device.h : null,
                lowAlarmThresholdMgDl: Number.isFinite(device.ll) ? device.ll : null,
                highAlarmThresholdMgDl: Number.isFinite(device.hl) ? device.hl : null,
                lastUpload: epochDate(device.u) ? epochDate(device.u).toISOString() : null,
                fixedLowAlarmValues: device.fixedLowAlarmValues && typeof device.fixedLowAlarmValues === 'object'
                  ? {
                    mgdl: Number.isFinite(device.fixedLowAlarmValues.mgdl) ? device.fixedLowAlarmValues.mgdl : null,
                    mmoll: Number.isFinite(device.fixedLowAlarmValues.mmoll) ? device.fixedLowAlarmValues.mmoll : null
                  } : null,
                fixedLowThreshold: Number.isFinite(device.fixedLowThreshold) ? device.fixedLowThreshold : null
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
        // Retry ordinary failures within a frame; throttle responses end it.
        maxRetries: opts.linkUpMaxRetries === undefined ? 2 : opts.linkUpMaxRetries,
        retry_interval_ms: opts.linkUpRetryIntervalMs || 150000,
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
  // Preserve the existing starting route. Shared timezone-based configuration
  // belongs in a separate change with compatibility across all sources.
  var region = input.linkUpRegion || 'EU';
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
  function boundedInteger(value, name, fallback, minimum, maximum) {
    if (value === undefined || value === null || value === '') return fallback;
    var number = Number(value);
    if (!Number.isInteger(number) || number < minimum || number > maximum) {
      errors.push({ desc: `${name} must be an integer from ${minimum} to ${maximum}`, err: new Error(name) });
      return fallback;
    }
    return number;
  }
  var interval = input.linkUpInterval === undefined || input.linkUpInterval === null || input.linkUpInterval === ''
    ? 5 : Number(input.linkUpInterval);
  if (!Number.isInteger(interval) || interval < 1 || interval > 60) {
    errors.push({ desc: 'CONNECT_LINK_UP_INTERVAL must be an integer from 1 to 60 minutes', err: new Error('CONNECT_LINK_UP_INTERVAL') });
  }
  try {
    baseURL = base_for({ ...input, linkUpRegion: region });
  } catch (err) {
    errors.push({ desc: err.message, err });
  }
  var config = {
    linkUpRegion: region,
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
    linkUpStealthTls: input.linkUpStealthTls === true || input.linkUpStealthTls === 'true' || input.linkUpStealthTls === '1',
    linkUpMaxRetries: boundedInteger(input.linkUpMaxRetries, 'CONNECT_LINK_UP_MAX_RETRIES', 2, 0, 5),
    linkUpRetryIntervalMs: boundedInteger(input.linkUpRetryIntervalMs, 'CONNECT_LINK_UP_RETRY_INTERVAL_MS', 150000, 1000, 900000),
    linkUpRequestTimeoutMs: boundedInteger(input.linkUpRequestTimeoutMs, 'CONNECT_LINK_UP_REQUEST_TIMEOUT_MS', 30000, 1000, 120000),
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
