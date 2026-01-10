/**
 * LibreLinkUp integration for Nightscout Connect
 * 
 * Based on the standalone implementation by Timo Schlueter:
 * https://github.com/timoschlueter/nightscout-librelink-up
 * 
 * Original work Copyright (c) Timo Schlueter
 * Licensed under MIT License
 * 
 * Portions of this code are adapted from the above repository,
 * which is licensed under the MIT License:
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

var url = require('url');
var debug = require('../debug');
var crypto = require('crypto');

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
    LA: "api-la.libreview.io",
    RU: "api.libreview.ru",
    CN: "api-cn.myfreestyle.cn"
}

var Defaults = {
  Login: '/llu/auth/login',
  Connections: '/llu/connections',
  Graph: '/llu/connections/',
  mime: 'application/json',
  Version: '4.16.0',
  Product: 'llu.ios',
};

// iPhone user agent for stealth mode
const USER_AGENT = "Mozilla/5.0 (iPhone; CPU OS 17_4.1 like Mac OS X) AppleWebKit/536.26 (KHTML, like Gecko) Version/17.4.1 Mobile/10A5355d Safari/8536.25";

var software = require('../../package.json');

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

function getUtcDateFromString(timeStamp) {
  const utcDate = new Date(timeStamp);
  utcDate.setTime(utcDate.getTime() - utcDate.getTimezoneOffset() * 60 * 1000);
  return utcDate;
}

function base_for (spec) {
  var server = spec.linkUpServer ? spec.linkUpServer : _LluApiEndpoints[spec.linkUpRegion.toUpperCase( ) || 'EU' ];
  var base = {
    protocol: 'https',
    host: server
  };
  return url.format(base);
}

function linkUpSource (opts, axios) {
  // Generate stealth ciphers for HTTPS agent to bypass Cloudflare SSL fingerprinting
  const defaultCiphers = crypto.constants.defaultCipherList.split(":");
  const stealthCiphers = [
    defaultCiphers[0],
    defaultCiphers[2],
    defaultCiphers[1],
    ...defaultCiphers.slice(3)
  ];

  var default_headers = { 
    'Content-Type': Defaults.mime + ';charset=UTF-8',
    'Accept': Defaults.mime,
    'Accept-Encoding': "gzip, deflate, br",
    'version': opts.linkUpVersion,
    'User-Agent': USER_AGENT,
    'product': opts.linkUpProduct
  };
  
  var baseURL = opts.baseURL;
  
  // Create axios instance with stealth HTTPS agent
  var https = require('https');
  var stealthHttpsAgent = new https.Agent({
    ciphers: stealthCiphers.join(":")
  });
  
  var http = axios.create({ 
    baseURL, 
    headers: default_headers,
    httpsAgent: stealthHttpsAgent
  });

  // State management for authentication
  var authState = {
    authTicket: null,
    userId: null
  };

  var impl = {
    authFromCredentials ( ) {
      var payload = {
        email: opts.linkUpUsername,
        password: opts.linkUpPassword
      };
      
      debug("LIBRE LINKUP AUTH REQUEST", payload.email);
      
      return http.post(Defaults.Login, payload).then((response) => {
        debug("LIBRE LINKUP AUTH RESPONSE", response.status, response.data);
        
        if (response.data.status !== 0) {
          var err = new Error("LibreLink Up - Non-zero status code: " + JSON.stringify(response.data));
          debug(err);
          throw err;
        }
        
        if (response.data.data.redirect === true && response.data.data.region) {
          const correctRegion = response.data.data.region.toUpperCase();
          var err = new Error(`LibreLink Up - Logged in to wrong region. Switch to '${correctRegion}' region.`);
          debug(err);
          throw err;
        }
        
        // Store userId for account-id header
        if (response.data.data.user && response.data.data.user.id) {
          authState.userId = response.data.data.user.id;
        }
        
        return response.data;
      });
    },
    sessionFromAuth (auth) {
      function isPatient (elem) {
        return elem.patientId == opts.linkUpPatientId;
      }
      
      var token = auth.data.authTicket.token;
      authState.authTicket = auth.data.authTicket;
      
      var headers = {
        'Authorization': 'Bearer ' + token
      };
      
      // Add SHA-256 hashed account-id if userId is available
      if (authState.userId) {
        try {
          headers['account-id'] = crypto.createHash("sha256").update(authState.userId).digest("hex");
        } catch (error) {
          debug("Error creating account-id hash:", error);
        }
      }
      
      debug("REQUESTING CONNECTIONS WITH HEADERS", headers);
      
      return http.get(Defaults.Connections, { headers }).then((resp) => {
        debug("CONNECTIONS RESPONSE FROM LIBRELINKUP", resp.status, resp.data);
        var connections = resp.data.data;

        if (connections.length == 0) {
          var err = new Error("NO CONNECTION WITH LIBRE LINKUP AVAILABLE");
          debug(err);
          throw err;
        }
        
        if (connections.length > 1 && opts.linkUpPatientId) {
          connections = connections.filter(isPatient);
          if (connections.length > 1) {
            debug("WARNING: Multiple connections found. Choose one patientId:", connections.map(c => c.patientId));
          }
        }
        
        if (connections.length > 1 && !opts.linkUpPatientId) {
          debug("WARNING: Multiple connections found. Using first connection. Consider setting CONNECT_LINK_UP_PATIENT_ID");
          debug("Available Patient IDs:", connections.map(c => ({ 
            name: c.firstName + ' ' + c.lastName, 
            patientId: c.patientId 
          })));
        }
        
        var result = connections[0];
        result.authTicket = auth.data.authTicket;
        debug("LIBRE SESSION FROM AUTH - Selected Connection:", result.firstName, result.lastName, result.patientId);
        return result;
      });
    },
    dataFromSesssion (session, last_known) {
      var token = session.authTicket.token;
      var patientId = session.patientId;
      var graph_url = Defaults.Graph + patientId + '/graph';
      
      var headers = {
        'Authorization': 'Bearer ' + token
      };
      
      // Add SHA-256 hashed account-id if userId is available
      if (authState.userId) {
        try {
          headers['account-id'] = crypto.createHash("sha256").update(authState.userId).digest("hex");
        } catch (error) {
          debug("Error creating account-id hash:", error);
        }
      }
      
      debug("REQUESTING GLUCOSE DATA FROM", graph_url);
      
      return http.get(graph_url, { headers }).then((resp) => {
        debug("RECEIVED LIBRE GRAPH DATA", resp.status, resp.data);
        return resp.data;
      });
    },
    transformGlucose (payload, last_known) {
      var { status, data, ticket } = payload;
      
      if (status !== 0) {
        debug("WARNING: Non-zero status in graph response:", status);
      }
      
      var connection = data.connection;
      var graphData = data.graphData;
      
      function is_newer (elem) {
        if (!last_known || !last_known.entries) { 
          return true; 
        }
        var entryDate = getUtcDateFromString(elem.FactoryTimestamp);
        return last_known.entries < entryDate;
      }

      function to_ns_sgv (elem, includeDirection) {
        var dateTime = getUtcDateFromString(elem.FactoryTimestamp);
        
        var entry = {
          type: 'sgv',
          device: 'nightscout-connect-librelinkup',
          dateString: dateTime.toISOString( ),
          date: dateTime.getTime( ),
          sgv: elem.ValueInMgPerDl,
        };
        
        // Only include direction if present (current measurement)
        if (includeDirection && elem.TrendArrow !== undefined) {
          entry.direction = mapArrowTrend(elem.TrendArrow);
        }
        
        return entry;
      }

      var entries = [ ];
      
      // Add the most recent measurement first (from connection.glucoseMeasurement)
      if (connection && connection.glucoseMeasurement) {
        var currentMeasurement = connection.glucoseMeasurement;
        if (is_newer(currentMeasurement)) {
          entries.push(to_ns_sgv(currentMeasurement, true));
        }
      }
      
      // Add historical measurements (from graphData array)
      if (graphData && graphData.length > 0) {
        var historicalEntries = graphData
          .filter(is_newer)
          .map(elem => to_ns_sgv(elem, false));
        entries = entries.concat(historicalEntries);
      }
      
      var treatments = [ ];
      var devicestatus = [ ];
      var profiles = [ ];
      
      debug("TRANSFORMING LIBRE BATCH - Total entries:", entries.length);
      
      return { entries, treatments, devicestatus, profiles };
    },
    align_to_glucose (last_known) {
      debug("LIBRELINKUP SOURCE DRIVER ALIGNMENT FOR GLUCOSE");
      if (!last_known || !last_known.entries) {
        return;
      }
      
      var last_glucose_at = last_known.entries;
      var now = new Date( ).getTime( );
      var elapsed = now - last_glucose_at.getTime( );
      var missing = elapsed / (1000 * 60 * 5); // 5-minute intervals
      
      if (missing > 1 && missing < 3) {
        debug("READJUSTING ALIGNMENT - Missing intervals:", missing);
      }
      
      // Calculate next expected reading time
      var next_due = last_glucose_at.getTime( ) + (Math.ceil(missing) * 1000 * 60 * 5);
      var buffer_lag = 18000; // 18 second buffer
      var jitter = Math.floor(Math.random( ) * 1000 * 18); // 18 second random jitter
      var align_to = next_due + buffer_lag + jitter;
      
      debug("ALIGNMENT calculated - Next due:", new Date(align_to).toISOString());
      
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
      delays: {
        // Token typically valid for 180 days (15552000000 ms), refresh 10 minutes before expiry
        REFRESH_AFTER_SESSSION_DELAY: 15552000000 - 600000,
        EXPIRE_SESSION_DELAY: 15552000000
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

linkUpSource.validate = function validate_inputs (input) {
  var ok = false;
  var baseURL = base_for(input);
  var config = {
    linkUpRegion: input.linkUpRegion,
    linkUpServer: input.linkUpServer,
    linkUpUsername: input.linkUpUsername,
    linkUpPassword: input.linkUpPassword,
    linkUpPatientId: input.linkUpPatientId,
    linkUpVersion: input.linkUpVersion || Defaults.Version,
    linkUpProduct: input.linkUpProduct || Defaults.Product,
    baseURL
  };
  
  var errors = [ ];
  
  if (!config.linkUpUsername) {
    errors.push({
      desc: "LibreLinkUp Username is required. CONNECT_LINK_UP_USERNAME must be set to an active LibreLinkUp email address.", 
      err: new Error('CONNECT_LINK_UP_USERNAME') 
    });
  }
  
  if (!config.linkUpPassword) {
    errors.push({
      desc: "LibreLinkUp Password is required. CONNECT_LINK_UP_PASSWORD must be set to the password for the LibreLinkUp account.", 
      err: new Error('CONNECT_LINK_UP_PASSWORD') 
    });
  }
  
  // Validate region if specified
  if (config.linkUpRegion) {
    var validRegions = Object.keys(_LluApiEndpoints);
    if (!validRegions.includes(config.linkUpRegion.toUpperCase())) {
      errors.push({
        desc: `LibreLinkUp Region must be one of: ${validRegions.join(', ')}. Got: ${config.linkUpRegion}`,
        err: new Error('CONNECT_LINK_UP_REGION')
      });
    }
  }
  
  ok = errors.length == 0;
  config.kind = ok ? 'linkUp' : 'disabled';
  
  return { ok, errors, config };
}

module.exports = linkUpSource;
