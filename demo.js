
const { createMachine, Machine, actions, interpret, spawn  } = require('xstate');

var testImpl = require('./testable_driver');
var axios = require('axios');
var builder = require('./lib/builder');

function demoLoop ( ) {
  
  var output = require('./lib/outputs')( )( );
  var make = builder({ output });
  var impl = testImpl.fakeFrame({ }, axios);

  impl.generate_driver(make);

  var built = make( );
  // console.log("BUILDER OUTPUT", built);
  console.log("BUILDER OUTPUT", JSON.stringify(built, null, 2));
  return built;

}

function main ( ) {
  var things = demoLoop( );
  console.log(things);
  var actor = interpret(things);
  actor.start( );
  actor.send({type: 'START'});
  setTimeout(( ) => {
  actor.send({type: 'STOP'});
  }, 60000 * 5);

}
if (!module.parent) {
  main( );
}
module.exports.command = 'demo';
exports.describe = 'a quick demo using timers instead of I/O';
module.exports.handler = main;
