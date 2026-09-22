
const { createMachine, Machine, actions, interpret, spawn  } = require('xstate');
var testImpl = require('../testable_driver');
var axios = require('axios');
var builder = require('../lib/builder');
var sources = require('../lib/sources');
var outputs = require('../lib/outputs');
var logger = require('../lib/log-scrub').createLogger();

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
  var _v = driver.validate ? driver.validate(input) : null;
  if (_v && !_v.ok) logger.log("VALIDATION ERRORS", { count: _v.errors.length });
  var _opts = (_v && _v.ok) ? _v.config : input;
  console.log("DRIVER CONFIGURED", { kind: input.kind });
  var impl = driver(_opts, axios);
  // var impl = testImpl.fakeFrame({ }, axios);

  impl.generate_driver(make);

  var built = make( );
  // console.log("BUILDER OUTPUT", built);
  return built;

}

function main (argv) {
  console.log("STARTING", { source: argv.source });
  // selected output
  // argv.nightscoutEndpoint;
  // argv.apiSecret;
  // 
  var output = { name: 'nightscout', url: argv.nightscoutEndpoint, apiSecret: argv.apiSecret };
  console.log("CONFIGURED OUTPUT", { name: output.name });
  var input = Object.assign({}, argv, { kind: argv.source, url: argv.sourceEndpoint, apiSecret: argv.sourceApiSecret });
  // argv now carries every CONNECT_* env var, credentials included, so log the
  // shape rather than the values.
  console.log("CONFIGURED INPUT", { kind: input.kind });

  var things = sidecarLoop(input, output);
  var actor = interpret(things, { logger: logger.xstate });
  actor.start( );
  actor.send({type: 'START'});
  setTimeout(( ) => {
  actor.send({type: 'STOP'});
  }, 60000 * 60 * 24);

}


module.exports.command = 'forever [hint]';
module.exports.describe = 'Runs as a background server forever.'
module.exports.builder = (yargs) => yargs.option('source', { alias: 'hint', describe: 'source input', default: 'default', choices: Object.keys(sources.kinds)})
module.exports.handler = main;
