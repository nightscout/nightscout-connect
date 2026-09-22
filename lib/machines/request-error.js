'use strict';

// Only pass these scalar values between actors; request errors can contain
// credentials and medical payloads.
function status(error) {
  const value = Number(error && (error.status || (error.response && error.response.status)));
  return Number.isInteger(value) && value > 0 ? value : null;
}

function retryAfterMs(error) {
  const headers = error && error.response && error.response.headers;
  const value = headers && (headers['retry-after'] || headers['Retry-After']);
  const seconds = Number(value);
  const headerDelay = value === undefined ? 0
    : Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  const explicitDelay = Number(error && error.retryAfterMs);
  const duration = Math.max(Number.isFinite(headerDelay) ? headerDelay : 0,
    Number.isFinite(explicitDelay) ? explicitDelay : 0);
  return Math.max(0, Math.min(duration, 15 * 60 * 1000));
}

module.exports = { status, retryAfterMs };
