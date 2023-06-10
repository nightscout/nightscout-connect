

var createSession = require('./machines/session');
var createFetch = require('./machines/fetch');
var createCycle = require('./machines/cycle');
var createPoller = require('./machines/poller');

var backoff = require('./backoff');

// var outputs = require('./outputs');
var defaults = { };
function builder (config) {

  config = { ...config, ...defaults };

  var output = config.output;
  var impl = { };
  var OperatingStates = { };
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
    // var outputMachine = createOutput(output);
    // if (output.gaps_for) { }

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
    // { transformService, persistService }
    // promises exported from a vendor, and the output
    var adapter = {
      align_schedule: cfg.frame.align_schedule,
      dataFromSesssion: cfg.frame.impl,
      transformer: cfg.frame.transform,
      persister: output
    };
    var fetchMachine = createFetch(adapter, fetchConfig);

    var capture = config.capture && cfg.tracker ? { start: cfg.tracker, ...config.capture } : null;
    var cycleConfig = {
      delay_per_frame_error: backoff(cfg.backoff),
      expected_data_interval_ms: cfg.expected_data_interval_ms,
      name,
      capture
    };
    var serviceName = [name, 'Service'].join('');
    var cycleMachine = createCycle({ fetchMachine }, cycleConfig);
    consumer.services[serviceName] = cycleMachine;
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
