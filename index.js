
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


function internalLoop (input, output) {
}

function manage (env, ctx) {

  // source
  // output
  // env.extendedSettings.connect.source
  var spec = { kind: 'disabled' };
  if (!env.extendedSettings.connect) {
    console.log("Skipping disabled nightscout-connect");
    return;
  }
  if (!env.extendedSettings.connect.source) {
    console.log("Skipping disabled nightscout-connect, no source driver spec");
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

  console.log("nightscout-connect input configured");

  if (!validated.ok) {
    console.log("Invalid configuration, disabling nightscout-connect");
    return;
  }
  var internal = { name: 'internal' };
  var output = outputs(internal)(internal, ctx);
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
    var make = builder({output});
    var impl = driver(validated.config, axios);
    impl.generate_driver(make);
    actor = interpret(make());
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
