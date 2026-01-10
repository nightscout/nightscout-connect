# Bridge Plugin Compatibility Layer

## Overview

This module includes a compatibility layer to support environment variables from the legacy `share2nightscout-bridge` plugin. This makes migration seamless for existing Nightscout users.

## Environment Variable Mapping

The following environment variables are automatically mapped:

| Legacy (Bridge)      | New (Connect)                | Notes                                           |
|---------------------|------------------------------|------------------------------------------------|
| `BRIDGE_USER_NAME`  | `CONNECT_SHARE_ACCOUNT_NAME` | Dexcom Share account username                  |
| `BRIDGE_PASSWORD`   | `CONNECT_SHARE_PASSWORD`     | Dexcom Share account password                  |
| `BRIDGE_SERVER`     | `CONNECT_SHARE_REGION`       | Server region or custom domain (see below)     |

## BRIDGE_SERVER Mapping Details

The `BRIDGE_SERVER` variable is intelligently mapped to match the old bridge plugin behavior:

- **Blank/Empty `""`** → Maps to `CONNECT_SHARE_REGION=us` (uses share2.dexcom.com) - **This is the old bridge plugin default**
- **`us`** → Maps to `CONNECT_SHARE_REGION=us` (uses share2.dexcom.com)
- **`EU`** (case-insensitive) → Maps to `CONNECT_SHARE_REGION=ous` (uses shareous1.dexcom.com) - **Old bridge plugin EU setting**
- **`ous`** → Maps to `CONNECT_SHARE_REGION=ous` (uses shareous1.dexcom.com)
- **Custom domain** (e.g., `custom.dexcom.com`) → Maps to `CONNECT_SHARE_SERVER=custom.dexcom.com`

## Precedence Rules

**IMPORTANT:** When `CONNECT_*` variables are set, the corresponding `BRIDGE_*` variables are **completely ignored**.

The compatibility layer checks each config property individually:
- If `CONNECT_SHARE_ACCOUNT_NAME` is set → `BRIDGE_USER_NAME` is ignored
- If `CONNECT_SHARE_PASSWORD` is set → `BRIDGE_PASSWORD` is ignored  
- If `CONNECT_SHARE_REGION` or `CONNECT_SHARE_SERVER` is set → `BRIDGE_SERVER` is ignored

```bash
# Example: Both variables set
export BRIDGE_USER_NAME=old_user
export CONNECT_SHARE_ACCOUNT_NAME=new_user
# Result: new_user is used, old_user is completely ignored
```

```bash
# Example: Mixed configuration (selective fallback)
export BRIDGE_USER_NAME=bridge_user
export BRIDGE_PASSWORD=bridge_pass
export CONNECT_SHARE_ACCOUNT_NAME=connect_user
# Result: Uses connect_user for account, bridge_pass for password
# Only unset CONNECT_ variables fall back to BRIDGE_ variables
```

This allows for gradual migration and explicit overrides while ensuring no conflicts.

## Implementation

The compatibility layer is implemented in [`lib/compat.js`](lib/compat.js) and is automatically applied in:

1. **Nightscout plugin mode** ([`index.js`](index.js)) - When running as a Nightscout plugin
2. **CLI capture mode** ([`commands/capture.js`](commands/capture.js)) - When using `nightscout-connect capture`
3. **CLI forever mode** ([`commands/forever.js`](commands/forever.js)) - When using `nightscout-connect forever`

## Examples

### Example 1: Using Legacy Variables Only

```bash
# Set only legacy variables
export ENABLE=connect
export BRIDGE_USER_NAME=myusername
export BRIDGE_PASSWORD=mypassword
export BRIDGE_SERVER=us

# nightscout-connect will automatically use these
```

### Example 2: Using New Variables Only

```bash
# Set only new variables
export ENABLE=connect
export CONNECT_SOURCE=dexcomshare
export CONNECT_SHARE_ACCOUNT_NAME=myusername
export CONNECT_SHARE_PASSWORD=mypassword
export CONNECT_SHARE_REGION=us
```

### Example 3: Mixed Variables (New Takes Precedence)

```bash
# Mix of old and new - new variables win
export ENABLE=connect
export CONNECT_SOURCE=dexcomshare
export BRIDGE_USER_NAME=old_username
export CONNECT_SHARE_ACCOUNT_NAME=new_username  # This one is used
export BRIDGE_PASSWORD=mypassword
export BRIDGE_SERVER=us
```

### Example 4: Blank BRIDGE_SERVER (Old Default Behavior)

```bash
# Old bridge plugin default: blank = US servers
export ENABLE=connect
export BRIDGE_USER_NAME=myusername
export BRIDGE_PASSWORD=mypassword
export BRIDGE_SERVER=  # Blank/empty maps to us region (share2.dexcom.com)
```

### Example 5: EU Server with Legacy Variables

```bash
export ENABLE=connect
export BRIDGE_USER_NAME=myusername
export BRIDGE_PASSWORD=mypassword
export BRIDGE_SERVER=EU  # Automatically maps to ous region (shareous1.dexcom.com)
```

## Testing

A test suite is provided in [`test-compat.js`](test-compat.js) to verify the compatibility layer works correctly:

```bash
node test-compat.js
```

## Migration Recommendations

For new deployments, use the new `CONNECT_*` variable names. For existing deployments:

1. **No rush to migrate** - Legacy variables will continue to work
2. **Test before switching** - Verify new variables work in a test environment
3. **Update documentation** - Update your deployment docs to reference new variable names
4. **Optional gradual migration** - You can migrate one variable at a time

## Technical Notes

- The compatibility layer creates a shallow copy of the config object to avoid mutations
- Environment variables are only checked if the corresponding config property is not already set
- The mapping happens before validation, so validation errors will reference the new variable names
- No performance impact - the mapping is a simple object copy with conditional checks
