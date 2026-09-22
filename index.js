
const { createMachine, Machine, actions, interpret, spawn  } = require('xstate');

/*
* 
* https://github.com/nightscout/cgm-remote-monitor/blob/master/lib/server/bootevent.js
*
  // ctx.nightscoutConnect = require('nightscout-connect')(env, ctx);
*/
var axios = require('axios');
var builder = require('./lib/builder');
var sources = require('./lib/sources');
var outputs = require('./lib/outputs');
var createLogger = require('./lib/logging');


function internalLoop (input, output) {
}

// A pool of connectors started together will otherwise reach the vendor
// together. Both windows default to 0, which is what every deployment does
// today; a hoster running many accounts behind one egress address sets them.
//
//   CONNECT_START_JITTER_MS     spread over the first cycle after START
//   CONNECT_INTERVAL_JITTER_MS  spread over the poll interval, on the path
//                               where the source has declined to align - the
//                               aligned path carries the driver's own spread
//
// Nightscout's extended settings coerce a numeric value for us, but a
// connector can also be constructed directly, so the parse is defensive.
// lib/machines/cycle.js caps every window at five minutes.
function jitter_window (value) {
  var ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function manage (env, ctx) {
  var connect = env.extendedSettings.connect;
  var log = createLogger(connect && connect.debug !== undefined
    ? connect.debug : env.debug && env.debug.logging);

  // source
  // output
  // env.extendedSettings.connect.source
  var spec = { kind: 'disabled' };
  if (!env.extendedSettings.connect) {
    log.debug('Skipping disabled connector');
    return;
  }
  if (!env.extendedSettings.connect.source) {
    log.debug('Skipping connector without a source');
    return;
  }

  spec.kind = env.extendedSettings.connect.source;

  // select an available input source implementation based on env
  // variables/config
  var driver = sources(spec);
  var validated = driver.validate(env.extendedSettings.connect);
  if (validated.errors) {
      ctx.bootErrors.push(...validated.errors);
  }

  log.debug('Input configured');

  if (!validated.ok) {
    log.error('Invalid configuration, disabling connector');
    return;
  }
  var internal = { name: 'internal', logger: log };
  var output = outputs(internal)(internal, ctx);
  log.debug('Internal output configured');
  var actor;
  var stopped = false;
  function handle () { return actor; }
  handle.run = () => {
    if (!stopped) actor.send({type: 'START'});
    return Promise.resolve(handle);
  };
  handle.stop = () => {
    if (!stopped) {
      stopped = true;
      ctx.bus.removeListener('data-processed', handle.run);
      ctx.bus.removeListener('tearDown', handle.stop);
      ctx.bus.removeListener('teardown', handle.stop);
      try { if (actor) actor.stop(); }
      finally { output.close(); }
    }
    return Promise.resolve(handle);
  };
  try {
    // output must be passed into builder, before generate_driver is called.
    var make = builder({
      output,
      logger: log,
      start_jitter_ms: jitter_window(connect.startJitterMs),
      interval_jitter_ms: jitter_window(connect.intervalJitterMs)
    });
    var impl = driver(validated.config, axios, log);
    impl.generate_driver(make);
    // Anything a machine logs goes through the connector logger as a fixed
    // label, never the value (Andy Low, 6abefe1).
    actor = interpret(make(), { logger: (label) => log.debug(typeof label === 'string' ? label : 'State machine log') });
    ctx.bus.once('data-processed', handle.run);
    ctx.bus.once('tearDown', handle.stop);
    ctx.bus.once('teardown', handle.stop);
    actor.start();
  } catch (error) {
    handle.stop();
    throw error;
  }

  return handle;
}


module.exports = manage;
