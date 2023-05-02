
var sources = {
  nightscout: require('./nightscout'),
  dexcomshare: require('./dexcomshare'),
  glooko: require('./glooko/'),
  linkup: require('./librelinkup'),
  testImpl: require('../../testable_driver').fakeFrame,
};

function select (config) {
  var { kind } = config;
  var result = sources[kind] || sources.testImpl;
  console.log("KIND", kind, result);
  return result;
}
module.exports = select;
