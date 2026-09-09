'use strict';

function enabled (value) {
  return value === true || (typeof value === 'string' && /^(true|on)$/i.test(value.trim()));
}

// Each connector owns its logger. Never replace the process-wide console or
// print source credentials, patient payloads, HTTP bodies or XState context.
function createLogger (debug) {
  const verbose = enabled(debug);
  function diagnostic (level, message, error) {
    const status = error && error.response && error.response.status;
    const suffix = Number.isInteger(status) && status >= 100 && status <= 599
      ? ' (HTTP ' + status + ')' : '';
    console[level]('nightscout-connect: ' + message + suffix);
  }
  return {
    debug (message) {
      if (verbose) console.debug('DEBUG nightscout-connect: ' + message);
    },
    warn (message) { diagnostic('warn', message); },
    error (message, error) { diagnostic('error', message, error); }
  };
}

module.exports = createLogger;
