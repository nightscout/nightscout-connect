# LibreLinkUp v4 regression and local account testing

This lab tests the work consolidated in PR #73. It follows the Glooko validation
approach: compare source data independently, exercise both Nightscout write paths,
read back MongoDB records, replay the batch, and restart the connector. No v5
implementation or credentials are included.

## What CI proves

`npm test` covers regional endpoints and redirects, account-ID headers, patient
selection, both current-reading shapes, UTC factory times, malformed readings,
sensor attribution, optional metadata, terms handling, timeouts/retries, body/HTTP
429 responses, throttling, and output error/deduplication behaviour. The lab oracle
also has deliberate-corruption tests: losing the latest reading, converting mg/dL
twice, shifting times, changing arrows, losing metadata and duplicating records
must fail.

The additional **LibreLinkUp / real Nightscout storage** CI job uses MongoDB 6.0.27
and Nightscout commit `59430336dac0d75cdc7622725225b7ab774d788e`. It builds Nightscout
with this PR mounted as its connector, then checks:

- Synthetic v4 login, connections, graph and latest reading.
- Exact stored glucose, timestamp, trend and sensor metadata in real MongoDB.
- REST authentication: a wrong API secret cannot write any records.
- REST and internal writes, repeated batches and restart replay without duplicates.
- Overlapping history plus a new current reading; one Sensor Start remains.
- A real Nightscout process loading the embedded connect plugin, first sync and
  process restart, with the same stored-record checks.

Only the synthetic plugin process loads the Abbott transport replacement. The REST
server, MongoDB and Nightscout storage modules are real. This does **not** prove
that a regional Abbott endpoint accepts a real account; that is the live phase.
CI never uses real credentials, uploads reports or contacts Abbott.

## Local installation

Requires Node 22.23.2 or newer supported Node and Docker with Compose. In the PR
checkout:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run test:librelinkup:lab -- setup
npm run test:librelinkup:lab -- build
npm run test:librelinkup:lab -- up
npm run test:librelinkup:lab -- fixture
```

`build` pins the Nightscout source above. The prepared local installation can reuse
the already-built Glooko validation image from that same Nightscout commit. There
is no need to rebuild it before entering accounts.

Settings are in **`.local/librelinkup/.env`**, created once and never overwritten.
The directory is Git-ignored and private; the file has owner-only permissions.
All generated configuration and aggregate reports also stay under `.local/`.
Keep credentials there, not in commands, issues, PRs or CI secrets. The environment
file is parsed as data, never executed as a shell script. Quote passwords containing
spaces or `#`; comments remain comments. A partially configured account fails.

### Account settings

`LLU_TEST_ACCOUNTS` lists neutral aliases, initially
`uk,eu,us,ca,au,ap,ae,la,ru,jp,cn,de,fr`. Set these
fields for each account (`UK` below is the uppercase alias):

| Setting | Meaning |
| --- | --- |
| `LLU_UK_USERNAME`, `LLU_UK_PASSWORD` | LibreLinkUp follower login |
| `LLU_UK_PATIENT_ID` | Required when more than one connection exists |
| `LLU_UK_REGION` | Initial region: EU2/UK/GB, EU, US, CA, AU, AP, AE, DE, FR, JP, CN, RU or LA |
| `LLU_UK_TIMEZONE` | IANA timezone, e.g. Europe/London |
| `LLU_UK_UNITS` | Nightscout display `mmol` or `mg/dl`; stored SGVs remain mg/dL |
| `LLU_UK_MAX_AGE_MINUTES` | Newest acceptable reading age; defaults to 30 |
| `LLU_UK_SENSOR_INFO` | Sensor metadata on by default; `false` tests glucose-only mode |
| `LLU_UK_STEALTH_TLS` | Defaults false; optional v4 TLS compatibility setting |

Add further aliases and corresponding fields for other regions or a second patient.
Use a new alias for a different patient. The lab binds each database to a hashed
account/patient identity and refuses to blend another patient's records into it.
Account aliases must be lowercase letters/digits, start with a letter and have no
more than 16 characters. `fixture`, `mongo` and `runner` are reserved. Up to 13
aliases are supported.

### Regional endpoints

Each explicit `LLU_<ALIAS>_REGION` selects the corresponding built-in endpoint.
The template covers all 13 endpoints listed by the public
[nightscout-librelink-up project](https://github.com/timoschlueter/nightscout-librelink-up/blob/main/src/constants/llu-api-endpoints.ts).

| Region | Starting endpoint |
| --- | --- |
| EU2 (UK/GB aliases) | `https://api-eu2.libreview.io` |
| EU | `https://api-eu.libreview.io` |
| US | `https://api-us.libreview.io` |
| CA | `https://api-ca.libreview.io` |
| AU | `https://api-au.libreview.io` |
| AP | `https://api-ap.libreview.io` |
| AE | `https://api-ae.libreview.io` |
| LA | `https://api-la.libreview.io` |
| RU | `https://api.libreview.ru` |
| JP | `https://api-jp.libreview.io` |
| CN | `https://api-cn.myfreestyle.cn` |
| DE | `https://api-de.libreview.io` |
| FR | `https://api-fr.libreview.io` |

Timezone is only an account-selection hint. Berlin and Paris default to EU when
no region is specified; the DE and FR slots explicitly select their own endpoints.
An account working in a production deployment does not prove its regional host.
The source's own region redirects are honoured. Reports include `requestedHost`,
`resolvedHost` and `regionRedirected`; a redirected login validates that redirect
path, not a direct login to the originally requested region. The `status` command
also shows each account's starting endpoint without making a login request.

The lab makes one login/connections/graph sequence per selected account,
with no automatic retry loop or terms acceptance. Accept required terms manually
in the official app before rerunning. The test does not discover or print patient
IDs: obtain the desired ID privately if patient selection is required.

### Destinations

| Default alias | Local Nightscout |
| --- | --- |
| uk | http://127.0.0.1:1350 |
| eu | http://127.0.0.1:1351 |
| us | http://127.0.0.1:1352 |
| ca | http://127.0.0.1:1353 |
| au | http://127.0.0.1:1354 |
| ap | http://127.0.0.1:1355 |
| ae | http://127.0.0.1:1356 |
| la | http://127.0.0.1:1357 |
| ru | http://127.0.0.1:1358 |
| jp | http://127.0.0.1:1359 |
| cn | http://127.0.0.1:1360 |
| de | http://127.0.0.1:1361 |
| fr | http://127.0.0.1:1362 |
| synthetic demo | http://127.0.0.1:1369 |

Ports follow alias order. Re-run `up` after changing settings. Each account has a
separate database, with an additional `_rest` database used to test REST writes.
The visible UI shows the verified **internal** output. A dedicated runner process
hosts the REST test endpoint internally. MongoDB has no published host port; all
browser ports bind only to localhost. No production Nightscout URL is accepted.
The existing Glooko lab is unaffected.

These are snapshots: the browser containers have Connect disabled. Opening a page
or leaving Docker running does not poll Abbott. All database volumes persist when
the lab stops; live records are never automatically cleared. `fixture` resets only
the three named synthetic databases and cannot touch account databases.

## Run real-account checks

After filling the private file, first probe one account:

```sh
npm run test:librelinkup:lab -- probe uk
npm run test:librelinkup:lab -- run uk
```

`probe` validates authentication, selection, graph mapping and freshness without
writing glucose to Nightscout. `run` fetches once, then reuses that payload to test
REST and internal persistence, replay and restart. It compares raw glucose/time/
trend independently of the source transformation and verifies all mapped metadata
against MongoDB. It restarts the visible account UI to load the verified snapshot.

Omit the alias to test all configured accounts sequentially. Blank accounts are
skipped. An explicitly selected blank account fails. A failed account makes the
command fail while the remaining accounts are still checked. Do not run two lab
commands concurrently. Reports in `.local/librelinkup/results/` contain only alias,
host, counts, stage and pass/fail codes; no tokens, IDs, serials or glucose values.

Empty data, stale data (default >30 minutes) or future data (>5 minutes) fail rather
than count as a successful import. Increase the age threshold deliberately for
an inactive-sensor account; an empty graph still cannot prove glucose delivery.
Unavailable sensor metadata is reported separately from successful glucose delivery.
Patient-selection, terms, access-denied and throttling errors remain failed tests;
do not repeatedly rerun against a throttled account.

Failures use safe codes such as `PATIENT_ID_NOT_FOUND`, `NO_AUTH_TICKET` and
`ACCOUNT_ACTION_REQUIRED`, with numeric `sourceStatus` and a recognised network
error code where available. Raw upstream errors are never included in reports.
Some older production connectors ignore a configured patient ID when an account
has only one connection. This source validates an explicit ID strictly. Correct
the local selector only after confirming the intended connection; the lab still
refuses to choose implicitly from multiple patients.

If a timezone-inferred endpoint rejects a login that works in production, check
the production starting host. A separate diagnostic run using that host may
validate the account, but retain the failed regional result and do not count it
as successful coverage of the originally requested endpoint.

Live source logs and child Nightscout logs are suppressed, and Docker logging is
disabled for these containers. Medical data remains in the local Mongo volume;
optional sensor information includes serials. Do not share that volume or screenshots
containing personal data publicly. The API write secret is local and generated;
browser read access requires no login on these localhost-only test instances.

## Manual acceptance checklist (per account)

Record pass/fail and notes privately; automation leaves `manualReview: pending`.

1. Confirm the intended patient and regional login work in the official LibreLinkUp
   app. Note app time/units and whether the sensor is active, warming up or replaced.
2. Run the account test. Confirm `ok: true`, correct resolved region, nonzero
   readings, both write paths passed, and replay/restart passed.
3. Open that account's URL. Compare the latest imported reading's **timestamp and
   value at that timestamp** with LibreLinkUp; a later phone reading may have arrived
   since the snapshot. Check displayed units and local time, including timezone/DST.
4. Inspect the available history for shifted times, missing current data, duplicates,
   wrong trend arrows or implausible gaps. LibreLinkUp's graph window limits the
   available history; this lab does not invent older data.
5. With metadata enabled, inspect the Sensor Start event and sensor age. Advanced
   metadata is persisted in entries/devicestatus; the standard UI may not display
   every field. With metadata disabled, verify glucose still imports.
6. Wait for new genuine readings, rerun the same account, refresh its UI and confirm
   those readings appear while earlier history and the Sensor Start remain. This
   exercises a real incremental import across separate runner processes.
7. Stop/start the lab and verify the snapshot survives. Cover at least UK/EU2, EU,
   US and every other available real region before claiming those regions validated.
   Include a multi-patient account, a recent sensor replacement and both display
   units where accounts are available.

```sh
npm run test:librelinkup:lab -- status
npm run test:librelinkup:lab -- stop
npm run test:librelinkup:lab -- up
```

## Completion criteria

CI and synthetic storage checks must pass; each available regional account must
pass live authentication/mapping/persistence and manual visual review, including
a later real incremental run. Record unavailable regions as **not tested**.
The embedded plugin's boot/restart is tested synthetically in CI; live tests exercise
the same source and actual output code without an unattended polling loop. A
long-running live deployment/soak test remains a separate final release check.
