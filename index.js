
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

  var internal = { name: 'internal' };
  var output = outputs(internal)(internal, ctx);
  console.log("CONFIGURED OUTPUT", output);

  // var things = internalLoop(input, output);
  // everything known for output
  // output must be passed into builder, before generate_driver is
  // called.
  var make = builder({ output });

  // select an available input source implementation based on env
  // variables/config
  var driver = sources(spec);
  var validated = driver.validate(env.extendedSettings.connect);
  if (validated.errors) {
      ctx.bootErrors.push(...validated.errors);
  }

  console.log("INPUT PARAMS", spec, validated.config);

  if (!validated.ok) {
    console.log("Invalid, disabling nightscout-connect", validated);
    return;
  }
  var impl = driver(validated.config, axios);
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


  ctx.bus.on('tick', console.log.bind(console, 'DEBUG nightscout-connect'));
  ctx.bus.once('data-processed', handle.run);
  ctx.bus.once('tearDown', handle.stop);
  // console.log(things);
  var actor = interpret(things);
  actor.start( );
  // actor.send({type: 'START'});

  return handle;
}


module.exports = manage;
