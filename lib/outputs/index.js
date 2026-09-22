
var createLogger = require('../logging');

var outputs = {
  // Dry run: nothing is stored. Counts only, like every other output.
  default: (config = { }) => {
    var log = config.logger || createLogger(config.debug);
    return (batch) => {
      log.debug('Default output (not stored): ' + ['entries', 'treatments', 'devicestatus', 'profiles']
        .map((kind) => ((batch && batch[kind]) || [ ]).length + ' ' + kind).join(', '));
      return Promise.resolve(batch);
    };
  },

  filesystem: require('./filesystem'),
  nightscout: require('./nightscout'),
  internal: require('./internal'),
};

function select (config) {
  var defaults = { name: 'default' };
  config = { ...config, ...defaults, ...config };
  var { name } = config;
  return outputs[name] || outputs.default;
}
module.exports = select;
