
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

  function generate_driver (builder) {
    builder.support_session({
    });
    builder.register_loop({
    });
    // builder.register_loop({ });

    return builder( );
  }

  return impl;

  function Factory ( ) { return this };
  Object.assign(Factory.prototype, impl);
  return new Factory( );

}
module.exports.fakeFrame = fakeFrame;

