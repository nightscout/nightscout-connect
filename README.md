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
  * [x] translate treatments and v2 CGM readings (experimental)
* [x] LibreLinkUp
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
* testing, especially with real-world international accounts and version changes


## Brief Doc
* `ENABLE=connect` include the keyword `connect` in the `ENABLE` list.
* Environment variable prefix `CONNECT_`:
  * `CONNECT_SOURCE` - The name for the source of one of the supported inputs.  one of `nightscout`, `dexcomshare`, etc...

## Testing

The package has a Node test suite covering connector contracts and fake-server
Nightscout connectivity paths:

```
npm install
npm test
```

Current coverage includes Dexcom Share auth/session shapes, Nightscout
source/output token flows, LibreLinkUp regional and timestamp behavior, and
Glooko regional/device identity plus v2 CGM reading transforms.


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

When using the external Nightscout output, provide:

* `CONNECT_NIGHTSCOUT_ENDPOINT=<destination Nightscout URL>`
* `CONNECT_API_SECRET=<destination Nightscout API secret>`


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
* `CONNECT_SOURCE_COLLECTIONS=entries,treatments,devicestatus,profiles`
* `CONNECT_SOURCE_MAX_COUNT=1000`

The `CONNECT_SOURCE_ENDPOINT` must be a fully qualified URL and may contain a
`?token=<subject>` query string to specify an accessToken.
The `CONNECT_SOURCE_API_SECRET`, if provided, will be used to create a token
called `nightscout-connect-reader`.  This information or the token provided in
the query will be used to read information from Nightscout and is optional if
the site is readable by default.

Select this driver by setting `CONNECT_SOURCE` equal to `nightscout`.

The Nightscout source copies entries, treatments, devicestatus, and profiles by
default. Set `CONNECT_SOURCE_COLLECTIONS` to a comma-separated subset if you
only want specific collections. Each collection uses its own cursor from the
destination output's gap analysis.



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

Dexcom Share supports both older authentication responses that return a bare
account ID and newer G7-era responses that return `{ accountId: "..." }`.
Authentication and non-HTTP failures are surfaced to the state machine rather
than treated as empty data.


### Glooko

> Note: Experimental.

To synchronize from Glooko use the following variables.
* `CONNECT_SOURCE=glooko`
* `CONNECT_GLOOKO_EMAIL=`
* `CONNECT_GLOOKO_PASSWORD=`
* `CONNECT_GLOOKO_TIMEZONE=` optional IANA timezone, for example `Europe/Prague`
* `CONNECT_GLOOKO_TIMEZONE_OFFSET=0`
* `CONNECT_GLOOKO_DEVICE_ID=` optional stable device identity
* `CONNECT_GLOOKO_SERIAL_NUMBER=` optional stable serial number
* `CONNECT_GLOOKO_WEB_ORIGIN=` optional web origin override for regional/custom hosts
* `CONNECT_GLOOKO_AUTH_MODE=api` optional auth mode: `api`, `web`, or `auto`
* `CONNECT_GLOOKO_USE_V3_GRAPH=true` optional v3 graph CGM fallback when v2 returns no readings

By default, `CONNECT_GLOOKO_SERVER` is set to `api.glooko.com` because the
default value for `CONNECT_GLOOKO_ENV` is `default`.
* `CONNECT_GLOOKO_ENV` is the word `default` by default.  Other values are
  `eu`, `development`, `production`, for `api.glooko.work`, and
  `externalapi.glooko.com`, respectively.
* `CONNECT_GLOOKO_SERVER` the hostname server to use - `api.glooko.com` by `default`, `eu.api.glooko.com` for EU users, or a more specific regional host such as `de-fr.api.glooko.com`.
* `CONNECT_GLOOKO_TIMEZONE` defines the IANA timezone used to convert Glooko local wall-clock timestamps, for example `Europe/Prague`. This handles daylight saving time based on each timestamp.
* `CONNECT_GLOOKO_TIMEZONE_OFFSET` defines a fixed offset from UTC in hours and is retained for backward compatibility. `CONNECT_GLOOKO_TIMEZONE` takes precedence when both are configured.

If both, `CONNECT_GLOOKO_SERVER` and `CONNECT_GLOOKO_ENV` are set, only
`CONNECT_GLOOKO_SERVER` will be used.

Glooko uploads treatments and, when the v2 `cgm/readings` endpoint returns
readings, CGM entries. Some EU accounts may require newer web-login or v3 graph
flows. `CONNECT_GLOOKO_AUTH_MODE=web` uses Glooko's web sign-in form with CSRF
token handling; `auto` tries API login first and falls back to web login on a
422 response. The optional v3 graph fallback fetches `cgmHigh`, `cgmNormal`,
and `cgmLow` series when v2 CGM readings are empty, using the same
authenticated session cookie.

### Libre Link Up
To synchronize from Libre Link Up use the following variables.
* `CONNECT_SOURCE=linkup`
* `CONNECT_LINK_UP_USERNAME=`
* `CONNECT_LINK_UP_PASSWORD=`

By default, `CONNECT_LINK_UP_SERVER` is set to `api-eu.libreview.io` because the
default value for `CONNECT_LINK_UP_REGION` is `EU`.
Other available values for `CONNECT_LINK_UP_REGION`:
  * `US`, `EU`, `EU2`, `DE`, `FR`, `JP`, `AP`, `AU`, `AE`, `CA`
* `CONNECT_LINK_UP_SERVER` may be used to override the region mapping with an
  explicit LibreView API host.
* `CONNECT_LINK_UP_VERSION` and `CONNECT_LINK_UP_PRODUCT` may be used when
  LibreLinkUp requires a newer client version or product identifier.

For folks connected to many patients, you can provide the patient ID by setting
the `CONNECT_LINK_UP_PATIENT_ID` variable.

Optionally, you can override the default 5-minute refresh interval by providing
`CONNECT_LINK_UP_INTERVAL` as an integer representing minutes.

LibreLinkUp uploads graph readings and the current glucose item to avoid the
historical graph delay. Nightscout duplicate handling is relied on for overlap.

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
* https://github.com/timoschlueter/nightscout-librelink-up
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
