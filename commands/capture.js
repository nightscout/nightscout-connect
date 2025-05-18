const { interpret } = require("xstate");
var axios = require("axios");
var builder = require("../lib/builder");
var sources = require("../lib/sources");
var outputs = require("../lib/outputs");


/**
 * @param {object} argv - Command line arguments.
 * @param {string} argv.source - The source input type.
 * @param {string} [argv.sourceEndpoint] - The source endpoint URL.
 * @param {string} [argv.sourceApiSecret] - The API secret for the source.
 * @param {string} argv.output - The output type.
 * @param {string} [argv.url] - Nightscout instance URL.
 * @param {string} [argv.apiSecret] - Nightscout API_SECRET.
 * @param {string} [argv["fs-prefix"]] - Filesystem prefix for output.
 * @param {string} [argv["fs-label"]] - Filesystem label for output.
 * @param {string} argv.dir - Output directory.
 */
function main(argv) {
  console.log("STARTING", argv);
  // selected output
  // argv.nightscoutEndpoint;
  // argv.apiSecret;
  //

  /** @type {OutputConfig} */
  var endpoint = {
    name: "nightscout",
    url: argv.url,
    apiSecret: argv.apiSecret,
  };
  /** @type {InputConfig} */
  var input = {
    kind: argv.source,
    url: argv.sourceEndpoint,
    apiSecret: argv.sourceApiSecret || "",
  };
  console.log("CONFIGURED INPUT", input);

  // var things = sidecarLoop(input, output, { dir: argv.dir });
  /** @type {OutputConfig} */
  var output_config = endpoint;
  if (argv.output == "filesystem") {
    output_config = {
      name: "filesystem",
      directory: argv["fs-prefix"],
      label: argv["fs-label"],
    };
  }

  console.log("CONFIGURED OUTPUT", output_config);
  var output = outputs(output_config)(output_config, axios);
  /** @type {CaptureConfig} */
  var capture = { dir: argv.dir };
  var make = builder({ output, capture });

  /** @type {InputConfig} */
  var spec = { kind: "disabled" };
  spec.kind = argv.source;
  // select an available input source implementation based on env
  // variables/config
  var driver = sources(spec);
  /**
   * @typedef {object} ValidatedConfig
   * @property {boolean} ok
   * @property {InputConfig} config
   * @property {string[]} [errors]
   */
  /** @type {ValidatedConfig} */
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
  /** @type {import('xstate').StateMachine<any, any, any>} */
  var things = make();

  //console.log(things);
  /** @type {import('xstate').Interpreter<any, any, any>} */
  var actor = interpret(things);
  actor.start();
  actor.send({ type: "START" });
  // setTimeout(( ) => { actor.send({type: 'STOP'}); }, 60000 * 1);
}

module.exports.command = "capture <dir> [hint]";
module.exports.describe = "Runs as a background server forever.";
/**
 * @param {import('yargs').Argv} yargs
 */
module.exports.builder = (yargs) =>
  yargs
    .option("source", {
      alias: "hint",
      describe: "source input",
      default: "default",
      choices: Object.keys(sources.kinds),
    })
    .option("output", {
      describe: "output type",
      default: "nightscout",
      choices: ["nightscout", "filesystem"],
    })
    .option("fs-prefix", {
      describe: "filesystem prefix for output",
      default: "logs/",
    })
    .option("fs-label", { describe: "filesystem label for output" })
    .option("dir", { describe: "output directory", default: "./har" })
    .option("url", {
      describe:
        "Nightscout instance URL (e.g., https://yournightscout.herokuapp.com)",
      type: "string",
    })
    .option("apiSecret", { describe: "Nightscout API_SECRET", type: "string" });
module.exports.handler = main;
