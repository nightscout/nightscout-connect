
var outputs = {
  default: ( ) => (_) => { console.log('PERSISTED', _); return Promise.resolve(_); },

  filesystem: require('./filesystem'),
  nightscout: require('./nightscout'),
  internal: require('./internal'),
};

function select (config) {
  var defaults = { name: 'default' };
  config = { ...config, ...defaults, ...config };
  var { name } = config;
  console.log("SELECTING OUTPUT", config, name, outputs[name] || outputs.default);
  return outputs[name] || outputs.default;
}
module.exports = select;
