'use strict';

function tlsAgent() {
  const ciphers = require('crypto').constants.defaultCipherList.split(':');
  if (ciphers.length >= 3) [ciphers[1], ciphers[2]] = [ciphers[2], ciphers[1]];
  return new (require('https').Agent)({ keepAlive: true, ciphers: ciphers.join(':'),
    minVersion: 'TLSv1.2', rejectUnauthorized: true });
}

module.exports = { tlsAgent };
