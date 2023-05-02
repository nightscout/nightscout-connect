
var qs = require('qs');
var url = require('url');

_known_servers = {
  default: 'api.glooko.com'
, development: 'api.glooko.work'
, production: 'externalapi.glooko.com'
};

var Defaults = {
  "applicationId":"d89443d2-327c-4a6f-89e5-496bbb0317db"
, "lastGuid":"1e0c094e-1e54-4a4f-8e6a-f94484b53789" // hardcoded, random guid; no Glooko docs to explain need for param or why bad data works
, login: '/api/v2/users/sign_in'
, mime: 'application/json'
, LatestFoods: '/api/v2/foods'
, LatestInsulins: '/api/v2/insulins'
, LatestPumpBasals: '/api/v2/pumps/scheduled_basals'
, LatestPumpBolus: '/api/v2/pumps/normal_boluses'
// ?sessionID=e59c836f-5aeb-4b95-afa2-39cf2769fede&minutes=1440&maxCount=1"
};

function base_for (spec) {
  var server = spec.glookoServer ? spec.glookoServer : _known_servers[spec.glookoEnv || 'default' ];
  var base = {
    protocol: 'https',
    host: server
  };
  return url.format(base);
}

function login_payload (opts) {
  var body = {
    "userLogin": {
      "email": opts.glookoEmail,
      "password": opts.glookoPassword
    },
    "deviceInformation": {
      "deviceModel": "iPhone"
    }    
  };
  return body;
}
function glookoSource (opts, axios) {
  var default_headers = { 'Content-Type': Defaults.mime,
                          'Accept': Defaults.mime };
  var baseURL = opts.baseURL;
  var http = axios.create({ baseURL, headers: default_headers });
  var impl = {
    authFromCredentials ( ) {
      var payload = login_payload(opts);
      return http.post(Defaults.login, payload).then((response) => {
        console.log("GLOOKO AUTH", response.headers, response.data);
        return { cookies: response.headers['set-cookie'][0] };

      });
    },
    sessionFromAuth (auth) {
      return Promise.resolve(auth);
    },
    dataFromSesssion (session, last_known) {
      function fetcher (endpoint) {
        var headers = { Cookie: session.cookies };
        return http.get(endpoint, {headers: headers});
      }

      return Promise.all([
        fetcher(Defaults.LatestFoods),
        fetcher(Defaults.LatestInsulins),
        fetcher(Defaults.LatestPumpBasals),
        fetcher(Defaults.LatestPumpBolus),
        ]).then(function (results) {
          console.log('GLOOKO DATA FETCH', results);
        });
    },
    align_to_glucose ( ) {
    },
    transformData (batch) {
      return { entries: [ ] };
    },
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
  }
  impl.generate_driver = generate_driver;
  return impl;
}

glookoSource.validate = function validate_inputs (input) {
  var ok = false;
  var baseURL = base_for(input);
  var config = {
    glookoEnv: input.glookoEnv,
    glookoServer: input.glookoServer,
    glookoEmail: input.glookoEmail,
    glookoPassword: input.glookoPassword,
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
