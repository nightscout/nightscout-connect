
var axios = require('axios');
var fs = require('fs');
var path = require('path');
var readline = require('readline');
var auth = require('../lib/sources/minimedcarelink/auth');
var oauth = require('../lib/sources/minimedcarelink/oauth');

function promptUser (question) {
  var rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(function (resolve) {
    rl.question(question, function (answer) {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function openBrowser (url) {
  var exec = require('child_process').exec;
  var cmd = process.platform === 'win32' ? 'start ""'
    : process.platform === 'darwin' ? 'open'
    : 'xdg-open';
  exec(cmd + ' "' + url + '"');
}

async function main (argv) {
  var isUS = (argv.region || 'eu').toLowerCase() === 'us';
  var outputPath = path.resolve(argv.output || './logindata.json');
  var username = argv.carelinkUsername;
  var password = argv.carelinkPassword;

  console.log('[Login] Region:', isUS ? 'US' : 'EU');
  console.log('[Login] Output:', outputPath);

  // Check if logindata.json already exists
  if (fs.existsSync(outputPath)) {
    var loaded = oauth.loadLoginData(outputPath);
    if (loaded.data) {
      var expired = oauth.isTokenExpired(loaded.data.access_token);
      if (!expired) {
        console.log('[Login] logindata.json already exists and has a valid token.');
        console.log('[Login] Delete it first if you want to re-login.');
        return;
      }
      console.log('[Login] logindata.json exists but token is expired. Re-authenticating...');
    }
  }

  // Step 1: Discover Auth0 configuration
  var config = await auth.discoverAuth0Config(isUS, axios);
  var ssoConfig = config.ssoConfig;
  var baseUrl = config.baseUrl;

  // Step 2: Generate PKCE pair
  var pkce = auth.generatePKCE();
  console.log('[Login] PKCE code verifier generated');

  var authCode = null;

  // Strategy 1: Automated login (if credentials provided)
  if (username && password) {
    console.log('[Login] Credentials provided, trying automated login...');
    try {
      authCode = await auth.loginAutomated(ssoConfig, baseUrl, pkce.codeChallenge, username, password, axios);
    } catch (err) {
      if (err.message.indexOf('Invalid username or password') !== -1) {
        throw err;
      }
      if (err.message.indexOf('CAPTCHA') !== -1) {
        console.log('[Login] CAPTCHA detected — falling back to manual login.');
      } else {
        console.log('[Login] Automated login failed:', err.message);
        console.log('[Login] Falling back to manual login...');
      }
    }
  }

  // Strategy 2: Terminal paste (manual)
  if (!authCode) {
    var authUrl = auth.buildAuthorizeUrl(ssoConfig, baseUrl, pkce.codeChallenge);

    console.log('');
    console.log('=== CareLink Login ===');
    console.log('');
    console.log('Open this URL in your browser and log in:');
    console.log('');
    console.log(authUrl.url);
    console.log('');
    console.log('After login (and CAPTCHA if prompted), the page will fail to load —');
    console.log('that\'s expected. To get the authorization code:');
    console.log('');
    console.log('  1. Open DevTools (F12) > Network tab BEFORE logging in');
    console.log('  2. Log in with your CareLink credentials');
    console.log('  3. After login, find the blocked GET request to /authorize/resume');
    console.log('  4. Click it > Headers > Response Headers > copy the "Location" value');
    console.log('     (It starts with "com.medtronic.carepartner:/sso?code=...")');
    console.log('');

    openBrowser(authUrl.url);

    var pastedUrl = await promptUser('Paste the URL here: ');
    authCode = auth.extractCodeFromUrl(pastedUrl);
    if (!authCode) {
      throw new Error('No authorization code found in the pasted URL. Make sure you copied the full URL from the address bar.');
    }
    console.log('[Login] Got authorization code from pasted URL');
  }

  // Step 3: Exchange code for tokens
  var loginData = await auth.exchangeCodeForTokens(ssoConfig, baseUrl, authCode, pkce.codeVerifier, axios);

  // Step 4: Save to MongoDB (primary) and attempt file save as backup
  var tokenStore = require('../lib/sources/minimedcarelink/token-store');
  var store = tokenStore.create();
  if (store) {
    await store.save(loginData);
  }

  // Best-effort file save (oauth.saveLoginData handles its own errors silently)
  oauth.saveLoginData(outputPath, loginData);

  console.log('');
  console.log('[Login] Success! Tokens saved to MongoDB.');
  console.log('');

  // Decode and show token info
  var payload = oauth.decodeJwtPayload(loginData.access_token);
  if (payload) {
    if (payload.token_details && payload.token_details.country) {
      console.log('[Login] Country detected:', payload.token_details.country);
    }
    if (payload.exp) {
      var expiresAt = new Date(payload.exp * 1000);
      console.log('[Login] Access token expires:', expiresAt.toISOString());
    }
  }
}

module.exports.command = 'login';
module.exports.describe = 'Authenticate with CareLink to generate logindata.json';
module.exports.builder = function (yargs) {
  return yargs
    .option('region', {
      alias: 'r',
      describe: 'CareLink region',
      default: 'eu',
      choices: ['us', 'eu'],
    })
    .option('output', {
      alias: 'o',
      describe: 'Output path for logindata.json',
      default: './logindata.json',
    });
};
module.exports.handler = main;
