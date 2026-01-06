
const { createMachine, Machine, actions, interpret, spawn  } = require('xstate');
var testImpl = require('../testable_driver');
var axios = require('axios');
var builder = require('../lib/builder');
var sources = require('../lib/sources');
var outputs = require('../lib/outputs');

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
  var input = { kind: argv.source, url: argv.sourceEndpoint, apiSecret: argv.sourceApiSecret };
  console.log("CONFIGURED INPUT", input);

  var things = sidecarLoop(input, output);
  console.log(things);
  var actor = interpret(things);
  
  // Handle errors to prevent crashes
  actor.onError((error) => {
    console.error("STATE MACHINE ERROR:", error);
    // Don't exit - let it continue running
  });
  
  // Handle graceful shutdown on SIGINT/SIGTERM
  process.on('SIGINT', () => {
    console.log("Received SIGINT, stopping gracefully...");
    actor.send({type: 'STOP'});
    setTimeout(() => process.exit(0), 1000);
  });
  
  process.on('SIGTERM', () => {
    console.log("Received SIGTERM, stopping gracefully...");
    actor.send({type: 'STOP'});
    setTimeout(() => process.exit(0), 1000);
  });
  
  actor.start( );
  actor.send({type: 'START'});
  
  console.log("nightscout-connect running continuously. Press Ctrl+C to stop.");
}


module.exports.command = 'forever [hint]';
module.exports.describe = 'Runs as a background server forever.'
module.exports.builder = (yargs) => yargs.option('source', { alias: 'hint', describe: 'source input', default: 'default', choices: Object.keys(sources.kinds)})
module.exports.handler = main;
