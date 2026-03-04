
// CareLink OAuth2 PKCE Authentication Flow
// Ported from carelink-bridge (https://github.com/nightscout/carelink-bridge)
//
// This module handles:
// - Discovery of Auth0 SSO configuration from CareLink cloud
// - PKCE (Proof Key for Code Exchange) generation
// - Building authorize URLs for the OAuth2 flow
// - Automated login (POST credentials directly)
// - Token exchange (authorization code -> access/refresh tokens)
// - Extracting authorization codes from redirect URLs

var crypto = require('crypto');
var qs = require('qs');

var DISCOVERY_URL_US = 'https://clcloud.minimed.com/connect/carepartner/v13/discover/android/3.6';
var DISCOVERY_URL_EU = 'https://clcloud.minimed.eu/connect/carepartner/v13/discover/android/3.6';

var MOBILE_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

/**
 * Convert a Buffer to base64url encoding (RFC 7636).
 */
function toBase64Url (buf) {
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Fetch Auth0 SSO configuration from the CareLink discovery endpoint.
 *
 * @param {boolean} isUS - true for US region, false for EU
 * @param {object} axios - axios module for HTTP requests
 * @returns {Promise<object>} { ssoConfig, baseUrl }
 */
async function discoverAuth0Config (isUS, axios) {
  var discoveryUrl = isUS ? DISCOVERY_URL_US : DISCOVERY_URL_EU;

  console.log('[Auth] Fetching discovery config from', discoveryUrl);
  var discoverResp = await axios.get(discoveryUrl);
  var discoverData = discoverResp.data;

  var region = isUS ? 'us' : 'eu';
  var cpEntry = null;
  for (var i = 0; i < discoverData.CP.length; i++) {
    if (discoverData.CP[i].region.toLowerCase() === region) {
      cpEntry = discoverData.CP[i];
      break;
    }
  }
  if (!cpEntry) {
    throw new Error('Could not find config for region: ' + region);
  }

  var ssoConfigKey = cpEntry.UseSSOConfiguration || 'Auth0SSOConfiguration';
  var ssoUrl = cpEntry[ssoConfigKey];
  if (!ssoUrl) {
    throw new Error('Could not find SSO config URL (key: ' + ssoConfigKey + ')');
  }

  console.log('[Auth] Fetching Auth0 SSO config from', ssoUrl);
  var ssoResp = await axios.get(ssoUrl);
  var ssoConfig = ssoResp.data;

  var baseUrl = 'https://' + ssoConfig.server.hostname;
  if (ssoConfig.server.port && ssoConfig.server.port !== 443) {
    baseUrl += ':' + ssoConfig.server.port;
  }
  if (ssoConfig.server.prefix) {
    baseUrl += '/' + ssoConfig.server.prefix;
  }

  console.log('[Auth] Auth0 base URL:', baseUrl);
  console.log('[Auth] Client ID:', ssoConfig.client.client_id);

  return { ssoConfig: ssoConfig, baseUrl: baseUrl };
}

/**
 * Generate a PKCE code_verifier and code_challenge pair.
 *
 * @returns {{ codeVerifier: string, codeChallenge: string }}
 */
function generatePKCE () {
  var codeVerifier = toBase64Url(crypto.randomBytes(32));
  var codeChallenge = toBase64Url(
    crypto.createHash('sha256').update(codeVerifier).digest()
  );
  return { codeVerifier: codeVerifier, codeChallenge: codeChallenge };
}

/**
 * Build the full authorize URL for the OAuth2 PKCE flow.
 *
 * @param {object} ssoConfig - Auth0 SSO configuration
 * @param {string} baseUrl - Auth0 base URL
 * @param {string} codeChallenge - PKCE code challenge
 * @returns {{ url: string, state: string }}
 */
function buildAuthorizeUrl (ssoConfig, baseUrl, codeChallenge) {
  var client = ssoConfig.client;
  var state = toBase64Url(crypto.randomBytes(16));
  var params = {
    client_id: client.client_id,
    response_type: 'code',
    scope: client.scope,
    audience: client.audience,
    redirect_uri: client.redirect_uri,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state: state,
  };
  var authorizeUrl = baseUrl + ssoConfig.system_endpoints.authorization_endpoint_path;
  return {
    url: authorizeUrl + '?' + qs.stringify(params),
    state: state,
  };
}

/**
 * Extract the authorization code from a redirect URL.
 * Handles both standard https:// URLs and custom scheme URLs
 * (e.g., com.medtronic.carelink://authorize?code=...).
 *
 * @param {string} url - URL to extract code from
 * @returns {string|null} The authorization code, or null
 */
function extractCodeFromUrl (url) {
  if (!url) return null;
  var match = url.match(/[?&]code=([^&]+)/);
  return match ? match[1] : null;
}

/**
 * Exchange an authorization code for access and refresh tokens.
 *
 * @param {object} ssoConfig - Auth0 SSO configuration
 * @param {string} baseUrl - Auth0 base URL
 * @param {string} authCode - Authorization code from redirect
 * @param {string} codeVerifier - PKCE code verifier (original, NOT challenge)
 * @param {object} axios - axios module for HTTP requests
 * @returns {Promise<object>} logindata.json content
 */
async function exchangeCodeForTokens (ssoConfig, baseUrl, authCode, codeVerifier, axios) {
  var client = ssoConfig.client;
  var tokenUrl = baseUrl + ssoConfig.system_endpoints.token_endpoint_path;

  console.log('[Auth] Exchanging authorization code for tokens...');
  var resp = await axios.post(
    tokenUrl,
    qs.stringify({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code: authCode,
      redirect_uri: client.redirect_uri,
      code_verifier: codeVerifier,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  if (resp.status !== 200) {
    throw new Error('Token exchange failed (HTTP ' + resp.status + '): ' + JSON.stringify(resp.data));
  }

  console.log('[Auth] Token exchange successful');
  console.log('[Auth] Fields received:', Object.keys(resp.data));

  if (resp.data.expires_in) {
    var expiresInMinutes = Math.floor(resp.data.expires_in / 60);
    var expiresAt = new Date(Date.now() + resp.data.expires_in * 1000);
    console.log('[Auth] Access token expires in:', expiresInMinutes, 'minutes');
    console.log('[Auth] Access token expires at:', expiresAt.toISOString());
  }

  if (resp.data.refresh_expires_in) {
    var refreshExpiresInHours = Math.floor(resp.data.refresh_expires_in / 3600);
    console.log('[Auth] Refresh token expires in:', refreshExpiresInHours, 'hours');
  }

  var loginData = {
    access_token: resp.data.access_token,
    refresh_token: resp.data.refresh_token,
    scope: resp.data.scope || client.scope,
    client_id: client.client_id,
    token_url: tokenUrl,
    audience: client.audience,
  };

  return loginData;
}

/**
 * Automated login: POST credentials directly to Auth0 login form.
 * Works when CAPTCHA is not required. Falls back on CAPTCHA detection.
 *
 * @param {object} ssoConfig - Auth0 SSO configuration
 * @param {string} baseUrl - Auth0 base URL
 * @param {string} codeChallenge - PKCE code challenge
 * @param {string} username - CareLink username
 * @param {string} password - CareLink password
 * @param {object} axios - axios module
 * @returns {Promise<string>} Authorization code
 */
async function loginAutomated (ssoConfig, baseUrl, codeChallenge, username, password, axios) {
  // Create HTTP client with manual cookie management
  var cookies = {};
  var httpClient = axios.create({
    maxRedirects: 0,
    timeout: 20000,
    validateStatus: function () { return true; },
    headers: {
      'User-Agent': MOBILE_USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  // Cookie interceptors
  httpClient.interceptors.request.use(function (config) {
    var cookieKeys = Object.keys(cookies);
    if (cookieKeys.length > 0) {
      config.headers['Cookie'] = cookieKeys.map(function (k) {
        return k + '=' + cookies[k];
      }).join('; ');
    }
    return config;
  });
  httpClient.interceptors.response.use(function (resp) {
    var sc = resp.headers['set-cookie'];
    if (sc) {
      for (var i = 0; i < sc.length; i++) {
        var m = sc[i].match(/^([^=]+)=([^;]*)/);
        if (m) cookies[m[1]] = m[2];
      }
    }
    return resp;
  });

  // Build authorize URL
  var auth = buildAuthorizeUrl(ssoConfig, baseUrl, codeChallenge);
  var authorizeFullUrl = auth.url;

  console.log('[Auth] Starting automated login...');
  var resp = await httpClient.get(authorizeFullUrl);

  // Follow redirects to the login page
  var auth0Origin = (new URL(authorizeFullUrl)).origin;
  var loginPageUrl = '';
  for (var i = 0; i < 10 && resp.status >= 300 && resp.status < 400; i++) {
    var location = resp.headers['location'];
    if (!location) break;
    var nextUrl = location.startsWith('/') ? auth0Origin + location : location;
    auth0Origin = (new URL(nextUrl)).origin;
    loginPageUrl = nextUrl;
    resp = await httpClient.get(nextUrl);
  }

  if (resp.status !== 200 || typeof resp.data !== 'string') {
    throw new Error('Could not reach Auth0 login page (HTTP ' + resp.status + ')');
  }

  var html = resp.data;

  // Extract hidden form fields
  var hiddenFields = {};
  var hiddenRegex = /<input[^>]+type=["']hidden["'][^>]*>/gi;
  var match;
  while ((match = hiddenRegex.exec(html)) !== null) {
    var nameMatch = match[0].match(/name=["']([^"']*)["']/i);
    var valueMatch = match[0].match(/value=["']([^"']*)["']/i);
    if (nameMatch) {
      hiddenFields[nameMatch[1]] = valueMatch ? valueMatch[1] : '';
    }
  }

  var formActionMatch = html.match(/<form[^>]*action=["']([^"']*)["']/i);
  var postUrl = formActionMatch
    ? (formActionMatch[1].startsWith('/') ? auth0Origin + formActionMatch[1] : formActionMatch[1])
    : loginPageUrl;

  // POST credentials
  console.log('[Auth] Submitting credentials...');
  var postData = Object.assign({}, hiddenFields, {
    username: username,
    password: password,
    action: 'default',
  });
  resp = await httpClient.post(postUrl, qs.stringify(postData), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  // Check for errors
  if (resp.status === 200 && typeof resp.data === 'string') {
    if (resp.data.indexOf('Wrong username or password') !== -1 || resp.data.indexOf('wrong-credentials') !== -1) {
      throw new Error('Invalid username or password');
    }
    if (resp.data.indexOf('captcha') !== -1 || resp.data.indexOf('CAPTCHA') !== -1 || resp.data.indexOf('arkose') !== -1) {
      throw new Error('CAPTCHA required');
    }
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new Error('Login rejected (HTTP ' + resp.status + ')');
  }

  // Follow redirect chain to extract auth code
  var code = null;
  for (var j = 0; j < 15; j++) {
    var loc = resp.headers['location'] || '';
    var codeMatch = loc.match(/[?&]code=([^&]+)/);
    if (codeMatch) { code = codeMatch[1]; break; }

    if (resp.status >= 300 && resp.status < 400 && loc) {
      var next = loc.startsWith('/') ? auth0Origin + loc : loc;
      // Check for custom scheme redirect (not http)
      if (/^[a-z]+:\/\//.test(next) && !next.startsWith('http')) {
        var m = next.match(/code=([^&]+)/);
        if (m) { code = m[1]; break; }
      }
      resp = await httpClient.get(next);
    } else {
      break;
    }
  }

  if (!code) {
    throw new Error('Could not extract authorization code from redirect chain');
  }

  console.log('[Auth] Got authorization code via automated login');
  return code;
}

module.exports = {
  toBase64Url: toBase64Url,
  discoverAuth0Config: discoverAuth0Config,
  generatePKCE: generatePKCE,
  buildAuthorizeUrl: buildAuthorizeUrl,
  extractCodeFromUrl: extractCodeFromUrl,
  exchangeCodeForTokens: exchangeCodeForTokens,
  loginAutomated: loginAutomated,
};
