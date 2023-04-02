

var createSession = require('./machines/session');
var createFetch = require('./machines/fetch');
var createCycle = require('./machines/cycle');
var createPoller = require('./machines/poller');

function backoff (config) {
  var defaults = {
    interval_ms: 256,
    exponent_ceiling: 20,
    exponent_base: 2,
    use_random_slot: false
  };
  var opts = { ...config, ...defaults };
  var I = opts.interval_ms || 265;
  var C = opts.exponent_ceiling || 20;
  var B = opts.exponent_base || 2;
  function pick_random_slot(K) {
    var S = Math.floor(Math.random( ) * (K + 1))
    return S;
  }
  function maximum_time (K) {
    return K;
  }
  const choose = opts.use_random_slot ? pick_random_slot : maximum_time;
  function duration_for (attempt) {
    var K = Math.pow(B, Math.min(attempt, C)) - 1;
    var S = choose(K);
    var interval = I * S;
    return interval;
    // return I * Math.pow(B, attempt);
  }
  return duration_for;
}


function builder ( ) {

  var impl = { };
  var OperatingStates = {
  };
  var consumer = {
    services: {
    },
    names: [ ],
    states: { },
  };

  var session_consumers = [ ];

  function framer ( ) {

    return make( );
    return { services: impl, states: OperatingStates, session_consumers, consumer };

  }

  function make ( ) {
    var sessionMachine = createSession(impl);

    var pollingMachine = createPoller(sessionMachine, consumer);
    return pollingMachine;

  }

  framer.support_session = (details) => {
    impl = { ...details, ...impl };
    return framer;
  }
  framer.register_loop = (name, cfg) => {
    session_consumers.push(name);
    consumer.names.push(name);
    // cfg.frame.maxRetries
    //
    var fetchConfig = {
      maxRetries: cfg.frame.maxRetries,
      frame_retry_duration: backoff(cfg.frame.backoff)
    };
    var fetchMachine = createFetch({ dataFromSesssion: cfg.frame.impl }, fetchConfig);

    var cycleConfig = {
      delay_per_frame_error: backoff(cfg.backoff),
      expected_data_interval_ms: cfg.expected_data_interval_ms,
      name
    };
    var serviceName = [name, 'Service'].join('');
    var cycleMachine = createCycle({ fetchMachine }, cycleConfig);
    consumer.services[serviceName] = cycleMachine;
    // consumer.services[serviceName] = (context, event) => cfg.frame.impl(context.session);
    consumer.states[name] = {
      invoke: {
        id: name,
        src: serviceName,
        // src: cfg.frame.impl
      }
    };
    return framer;
  }
  return framer;
}
module.exports = builder;
