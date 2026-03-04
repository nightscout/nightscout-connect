
// OAuth token management for CareLink API
// Ported from carelink-bridge (https://github.com/nightscout/carelink-bridge)
//
// This module handles:
// - Loading logindata.json (from file path or inline JSON string)
// - JWT token expiration checking
// - OAuth refresh token flow
// - Saving updated tokens back to disk
// - Auto-detecting CareLink region from token_url

var fs = require('fs');
var qs = require('qs');

/**
 * Load login data from a file path or inline JSON string.
 *
 * Supports two input formats:
 *   1. File path: "/path/to/logindata.json"
 *   2. Inline JSON: '{"access_token":"...","refresh_token":"...",...}'
 *
 * @param {string} pathOrJson - File path or inline JSON string
 * @returns {{ data: object|null, filePath: string|null }}
 */
function loadLoginData (pathOrJson) {
  if (!pathOrJson) return { data: null, filePath: null };

  // Try parsing as inline JSON first (starts with '{')
  if (pathOrJson.trim().startsWith('{')) {
    try {
      var data = JSON.parse(pathOrJson);
      if (validateLoginData(data)) {
        return { data: data, filePath: null };
      }
    } catch (e) {
      // Not valid JSON, fall through to treat as file path
    }
  }

  // Treat as file path
  try {
    if (!fs.existsSync(pathOrJson)) {
      console.log('[OAuth] logindata.json not found at:', pathOrJson);
      return { data: null, filePath: pathOrJson };
    }
    var content = fs.readFileSync(pathOrJson, 'utf8');
    var data = JSON.parse(content);
    if (validateLoginData(data)) {
      return { data: data, filePath: pathOrJson };
    }
    return { data: null, filePath: pathOrJson };
  } catch (e) {
    console.log('[OAuth] Failed to read logindata.json:', e.message);
    return { data: null, filePath: pathOrJson };
  }
}

/**
 * Validate that login data contains all required fields.
 *
 * Required fields (from carelink-bridge):
 *   - access_token: JWT for API requests
 *   - refresh_token: Used to obtain new access tokens
 *   - client_id: Auth0 client identifier
 *   - token_url: OAuth token endpoint (US or EU)
 *
 * @param {object} data - Login data to validate
 * @returns {boolean}
 */
function validateLoginData (data) {
  var required = ['access_token', 'refresh_token', 'client_id', 'token_url'];
  for (var i = 0; i < required.length; i++) {
    if (!data[required[i]]) {
      console.log('[OAuth] logindata.json missing required field:', required[i]);
      return false;
    }
  }
  return true;
}

/**
 * Save updated login data to file (after token refresh).
 * No-op if filePath is null (inline JSON mode).
 *
 * @param {string|null} filePath
 * @param {object} data
 */
function saveLoginData (filePath, data) {
  if (!filePath) return;
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 4));
    console.log('[OAuth] Saved updated tokens to', filePath);
  } catch (e) {
    console.log('[OAuth] Failed to save logindata.json:', e.message);
  }
}

/**
 * Check if a JWT access token is expired or about to expire.
 * Returns true if less than 1 minute of validity remains.
 *
 * @param {string} accessToken - JWT access token
 * @returns {boolean}
 */
function isTokenExpired (accessToken) {
  try {
    var parts = accessToken.split('.');
    if (parts.length !== 3) return true;

    var payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    if (!payload.exp) return true;

    // Expired if less than 1 minute remaining
    return payload.exp * 1000 < Date.now() + 60 * 1000;
  } catch (e) {
    return true;
  }
}

/**
 * Decode JWT payload without verification.
 * Useful for extracting user info (country, role, username).
 *
 * @param {string} accessToken - JWT access token
 * @returns {object|null} Decoded payload or null on error
 */
function decodeJwtPayload (accessToken) {
  try {
    var parts = accessToken.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * Refresh the OAuth access token using the refresh token.
 *
 * Makes a POST to the token_url with grant_type=refresh_token.
 * Updates loginData in-place with new access_token (and refresh_token
 * if the server rotates it).
 *
 * @param {object} loginData - Login data with refresh_token, client_id, token_url
 * @param {object} axios - Axios module (not instance) for HTTP requests
 * @returns {Promise<object>} Updated login data
 */
async function refreshAccessToken (loginData, axios) {
  console.log('[OAuth] Refreshing access token...');

  var resp = await axios.post(
    loginData.token_url,
    qs.stringify({
      grant_type: 'refresh_token',
      client_id: loginData.client_id,
      refresh_token: loginData.refresh_token,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  loginData.access_token = resp.data.access_token;
  if (resp.data.refresh_token) {
    loginData.refresh_token = resp.data.refresh_token;
  }

  console.log('[OAuth] Token refreshed successfully');
  return loginData;
}

/**
 * Detect CareLink region (US or EU) from the token_url in logindata.json.
 *
 * @param {object} loginData - Login data with token_url
 * @returns {string|null} 'eu', 'us', or null if indeterminate
 */
function detectRegion (loginData) {
  if (!loginData || !loginData.token_url) return null;
  if (loginData.token_url.indexOf('minimed.eu') !== -1) return 'eu';
  if (loginData.token_url.indexOf('minimed.com') !== -1) return 'us';
  return null;
}

module.exports = {
  loadLoginData: loadLoginData,
  validateLoginData: validateLoginData,
  saveLoginData: saveLoginData,
  isTokenExpired: isTokenExpired,
  decodeJwtPayload: decodeJwtPayload,
  refreshAccessToken: refreshAccessToken,
  detectRegion: detectRegion,
};
