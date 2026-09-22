'use strict';
// Loaded with --require into a lab's Nightscout process only. Prints a fixed
// marker after each completed internal write, so a lab can tell the embedded
// connector has synced without depending on connector log text or on
// CONNECT_DEBUG, which the labs keep off. Nothing here is loaded in
// production.
const { MARKER } = require('./lab-plugin-completion-marker');
const file = require.resolve('../lib/outputs/internal');
const real = require(file);
require.cache[file].exports = function labInternalOutput (config, ctx) {
  const persist = real(config, ctx);
  function persistAndMark (batch) {
    return persist(batch).then((known) => {
      if (known) process.stdout.write('\n' + MARKER + '\n');
      return known;
    });
  }
  return Object.assign(persistAndMark, persist);
};
