
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

  var internal = { name: 'internal', logger: log };
  var output = outputs(internal)(internal, ctx);
  log.debug('Internal output configured');

  // var things = internalLoop(input, output);
  // everything known for output
  // output must be passed into builder, before generate_driver is
  // called.
  var make = builder({ output, logger: log });

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
  var impl = driver(validated.config, axios, log);
  impl.generate_driver(make);
  var things = make( );

  function handle ( ) { return actor; };
  handle.run = () => {
    actor.send({type: 'START'});
    return Promise.resolve(handle);
  }
  handle.stop = () => {
    actor.stop( );
    return Promise.resolve(handle);
  }


  ctx.bus.once('data-processed', handle.run);
  ctx.bus.once('tearDown', handle.stop);
  // console.log(things);
  var actor = interpret(things);
  actor.start( );
  // actor.send({type: 'START'});

  return handle;
}


module.exports = manage;
