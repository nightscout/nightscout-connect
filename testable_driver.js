
/*
* 
* Roughly simulates network I/O via a Promise using setTimeout.  These fail at
* much higher rates than in real life at every point, making it a kind of
* stress test for the actor logic.
*
* Real drivers would be expected to use axios.get and axios.post with suitable
* URLs, headers, content bodies to exchange credentials for a session and a
* session for up to date Nightscout data.
* There will also need to be a way to evalute gaps for Nightscout and pass the
* needed gap information into this in order to customize the query correctly.
* 
* Injecting axios as a dependency will allow mocking using moxios, sinon or
* other tools.
*/

function fakeFrame (opts, axios) {

  
  const impl = {
    authFromCredentials(creds, settings) {
      var delay = 200;
      var probability = .2;
      var maybeCredentials = new Promise((resolve, reject) => {
        setTimeout(() => {
          if (probability > Math.random( )) {
            return reject({ type: 'auth', status: 500, msg: "foo"});
          }
          resolve("foo");
        }, delay);
      });
      return maybeCredentials;
    },

    sessionFromAuth(auth, settings) {
      var delay = 100;
      var probability = .2;
      var maybeSession= new Promise((resolve, reject) => {
        setTimeout(() => {
          if (probability > Math.random( )) {
            return reject({ type: 'session', status: 500, msg: "foo"});
          }
          resolve(auth);
        }, delay);
      });
      return maybeSession;
    },

    dataFromSesssion(session, settings) {
      var delay = 300;
      var probability = .5;
      var maybeData = new Promise((resolve, reject) => {
        setTimeout(() => {
          if (probability > Math.random( )) {
            return reject({ type: 'data', status: 500, msg: "foo"});
          }
          resolve({entries: [], treatments: [] });
        }, delay);
      });
      return maybeData;
    },

    fakeTransformGlucose (data) {
      console.log('MODIFY TRANSFORM GLUCOSE FAKE', data);
      data.faked = true;
      data.dateTime =  (new Date()).toISOString();
      data.date =  (new Date()).getTime();
      return data;

    },
    simulateBadCreds(ref) {
    },

    simulateGoodCreds(ref) {
    },

    simulateBadSession(ref) {
    },

    simulateGoodSession(ref) {
    },

    simulateBadData(ref) {
    },

    simulateGoodData(ref) {
    },

  };

  /*
  * Pass the driver a builder to describe how this driver exposes
  * functionality.
  */
  function generate_driver (builder) {

    // it's common to need to build a session
    builder.support_session({
      authenticate: impl.authFromCredentials,
      authorize: impl.sessionFromAuth,
      // refresh: impl.refreshSession,
      delays: {
        REFRESH_AFTER_SESSSION_DELAY: 1600,
        EXPIRE_SESSION_DELAY: 2200,
      }
    });

    // some drivers have one loop every five minutes, some have others at
    // varying hourly or daily intervals.
    builder.register_loop('Cycle', {
      frame: {
        impl: impl.dataFromSesssion,
        transform: impl.fakeTransformGlucose,
        backoff: {
        },
        // transformer
        maxRetries: 3
      },
      // expected_data_interval_ms: 5 * 60 * 1000
      expected_data_interval_ms: 333,
      backoff: {
        interval_ms: 2500
      },
    });
    // could be called multiple times
    // builder.register_loop({ ...hourlyConfig });
    builder.register_loop('AnotherLonger', {
      frame: {
        impl: impl.dataFromSesssion,
        backoff: {
          interval_ms: 3500
        },
        maxRetries: 3
      },
      // expected_data_interval_ms: 5 * 60 * 1000
      expected_data_interval_ms: 2.3 * 60 * 1000,
      backoff: {
        interval_ms: 4500
      },
    });

    return builder;
  }

  impl.generate_driver = generate_driver;
  return impl;

  // consider using class, but rejected; maybe in the builder?
  function Factory ( ) { return this };
  Object.assign(Factory.prototype, impl);
  return new Factory( );

}
module.exports.fakeFrame = fakeFrame;

