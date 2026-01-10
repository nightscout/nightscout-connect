/**
 * Compatibility layer for environment variable mapping
 * Maps old bridge plugin variable names to new nightscout-connect names
 */

function applyBridgeCompatibility(config) {
  // Create a copy to avoid mutating the original
  const result = { ...config };
  
  // Map old BRIDGE_ variables to new CONNECT_ variables
  // IMPORTANT: Only apply BRIDGE_ variables if the corresponding CONNECT_ variable is NOT already set
  // This ensures CONNECT_ variables always take precedence and BRIDGE_ variables are ignored when CONNECT_ exists
  
  // BRIDGE_USER_NAME -> CONNECT_SHARE_ACCOUNT_NAME (shareAccountName)
  // Only apply if shareAccountName is not already set from CONNECT_SHARE_ACCOUNT_NAME
  if (!result.shareAccountName && process.env.BRIDGE_USER_NAME) {
    result.shareAccountName = process.env.BRIDGE_USER_NAME;
  }
  
  // BRIDGE_PASSWORD -> CONNECT_SHARE_PASSWORD (sharePassword)
  // Only apply if sharePassword is not already set from CONNECT_SHARE_PASSWORD
  if (!result.sharePassword && process.env.BRIDGE_PASSWORD) {
    result.sharePassword = process.env.BRIDGE_PASSWORD;
  }
  
  // BRIDGE_SERVER -> CONNECT_SHARE_REGION (shareRegion)
  // Only apply if shareRegion/shareServer is not already set from CONNECT_SHARE_REGION/CONNECT_SHARE_SERVER
  // Note: In old bridge plugin, blank/empty = US, "EU" = European servers
  if (!result.shareRegion && !result.shareServer && process.env.BRIDGE_SERVER !== undefined) {
    const server = process.env.BRIDGE_SERVER.trim();
    
    if (server === '' || server.toLowerCase() === 'us') {
      // Blank or 'us' means US servers (default)
      result.shareRegion = 'us';
    } else if (server.toLowerCase() === 'eu' || server.toLowerCase() === 'ous') {
      // 'EU' or 'ous' means European servers
      result.shareRegion = 'ous';
    } else {
      // If it's a custom server domain, use it directly
      result.shareServer = server;
    }
  }
  
  return result;
}

module.exports = applyBridgeCompatibility;
