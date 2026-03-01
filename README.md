# nightscout-connect

Nightscout's methods for synchronizing with common diabetes cloud providers.
This module provides a single entry point to Nightscout for similar modules
and allows managing http library and injecting dependencies from a single
point.


## Roadmap

* Nightscout
  * [x] hello world
  * [x] better gap finding
  * [x] glucose
  * [ ] treatments, profiles, devicestatus
* [x] Dexcom
* [x] Glooko
  * [x] fetch data
  * [x] translate data (likely needs work)
* [x] LibreLinkUp (needs testing)
* [x] ~~Medtronic~~
  * [x] hello world
  * [x] glucose, stub devicestatus
  * [ ] treatments, profiles, devicestatus
* [ ] Tidepool
* [ ] Tandem
* [ ] ~~Diasend - obsolete~~

## Lower priority
* Better UI integration, diagnostics, test connection, fix errors, manage plugin...
* Generate predictable pattern eg sine for test.
* run in capture mode to generate up to date test fixtures
* better sidecar support
* better cli support (pipe to/from anywhere: `* | nightscout-connect | * `,
  file, fixtures, csv, json, web services...

## Help wanted
* more vendors
* better design suggestions
* testing


## Brief Doc
* `ENABLE=connect` include the keyword `connect` in the `ENABLE` list.
* Environment variable prefix `CONNECT_`:
  * `CONNECT_SOURCE` - The name for the source of one of the supported inputs.  one of `nightscout`, `dexcomshare`, etc...
  * `CONNECT_DEBUG` - Set to `true`, `1`, or `yes` to enable detailed debug logging. Default is disabled.


## How to use

For now there are two "output" devices available, internal Nightscout as a
plugin, or external Nightscout as a sidecar from the commnandline.
We will consider additional output targets.

### From Nightscout

This is a Nightscout plugin.  Enable the plugin by including the word `connect`
in the `ENABLE` list.  Select a data source by providing `CONNECT_SOURCE`.
Make sure to provide the credentials needed by your data source.  If they are
missing, the plugin will produce a helpful error through Nightscout indicating
which variables to set.

### From command line

Running from the commandline for development purposes, as a sidecar, for
example, use `npm install` and consider `npm ln` to place the
`nightscout-connect` shell script in your path. Once in your path, it will offer `--help` for all subcommands.

#### Using a .env file (Recommended)

The easiest way to run nightscout-connect is with a `.env` file in the project root:

1. Create a `.env` file with your configuration:
```bash
CONNECT_API_SECRET=your_api_secret
CONNECT_NIGHTSCOUT_ENDPOINT=https://your-nightscout-site.com
CONNECT_SOURCE=nightscout
CONNECT_SOURCE_ENDPOINT=https://source-nightscout.com
CONNECT_SOURCE_API_SECRET=source_api_secret
```

2. Run the forever command:
```bash
node bin/nightscout-connect forever
```

The `.env` file will be automatically loaded (using dotenv) and environment variables will be available to the application.

#### Command-line help

```
$ nightscout-connect --help
```
```
nightscout-connect <cmd> [args]

Commands:
  nightscout-connect capture <dir> [hint]  Runs as a background server forever.
  nightscout-connect forever [hint]        Runs as a background server forever.
  nightscout-connect demo                  a quick demo using timers instead of
                                           I/O
  nightscout-connect completion            generate completion script

Options:
  --version  Show version number                                       [boolean]
  --help     Show help                                                 [boolean]
```

`nightscout-connect` will read the environment variables the same way as Nightscout
extended variables using the prefix `CONNECT_`.

#### Alternative: Using env-cmd

For development use with multiple environment files, you can use `env-cmd`:

```bash
npm install -g env-cmd
env-cmd -f path/to/your.env nightscout-connect forever
```

Development use typically consists of commands like this:

```
../cgm-remote-monitor/node_modules/.bin/env-cmd -f ../minimed-envs/subject.env nightscout-connect capture logs

```
Where `subject.env` typically consists of something like this:


```
CONNECT_API_SECRET=626753d7f62f000078e8f6e2
CONNECT_NIGHTSCOUT_ENDPOINT=http://localhost:3030
CONNECT_SOURCE=minimedcarelink
CONNECT_CARELINK_USERNAME=your username
CONNECT_CARELINK_PASSWORD=your password
CONNECT_CARELINK_REGION=your region
CONNECT_COUNTRY_CODE=your country code
```


## Input Data Sources

### Nightscout

> Work in progress

To sync from another Nightscout site, include `CONNECT_SOURCE_ENDPOINT` and
`CONNECT_SOURCE_API_SECRET`. 
* `CONNECT_SOURCE=nightscout`
* `CONNECT_SOURCE_ENDPOINT=<URL>`
* `CONNECT_SOURCE_API_SECRET=<OPTIONAL_API_SECRET>`

The `CONNECT_SOURCE_ENDPOINT` must be a fully qualified URL and may contain a
`?token=<subject>` query string to specify an accessToken.
The `CONNECT_SOURCE_API_SECRET`, if provided, will be used to create a token
called `nightscout-connect-reader`.  This information or the token provided in
the query will be used to read information from Nightscout and is optional if
the site is readable by default.

Select this driver by setting `CONNECT_SOURCE` equal to `nightscout`.



### Dexcom Share
To synchronize from Dexcom Share use the following variables.
* `CONNECT_SOURCE=dexcomshare`
* `CONNECT_SHARE_ACCOUNT_NAME=`
* `CONNECT_SHARE_PASSWORD=`

Optional, `CONNECT_SHARE_REGION` and `CONNECT_SHARE_SERVER` do the same thing, only specify one.
* `CONNECT_SHARE_REGION=`  `ous` or `us`. `us` is the default if nothing is
  provided.  Selecting `us` sets `CONNECT_SHARE_SERVER` to `share2.dexcom.com`.
  Selecting `ous` here sets `CONNECT_SHARE_SERVER` to `shareous1.dexcom.com`.
* `CONNECT_SHARE_SERVER=` set the server domain to use.

#### Legacy Bridge Plugin Compatibility

For backward compatibility with the old bridge plugin, the following environment
variables are also supported and will map to the new variable names:

* `BRIDGE_USER_NAME` → `CONNECT_SHARE_ACCOUNT_NAME`
* `BRIDGE_PASSWORD` → `CONNECT_SHARE_PASSWORD`
* `BRIDGE_SERVER` → `CONNECT_SHARE_REGION`
  * Blank/empty (old default) → `us` (share2.dexcom.com)
  * `EU` → `ous` (shareous1.dexcom.com)
  * `us` → `us` (share2.dexcom.com)
  * Custom domain → Uses `CONNECT_SHARE_SERVER` directly

**Important:** If a `CONNECT_*` variable is set, the corresponding `BRIDGE_*` variable is completely ignored. Only unset `CONNECT_*` variables will fall back to `BRIDGE_*` values.


### Glooko

> Note: Experimental.

To synchronize from Glooko use the following variables.
* `CONNECT_SOURCE=glooko`
* `CONNECT_GLOOKO_EMAIL=`
* `CONNECT_GLOOKO_PASSWORD=`
* `CONNECT_GLOOKO_TIMEZONE_OFFSET=0`

By default, `CONNECT_GLOOKO_SERVER` is set to `api.glooko.com` because the
default value for `CONNECT_GLOOKO_ENV` is `default`.
* `CONNECT_GLOOKO_ENV` is the word `default` by defalt.  Other values are
  `eu`, `development`, `production`, for `api.glooko.work`, and
  `externalapi.glooko.com`, respectively.
* `CONNECT_GLOOKO_SERVER` the hostname server to use - `api.glooko.com` by `default`, or `eu.api.glooko.com` for EU users.
* `CONNECT_GLOOKO_TIMEZONE_OFFSET` defines the time zone offset you are at from the UTC time zone, in hours

If both, `CONNECT_GLOOKO_SERVER` and `CONNECT_GLOOKO_ENV` are set, only
`CONNECT_GLOOKO_SERVER` will be used.

### Libre Link Up

To synchronize from Libre Link Up use the following variables:

**Required:**
* `CONNECT_SOURCE=linkup`
* `CONNECT_LINK_UP_USERNAME=` - Your LibreLinkUp email address
* `CONNECT_LINK_UP_PASSWORD=` - Your LibreLinkUp password

**Optional:**
* `CONNECT_LINK_UP_REGION=` - Your region (default: `EU`)
  * Available values: `AE`, `AP`, `AU`, `CA`, `DE`, `EU`, `EU2`, `FR`, `JP`, `US`, `LA`, `RU`, `CN`
  * This automatically sets the correct server (e.g., `EU` → `api-eu.libreview.io`)
* `CONNECT_LINK_UP_PATIENT_ID=` - Specific Patient ID (required if you have multiple connections)
* `CONNECT_LINK_UP_VERSION=` - LibreLink Up app version (default: `4.16.0`)
* `CONNECT_LINK_UP_SERVER=` - Override automatic server selection (advanced use only)

**Example Configuration:**
```bash
CONNECT_SOURCE=linkup
CONNECT_LINK_UP_USERNAME=your.email@example.com
CONNECT_LINK_UP_PASSWORD=yourpassword
CONNECT_LINK_UP_REGION=EU
```

**Note:** The implementation includes Cloudflare bypass features and follows the latest LibreLinkUp API standards from the reference implementation at https://github.com/timoschlueter/nightscout-librelink-up (MIT License)

### Minimed Carelink

To synchronize from Medtronic Minimed Carelink, set the following
environment variables.
* `CONNECT_SOURCE=minimedcarelink`
* `CONNECT_CARELINK_USERNAME`
* `CONNECT_CARELINK_PASSWORD`
* `CONNECT_CARELINK_REGION` Either `eu` to set `CONNECT_CARELINK_SERVER` to
  `carelink.minimed.eu` or `us` to use `carelink.minimed.com`.

For folks using the new Many to Many feature, please provide the username of the
patient to follow using `CONNECT_CARELINK_PATIENT_USERNAME` variable.

### Tidepool

* [ ] TODO

### Tandem

* [ ] TODO

## History

Initially there was `share2nightscout-bridge`, then
[`minimed-connect-to-nightscout`](https://github.com/nightscout/minimed-connect-to-nightscout).
The `request` library was deprecated in February, 2020, and Nightscout needs to
adapt by using currently maintained and supported dependencies.  The initial
goal is to help deprecate `share2nightscout-bridge` and use currently supported
dependencies.
Now there are more:
* https://github.com/burnedikt/diasend-nightscout-bridge
* https://github.com/jpollock/glooko2nightscout-bridge
* https://github.com/timoschlueter/nightscout-librelink-up (MIT License)
* https://github.com/jwoglom/tconnectsync
* https://github.com/skalahonza/TidepoolToNightScoutSync

This module should be sufficient to replace `share2nightscout-bridge` as an
initial minimum viable project.  There are a few minor enhancements to help
encourage migration away from `share2nightscout-bridge`:
* Less latency: new glucose fetches will be tightly aligned to the previous glucose reading.
  In most cases, new glucose readings will be produced within 30 seconds.
* Safe retries: There is an exponential backoff system to help prevent locking
  your account if the password changes.  Each retry will take a much longer
  amount of time.
* Safe community: There are now randomization behaviors to prevent tragedy of
  the commons from occurring.  These features help spread the load to avoid
  accidentally overwhelming vendor servers.

## Migration from share2nightscout-bridge

If you're migrating from the old `share2nightscout-bridge` plugin, you have two options:

### Option 1: Use Legacy Environment Variables (Easiest)

Keep your existing `BRIDGE_*` environment variables - they will work automatically:
```bash
ENABLE=connect
BRIDGE_USER_NAME=your_dexcom_username
BRIDGE_PASSWORD=your_dexcom_password
BRIDGE_SERVER=         # Blank for US (old default), or set to EU for European servers
```

### Option 2: Update to New Variable Names (Recommended)

Update your environment variables to the new naming convention:
```bash
ENABLE=connect
CONNECT_SOURCE=dexcomshare
CONNECT_SHARE_ACCOUNT_NAME=your_dexcom_username
CONNECT_SHARE_PASSWORD=your_dexcom_password
CONNECT_SHARE_REGION=us
```

Both approaches work identically. The new `CONNECT_*` variables take precedence if both are set.


