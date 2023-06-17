
const { createMachine, Machine, actions, interpret, spawn  } = require('xstate');
var testImpl = require('../testable_driver');
var axios = require('axios');
var builder = require('../lib/builder');
var sources = require('../lib/sources');
var outputs = require('../lib/outputs');

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

  var endpoint = { name: 'nightscout', url: argv.nightscoutEndpoint, apiSecret: argv.apiSecret };
  var input = { kind: argv.source, url: argv.sourceEndpoint, apiSecret: argv.sourceApiSecret || '' };
  console.log("CONFIGURED INPUT", input);


  // var things = sidecarLoop(input, output, { dir: argv.dir });
  var output_config = endpoint;
  if (argv.output == 'filesystem') {
    output_config = {
      name: 'filesystem'
    , directory: argv['fs-prefix']
    , label: argv['fs-label']
    };
  }

  console.log("CONFIGURED OUTPUT", output_config);
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
    validated.errors.forEach((item) => {
      console.log(item);
    });
  }

  console.log("INPUT PARAMS", spec, validated.config);

  if (!validated.ok) {
    console.log("Invalid, disabling nightscout-connect", validated);
    process.exit(1);
    return;
  }
  var impl = driver(validated.config, axios);
  impl.generate_driver(make);
  var things = make( );



  //console.log(things);
  var actor = interpret(things);
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
