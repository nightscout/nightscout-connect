// Simple leveled logger for nightscout-connect.
// Controlled by the LOG_LEVEL environment variable: debug | info | warn | error | silent
// Defaults to "info".

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };
const current = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

module.exports = {
  debug: (...a) => { if (current <= 0) console.log('[connect]', ...a); },
  info:  (...a) => { if (current <= 1) console.log('[connect]', ...a); },
  warn:  (...a) => { if (current <= 2) console.warn('[connect]', ...a); },
  error: (...a) => { if (current <= 3) console.error('[connect]', ...a); },
};
