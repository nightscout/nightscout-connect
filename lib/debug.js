/**
 * Debug logging utility for nightscout-connect
 * Set CONNECT_DEBUG=true or CONNECT_DEBUG=1 to enable debug output
 */

const isDebugEnabled = () => {
  const debugEnv = process.env.CONNECT_DEBUG;
  return debugEnv === 'true' || debugEnv === '1' || debugEnv === 'yes';
};

const debug = (...args) => {
  if (isDebugEnabled()) {
    console.log('[nightscout-connect]', ...args);
  }
};

debug.enabled = isDebugEnabled;

module.exports = debug;
