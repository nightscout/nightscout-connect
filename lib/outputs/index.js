
var outputs = {
  default: (_) => { console.log('PERSISTED', _); return Promise.resolve(_); },

};

function select (config) {
  return outputs[config] || outputs.default;
}
module.exports = select;
