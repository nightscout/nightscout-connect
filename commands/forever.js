
const { createMachine, Machine, actions, interpret, spawn  } = require('xstate');
var testImpl = require('../testable_driver');
var axios = require('axios');
var builder = require('../lib/builder');
var sources = require('../lib/sources');
var outputs = require('../lib/outputs');
var applyBridgeCompatibility = require('../lib/compat');

function sidecarLoop (input, output) {
  
  // everything known for output
  // output must be passed into builder, before generate_driver is
  // called.
  var endpoint = outputs(output)(output, axios);
  var make = builder({ output: endpoint });
  // var make = builder({ output });

  // select an available input source implementation based on env
  // variables/config
  var driver = sources(input);
  console.log("INPUT PARAMS", input);
  var impl = driver(input, axios);
  // var impl = testImpl.fakeFrame({ }, axios);

  impl.generate_driver(make);

  var built = make( );
  // console.log("BUILDER OUTPUT", built);
  console.log("BUILDER OUTPUT", JSON.stringify(built, null, 2));
  return built;

}

function main (argv) {
  console.log("STARTING", argv);
  // selected output
  // argv.nightscoutEndpoint;
  // argv.apiSecret;
  // 
  var output = { name: 'nightscout', url: argv.nightscoutEndpoint, apiSecret: argv.apiSecret };
  console.log("CONFIGURED OUTPUT", output);
  
  // Apply compatibility layer for old bridge plugin environment variables
  var connectInput = applyBridgeCompatibility(argv);
  
  var input = { kind: argv.source, url: argv.sourceEndpoint, apiSecret: argv.sourceApiSecret, ...connectInput };
  console.log("CONFIGURED INPUT", input);

  var things = sidecarLoop(input, output);
  console.log(things);
  var actor = interpret(things);
  
  // Subscribe to state transitions to catch errors
  actor.onTransition((state) => {
    if (state.event && state.event.type && state.event.type.includes('ERROR')) {
      console.error("STATE MACHINE ERROR:", state.event);
    }
  });
  
  // Handle graceful shutdown on SIGINT/SIGTERM
  process.on('SIGINT', () => {
    console.log("\nReceived SIGINT, stopping gracefully...");
    actor.send({type: 'STOP'});
    setTimeout(() => process.exit(0), 1000);
  });
  
  process.on('SIGTERM', () => {
    console.log("\nReceived SIGTERM, stopping gracefully...");
    actor.send({type: 'STOP'});
    setTimeout(() => process.exit(0), 1000);
  });
  
  // Catch unhandled errors
  process.on('uncaughtException', (error) => {
    console.error("UNCAUGHT EXCEPTION:", error);
    console.error("Process will continue running...");
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    console.error("UNHANDLED REJECTION at:", promise, "reason:", reason);
    console.error("Process will continue running...");
  });
  
  actor.start( );
  actor.send({type: 'START'});
  
  console.log("nightscout-connect running continuously. Press Ctrl+C to stop.");
}


module.exports.command = 'forever [hint]';
module.exports.describe = 'Runs as a background server forever.'
module.exports.builder = (yargs) => yargs.option('source', { alias: 'hint', describe: 'source input', default: 'default', choices: Object.keys(sources.kinds)})
module.exports.handler = main;
