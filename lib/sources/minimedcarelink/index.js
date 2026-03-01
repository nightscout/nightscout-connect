
var qs = require('qs');
var url = require('url');
var tough = require('tough-cookie');

var ACS = require('axios-cookiejar-support');
var software = require('../../../package.json');
var software_string = [software.name, `${software.name}/${software.version}`, '(M2M@V6)', software.homepage].join(' ');
var browser_string = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.85 Safari/537.36 Edg/90.0.818.46`;
var enhanced_browser_string = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.85 Safari/537.36 Edg/90.0.818.46 ${software.name}/${software.version} (M2M/V6)`;
var debug = require('../../debug');
var user_agent_string = browser_string;

// https://github.com/NightscoutFoundation/xDrip/blob/990df119a8404cff56cb68b92a7e0bb640da95ef/app/src/main/java/com/eveningoutpost/dexdrip/cgm/carelinkfollow/client/CareLinkClient.java#L559
// https://github.com/nightscout/minimed-connect-to-nightscout/blob/master/carelink.js
// https://github.com/nightscout/minimed-connect-to-nightscout/blob/master/transform.js

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

function markers_to_treatment (markers) {
  var meals = markers.filter((entry) => entry.type == 'MEAL');
  var mealIndices = meals.map((meal) => meal.index);

  function find_insulin (meal) {
    return markers.filter((dose) => meal.index == dose.index && dose.type == 'INSULIN').pop( );
  }

  function remaining_non_meal_treatments (candidate) {
    return !mealIndices.includes(candidate.index);

  }

  function make_meal (meal) {
    var dose = find_insulin(meal);
    var treatment = marker.MEAL(meal, dose);
    return treatment;
  }

  function make_remaining (candidate) {
    if (to_fingerprick.types.includes(candidate.type)) {
      return to_fingerprick(candidate);
    }
    return marker.INSULIN(candidate);
  }

  var treatments = meals.map(make_meal);
  var remainder = markers.filter(remaining_non_meal_treatments)
    .map(make_remaining);
  return treatments.concat(remainder);
}

function to_fingerprick (item) {
  return {
    eventType: 'BG CHECK'
    , created_at: item.dateTime
    , glucose: item.value
    , glucoseType: "Finger"
  };
}

to_fingerprick.types = [ 'CALIBRATION', 'BG READING', 'BG' ];
var marker = {
  MEAL: function to_meal (item, dose) {
    var result =  {
      eventType: 'Meal Bolus'
    , created_at: item.dateTime
    , carbs: item.amount || 0
    , _meal: item
    , _dose: dose
    };
    if (dose && dose.bolusType == 'FAST') {
      result.duration = dose.effectiveDuration;
      result.type = 'normal';
      result.insulin = dose.deliveredFastAmount;
      result.programmed = dose.programmedFastAmount;
      if (result.completed) {
        result.unabsorbed = 0;
      }
    }
    return result
  },
  INSULIN: function to_dose (item) {
    var eventType = item.activationType;
    return {
      eventType: 'Correction Bolus'
    , created_at: item.dateTime
    , insulin: item.deliveredFastAmount || 0
    , carelink: item
    };

  }
}

var CARELINK_TREND_TO_NIGHTSCOUT_TREND = {
  'NONE': {
    'trend': 4,
    'direction': 'Flat'
  },
  'UP_TRIPLE': {
    'trend': 1,
    'direction': 'TripleUp'
  },
  'UP_DOUBLE': {
    'trend': 1,
    'direction': 'DoubleUp'
  },
  'UP': {
    'trend': 2,
    'direction': 'SingleUp'
  },
  'DOWN': {
    'trend': 6,
    'direction': 'SingleDown'
  },
  'DOWN_DOUBLE': {
    'trend': 7,
    'direction': 'DoubleDown'
  },
  'DOWN_TRIPLE': {
    'trend': 7,
    'direction': 'TripleDown'
  }
};

function deviceStatusEntry (data, deviceName) {
  var common = {
    'created_at': (new Date( )).toISOString( ),
    'lastMedicalDeviceDataUpdateServerTime': data['lastMedicalDeviceDataUpdateServerTime'],
    'device': deviceName,
    'uploader': {
      'battery': data['medicalDeviceBatteryLevelPercent'],
    },
    // For the values these can take, see:
    // https://gist.github.com/mddub/5e4a585508c93249eb51
    'connect': {
      'sensorState': data['sensorState'],
      'calibStatus': data['calibStatus'],
      'sensorDurationHours': data['sensorDurationHours'],
      'timeToNextCalibHours': data['timeToNextCalibHours'],
      'conduitInRange': data['conduitInRange'],
      'conduitMedicalDeviceInRange': data['conduitMedicalDeviceInRange'],
      'conduitSensorInRange': data['conduitSensorInRange'],
      'medicalDeviceBatteryLevelPercent': data['medicalDeviceBatteryLevelPercent'],
      'medicalDeviceFamily': data['medicalDeviceFamily']
    }
  };
  if (data['medicalDeviceFamily'] != 'GUARDIAN') {
    common.pump = {
      'battery': {
        'percent': data['medicalDeviceBatteryLevelPercent'],
      },
      'reservoir': data['reservoirRemainingUnits'],
      'iob': {
        'timestamp': data['lastMedicalDeviceDataUpdateServerTime'],
      },
      'clock': data['sMedicalDeviceTime'],
      // 'clock': timestampAsString(parsePumpTime(data['sMedicalDeviceTime'], offset, offsetMilliseconds, data['medicalDeviceFamily'])),
      // TODO: add last alarm from data['lastAlarm']['code'] and data['lastAlarm']['datetime']
      // https://gist.github.com/mddub/a95dc120d9d1414a433d#file-minimed-connect-codes-js-L79
    };

    if (data.activeInsulin && data.activeInsulin.amount >= 0) {
      common.pump.bolusiob = data.activeInsulin.amount;
    }
  }
  return common
}

function carelinkSource (opts, axios) {

  var baseURL = base_for(opts);
  var default_headers = { //  'Content-Type': modDefaults.mime,
                          // 'Accept': modDefaults.mime,
                          'Accept': 'application/json,text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
                          // 'User-Agent': '"nightscout-connect", nightscout-connect@0.0.1, "https://github.com/nightscout/nightscout-connect"'
                          "x-powered-by": software_string,
                          'User-Agent': user_agent_string
                        };
  var html_headers = {
    // 'Content-Type': 'text/html'
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9'
  , 'Accept-Language': "en;q=0.9, *;q=0.8"
  , 'sec-ch-ua': "\"Chromium\";v=\"112\", \"Google Chrome\";v=\"112\", \"Not:A-Brand\";v=\"99\""
  , "User-Agent": browser_string
  };


  var jar = new tough.CookieJar( );
  var http = ACS.wrapper(axios.create({ baseURL, headers: default_headers, jar }));
  var session = { };
  var impl = {
    authFromCredentials (creds, settings) {

      function getLoginFlow ( ) {
        var params = {
          country: opts.countryCode
        , lang: opts.languageCode
        };
        var headers = {
          ...html_headers
        };
        debug("AUTH WITH", modDefaults.login_url, params, headers);
        return http.get(modDefaults.login_url, { params, headers }).then((resp) => {
          debug("FIRST STEP LOGIN FLOW", resp.headers, resp.data);
          var regex = /(<form action=")(.*)" method="POST"/gm;
          var endpoint = (regex.exec(resp.data) || [])[2] || '';

          // Session data is changed, need to get it from the html body form
          regex = /(<input type="hidden" name="sessionID" value=")(.*)"/gm;
          var sessionID = (regex.exec(resp.data) || [])[2] || '';

          regex = /(<input type="hidden" name="sessionData" value=")(.*)"/gm;
          var sessionData = (regex.exec(resp.data)[2] || []) || '';
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
          debug("ERROR", error.response.headers, error.response.data);
          return Promise.reject(error);
        });
      }

      function submitLoginFlow (loginFlow) {
        var payload = {
          ...loginFlow
        , username: opts.carelinkUsername
        , password: opts.carelinkPassword
        , actionButton: 'Log In'
        };
        var query = {
          country: opts.countryCode
        , locale: 'en'
        , 'g-recaptcha-response': Buffer.from('YWJj', 'base64').toString( )
        };
        delete payload.endpoint;
        var headers = {
          ...html_headers
        , 'content-type': 'application/x-www-form-urlencoded'
        };
        var params = { ...query };
        var loginEndpoint = loginFlow.endpoint;
        // var loginEndpoint = url.parse(loginFlow.endpoint);
        // query = { ...qs.parse(loginEndpoint.query), ...query };
        // loginEndpoint = url.format({ ...loginEndpoint, search: null, query });
        debug("SUBMITTING LOGIN", loginEndpoint, payload, params, headers);
        return http.post(loginEndpoint, qs.stringify(payload), { params, headers }).then((resp) => {
          debug("SUCCESS LOGGING IN", resp.headers, resp.data);
          var regex = /(<form action=")(.*)" method="POST"/gm;
          var endpoint = (regex.exec(resp.data) || [])[2] || '';

          // Session data is changed, need to get it from the html body form
          regex = /(<input type="hidden" name="sessionID" value=")(.*)"/gm;
          var sessionID = (regex.exec(resp.data) || [])[2] || '';

          regex = /(<input type="hidden" name="sessionData" value=")(.*)"/gm;
          var sessionData = (regex.exec(resp.data)[2] || []) || '';
          var cookies = (resp.headers['set-cookie'] || []).map(tough.parse);
          if (cookies.length < 1) {
            var err = new Error("Invalid Medtronic Carelink Credentials.");
            err.data = resp.data;
            return Promise.reject(err);
          }
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
          if (error.response) {
            debug("ERROR SUBMITTING LOGIN FLOW", error.response.headers, error.response.data);
          } else {
            debug('ERROR', error);
          }
          // return error;
          return Promise.reject(error);
          throw error;
        });
      }

      function consentStep (flow) {
        var payload = { ...flow };
        delete payload.endpoint;
        var params = { };
        var headers = {
          'content-type': 'application/x-www-form-urlencoded'
          , ...html_headers
          // ,  'Cookie': flow.cookies.map((c) => { return  new tough.Cookie(c).cookieString( ); })
        };
        debug("SUBMITTING CONSENT FLOW", flow.endpoint, payload, params, headers);
        function validateStatus (status) {
          return status < 400 && status >= 200;
        }

        return http.post(flow.endpoint, qs.stringify(payload), { params, headers, validateStatus }).then((resp) => {
          debug("SUCCESS WITH CONSENT FOR", resp.headers, resp.data);
          var cookies = jar.getCookiesSync(baseURL);
          debug("COOKIES", cookies);
          var token = cookies.filter((c) => { debug(c); return c.key == modDefaults.cookies.token; }).pop( ).value;
          var expires = cookies.filter((c) => { debug(c); return c.key == modDefaults.cookies.recency; }).pop( ).value;
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
          if (error.response) {
            debug("ERROR SUBMITTING CONSENT", error.response.headers, error.response.data);
          }
          else {
            debug("ERROR SUBMITTING CONSENT FLOW", error);
          }
          return Promise.reject(error);
        });
      }

      return getLoginFlow( )
        .then(submitLoginFlow)
        .then(consentStep)
        ;
    },
    sessionFromAuth(account, settings) {
      // TODO://
      var headers = { };
      var authed_headers = {
        Authorization: `Bearer ${account.token}`
      };

      if (account && account.token) {
        headers = authed_headers;
      }
      function getUser ( ) {
        var headers = {
        ...authed_headers
        };
        return http.get(modDefaults.me_url, { headers }).then((resp) => {
          debug("SUCCESS FETCHING USER", resp.headers, resp);
          account.user = resp.data;
          return resp.data;
        return resp.data;
        }).catch((error) => {
          debug("ERROR FETCHING USER", error);
          if (error.response) {
            debug("USER ERROR HEADERS/DATA", error.response.headers, error.response.data);
          }
          return Promise.reject(error);
        });
      }

      function getProfile ( ) {
        var headers = {
        ...authed_headers
        };
        return http.get(modDefaults.my_profile_url, { headers }).then((resp) => {
          debug("GOT PROFILE", resp.headers, resp.data);
          account.profile = resp.data;
          return resp.data;
        }).catch((error) => {
          debug("ERROR FETCHING PROFILE", error);
        });
      }

      function getCountrySettings ( ) {
        var params = {
          countryCode: opts.countryCode
        , language: opts.languageCode
        };
        var headers = {
        ...authed_headers
        };
        return http.get(modDefaults.country_settings_url, { params, headers }).then((resp) => {
          debug("GOT COUNTRY SETTINGS", resp.headers, resp.data);
          account.requirements = resp.data;
          return resp.data;
        }).catch((error) => {
          debug("ERROR FETCHING COUNTRY SETTINGS", error);
          return Promise.reject(error);
        });
      }

      function getM2M ( ) {
        var headers = {
        ...authed_headers
        };
        return http.get(modDefaults.config_check_url, { headers }).then((resp) => {
          debug("GOT M2M SETTINGS", resp.headers, resp.data);
          account.m2m_enabled = resp.data.value;
          return resp.data;
        }).catch((error) => {
          debug("ERROR FETCHING M2M SETTINGS", error);
          return Promise.reject(error);
        });
      }

      function fetchPatientList (enabled) {
        if (!enabled) {
          return enabled;
        }
        debug("SHOULD FETCH PATIENT LIST?", enabled, account.user.role, account.user.role == 'PATIENT_OUS');
        var acceptable = [null, 'PATIENT', 'PATIENT_US', 'PATIENT_OUS' ];
        if (acceptable.indexOf(account.user.role) > 0) {

          return false;
        }
        var headers = {
        ...authed_headers
        };
        return http.get(modDefaults.patient_list_url, { headers }).then((resp) => {
          debug("PATIENT LIST", resp.data);
          account.patient_list = resp.data;
          return resp.data;
        }).catch((error) => {
          debug("ERROR FETCHING M2M LIST", error.response.headers, error.response.data);
        });

      }

      function summarize ( ) {
        var inputs = [getUser( ).then(getM2M).then(fetchPatientList), getProfile( ), getCountrySettings( ) ];
        return Promise.allSettled(inputs).then((results) => {
          debug("FINAL", results);
          var fulfilled = results.filter((result) => 'fulfilled' == result.status);
          if (fulfilled.length < inputs.length) {
            return Promise.reject(new Error("unable to fulfill session specifications"));
          }
          var isPatient = [ null, 'PATIENT', 'PATIENT_OUS', 'PATIENT_US' ].indexOf(account.user.role) > 0;
          account.isPatient = isPatient;
          if (isPatient) {
            account.patientUsername = account.profile.username;
          } else {
            account.patientUsername = opts.carelinkPatientUsername
              ? opts.carelinkPatientUsername
              : account.patient_list[0].username;
          }
          return account;
        });
      }
      return summarize( );

    },
    dataFromSesssion(session, last_known) {

      var headers = { };
      var authed_headers = {
        Authorization: `Bearer ${session.token}`
      };
      if (session && session.token) {
        headers = authed_headers;
      }

      function m2m_data ( ) {
        var params = {
          cpSerialNumber: 'NONE'
        , msgType: 'last24hours'
        , requestTime: Date.now( )
        };
        var headers = {
        ...authed_headers
        };
        if (!session.patientUsername) {
          return Promise.resolve(new Error("no patientUsername"));
        }
        return http.get(modDefaults.m2m_data_url + session.patientUsername, { params, headers }).then((resp) => {
          debug("DATA", resp.headers, resp.data);
          return resp.data;
        }).catch((error) => {
          debug("ERROR DATA FETCH", error);
          return Promise.reject(error);
        });
      }

      function bleEndpointData ( ) {
        // TODO: M2M obsoletes this endpoint?
        // BLE endpoint is used when:
        // * device field from RecentUploads has string MiniMed.
        var body = {
          username: session.profile.username
        , role: "patient"
        };
        var headers = {
        ...authed_headers
        };
        if (!session.isPatient) {
          body.role = "carepartner";
          body.patientId = session.patientUsername;
        }
        // if (session.isPatient) { return Promise.resolve( ); }
        return http.post(session.requirements.blePereodicDataEndpoint, body, { headers }).then((resp) => {
          debug("BLE PERIODIC ENDPOINT DATA", resp.headers, resp.data);
          return resp.data;
        }).catch((error) => {
          debug("BLE PERIODIC ENDPOINT ERROR", error, error.response ? error.response.headers : "", error.response ? error.response.data : "");
          return Promise.reject(error);
        });
      }

      function getMonitorData ( ) {
        // TODO: obsoleted by M2M?
        // deviceFamily determines whether to use M2M or BLE endpoint.
        var headers = {
        ...authed_headers
        };
        return http.get(modDefaults.monitor_data_url, { headers }).then((resp) => {

          debug("MONITOR DATA ENDPOINT DATA", resp.headers, resp.data);
          return resp.data;
        }).catch((error) => {
          debug("MONITOR DATA ENDPOINT ERROR", error, error.response ? error.response.headers : "", error.response ? error.response.data : "");
          return Promise.reject(error);
        });
      }

      function getRecentUploads ( ) {
        var params = {
          numUploads: 1
        };
        var headers = {
        ...authed_headers
        };
        return http.get(modDefaults.recent_uploads_url, { params, headers }).then((resp) => {
          debug("RECENT UPLOADS DATA", resp.headers, resp.data);
          return resp.data;
        }).catch((error) => {
          debug("RECENT UPLOADS ERROR", error, error.response ? error.response.headers : "", error.response ? error.response.data : "");
          return Promise.reject(error);
        });
      }

      function fetch_payload ({ deviceFamily }) {
        debug("SELECTING PAYLOAD FETCH FOR ", deviceFamily);
        if (deviceFamily == 'GUARDIAN') {
          return m2m_data( );
        }
        return bleEndpointData( );
      }

      function summarize (results) {
        debug("RESULTS", results);
        // return result that has sgs
        var outputs = results
          .filter(({status, value: payload }) => status == 'fulfilled' && payload && payload.sgs)
        ;
        if (outputs.length < 1) {
          return Promise.reject(new Error("unable to fulfill data for dataFromSesssion"));
        }
        return outputs
          .map((fulfilled) => fulfilled.value)
          .pop( )
        ;
      }

      var inputs = [
        getMonitorData( ).then(fetch_payload)
      , getRecentUploads( )
      ];
      return Promise.allSettled(inputs).then(summarize);
    },
    refreshSession (authInfo, session) {
      debug("REFRESH REFRESH REFRESH", authInfo, session);
      var authed_headers = {
        Authorization: `Bearer ${session.token}`
      };
      var headers = {
      ...authed_headers
      , 'content-type': 'application/json; charset=utf-8'
      };
      var params = {
          country: opts.countryCode
        , locale: opts.languageCode
      };
      return http.post(modDefaults.refresh_token_url, {},  { params, headers }).then((resp) => {
        debug("SUCCESS WITH REFRESH FOR", resp.headers, resp.data);
        var cookies = jar.getCookiesSync(baseURL);
        debug("COOKIES", cookies);
        var token = cookies.filter((c) => { debug(c); return c.key == modDefaults.cookies.token; }).pop( )?.value;
        var expires = cookies.filter((c) => { debug(c); return c.key == modDefaults.cookies.recency; }).pop( )?.value;
        // authInfo.token = token;
        // authInfo.expires = expires;
        debug("REFRESHING TOKEN?", token, expires, token && expires);
        if (token && expires) {
          session.token = token;
          session.expires = expires;
        }
        return session;
      }).catch((error) => {
        debug("ERROR REFRESHING TOKEN!!");
        if (error.response) {
          debug("REFRESH ERROR", error.response.headers, error.response.data);
        } else {
          debug(error);
        }

        return Promise.reject(error);
      });
    },
    align_to_glucose (last_known) {

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
      var buffer_lag = 68000; // 68 second buffer
      var jitter = Math.floor(Math.random( ) * 1000 * 18); // 18 second random
      var align_to = next_due + buffer_lag + jitter;
      return align_to;
    },
    transformPayload (data, last_known) {
      debug("INCOMING DATA", last_known, data);
      if (!data || !data.medicalDeviceFamily) {
        return { entries: [ ] };
      }
      var recent_mills = last_known && last_known.entries ? last_known.entries.getTime( ) : 0;
      var recent_treatment_mills = last_known && last_known.treatments ? last_known.treatments.getTime( ) : 0;
      function is_missing (reading) {
        return reading.date > recent_mills;
      }

      function is_recent_treatment (treatment) {
        // based on glucose
        return (new Date(treatment.created_at)).getTime( ) > recent_treatment_mills;
      }

      function has_dateprop (prop) {
				if (!prop) { prop = 'datetime'; }
        function has_datetime (elem) {
          return elem[prop]
        }
        return has_datetime;
      }

      var deviceName = "nightscout-connect://minimedcarelink/" + data.medicalDeviceFamily;
      var lastConduitDateTime = data.lastConduitDateTime;
      function assign_device (elem) {
        elem.device = deviceName;
        return elem;
      }

      function reassign_zone(field) {
        if (lastConduitDateTime) {
          var zoneOffsetMatch = lastConduitDateTime.match(/[+-]\d{2}:\d{2}$/);
          var zoneOffset = zoneOffsetMatch ? zoneOffsetMatch[0] : '00:00';
          return adjust_conduit_timezone.bind(null, zoneOffset, field);
        }
        return id;
      }
      
      function id(x) { return x; }

      function adjust_conduit_timezone(zoneOffset, field, item) {
        // Handle item.datetime
				var pattern = /([+-]\d{2}:\d{2}|Z)$/g;
        if (item[field] && item[field].match(pattern)) {
          item[field] = item[field].replace(pattern, zoneOffset);
        }
				return item;
      
      }

      var entries = data.sgs
        .filter(has_dateprop('datetime'))
        .map(reassign_zone('datetime'))
        .map(sgs_to_sgv)
        .filter(is_missing)
        .map(assign_device);

      // only the last item has its trend described.
      var lastItem = entries.pop( )
      var lastSGTrend = data.lastSGTrend;
      var trendInfo = CARELINK_TREND_TO_NIGHTSCOUT_TREND[lastSGTrend];
      // guard against pushing a non-reading with only trend information
      if (lastItem && lastItem.sgv == data.lastSG.sg) {
        lastItem = { lastSGTrend, ...lastItem, ...trendInfo };
        entries.push(lastItem);
      }

      var deviceStatus = deviceStatusEntry(data, deviceName);
      if (deviceStatus.pump) {
        var adjust_pump_clock = reassign_zone('clock');
				adjust_pump_clock(deviceStatus.pump);
      }
      var devicestatus = [ deviceStatus ];

			var markers = data.markers
        .filter(has_dateprop('dateTime'))
				.map(reassign_zone('dateTime'))
        ;
      var treatments = markers_to_treatment(markers)
        .filter(is_recent_treatment);

      debug("INCOMING TALLY SGS", data.sgs.length, 'reduced', entries.length);
      debug("INCOMING TALLY TREATMENTS", data.markers.length, 'reduced', treatments.length);
      debug("INCOMING DEVICESTATUS", deviceStatus);
      return { entries, devicestatus, treatments };
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
      // TODO: have never seen refreshSession work, disabling until further
      // notice
      // refresh: impl.refreshSession,
      delays: {
        REFRESH_AFTER_SESSSION_DELAY: (1000 * 60 * 7),
        EXPIRE_SESSION_DELAY: 1000 * 60 *  9,
      }
    });

    builder.register_loop('MinimedCarelink', {
      tracker: tracker_for,
      frame: {
        impl: impl.dataFromSesssion,
        align_schedule: impl.align_to_glucose,
        transform: impl.transformPayload,
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
