/*
*
* https://github.com/jonfawcett/glooko2nightscout-bridge/blob/master/index.js#L146
* Authors:
* Jeremy Pollock
* https://github.com/jpollock
* Jon Fawcett
* and others.
*/

var qs = require('qs');
var url = require('url');
var uid = require('uid');

var helper = require('./convert');

function makeUid (length) {
  var generator = typeof uid === 'function' ? uid : uid.uid;
  return generator(length);
}

_known_servers = {
  default: 'api.glooko.com'
, development: 'api.glooko.work'
, production: 'externalapi.glooko.com'
, eu: 'eu.api.glooko.com'
, ca: 'ca.api.glooko.com'
};
var _known_web_origins = {
  default: 'https://my.glooko.com',
  development: 'https://my.glooko.work',
  production: 'https://my.glooko.com',
  eu: 'https://eu.my.glooko.com',
  ca: 'https://ca.my.glooko.com'
};

var Defaults = {
  "applicationId":"d89443d2-327c-4a6f-89e5-496bbb0317db"
, "lastGuid":"1e0c094e-1e54-4a4f-8e6a-f94484b53789" // hardcoded, random guid; no Glooko docs to explain need for param or why bad data works
, login: '/api/v2/users/sign_in'
, WebSignIn: '/users/sign_in?locale=en-GB'
, mime: 'application/json'
, LatestFoods: '/api/v2/foods'
, LatestInsulins: '/api/v2/insulins'
, LatestPumpBasals: '/api/v2/pumps/scheduled_basals'
, LatestPumpBolus: '/api/v2/pumps/normal_boluses'
, LatestCGMReadings: '/api/v2/cgm/readings'
, PumpSettings: '/api/v2/external/pumps/settings'
, V3GraphData: '/api/v3/graph/data'
, v3API: '/api/v3/graph/data?patient=_PATIENT_&startDate=_STARTDATE_&endDate=_ENDDATE_&series[]=automaticBolus&series[]=basalBarAutomated&series[]=basalBarAutomatedMax&series[]=basalBarAutomatedSuspend&series[]=basalLabels&series[]=basalModulation&series[]=bgAbove400&series[]=bgAbove400Manual&series[]=bgHigh&series[]=bgHighManual&series[]=bgLow&series[]=bgLowManual&series[]=bgNormal&series[]=bgNormalManual&series[]=bgTargets&series[]=carbNonManual&series[]=cgmCalibrationHigh&series[]=cgmCalibrationLow&series[]=cgmCalibrationNormal&series[]=cgmHigh&series[]=cgmLow&series[]=cgmNormal&series[]=deliveredBolus&series[]=deliveredBolus&series[]=extendedBolusStep&series[]=extendedBolusStep&series[]=gkCarb&series[]=gkInsulin&series[]=gkInsulin&series[]=gkInsulinBasal&series[]=gkInsulinBolus&series[]=gkInsulinOther&series[]=gkInsulinPremixed&series[]=injectionBolus&series[]=injectionBolus&series[]=interruptedBolus&series[]=interruptedBolus&series[]=lgsPlgs&series[]=overrideAboveBolus&series[]=overrideAboveBolus&series[]=overrideBelowBolus&series[]=overrideBelowBolus&series[]=pumpAdvisoryAlert&series[]=pumpAlarm&series[]=pumpBasaliqAutomaticMode&series[]=pumpBasaliqManualMode&series[]=pumpCamapsAutomaticMode&series[]=pumpCamapsBluetoothTurnedOffMode&series[]=pumpCamapsBoostMode&series[]=pumpCamapsDailyTotalInsulinExceededMode&series[]=pumpCamapsDepoweredMode&series[]=pumpCamapsEaseOffMode&series[]=pumpCamapsExtendedBolusNotAllowedMode&series[]=pumpCamapsManualMode&series[]=pumpCamapsNoCgmMode&series[]=pumpCamapsNoPumpConnectivityMode&series[]=pumpCamapsPumpDeliverySuspendedMode&series[]=pumpCamapsUnableToProceedMode&series[]=pumpControliqAutomaticMode&series[]=pumpControliqExerciseMode&series[]=pumpControliqManualMode&series[]=pumpControliqSleepMode&series[]=pumpGenericAutomaticMode&series[]=pumpGenericManualMode&series[]=pumpOp5AutomaticMode&series[]=pumpOp5HypoprotectMode&series[]=pumpOp5LimitedMode&series[]=pumpOp5ManualMode&series[]=reservoirChange&series[]=scheduledBasal&series[]=setSiteChange&series[]=suggestedBolus&series[]=suggestedBolus&series[]=suspendBasal&series[]=temporaryBasal&series[]=unusedScheduledBasal&locale=en-GB'
// ?sessionID=e59c836f-5aeb-4b95-afa2-39cf2769fede&minutes=1440&maxCount=1"
};
var V3_CGM_SERIES = [ 'cgmHigh', 'cgmNormal', 'cgmLow' ];

function base_for (spec) {
  var server = spec.glookoServer ? spec.glookoServer : _known_servers[spec.glookoEnv || 'default' ];
  var base = {
    protocol: 'https',
    host: server
  };
  return url.format(base);
}
function web_origin_for (spec) {
  if (spec.glookoWebOrigin) {
    return spec.glookoWebOrigin;
  }
  if (!spec.glookoServer && !spec.baseURL) {
    return _known_web_origins[spec.glookoEnv || 'default'];
  }
  var host = spec.glookoServer || url.parse(spec.baseURL).host;
  var derived = host.replace(/^api\./, 'my.').replace(/\.api\./, '.my.');
  return 'https://' + derived;
}
function boolish (value) {
  return value === true || value === 'true' || value === '1' || value === 1 || value === 'yes';
}
function authModeFor (value) {
  return [ 'api', 'web', 'auto' ].includes(value) ? value : 'api';
}
function extractSetCookie (headers) {
  var cookies = headers && (headers['set-cookie'] || headers['Set-Cookie']);
  if (Array.isArray(cookies)) {
    return cookies[0];
  }
  return cookies;
}
function extractAuthenticityToken (html) {
  var match = html && html.match(/name=["']authenticity_token["'][^>]*value=["']([^"']+)["']/i);
  if (!match) {
    match = html && html.match(/value=["']([^"']+)["'][^>]*name=["']authenticity_token["']/i);
  }
  if (!match) {
    match = html && html.match(/name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i);
  }
  if (!match) {
    match = html && html.match(/content=["']([^"']+)["'][^>]*name=["']csrf-token["']/i);
  }
  return match && match[1];
}
function assertNoTwoFactorRequired (data) {
  var required = data && (data.twoFaRequired || data.two_fa_required || data.twoFactorRequired);
  if (required) {
    throw new Error('Glooko sign-in requires two-factor authentication, which nightscout-connect does not support yet.');
  }
}

function login_payload (opts) {
  var deviceId = opts.glookoDeviceId || makeUid(16);
  var serialNumber = opts.glookoSerialNumber || makeUid(24);
  var body = {
    "userLogin": {
      "email": opts.glookoEmail,
      "password": opts.glookoPassword
    },
    "deviceInformation": {
      "applicationType": "logbook",
      "os": "android",
      "osVersion": "33",
      "device": "Google Pixel 4a",
      "deviceManufacturer": "Google",
      "deviceModel": "Pixel 4a",
      "serialNumber": serialNumber,
      "clinicalResearch": false,
      "deviceId": deviceId,
      "applicationVersion": "6.1.3",
      "buildNumber": "0",
      "gitHash": "g4fbed2011b"
    }
  };
  return body;
}
function web_login_payload (opts, authenticityToken) {
  return qs.stringify({
    utf8: '✓',
    authenticity_token: authenticityToken,
    'user[email]': opts.glookoEmail,
    'user[password]': opts.glookoPassword,
    language: 'en',
    redirect_to: '/',
    commit: 'Log in'
  });
}
function timestampWithOffset (timestamp, timestampDelta) {
  return new Date(new Date(timestamp).getTime( ) + (timestampDelta || 0));
}
function readingValueInMgdl (reading) {
  var value = reading.value || reading.glucose || reading.sgv;
  if (!value || value <= 0) {
    return null;
  }
  // Glooko v2 CGM values are commonly encoded as mg/dL x 100.
  return value > 1000 ? Math.round(value / 100) : value;
}
function readingToEntry (timestampDelta, reading) {
  if (!reading || reading.softDeleted) {
    return null;
  }
  var timestamp = reading.timestamp || reading.deviceTimestamp || reading.displayTime || reading.updatedAt;
  var sgv = readingValueInMgdl(reading);
  if (!timestamp || !sgv) {
    return null;
  }
  var date = timestampWithOffset(timestamp, timestampDelta);
  return {
    type: 'sgv',
    device: 'nightscout-connect-glooko',
    date: date.getTime( ),
    dateString: date.toISOString( ),
    sgv,
    direction: 'Flat'
  };
}
function generate_nightscout_entries (readings, timestampDelta) {
  if (!Array.isArray(readings)) {
    return [ ];
  }
  return readings.map(readingToEntry.bind(null, timestampDelta)).filter(Boolean);
}
function meterUnitsFromProfile (profile) {
  var user = profile && (profile.currentUser || profile.currentPatient || profile.user || profile.patient);
  return user && (user.meterUnits || user.meter_units || user.units);
}
function convertDisplayGlucoseToMgdl (value, meterUnits) {
  if (!value || value <= 0) {
    return null;
  }
  if (meterUnits && /^mmol/i.test(meterUnits)) {
    return Math.round(value * 18.0143);
  }
  return Math.round(value);
}
function v3PointValueInMgdl (point, meterUnits) {
  if (point.value && point.value > 0) {
    return point.value > 1000 ? Math.round(point.value / 100) : Math.round(point.value);
  }
  return convertDisplayGlucoseToMgdl(point.y, meterUnits);
}
function v3PointToEntry (timestampDelta, meterUnits, point) {
  if (!point || point.calculated) {
    return null;
  }
  var timestamp = point.timestamp || (point.x ? new Date(point.x * 1000).toISOString( ) : null);
  var sgv = v3PointValueInMgdl(point, meterUnits);
  if (!timestamp || !sgv) {
    return null;
  }
  var date = timestampWithOffset(timestamp, timestampDelta);
  return {
    type: 'sgv',
    device: 'nightscout-connect-glooko-v3',
    date: date.getTime( ),
    dateString: date.toISOString( ),
    sgv,
    direction: 'Flat'
  };
}
function generate_v3_nightscout_entries (graph, timestampDelta, userProfile) {
  if (!graph || !graph.series) {
    return [ ];
  }
  var meterUnits = meterUnitsFromProfile(userProfile);
  return V3_CGM_SERIES
    .reduce((all, name) => all.concat(Array.isArray(graph.series[name]) ? graph.series[name] : [ ]), [ ])
    .sort((a, b) => (a.x || 0) - (b.x || 0))
    .map(v3PointToEntry.bind(null, timestampDelta, meterUnits))
    .filter(Boolean);
}
function getGlookoCode (session) {
  return session && session.user && (session.user.userLogin && session.user.userLogin.glookoCode || session.user.user && session.user.user.glookoCode);
}
function constructV3GraphUrl (patientCode, startDate, endDate) {
  var seriesParams = V3_CGM_SERIES.map((series) => 'series[]=' + encodeURIComponent(series)).join('&');
  return Defaults.V3GraphData
    + '?patient=' + encodeURIComponent(patientCode)
    + '&startDate=' + encodeURIComponent(startDate.toISOString( ))
    + '&endDate=' + encodeURIComponent(endDate.toISOString( ))
    + '&' + seriesParams
    + '&locale=en&insulinTooltips=false&filterBgReadings=false&splitByDay=false';
}
function glookoSource (opts, axios) {
  var webOrigin = opts.glookoWebOrigin || web_origin_for(opts);
  var default_headers = { 'Content-Type': Defaults.mime,
                          'Accept': 'application/json, text/plain, */*',
                          'Accept-Encoding': 'gzip, deflate, br',
                          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15',
                          'Referer': webOrigin + '/',
                          'Origin': webOrigin,
                          'Connection': 'keep-alive',
                          'Accept-Language': 'en-GB,en;q=0.9'
                          };
  var baseURL = opts.baseURL;
  var baseHost = url.parse(baseURL).host;
  //console.log('GLOOKO OPTS', opts);
  var http = axios.create({ baseURL, headers: default_headers });
  var impl = {
    authFromCredentials ( ) {
      function apiLogin ( ) {
      var payload = login_payload(opts);
      return http.post(Defaults.login, payload).then((response) => {
        console.log("GLOOKO AUTH", response.headers, response.data);
          assertNoTwoFactorRequired(response.data);
          return { cookies: extractSetCookie(response.headers), user: response.data };
      });
      }
      function webLogin ( ) {
        return http.get(Defaults.WebSignIn).then((response) => {
          var authenticityToken = extractAuthenticityToken(response.data);
          var firstCookie = extractSetCookie(response.headers);
          if (!authenticityToken) {
            return Promise.reject(new Error('Glooko web login did not include authenticity_token.'));
          }
          var headers = {
            ...default_headers,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': firstCookie
          };
          return http.post('/users/sign_in?id=login_form', web_login_payload(opts, authenticityToken), { headers });
        }).then((response) => {
          assertNoTwoFactorRequired(response.data);
          var cookie = extractSetCookie(response.headers);
          if (!cookie) {
            return Promise.reject(new Error('Glooko web login did not return a session cookie.'));
          }
          return { cookies: cookie, user: response.data || { } };
        });
      }
      if (opts.glookoAuthMode === 'web') {
        return webLogin( );
      }
      if (opts.glookoAuthMode === 'auto') {
        return apiLogin( ).catch((err) => {
          var status = err && err.response && err.response.status;
          if (status === 422) {
            return webLogin( );
          }
          return Promise.reject(err);
        });
      }
      return apiLogin( );
    },
    sessionFromAuth (auth) {
      return Promise.resolve(auth);
    },
    dataFromSesssion (session, last_known) {
      var two_days_ago = new Date( ).getTime( ) - (2 * 24 * 60 * 60 * 1000);
      var last_mills = Math.max(two_days_ago, (last_known && last_known.entries) ? last_known.entries.getTime( ) : two_days_ago);
      var last_glucose_at = new Date(last_mills);
      var maxCount = Math.ceil(((new Date( )).getTime( ) - last_mills) / (1000 * 60 * 5));
      var minutes = 5 * maxCount;
      var lastUpdatedAt = last_glucose_at.toISOString( );
      var body = { };
      var v2Params = {
        lastGuid: Defaults.lastGuid,
        lastUpdatedAt,
        limit: maxCount,
      };

      function fetcher (endpoint, requestParams) {
        var headers = { ...default_headers };
        headers["Cookie"] = session.cookies;
        headers["Host"] = baseHost;
        headers["Sec-Fetch-Dest"] = "empty";
        headers["Sec-Fetch-Mode"] = "cors";
        headers["Sec-Fetch-Site"] = "same-site";
        console.log('GLOOKO FETCHER LOADING', endpoint);
        return http.get(endpoint, { headers, params: requestParams === undefined ? v2Params : requestParams })
          .then((resp) => resp.data);
      }

      // 2023-06-11T00:00:00.000Z
      // 2023-06-11T23:59:59.999Z

      const myDate = new Date();
      const dateString = myDate.getFullYear() + '-'
         + ('0' + (myDate.getMonth()+1)).slice(-2) + '-'
        + ('0' + myDate.getDate()).slice(-2);

      /*
      console.log('SESSION USER', session.user);
      let v3APIURL = Defaults.v3API.replace('_PATIENT_',session.user.userLogin.glookoCode).replace('_STARTDATE_', dateString + "T00:00:00.000Z").replace('_ENDDATE_', dateString + 'T23:59:59.999Z');
      */      
      function constructUrl(endpoint) {
        //?patient=orange-waywood-8651&startDate=2020-01-08T06:07:00.000Z&endDate=2020-01-09T06:07:00.000Z
        const myDate = new Date();
        const startDate = new Date(two_days_ago); // myDate.getTime() - 6 * 60 * 60 * 1000);
        const patientCode = getGlookoCode(session);
        if (!patientCode) {
          return null;
        }

        const url = endpoint + "?patient=" + patientCode
         + "&startDate=" + startDate.toISOString()
         + "&endDate=" + myDate.toISOString();

        return url;
      }

      const pumpBasalsUrl = constructUrl(Defaults.LatestPumpBasals);
      const pumpBolusUrl = constructUrl(Defaults.LatestPumpBolus);
      const cgmReadingsUrl = constructUrl(Defaults.LatestCGMReadings);
      const v2Fetches = pumpBasalsUrl && pumpBolusUrl && cgmReadingsUrl
        ? [
            //fetcher(v3APIURL)
            //fetcher(constructUrl(Defaults.LatestFoods)),
            //fetcher(constructUrl(Defaults.LatestInsulins)),
            fetcher(pumpBasalsUrl),
            fetcher(pumpBolusUrl),
            fetcher(cgmReadingsUrl),
            //fetcher(constructUrl(Defaults.PumpSettings))
          ]
        : [
            Promise.resolve({ scheduledBasals: [] }),
            Promise.resolve({ normalBoluses: [] }),
            Promise.resolve({ readings: [] })
          ];

      return Promise.all(v2Fetches).then(function (results) {
          //console.log(results);
         var some = {
            //food: results[0].foods,
            //insulins: results[1].insulins,
            scheduledBasals: results[0].scheduledBasals,
            normalBoluses: results[1].normalBoluses,
            readings: results[2].readings
            //settings: results[4].pumpSettings
         };

         //console.log('food sample', JSON.stringify(some.food[0]));
         //console.log('insulins sample', JSON.stringify(some.insulins[0]));
         //console.log('scheduledBasals sample', JSON.stringify(some.scheduledBasals[0]));
         //console.log('normalBoluses sample', JSON.stringify(some.normalBoluses[0]));
         //console.log('readings sample', JSON.stringify(some.readings[0]));
         //console.log('settings sample', JSON.stringify(results[4]));

          //console.log('GLOOKO DATA FETCH', results, some);
          //console.log('GOT RESULTS FROM GLOOKO', results);
          if (!opts.glookoUseV3Graph || some.readings && some.readings.length) {
            return some;
          }
          var patientCode = getGlookoCode(session);
          if (!patientCode) {
            return fetcher('/api/v3/session/users', {})
              .then((profile) => ({ ...some, userProfile: profile }))
              .then((withProfile) => {
                var profileCode = withProfile.userProfile && (withProfile.userProfile.currentUser && withProfile.userProfile.currentUser.glookoCode || withProfile.userProfile.currentPatient && withProfile.userProfile.currentPatient.glookoCode);
                if (!profileCode) {
                  return withProfile;
                }
                return fetcher(constructV3GraphUrl(profileCode, new Date(two_days_ago), new Date( )), {})
                  .then((v3Graph) => ({ ...withProfile, v3Graph }));
              })
              .catch((err) => {
                console.log('GLOOKO V3 PROFILE/GRAPH FETCH FAILED', err && err.message);
                return some;
              });
          }
          return fetcher(constructV3GraphUrl(patientCode, new Date(two_days_ago), new Date( )), {})
            .then((v3Graph) => ({ ...some, v3Graph }))
            .catch((err) => {
              console.log('GLOOKO V3 GRAPH FETCH FAILED', err && err.message);
              return some;
            });
        });
    },
    align_to_glucose ( ) {
      // TODO
    },
    transformData (batch) {
      // TODO
      console.log('GLOOKO passing batch for transforming');
      //console.log("TODO TRANSFORM", batch);
      var treatments = helper.generate_nightscout_treatments(batch, opts.glookoTimezoneOffset);
      var entries = generate_nightscout_entries(batch && batch.readings, opts.glookoTimezoneOffset);
      if (!entries.length && opts.glookoUseV3Graph) {
        entries = generate_v3_nightscout_entries(batch && batch.v3Graph, opts.glookoTimezoneOffset, batch && batch.userProfile);
      }
      return { entries, treatments };
    },
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

    builder.register_loop('Glooko', {
      tracker: tracker_for,
      frame: {
        impl: impl.dataFromSesssion,
        align_schedule: impl.align_to_glucose,
        transform: impl.transformData,
        backoff: {
        // wait 2.5 minutes * 2^attempt
          interval_ms: 2.5 * 60 * 1000

        },
        // only try 3 times to get data
        maxRetries: 1
      },
      // expect new data 5 minutes after last success
      expected_data_interval_ms: 5 * 60 * 1000,
      backoff: {
        // wait 2.5 minutes * 2^attempt
        interval_ms: 2.5 * 60 * 1000
      },
    });
    return builder;
  }
  impl.generate_driver = generate_driver;
  return impl;
}

glookoSource.validate = function validate_inputs (input) {
  var ok = false;
  var baseURL = base_for(input);

  const offset = !isNaN(input.glookoTimezoneOffset) ? input.glookoTimezoneOffset * -60 * 60 * 1000 : 0
  console.log('GLOOKO using ms offset:', offset, input.glookoTimezoneOffset);

  var config = {
    glookoEnv: input.glookoEnv,
    glookoServer: input.glookoServer,
    glookoEmail: input.glookoEmail,
    glookoPassword: input.glookoPassword,
    glookoTimezoneOffset: offset,
    glookoDeviceId: input.glookoDeviceId || makeUid(16),
    glookoSerialNumber: input.glookoSerialNumber || makeUid(24),
    glookoWebOrigin: web_origin_for(input),
    glookoUseV3Graph: boolish(input.glookoUseV3Graph),
    glookoAuthMode: authModeFor(input.glookoAuthMode),
    baseURL
  };
  var errors = [ ];
  if (!config.glookoEmail) {
    errors.push({desc: "The Glooko User Login Email is required.. CONNECT_GLOOKO_EMAIL must be an email belonging to an active Glooko User to log in.", err: new Error('CONNECT_GLOOKO_EMAIL') } );
  }
  if (!config.glookoPassword) {
    errors.push({desc: "Glooko User Login Password is required. CONNECT_GLOOKO_PASSWORD must be the password for the Glooko User Login.", err: new Error('CONNECT_GLOOKO_PASSWORD') } );
  }
  ok = errors.length == 0;
  config.kind = ok ? 'glooko' : 'disabled';
  return { ok, errors, config };
}
module.exports = glookoSource;
