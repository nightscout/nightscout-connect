
var qs = require('qs');
var url = require('url');
var tough = require('tough-cookie');

var ACS = require('axios-cookiejar-support');
var _known_servers = {
  eu: 'carelink.minimed.eu',
  us: 'carelink.minimed.com'
}

var modDefaults = {
  login_url: '/patient/sso/login' // ?country=gb&lang=en
, refresh_token_url:  '/patient/sso/reauth'
, json_base_url: '/patient/connect/data?cpSerialNumber=NONE&msgType=24hours&requestTime='
, me_url: '/patient/users/me'
, my_profile_url: '/patient/users/me/profile'
, recent_uploads_url: '/patient/dataUpload/recentUploads'
, monitor_data_url: '/patient/monitor/data'
, config_check_url: '/patient/configuration/system/personal.cp.m2m.enabled'
, patient_list_url: '/patient/m2m/links/patients'
, m2m_data_url: '/patient/m2m/connect/data/gc/patients/'
, country_settings_url: '/patient/countries/settings' // ?countryCode= &language= 
, default_language: 'en'
, mime: 'application/json'
, html: 'text/html'
, cookies: {
    token: 'auth_tmp_token'
  , recency: 'c_token_valid_to'
}
};
function base_for (spec) {
  var server = spec.carelinkServer ? spec.carelinkServer : _known_servers[ (spec.carelinkRegion || 'us').toLowerCase( ) ];
  var base = {
    protocol: 'https',
    host: server
  };
  return url.format(base);
}

function sgs_to_sgv (sgs) {
  var datetime = new Date(Date.parse(sgs.datetime));
  var glucose = {
    type: 'sgv'
  , sgv: sgs.sg
  , date: datetime.getTime( )
  , dateString: datetime.toISOString( )
  };

  return glucose;
}

function carelinkSource (opts, axios) {

  var baseURL = base_for(opts);
  var default_headers = { //  'Content-Type': modDefaults.mime,
                          // 'Accept': modDefaults.mime,
                          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
                          'User-Agent': '"nightscout-connect", nightscout-connect@0.0.1, "https://github.com/nightscout/nightscout-connect"'
                        };
  var html_headers = {
    // 'Content-Type': 'text/html'
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9'
  , 'Accept-Language': "en;q=0.9, *;q=0.8"
  , 'sec-ch-ua': "\"Chromium\";v=\"112\", \"Google Chrome\";v=\"112\", \"Not:A-Brand\";v=\"99\""
  , "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36"
  };

        function beforeRedirect (options, prev) {
          console.log("REDIRECT NEW OPTIONS", options);
          console.log("REDIRECT PREV RES", this);
        }

  var jar = new tough.CookieJar( );
  var http = ACS.wrapper(axios.create({ baseURL, headers: default_headers, beforeRedirect, jar }));
  var session = { };
  var impl = {
    authFromCredentials (creds, settings) {

      // TODO

      function getLoginFlow ( ) {
        var params = {
          country: opts.countryCode
        , lang: opts.languageCode
        };
        var headers = {  };
        console.log("AUTH WITH", modDefaults.login_url, params, headers);
        return http.get(modDefaults.login_url, { params, headers }).then((resp) => {
          console.log("FIRST STEP LOGIN FLOW", resp.headers, resp.data);
          let regex = /(<form action=")(.*)" method="POST"/gm;
          let endpoint = (regex.exec(resp.data) || [])[2] || '';

          // Session data is changed, need to get it from the html body form
          regex = /(<input type="hidden" name="sessionID" value=")(.*)"/gm;
          let sessionID = (regex.exec(resp.data) || [])[2] || '';

          regex = /(<input type="hidden" name="sessionData" value=")(.*)"/gm;
          let sessionData = (regex.exec(resp.data)[2] || []) || '';
          var loginFlow = {
            endpoint
          , sessionID
          , sessionData
          , locale: params.country
          , action: 'login'
          };
          return loginFlow; 
          // return resp.data;

        }).catch((error) => {
          if (error.response)
          console.log("ERROR", error.response.headers, error.response.data);
        });
      }

      function submitLoginFlow (loginFlow) {
        var payload = {
          ...loginFlow
        , username: opts.carelinkUsername
        , password: opts.carelinkPassword
        , actionButton: 'Log In'
        };
        delete payload.endpoint;
        var headers = { 'content-type': 'application/x-www-form-urlencoded' };
        var params = { };
        console.log("SUBMITTING LOGIN", loginFlow.endpoint, payload, params, headers);
        return http.post(loginFlow.endpoint, qs.stringify(payload), { params, headers }).then((resp) => {
          console.log("SUCCESS LOGGING IN", resp.headers, resp.data);
          let regex = /(<form action=")(.*)" method="POST"/gm;
          let endpoint = (regex.exec(resp.data) || [])[2] || '';

          // Session data is changed, need to get it from the html body form
          regex = /(<input type="hidden" name="sessionID" value=")(.*)"/gm;
          let sessionID = (regex.exec(resp.data) || [])[2] || '';

          regex = /(<input type="hidden" name="sessionData" value=")(.*)"/gm;
          let sessionData = (regex.exec(resp.data)[2] || []) || '';
          var cookies = resp.headers['set-cookie'].map(tough.parse);
          var formInfo = {
            cookies,
            endpoint,
            sessionID,
            sessionData,
            action: "consent",
            response_type: "code",
            response_mode: "query"
          };
          return formInfo;

        }).catch((error) => {
          console.log("ERROR SUBMITTING LOGIN FLOW", error.response.headers, error.response.data);
        });
      }

      function consentStep (flow) {
        var payload = { ...flow };
        delete payload.endpoint;
        var params = { };
        var headers = {
          'content-type': 'application/x-www-form-urlencoded'
          // ,  'Cookie': flow.cookies.map((c) => { return  new tough.Cookie(c).cookieString( ); })
        };
        console.log("SUBMITTING CONSENT FLOW", flow.endpoint, payload, params, headers);
        function validateStatus (status) {
          return status < 400 && status >= 200;
        }

        return http.post(flow.endpoint, qs.stringify(payload), { params, headers, validateStatus }).then((resp) => {
          console.log("SUCCESS WITH CONSENT FOR", resp.headers, resp.data);
          var cookies = jar.getCookiesSync(baseURL);
          console.log("COOKIES", cookies);
          var token = cookies.filter((c) => { console.log(c); return c.key == modDefaults.cookies.token; }).pop( ).value;
          var expires = cookies.filter((c) => { console.log(c); return c.key == modDefaults.cookies.recency; }).pop( ).value;
          var flow = {
            location: resp.headers['location']
          , cookies
          , token
          , expires
          , headers: resp.headers
          // , data: resp.data
          , status: resp.status
          };

          return flow;
          // return resp.data;
        }).catch((error) => {
          console.log("ERROR SUBMITTING CONSENT FLOW", error.toJSON( ));
          if (error.response)
          console.log("ERROR SUBMITTING CONSENT", error.response.headers, error.response.data);
        });
      }

      return getLoginFlow( )
        .then(submitLoginFlow)
        .then(consentStep)
        ;
    },
    sessionFromAuth(account, settings) {
      // TODO://
      var authed_headers = {
        Authorization: `Bearer ${account.token}`
      };

      function getUser ( ) {
        return http.get(modDefaults.me_url, { headers: authed_headers }).then((resp) => {
          console.log("SUCCESS FETCHING USER", resp.headers, resp);
          account.user = resp.data;
          return resp.data;
        return resp.data;
        }).catch((error) => {
          console.log("ERROR FETCHING USER", error);
        });
      }

      function getProfile ( ) {
        return http.get(modDefaults.my_profile_url, { headers: authed_headers }).then((resp) => {
          console.log("GOT PROFILE", resp.headers, resp.data);
          account.profile = resp.data;
          return resp.data;
        }).catch((error) => {
          console.log("ERROR FETCHING PROFILE", error);
        });
      }

      function getCountrySettings ( ) {
        var params = {
          countryCode: opts.countryCode
        , language: opts.languageCode
        };
        return http.get(modDefaults.country_settings_url, { params, headers: authed_headers }).then((resp) => {
          console.log("GOT COUNTRY SETTINGS", resp.headers, resp.data);
          account.requirements = resp.data;
          return resp.data;
        }).catch((error) => {
          console.log("ERROR FETCHING COUNTRY SETTINGS", error);
        });
      }

      function getM2M ( ) {
        return http.get(modDefaults.config_check_url, { headers: authed_headers }).then((resp) => {
          console.log("GOT M2M SETTINGS", resp.headers, resp.data);
          account.m2m_enabled = resp.data.value;
          return resp.data;
        }).catch((error) => {
          console.log("ERROR FETCHING M2M SETTINGS", error);
        });
      }

      function fetchPatientList (enabled) {
        if (!enabled) {
          return enabled;
        }
        console.log("SHOULD FETCH PATIENT LIST?", enabled, account.user.role, account.user.role == 'PATIENT_OUS');
        var acceptable = [null, 'PATIENT', 'PATIENT_US', 'PATIENT_OUS' ];
        if (acceptable.indexOf(account.user.role)) {

          return false;
        }
        return http.get(modDefaults.patient_list_url, { headers: authed_headers }).then((resp) => {
          console.log("PATIENT LIST", resp.data);
          account.patient_list = resp.data;
          return resp.data;
        }).catch((error) => {
          console.log("ERROR FETCHING M2M LIST", error.response.headers, error.response.data);
        });

      }

      function summarize ( ) {
        return Promise.all([getUser( ).then(getM2M).then(fetchPatientList), getProfile( ), getCountrySettings( ) ]).then((errors) => {
          console.log("FINAL", errors);
          var isPatient = [ null, 'PATIENT_OUS', 'PATIENT_US' ].indexOf(account.user.role);
          account.isPatient = isPatient;
          if (isPatient) {
            account.patientUsername = account.profile.username;
          } else {
            account.patientUsername = opts.carelinkPatientUsername
              ? opts.carelinkPatientUsername
              : account.patient_list_url[0].username;
          }
          return account;
        });
      }
      return summarize( );

    },
    dataFromSesssion(session, last_known) {
      // TODO
      var authed_headers = {
        Authorization: `Bearer ${session.token}`
      };
      function m2m_data ( ) {
        var params = {
          cpSerialNumber: 'NONE'
        , msgType: 'last24hours'
        , requestTime: Date.now( )
        };
        if (!session.patientUsername) {
          return Promise.resolve(new Error("no patientUsername"));
        }
        return http.get(modDefaults.m2m_data_url + session.patientUsername, { params, headers: authed_headers }).then((resp) => {
          console.log("DATA", resp.headers, resp.data);
          return resp.data;
        }).catch((error) => {
          console.log("ERROR DATA FETCH", error);
        });
      }

      function bleEndpointData ( ) {
        var body = {
          username: session.profile.username
        , role: "patient"
        };
        if (!session.isPatient) {
          body.role = "carepartner";
          body.patientId = session.patientUsername;
        }
        // if (session.isPatient) { return Promise.resolve( ); }
        return http.post(session.requirements.blePereodicDataEndpoint, body, { headers: authed_headers }).then((resp) => {
          console.log("BLE PERIODIC ENDPOINT DATA", resp.headers, resp.data);
          return resp.data;
        }).catch((error) => {
          console.log("BLE PERIODIC ENDPOINT ERROR", error, error.response ? error.response.headers : "", error.response ? error.response.data : "");
        });
      }

      function getMonitorData ( ) {
        return http.get(modDefaults.monitor_data_url, { headers: authed_headers }).then((resp) => {
          console.log("MONITOR DATA ENDPOINT DATA", resp.headers, resp.data);
          return resp.data;
        }).catch((error) => {
          console.log("MONITOR DATA ENDPOINT ERROR", error, error.response ? error.response.headers : "", error.response ? error.response.data : "");
        });
      }

      function getRecentUploads ( ) {
        var params = {
          numUploads: 1
        };
        return http.get(modDefaults.recent_uploads_url, { params, headers: authed_headers }).then((resp) => {
          console.log("RECENT UPLOADS DATA", resp.headers, resp.data);
          return resp.data;
        }).catch((error) => {
          console.log("RECENT UPLOADS ERROR", error, error.response ? error.response.headers : "", error.response ? error.response.data : "");
        });
      }

      function summarize (results) {
        console.log("RESULTS", results);
        // return result that has sgs
        return results.filter((payload) => payload && payload.sgs).pop( );
      }

      return Promise.all([
        bleEndpointData( )
      , m2m_data( )
      , getRecentUploads( )
      , getMonitorData( )
      ]).then(summarize);
    },
    align_to_glucose (last_known) {

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
    },
    transformGlucose (data, last_known) {
      console.log("INCOMING DATA", data);
      var recent_mills = last_known.entries.getTime( );
      function is_missing (reading) {
        return reading.date > recent_mills;
      }

      function has_datetime (elem) {
        return elem.datetime;
      }
      var entries = data.sgs.filter(has_datetime).map(sgs_to_sgv).filter(is_missing);
      console.log("INCOMING TALLY", data.sgs.length, 'reduced', entries.length);
      return { entries };
    }
  };

  function tracker_for ( ) {
    var { AxiosHarTracker } = require('axios-har-tracker');
    var tracker = new AxiosHarTracker(http);
    return tracker;
  }

  function generate_driver (builder) {
    builder.support_session({
      authenticate: impl.authFromCredentials,
      authorize: impl.sessionFromAuth,
      // refresh: impl.refreshSession,
      delays: {
        REFRESH_AFTER_SESSSION_DELAY: (1000 * 60 * 10),
        EXPIRE_SESSION_DELAY: 1000 * 60 *  15,
      }
    });

    builder.register_loop('MinimedCarelink', {
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


carelinkSource.validate = function validate_inputs (input) {

  var baseURL = base_for(input);
  var config = { };
  var ok = false;
  var errors = [ ];
  /*
  input.carelinkRegion
  input.carelinkServer
  input.carelinkPassword
  */

  var config = {
    carelinkRegion: input.carelinkRegion,
    carelinkServer: input.carelinkServer,
    carelinkUsername: input.carelinkUsername,
    carelinkPassword: input.carelinkPassword,
    carelinkPatientUsername: input.carelinkPatientUsername,
    countryCode: input.countryCode,
    languageCode: input.languageCode || 'en',
    baseURL
  };
  if (!config.carelinkUsername) {
    errors.push({desc: "The Medtronic Minimed Carelink Username is needed. CONNECT_CARELINK_USERNAME must be a valid account name.", err: new Error('CONNECT_CARELINK_USERNAME') } );
  }
  if (!config.carelinkPassword) {
    errors.push({desc: "The Medtronic Minimed Carelink Password is needed. CONNECT_CARELINK_PASSWORD must be the password to access this Minimed Carelink account.", err: new Error('CONNECT_CARELINK_PASSWORD') } );
  }
  if (!config.countryCode) {
    errors.push({desc: "Medtronic Minimed country code required. CONNECT_COUNTRY_CODE must a two letter country code where Minimed Carelink account was created.", err: new Error('CONNECT_COUNTRY_CODE') } );
  }

  ok = errors.length == 0;
  config.kind = ok ? 'minimedcarelink' : 'disabled';
  return { ok, errors, config }
}

module.exports = carelinkSource;
