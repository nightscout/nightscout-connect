// var qs = require('querystring');
var qs = require('qs');
var url = require('url');
var crypto = require('crypto');

var software = require('../../package.json');
var user_agent_string = [software.name, `${software.name}@${software.version}`, 'Nightscout API', software.homepage].join(', ');
var debug = require('../debug');

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
  
  debug("NIGHTSCOUT BASE URL", baseURL);
  
  var default_headers = {
    'User-Agent': user_agent_string
  };
  var http = axios.create({ baseURL, headers: default_headers });
  
  // Store detected API version
  var detectedApiVersion = null;
  var detectionPromise = null;
  
  // Detect API version by checking if V3 is available
  function detectApiVersion() {
    if (detectionPromise) {
      return detectionPromise;
    }
    
    debug("NIGHTSCOUT: Detecting API version...");
    detectionPromise = http.get('/api/v3/version')
      .then((resp) => {
        if (resp.data && resp.data.result && resp.data.result.apiVersion) {
          detectedApiVersion = 'v3';
          debug("NIGHTSCOUT: Detected API V3", resp.data.result.apiVersion);
          return 'v3';
        }
        detectedApiVersion = 'v1';
        debug("NIGHTSCOUT: Using API V1 (V3 response invalid)");
        return 'v1';
      })
      .catch((err) => {
        detectedApiVersion = 'v1';
        debug("NIGHTSCOUT: Using API V1 (V3 not available)", err.message);
        return 'v1';
      });
    
    return detectionPromise;
  }
  
  // V1 Implementation (existing code)
  var implV1 = {
    authFromCredentials(creds, settings) {
      var checkURL = '/api/v1/verifyauth';
      if (params.token) return Promise.resolve(params.token);
      debug("CHECKING V1", http, checkURL);
      return http.get(checkURL).then((resp) => {
        debug("CHECKED V1", checkURL, resp);
        var checked = resp.data;
        if (checked.status == 200 && checked.message.canRead) {
          return Promise.resolve({ readable: checked });
        }

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
            return http.get(authURL, { headers }).then((resp) => {
              var body = resp.data;
              var match = body.filter((item) => item.name == 'nightscout-connect-reader').pop( );
              if (match) {
                params.token = match.accessToken;
                return params.token;
              }
              return Promise.reject(body);
            });

          });
        })

      }).catch(debug.bind(null, "V1 AUTH ERROR"));

    },
    sessionFromAuth(accessToken, settings) {
      var tokenUrl = '/api/v2/authorization/request/' + accessToken; 
      if (accessToken && accessToken.readable) {
        return Promise.resolve({ readable: accessToken.readable });
      }
      var headers = {};
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
      debug("INSIDE NIGHTSCOUT SOURCE DRIVER ALIGNMENT FOR GLUCOSE V1");
      if (!last_known || !last_known.entries) {
        return;
      }
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
    },
    dataFromSesssion(session, last_known) {
      var two_days_ago = new Date( ).getTime( ) - (2 * 24 * 60 * 60 * 1000);
      var last_mills = Math.max(two_days_ago, (last_known && last_known.entries) ? last_known.entries.getTime( ) : two_days_ago);
      var last_glucose_at = new Date(last_mills);
      var count = Math.ceil(((new Date( )).getTime( ) - last_mills) / (1000 * 60 * 5));
      var query = { find: { dateString: { $gt: last_glucose_at.toISOString( ) } }, count };
      var dataUrl = '/api/v1/entries.json';
      var headers = { 'x-special-foo': 'special' };
      if (session.bearer) {
        headers['Authorization'] = ['Bearer', session.bearer].join(' ');
      }
      debug("FETCHING V1 GAPS FOR", last_known, dataUrl, query);
      return http.get(dataUrl, { params: query, headers }).then((resp) => {
        return resp.data;
      });
    },
    transformGlucose (data) {
      // V1 returns array directly
      debug("TRANSFORMING V1 DATA", Array.isArray(data), data.length);
      return { entries: data };
    }
  };
  
  // V3 Implementation (new)
  var implV3 = {
    // V3 requires proper JWT token, cannot use just 'readable'
    authFromCredentials(creds, settings) {
      // Always get a proper token for V3
      if (params.token) return Promise.resolve(params.token);
      
      debug("V3: Getting authentication token");
      var authURL = '/api/v2/authorization/subjects';
      var headers = { 'API-SECRET': apiHash };
      
      return http.get(authURL, { headers }).then((resp) => {
        var body = resp.data;
        var match = body.filter((item) => item.name == 'nightscout-connect-reader').pop( );
        if (match) {
          debug("V3: Found existing token");
          return match.accessToken;
        }
        
        debug("V3: Creating new token");
        var subject = {
          name: 'nightscout-connect-reader',
          role: [ 'readable' ],
          notes: 'Used by nightscout-connect to read Nightscout as a source of data.'
        };
        return http.post(authURL, subject, { headers }).then((resp) => {
          return http.get(authURL, { headers }).then((resp) => {
            var body = resp.data;
            var match = body.filter((item) => item.name == 'nightscout-connect-reader').pop( );
            if (match) {
              params.token = match.accessToken;
              debug("V3: Token created successfully");
              return params.token;
            }
            return Promise.reject(body);
          });
        });
      }).catch((err) => {
        debug("V3 AUTH ERROR", err.message);
        return Promise.reject(err);
      });
    },
    
    sessionFromAuth(accessToken, settings) {
      // V3 MUST have a bearer token, cannot use { readable: ... }
      if (accessToken && accessToken.readable) {
        debug("V3: 'readable' session not supported, need JWT token");
        // This shouldn't happen for V3, but if it does, reject
        return Promise.reject(new Error("V3 requires JWT bearer token"));
      }
      
      var tokenUrl = '/api/v2/authorization/request/' + accessToken;
      var headers = {};
      debug("V3: Exchanging token for JWT");
      return http.get(tokenUrl, { headers }).then((resp) => {
        var body = resp.data;
        var session = {
          bearer: body.token
        , ttl: (body.exp - body.iat) * 1000
        , info: body
        }
        debug("V3: JWT session established");
        return session;
      }).catch((err) => {
        debug("V3 SESSION ERROR", err.message);
        return Promise.reject(err);
      });
    },
    
    align_to_glucose (last_known) {
      debug("INSIDE NIGHTSCOUT SOURCE DRIVER ALIGNMENT FOR GLUCOSE V3");
      // Same logic as V1
      if (!last_known || !last_known.entries) {
        return;
      }
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
    },
    
    dataFromSesssion(session, last_known) {
      var two_days_ago = new Date( ).getTime( ) - (2 * 24 * 60 * 60 * 1000);
      var last_mills = Math.max(two_days_ago, (last_known && last_known.entries) ? last_known.entries.getTime( ) : two_days_ago);
      
      // V3 uses filter operators instead of MongoDB query syntax
      var count = Math.ceil(((new Date( )).getTime( ) - last_mills) / (1000 * 60 * 5));
      var query = {
        'date$gt': last_mills,  // Unix epoch in milliseconds
        'limit': count,
        'sort$desc': 'date'  // Most recent first
      };
      
      var dataUrl = '/api/v3/entries';
      var headers = { };
      
      // V3 REQUIRES bearer token
      if (!session.bearer) {
        debug("V3 ERROR: No bearer token in session", session);
        return Promise.reject(new Error("V3 requires bearer token for authentication"));
      }
      
      headers['Authorization'] = ['Bearer', session.bearer].join(' ');
      
      debug("FETCHING V3 GAPS FOR", last_known, dataUrl, query);
      return http.get(dataUrl, { params: query, headers }).then((resp) => {
        debug("V3 RESPONSE STATUS", resp.status, "HAS RESULT:", !!resp.data.result);
        // V3 wraps response in { status, result }
        if (resp.data && resp.data.result) {
          return resp.data.result;
        }
        return resp.data;
      }).catch((err) => {
        debug("V3 DATA FETCH ERROR", err.response?.status, err.message);
        return Promise.reject(err);
      });
    },
    
    transformGlucose (data) {
      // V3 returns array with different field names potentially
      // Map V3 fields to V1-compatible format if needed
      debug("TRANSFORMING V3 DATA", Array.isArray(data), data.length);
      
      // V3 uses 'date' field (epoch ms), V1 uses 'date' and 'dateString'
      // V3 uses 'identifier', V1 uses '_id'
      // Most other fields should be compatible
      var entries = data.map(function(entry) {
        // Ensure backward compatibility
        if (!entry.dateString && entry.date) {
          entry.dateString = new Date(entry.date).toISOString();
        }
        return entry;
      });
      
      return { entries: entries };
    }
  };
  
  // DEVICESTATUS SUPPORT
  // V1 DeviceStatus Implementation
  var devicestatusV1 = {
    align_to_devicestatus(last_known) {
      debug("INSIDE NIGHTSCOUT SOURCE DRIVER ALIGNMENT FOR DEVICESTATUS V1");
      if (!last_known || !last_known.devicestatus) {
        return;
      }
      var last_devicestatus_at = last_known.devicestatus;
      // DeviceStatus updates frequently (every 1-5 minutes typically)
      var check_interval = 5 * 60 * 1000; // Check every 5 minutes
      var next_check = last_devicestatus_at.getTime() + check_interval;
      var buffer_lag = 10000; // 10 second buffer
      var jitter = Math.floor(Math.random() * 1000 * 10); // 10 second random
      return next_check + buffer_lag + jitter;
    },
    
    dataFromSession(session, last_known) {
      var two_days_ago = new Date().getTime() - (2 * 24 * 60 * 60 * 1000);
      var last_mills = Math.max(two_days_ago, (last_known && last_known.devicestatus) ? last_known.devicestatus.getTime() : two_days_ago);
      var last_devicestatus_at = new Date(last_mills);
      var count = 1000; // DeviceStatus can be frequent
      
      var query = { 
        find: { created_at: { $gt: last_devicestatus_at.toISOString() } }, 
        count 
      };
      
      var dataUrl = '/api/v1/devicestatus.json';
      var headers = {};
      if (session.bearer) {
        headers['Authorization'] = ['Bearer', session.bearer].join(' ');
      }
      
      debug("FETCHING V1 DEVICESTATUS FOR", last_known, dataUrl, query);
      return http.get(dataUrl, { params: query, headers }).then((resp) => {
        return resp.data;
      }).catch((err) => {
        debug("V1 DEVICESTATUS FETCH ERROR", err.message);
        return Promise.reject(err);
      });
    },
    
    transformDeviceStatus(data) {
      debug("TRANSFORMING V1 DEVICESTATUS", Array.isArray(data), data ? data.length : 0);
      return { devicestatus: data };
    }
  };
  
  // V3 DeviceStatus Implementation
  var devicestatusV3 = {
    align_to_devicestatus(last_known) {
      debug("INSIDE NIGHTSCOUT SOURCE DRIVER ALIGNMENT FOR DEVICESTATUS V3");
      if (!last_known || !last_known.devicestatus) {
        return;
      }
      var last_devicestatus_at = last_known.devicestatus;
      var check_interval = 5 * 60 * 1000;
      var next_check = last_devicestatus_at.getTime() + check_interval;
      var buffer_lag = 10000;
      var jitter = Math.floor(Math.random() * 1000 * 10);
      return next_check + buffer_lag + jitter;
    },
    
    dataFromSession(session, last_known) {
      var two_days_ago = new Date().getTime() - (2 * 24 * 60 * 60 * 1000);
      var last_mills = Math.max(two_days_ago, (last_known && last_known.devicestatus) ? last_known.devicestatus.getTime() : two_days_ago);
      
      var query = {
        'date$gt': last_mills,
        'limit': 1000,
        'sort$desc': 'date'
      };
      
      var dataUrl = '/api/v3/devicestatus';
      var headers = {};
      
      if (!session.bearer) {
        debug("V3 DEVICESTATUS ERROR: No bearer token in session");
        return Promise.reject(new Error("V3 requires bearer token"));
      }
      
      headers['Authorization'] = ['Bearer', session.bearer].join(' ');
      
      debug("FETCHING V3 DEVICESTATUS FOR", last_known, dataUrl, query);
      return http.get(dataUrl, { params: query, headers }).then((resp) => {
        debug("V3 DEVICESTATUS RESPONSE STATUS", resp.status, "HAS RESULT:", !!resp.data.result);
        if (resp.data && resp.data.result) {
          return resp.data.result;
        }
        return resp.data;
      }).catch((err) => {
        debug("V3 DEVICESTATUS FETCH ERROR", err.response?.status, err.message);
        return Promise.reject(err);
      });
    },
    
    transformDeviceStatus(data) {
      debug("TRANSFORMING V3 DEVICESTATUS", Array.isArray(data), data ? data.length : 0);
      
      var devicestatus = data.map(function(status) {
        // Map V3 fields to be backward compatible
        if (!status.created_at && status.date) {
          status.created_at = new Date(status.date).toISOString();
        }
        if (!status._id && status.identifier) {
          status._id = status.identifier;
        }
        return status;
      });
      
      return { devicestatus: devicestatus };
    }
  };

  // Add devicestatus support
  var devicestatusImpl = {
    get current() {
      return detectedApiVersion === 'v3' ? devicestatusV3 : devicestatusV1;
    }
  };

  // TREATMENTS SUPPORT
  // V1 Treatments Implementation
  var treatmentsV1 = {
    align_to_treatments(last_known) {
      debug("INSIDE NIGHTSCOUT SOURCE DRIVER ALIGNMENT FOR TREATMENTS V1");
      if (!last_known || !last_known.treatments) {
        return;
      }
      var last_treatment_at = last_known.treatments;
      var check_interval = 5 * 60 * 1000; // Check every 5 minutes
      var next_check = last_treatment_at.getTime() + check_interval;
      var buffer_lag = 10000; // 10 second buffer
      var jitter = Math.floor(Math.random() * 1000 * 10); // 10 second random
      return next_check + buffer_lag + jitter;
    },
    
    dataFromSession(session, last_known) {
      var two_days_ago = new Date().getTime() - (2 * 24 * 60 * 60 * 1000);
      var last_mills = Math.max(two_days_ago, (last_known && last_known.treatments) ? last_known.treatments.getTime() : two_days_ago);
      var last_treatment_at = new Date(last_mills);
      var count = 1000;
      
      var query = { 
        find: { created_at: { $gt: last_treatment_at.toISOString() } }, 
        count 
      };
      
      var dataUrl = '/api/v1/treatments.json';
      var headers = {};
      if (session.bearer) {
        headers['Authorization'] = ['Bearer', session.bearer].join(' ');
      }
      
      debug("FETCHING V1 TREATMENTS FOR", last_known, dataUrl, query);
      return http.get(dataUrl, { params: query, headers }).then((resp) => {
        return resp.data;
      }).catch((err) => {
        debug("V1 TREATMENTS FETCH ERROR", err.message);
        return Promise.reject(err);
      });
    },
    
    transformTreatments(data) {
      debug("TRANSFORMING V1 TREATMENTS", Array.isArray(data), data ? data.length : 0);
      return { treatments: data };
    }
  };
  
  // V3 Treatments Implementation
  var treatmentsV3 = {
    align_to_treatments(last_known) {
      debug("INSIDE NIGHTSCOUT SOURCE DRIVER ALIGNMENT FOR TREATMENTS V3");
      if (!last_known || !last_known.treatments) {
        return;
      }
      var last_treatment_at = last_known.treatments;
      var check_interval = 5 * 60 * 1000;
      var next_check = last_treatment_at.getTime() + check_interval;
      var buffer_lag = 10000;
      var jitter = Math.floor(Math.random() * 1000 * 10);
      return next_check + buffer_lag + jitter;
    },
    
    dataFromSession(session, last_known) {
      var two_days_ago = new Date().getTime() - (2 * 24 * 60 * 60 * 1000);
      var last_mills = Math.max(two_days_ago, (last_known && last_known.treatments) ? last_known.treatments.getTime() : two_days_ago);
      
      var query = {
        'date$gt': last_mills,
        'limit': 1000,
        'sort$desc': 'date'
      };
      
      var dataUrl = '/api/v3/treatments';
      var headers = {};
      
      if (!session.bearer) {
        debug("V3 TREATMENTS ERROR: No bearer token in session");
        return Promise.reject(new Error("V3 requires bearer token"));
      }
      
      headers['Authorization'] = ['Bearer', session.bearer].join(' ');
      
      debug("FETCHING V3 TREATMENTS FOR", last_known, dataUrl, query);
      return http.get(dataUrl, { params: query, headers }).then((resp) => {
        debug("V3 TREATMENTS RESPONSE STATUS", resp.status, "HAS RESULT:", !!resp.data.result);
        if (resp.data && resp.data.result) {
          return resp.data.result;
        }
        return resp.data;
      }).catch((err) => {
        debug("V3 TREATMENTS FETCH ERROR", err.response?.status, err.message);
        return Promise.reject(err);
      });
    },
    
    transformTreatments(data) {
      debug("TRANSFORMING V3 TREATMENTS", Array.isArray(data), data ? data.length : 0);
      
      var treatments = data.map(function(treatment) {
        if (!treatment.created_at && treatment.date) {
          treatment.created_at = new Date(treatment.date).toISOString();
        }
        if (!treatment._id && treatment.identifier) {
          treatment._id = treatment.identifier;
        }
        return treatment;
      });
      
      return { treatments: treatments };
    }
  };

  // Add treatments support
  var treatmentsImpl = {
    get current() {
      return detectedApiVersion === 'v3' ? treatmentsV3 : treatmentsV1;
    }
  };
  
  // Wrapper that detects version and delegates to correct implementation
  var impl = {
    authFromCredentials(creds, settings) {
      // Detection happens during first auth
      return detectApiVersion().then((version) => {
        var selectedImpl = version === 'v3' ? implV3 : implV1;
        debug("NIGHTSCOUT: Using API version", version, "for authentication");
        return selectedImpl.authFromCredentials(creds, settings);
      });
    },
    sessionFromAuth(accessToken, settings) {
      // Use detected version
      var selectedImpl = detectedApiVersion === 'v3' ? implV3 : implV1;
      return selectedImpl.sessionFromAuth(accessToken, settings);
    },
    align_to_glucose(last_known) {
      var selectedImpl = detectedApiVersion === 'v3' ? implV3 : implV1;
      return selectedImpl.align_to_glucose(last_known);
    },
    dataFromSesssion(session, last_known) {
      var selectedImpl = detectedApiVersion === 'v3' ? implV3 : implV1;
      return selectedImpl.dataFromSesssion(session, last_known);
    },
    transformGlucose(data) {
      var selectedImpl = detectedApiVersion === 'v3' ? implV3 : implV1;
      var result = selectedImpl.transformGlucose(data);
      // Must return Nightscout-compatible batch with all collections
      return {
        entries: result.entries || [],
        treatments: [],
        profile: [],
        devicestatus: []
      };
    },
    // Treatments methods
    align_to_treatments(last_known) {
      return treatmentsImpl.current.align_to_treatments(last_known);
    },
    dataFromSessionTreatments(session, last_known) {
      return treatmentsImpl.current.dataFromSession(session, last_known);
    },
    transformTreatments(data) {
      var result = treatmentsImpl.current.transformTreatments(data);
      // Must return Nightscout-compatible batch with all collections
      return {
        entries: [],
        treatments: result.treatments || [],
        profile: [],
        devicestatus: []
      };
    },
    // DeviceStatus methods
    align_to_devicestatus(last_known) {
      return devicestatusImpl.current.align_to_devicestatus(last_known);
    },
    dataFromSessionDeviceStatus(session, last_known) {
      return devicestatusImpl.current.dataFromSession(session, last_known);
    },
    transformDeviceStatus(data) {
      var result = devicestatusImpl.current.transformDeviceStatus(data);
      // Must return Nightscout-compatible batch with all collections
      return {
        entries: [],
        treatments: [],
        profile: [],
        devicestatus: result.devicestatus || []
      };
    }
  };
  
  function tracker_for ( ) {
    var AxiosTracer = require('../../trace-axios');
    var tracker = AxiosTracer(http);
    return tracker;
  }
  
  function generate_driver (builder) {
    builder.support_session({
      authenticate: impl.authFromCredentials,
      authorize: impl.sessionFromAuth,
      delays: {
        REFRESH_AFTER_SESSSION_DELAY: 28800000,
        EXPIRE_SESSION_DELAY: 28800000,
      }
    });

    // Register entries loop
    builder.register_loop('NightscoutEntries', {
      tracker: tracker_for,
      frame: {
        impl: impl.dataFromSesssion,
        align_schedule: impl.align_to_glucose,
        transform: impl.transformGlucose,
        backoff: {
          interval_ms: 10000
        },
        maxRetries: 3
      },
      expected_data_interval_ms: 5 * 60 * 1000,
      backoff: {
        interval_ms: 2.5 * 60 * 1000
      },
    });
    
    // Register treatments loop
    builder.register_loop('NightscoutTreatments', {
      frame: {
        impl: impl.dataFromSessionTreatments,
        transform: impl.transformTreatments,
        backoff: {
          interval_ms: 10000
        },
        maxRetries: 3
      },
      expected_data_interval_ms: 5 * 60 * 1000,
      backoff: {
        interval_ms: 2.5 * 60 * 1000
      },
    });
    
    // Register devicestatus loop
    builder.register_loop('NightscoutDeviceStatus', {
      tracker: tracker_for,
      frame: {
        impl: impl.dataFromSessionDeviceStatus,
        transform: impl.transformDeviceStatus,
        backoff: {
          interval_ms: 10000
        },
        maxRetries: 3
      },
      expected_data_interval_ms: 5 * 60 * 1000,
      backoff: {
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