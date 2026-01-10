/**
 * Simple test to verify the bridge compatibility layer works correctly
 */

const applyBridgeCompatibility = require('./lib/compat');

console.log('Testing Bridge Compatibility Layer\n');

// Test 1: Empty config
console.log('Test 1: Empty config with BRIDGE_ env vars');
process.env.BRIDGE_USER_NAME = 'testuser';
process.env.BRIDGE_PASSWORD = 'testpass';
process.env.BRIDGE_SERVER = 'us';

let result = applyBridgeCompatibility({});
console.log('Result:', result);
console.assert(result.shareAccountName === 'testuser', 'shareAccountName should be testuser');
console.assert(result.sharePassword === 'testpass', 'sharePassword should be testpass');
console.assert(result.shareRegion === 'us', 'shareRegion should be us');
console.log('✓ Passed\n');

// Test 2: New vars take precedence
console.log('Test 2: New CONNECT_ vars should take precedence over BRIDGE_ vars');
// Set both BRIDGE and CONNECT env vars - CONNECT should win
process.env.BRIDGE_USER_NAME = 'bridge_user';
process.env.BRIDGE_PASSWORD = 'bridge_pass';
process.env.BRIDGE_SERVER = 'EU';

result = applyBridgeCompatibility({
  shareAccountName: 'connect_user',
  sharePassword: 'connect_pass',
  shareRegion: 'us'
});
console.log('Result:', result);
console.assert(result.shareAccountName === 'connect_user', 'shareAccountName should be connect_user, not bridge_user');
console.assert(result.sharePassword === 'connect_pass', 'sharePassword should be connect_pass, not bridge_pass');
console.assert(result.shareRegion === 'us', 'shareRegion should be us, not ous from BRIDGE_SERVER=EU');
console.log('✓ Passed - BRIDGE vars completely ignored when CONNECT vars present\n');

// Test 2b: Partial CONNECT vars - only unset CONNECT vars use BRIDGE fallback
console.log('Test 2b: Only unset CONNECT_ vars should fallback to BRIDGE_ vars');
// BRIDGE env vars still set from previous test
result = applyBridgeCompatibility({
  shareAccountName: 'connect_user',  // This is set, so BRIDGE_USER_NAME ignored
  // sharePassword not set, so should use BRIDGE_PASSWORD
  // shareRegion not set, so should use BRIDGE_SERVER
});
console.log('Result:', result);
console.assert(result.shareAccountName === 'connect_user', 'shareAccountName should use CONNECT value');
console.assert(result.sharePassword === 'bridge_pass', 'sharePassword should fallback to BRIDGE value');
console.assert(result.shareRegion === 'ous', 'shareRegion should fallback to BRIDGE_SERVER=EU mapping');
console.log('✓ Passed - Selective fallback works correctly\n');

// Test 3: Blank BRIDGE_SERVER (old bridge plugin default = US)
console.log('Test 3: BRIDGE_SERVER="" (blank) should map to shareRegion=us');
process.env.BRIDGE_SERVER = '';
result = applyBridgeCompatibility({});
console.log('Result:', result);
console.assert(result.shareRegion === 'us', 'shareRegion should be us for blank BRIDGE_SERVER');
console.log('✓ Passed\n');

// Test 4: EU/OUS mapping (uppercase EU like old bridge plugin)
console.log('Test 4: BRIDGE_SERVER=EU (uppercase) should map to shareRegion=ous');
process.env.BRIDGE_SERVER = 'EU';
result = applyBridgeCompatibility({});
console.log('Result:', result);
console.assert(result.shareRegion === 'ous', 'shareRegion should be ous for EU');
console.log('✓ Passed\n');

// Test 5: lowercase eu mapping
console.log('Test 5: BRIDGE_SERVER=eu (lowercase) should map to shareRegion=ous');
process.env.BRIDGE_SERVER = 'eu';
result = applyBridgeCompatibility({});
console.log('Result:', result);
console.assert(result.shareRegion === 'ous', 'shareRegion should be ous for eu');
console.log('✓ Passed\n');

// Test 6: Custom server domain
console.log('Test 6: Custom server domain');
process.env.BRIDGE_SERVER = 'custom.dexcom.com';
result = applyBridgeCompatibility({});
console.log('Result:', result);
console.assert(result.shareServer === 'custom.dexcom.com', 'shareServer should be custom.dexcom.com');
console.log('✓ Passed\n');

// Clean up
delete process.env.BRIDGE_USER_NAME;
delete process.env.BRIDGE_PASSWORD;
delete process.env.BRIDGE_SERVER;

console.log('All tests passed! ✓');
