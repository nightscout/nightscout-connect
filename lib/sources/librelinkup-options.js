'use strict';

// A configured timezone is a starting hint only. Explicit region/server
// settings and the service's own redirect take precedence.
const regions = {
  EU2: ['Europe/London', 'Europe/Guernsey', 'Europe/Jersey', 'Europe/Isle_of_Man'],
  US: ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu'],
  CA: ['America/St_Johns', 'America/Halifax', 'America/Glace_Bay', 'America/Moncton',
    'America/Goose_Bay', 'America/Blanc-Sablon', 'America/Toronto', 'America/Nipigon',
    'America/Thunder_Bay', 'America/Iqaluit', 'America/Pangnirtung', 'America/Atikokan',
    'America/Winnipeg', 'America/Rainy_River', 'America/Rankin_Inlet', 'America/Resolute',
    'America/Regina', 'America/Swift_Current', 'America/Edmonton', 'America/Cambridge_Bay',
    'America/Inuvik', 'America/Dawson_Creek', 'America/Fort_Nelson', 'America/Creston',
    'America/Vancouver', 'America/Whitehorse', 'America/Dawson'],
  JP: ['Asia/Tokyo'],
  CN: ['Asia/Shanghai', 'Asia/Urumqi'],
  RU: ['Europe/Moscow', 'Europe/Kaliningrad', 'Europe/Samara', 'Europe/Volgograd',
    'Asia/Yekaterinburg', 'Asia/Omsk', 'Asia/Novosibirsk', 'Asia/Krasnoyarsk',
    'Asia/Irkutsk', 'Asia/Yakutsk', 'Asia/Vladivostok', 'Asia/Magadan', 'Asia/Kamchatka'],
  AE: ['Asia/Jerusalem', 'Asia/Riyadh', 'Asia/Dubai', 'Asia/Tehran', 'Asia/Baghdad', 'Asia/Amman'],
  LA: ['America/Mexico_City', 'America/Sao_Paulo', 'America/Argentina/Buenos_Aires',
    'America/Buenos_Aires', 'America/Santiago', 'America/Bogota', 'America/Lima', 'America/Caracas']
};

function regionForTimezone(timezone) {
  if (!timezone) return null;
  const canonical = new Intl.DateTimeFormat('en', { timeZone: timezone }).resolvedOptions().timeZone;
  for (const [region, names] of Object.entries(regions)) {
    if (names.includes(timezone) || names.includes(canonical)) return region;
  }
  if (canonical.startsWith('Europe/') || canonical.startsWith('Africa/')) return 'EU';
  if (canonical.startsWith('Australia/') || canonical === 'Pacific/Auckland') return 'AU';
  if (canonical.startsWith('Asia/')) return 'AP';
  return null;
}

function tlsAgent() {
  const ciphers = require('crypto').constants.defaultCipherList.split(':');
  if (ciphers.length >= 3) [ciphers[1], ciphers[2]] = [ciphers[2], ciphers[1]];
  return new (require('https').Agent)({ keepAlive: true, ciphers: ciphers.join(':'),
    minVersion: 'TLSv1.2', rejectUnauthorized: true });
}

module.exports = { regionForTimezone, tlsAgent };
