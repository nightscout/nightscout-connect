

var createSession = require('./machines/session');
var createFetch = require('./machines/fetch');
var createCycle = require('./machines/cycle');
var createPoller = require('./machines/poller');

var backoff = require('./backoff');

// var outputs = require('./outputs');
var defaults = { };
function builder (config) {

  // Defaults first, so a caller's value is the one that survives. The other
  // spelling of this merge in lib/backoff.js silently discarded everything
  // every source passed it; there is nothing in `defaults` here today, but
  // the order should not be the reason for that.
  config = { ...defaults, ...config };

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
    var sessionMachine = createSession(impl, { logger: config.logger });
    // var outputMachine = createOutput(output);
    // if (output.gaps_for) { }

    var pollingMachine = createPoller(sessionMachine, consumer, { logger: config.logger });
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
    // Ceilings, which lib/backoff.js could not apply on its own because it is
    // not told what the loop's cadence is. Both are stated as a relationship
    // to the poll interval rather than as a constant, and a source can
    // override either by naming `max_interval_ms` in its own backoff block.
    //
    //   frame retry: waiting longer than the next scheduled cycle cannot
    //   help - the cycle would have re-fetched by then anyway.
    //
    //   cycle: bounds how long a feed stays dark after a long vendor outage.
    //   Six intervals is 30 minutes on the five-minute cadence every shipped
    //   source declares. REVIEWER: this number is a judgement, not a
    //   measurement.
    var interval_ms = cfg.expected_data_interval_ms;
    var fetchConfig = {
      logger: config.logger,
      maxRetries: cfg.frame.maxRetries,
      noRetryStatuses: cfg.frame.noRetryStatuses || [],
      // A source that names a fixed frame retry (LibreLinkUp) keeps it;
      // otherwise the frame backoff, capped at one poll interval.
      frame_retry_duration: cfg.frame.retry_interval_ms === undefined
        ? backoff({ max_interval_ms: interval_ms, ...cfg.frame.backoff })
        : (attempt) => attempt > 0 ? cfg.frame.retry_interval_ms : 0
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
      logger: config.logger,
      delay_per_frame_error: backoff({ max_interval_ms: interval_ms * 6, ...cfg.backoff }),
      expected_data_interval_ms: interval_ms,
      throttle_backoff_per_error_ms: cfg.throttle_backoff_per_error_ms,
      throttle_monitor_enabled: cfg.throttle_monitor_enabled,
      start_jitter_ms: config.start_jitter_ms,
      interval_jitter_ms: config.interval_jitter_ms,
      startup_jitter_ms: cfg.startup_jitter_ms,
      expected_interval_jitter_ms: cfg.expected_interval_jitter_ms,
      random: config.random,
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
