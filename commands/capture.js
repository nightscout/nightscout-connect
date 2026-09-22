
const { createMachine, Machine, actions, interpret, spawn  } = require('xstate');
var testImpl = require('../testable_driver');
var axios = require('axios');
var builder = require('../lib/builder');
var sources = require('../lib/sources');
var outputs = require('../lib/outputs');
var createLogger = require('../lib/logging');

function sidecarLoop (input, output, capture) {
  
  // everything known for output
  // output must be passed into builder, before generate_driver is
  // called.
  var endpoint = outputs(output)(output, axios);
  var make = builder({ output: endpoint, capture });
  // var make = builder({ output });

  // select an available input source implementation based on env
  // variables/config
  var driver = sources(input);
  console.log("INPUT PARAMS");
  var impl = driver(input, axios);
  // var impl = testImpl.fakeFrame({ }, axios);

  impl.generate_driver(make);

  var built = make( );
  // console.log("BUILDER OUTPUT", built);
  console.log("BUILDER OUTPUT");
  return built;

}

// Anything a machine logs is reduced to a fixed label, printed only with
// --debug / CONNECT_DEBUG (Andy Low, 6abefe1).
function stateMachineLogger (argv) {
  var log = createLogger(argv.debug);
  return (label) => log.debug(typeof label === 'string' ? label : 'State machine log');
}

function main (argv) {
  console.log("STARTING");
  // selected output
  // argv.nightscoutEndpoint;
  // argv.apiSecret;
  // 

  var endpoint = { name: 'nightscout', url: argv.nightscoutEndpoint, apiSecret: argv.apiSecret };
  var input = { kind: argv.source, url: argv.sourceEndpoint, apiSecret: argv.sourceApiSecret || '' };
  console.log("CONFIGURED INPUT", { kind: input.kind });


  // var things = sidecarLoop(input, output, { dir: argv.dir });
  var output_config = endpoint;
  if (argv.output == 'filesystem') {
    output_config = {
      name: 'filesystem'
    , directory: argv['fs-prefix']
    , label: argv['fs-label']
    };
  }

  console.log("CONFIGURED OUTPUT", { name: output_config.name });
  var output = outputs(output_config)(output_config, axios);
  var capture = { dir: argv.dir };
  var make = builder({ output, capture });

  var spec = { kind: 'disabled' };
  spec.kind = argv.source;
  // select an available input source implementation based on env
  // variables/config
  var driver = sources(spec);
  var validated = driver.validate(argv);
  if (validated.errors) {
    console.log("VALIDATION ERRORS", { count: validated.errors.length });
  }

  console.log("INPUT PARAMS", { kind: spec.kind });

  if (!validated.ok) {
    console.log("Invalid, disabling nightscout-connect");
    process.exit(1);
    return;
  }
  var impl = driver(validated.config, axios);
  impl.generate_driver(make);
  var things = make( );



  //console.log(things);
  var actor = interpret(things, { logger: stateMachineLogger(argv) });
  actor.start( );
  actor.send({type: 'START'});
  // setTimeout(( ) => { actor.send({type: 'STOP'}); }, 60000 * 1);

}


module.exports.command = 'capture <dir> [hint]';
module.exports.describe = 'Runs as a background server forever.'
module.exports.builder = (yargs) => yargs
  .option('source', { alias: 'hint', describe: 'source input', default: 'default', choices: Object.keys(sources.kinds)})
  .option('output', { describe: "output type", default: "nightscout", choices: [ 'nightscout', 'filesystem' ] })
  .option('fs-prefix', { describe: "filesystem prefix for output", default: 'logs/' })
  .option('fs-label', { describe: "filesystem label for output" })
  .option('dir', { describe: 'output directory', default: './har' })
module.exports.handler = main;
