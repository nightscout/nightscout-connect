# Glooko integration test plan

This plan tests the `wip/glooko-work` branch without exposing credentials or
writing health data to an unintended Nightscout instance. Automated tests use
synthetic fixtures only; a green CI run is not proof that Glooko's live API or
Nightscout persistence works.

## Verification status

**Passed for the tested scope; user manual browser review accepted.**

- The final credential-free regression suite passes all **122 tests** on Node
  22.23.2 and 24.20.0.
- The nine-account US/EU/de-fr live matrix passed source reads, REST and embedded
  Nightscout writes, replay, incremental updates and plugin startup/restart.
- Later delivery-state notes were additionally validated with account 1; the
  final persisted-history implementation was validated with account 3 through
  both outputs and actual plugin startup/restart. These follow-ups were not a
  repeat of the entire nine-account matrix against the final revision.
- Account 3's 90-day history expansion passed with 25,624 glucose readings,
  checkpoint recovery between batches, duplicate protection and an incremental
  follow-up. Its default 14-day snapshot was then restored for manual review.
- The user reviewed the real-data local Nightscout site in Dia and confirmed
  that the delivery-state presentation and extended glucose history looked good.
  This is user-performed visual verification, not an automated browser pass.

This records successful validation of the scenarios above, not universal
device coverage or a guarantee against future Glooko server changes. The
[known boundaries](glooko-sync.md#known-boundaries), including data types with
synthetic-only coverage, remain applicable. No production writes or
`cgm-remote-monitor` source changes were made during validation.

## Preparation

1. Use a Glooko account you are authorized to test. Keep its credentials in
   `.env.local` at the repository root, never in an issue, chat message, test
   fixture, shell history, or commit. The filename is Git-ignored. Set its file
   permissions to owner-only and remove it when testing is finished.
2. Start from `.env.example`, replacing the region, email, password, timezone,
   and auth mode with the account's actual settings. Do not put a Nightscout
   endpoint or API secret in this file for the read-only phase.
3. Confirm the branch and dependency install: `git branch --show-current`,
   `npm ci --ignore-scripts --no-audit --no-fund`, and `npm test`.

## Phase 1: read-only source probe

Run each relevant authentication mode, one at a time:

```sh
node --env-file=.env.local scripts/glooko-live-probe.js --live --auth-mode=api
node --env-file=.env.local scripts/glooko-live-probe.js --live --auth-mode=v3
node --env-file=.env.local scripts/glooko-live-probe.js --live --auth-mode=web
node --env-file=.env.local scripts/glooko-live-probe.js --live --auth-mode=auto
```

The probe authenticates, fetches one Glooko frame, and transforms it entirely
in memory. It does **not** connect to or write to Nightscout. It prints only
success/failure status and collection counts; it suppresses source logs and
does not print credentials, cookies, patient codes, glucose values, or record
timestamps. A failure reports the stage, HTTP status, and transport code only.

Check that the chosen regional server authenticates, the patient code resolves,
and expected non-empty collections are actually fetched. Run the probe once
with v3 graph fallback enabled and once with it disabled; compare the reported
CGM counts. A zero count is not automatically success: compare against the
source account's real activity and the expected timeframe. In particular,
verify that web login returns pump data as well as CGM data.

## Phase 2: isolated Nightscout destination

Only after read-only results are understood, use an isolated staging
Nightscout instance with an approved test account. Back up its data first.
Never aim a trial import at a production endpoint by default. Exercise both
the plugin and sidecar configurations, then compare Glooko with Nightscout:

- CGM values, counts, units, and timestamps from v2 and v3 fallback;
- bolus dose, carbs, basal rate/duration, site/sensor/reservoir events,
  alarms, and device-status IOB;
- winter/summer timestamps and records around both DST transitions;
- a second poll and a connector restart, checking for duplicate source GUIDs,
  treatments, and device-status snapshots;
- `CONNECT_GLOOKO_SKIP_ENTRIES=true` with another CGM source, confirming no
  duplicate glucose entries while treatments continue to import.

Keep only redacted pass/fail observations and aggregate counts. Do not save raw
responses or HAR captures containing patient data in the repository.

## Phase 3: failure and regression coverage

Synthetic tests should cover HTTP 422/500/timeouts on CGM and pump endpoints,
web sessions lacking a patient code, v3 requests without v2-only parameters,
delayed treatment bookmarks, write failures, and restart deduplication beyond
the initial 500-treatment seed. Real credentials should never be used in CI.
The web-login and pump-event error paths fail visibly in unit tests. The
disposable end-to-end run below now covers real persistence and restart
behavior. Live device categories absent from the sample still need targeted
validation; a passing import is not a blanket production certification.

## CI and Glooko-side change detection

Keep the pull-request workflow credential-free. `npm test` runs synthetic
fixtures on both supported Node versions; it should cover the US, EU and
Germany/France host mappings and web origins, API/v3 authentication response
shapes, v2-to-v3 CGM fallback (including non-empty but unconvertible v2
records), pump-event conversion, timezone/DST boundaries, failed fetches,
deduplication, and the aggregate-only live-probe warning rules. Never assert
fixed live collection counts in PR tests; the remote account data changes.

Synthetic CI cannot detect a Glooko API or authentication change by itself.
For that, run a separate, explicitly opted-in, read-only canary using dedicated
test accounts on each regional host. Store credentials only in protected CI
secrets, restrict who can trigger the job, do not run it on pull requests from
forks, and suppress raw HTTP responses, cookies, patient codes, record values,
and timestamps. For each account, assert successful authentication, a resolved
patient code, a successful fetch and transform, and non-zero CGM entries only
when that account is expected to have current CGM data. Record aggregate
counts and warning codes, not payloads. Alert on new failures, persistent
zero-entry results, or a newly reached response limit; do not fail because
normal live counts differ by a few readings between runs.

The earlier fixed-limit probe returned exactly 1,000 basal records for several
accounts. The new paginated collector was subsequently verified through up to
five basal pages, recovering as many as 2,187 basal segments in one account.

## Automated disposable matrix

`scripts/glooko-live-matrix.js` reads credential blocks separated by blank lines
from an ignored env file. Commented `# CONNECT_...` lines are interpreted **in
memory** so all accounts can be exercised without modifying the file. This is
intentional: use `--account=N` to restrict a run. Never point it at an env file
containing accounts you are not authorized to test.

Read-only run (no destination, no writes):

```sh
node scripts/glooko-live-matrix.js --live --env-file=.env.local --compact
```

For full writes, build the official Nightscout `dev` Dockerfile as
`glooko-validation-nightscout:dev`, and run the following with the actual
connector checkout substituted in the read-only bind mount. Run `npm ci` in the
connector checkout first. These names and the database are reserved for the
disposable test, not production:

```sh
docker network create glooko-validation
docker run -d --name glooko-validation-mongo --label codex.task=glooko-validation \
  --network glooko-validation --tmpfs /data/db:rw,noexec,nosuid,size=1g mongo:6.0.27
docker run -d --name glooko-validation-app --label codex.task=glooko-validation \
  --network glooko-validation -p 127.0.0.1:1346:1337 \
  -e MONGO_CONNECTION=mongodb://glooko-validation-mongo:27017/glooko_validation \
  -e API_SECRET=glooko-local-validation-only -e INSECURE_USE_HTTP=true \
  -e AUTH_DEFAULT_ROLES=readable \
  -v /absolute/path/to/nightscout-connect:/opt/app/node_modules/nightscout-connect:ro \
  glooko-validation-nightscout:dev
docker exec \
  -e GLOOKO_TEST_MONGO_URI=mongodb://glooko-validation-mongo:27017/glooko_validation \
  -e GLOOKO_TEST_API_SECRET=glooko-local-validation-only \
  glooko-validation-app node /opt/app/node_modules/nightscout-connect/scripts/glooko-live-matrix.js \
  --live --env-file=/opt/app/node_modules/nightscout-connect/.env.local \
  --nightscout=http://127.0.0.1:1347 --nightscout-root=/opt/app --plugin-boot --compact
```

The matrix starts a separate Nightscout process on **1347 inside the container**
for each account; do not use the parent server's port 1337. Restarting isolates
Nightscout's in-memory caches as well as its database. The test secret above is
deliberately synthetic and must never be reused in production.

The runner refuses non-local HTTP endpoints and MongoDB names other than
`glooko_validation`. It clears the four destination collections before and after
each account, including error exits. It suppresses patient payloads and prints
only numbered accounts, region/timezone, aggregate counts and diagnostic codes.
Do not enable HTTP debugging or capture raw server logs for live runs.

Each account checks:

1. Login, patient resolution, full paginated fetch and mapping.
2. Raw CGM versus independent v3 graph value/time cross-check.
3. REST writes and direct database readback of counts, identities and mapped fields.
4. Existing legacy treatment identities, repeat writes and output restart.
5. Incremental fetch and persistence through REST and internal output.
6. Real Nightscout internal storage modules, including profile and pump IOB readback.
7. Actual `ENABLE=connect` plugin startup and a fresh Nightscout process restart.
8. Empty destination collections before moving to the next account.

`--auth-mode=v3`, `--auth-mode=web`, and `--account=N` allow focused checks.
Omit `--compact` to include per-feed counts and page counts. No live credentials
or patient response fixtures belong in PR CI; the existing Node matrix discovers
the synthetic tests automatically through `npm test`.

After testing, verify these exact containers belong to the test, then remove
them and their network. MongoDB's tmpfs is destroyed when its container stops:

```sh
docker rm -f glooko-validation-app glooko-validation-mongo
docker network rm glooko-validation
```

## Verified results — 2026-09-21

Nightscout `dev`: `59430336dac0d75cdc7622725225b7ab774d788e` (15.0.9), Node
22.23.2, MongoDB 6.0.27. All writes were local. No production database or
deployment was modified. These are sample counts, not future test constants.

| Account | Region | Timezone | CGM entries | Treatments |
| --- | --- | --- | ---: | ---: |
| 1 | default | America/New_York | 557 | 187 |
| 2 | default | America/New_York | 595 | 59 |
| 3 | eu | Europe/Rome | 489 | 1,473 |
| 4 | default | America/New_York | 568 | 93 |
| 5 | default | America/Chicago | 636 | 93 |
| 6 | eu | Europe/Amsterdam | 557 | 1,749 |
| 7 | de-fr | Europe/Berlin | 2,412 | 2,082 |
| 8 | eu | Australia/Sydney | 615 | 93 |
| 9 | de-fr | Europe/Berlin | 732 | 2,300 |

All nine passed API-login fetch, REST/internal persistence, incremental writes, repeat writes,
legacy-identity preservation, and actual plugin startup/restart. All nine had a
complete importable profile; four had an eligible pump IOB snapshot. Cross-checks
against v3 graph data found zero mismatched glucose values at matching clocks.
Each account's destination collections were cleared after its run.

JSON v3 login additionally passed representative US, EU and de-fr accounts;
the de-fr example also passed the complete write/plugin-restart matrix using v3.
Legacy web-form login returned HTTP 422 for the de-fr example. Automatic login
now prefers JSON v3 after API 422; synthetic tests cover that fallback and ensure
401/403 do not cause extra credential attempts.

The credential-free regression suite passes **100/100 on Node 22.23.2 and
24.20.0**, the versions configured in the PR workflow. This is local execution
of that matrix, not a claim that a new hosted GitHub Actions run was triggered.

Browser visual verification was attempted with synthetic records only, but the
desktop browser tool refused access because its admin security-policy check was
unavailable. No bypass was attempted. Storage semantics and the relevant
Nightscout rendering/IOB source were inspected; a rendered UI check is still
outstanding at that stage. Dia was subsequently requested but was not available in the
connected-browser inventory. A single real account was then authorized for a
local manual visual review. The user subsequently completed that review and
accepted the display, as recorded in the verification status above.
The sample also lacks live extended boluses, injection and exercise
records; those mappings have synthetic coverage only. See the explicit
[remaining boundaries](glooko-sync.md#known-boundaries) before production rollout.

### Delivery-state duration notes follow-up

The suite subsequently grew to **110 tests**, passing on Node 22.23.2 and
24.20.0. The additional cases cover verified five-point graph rectangles,
duration/timezone mapping, adjacent-interval merging, pause/maximum precedence,
no insulin/basal/status side effects, stable identities on extension and window
advance, Omnipod mode deduplication, malformed shapes, missing capabilities,
and narrowly scoped note reconciliation.

Account 1 passed the full live REST/internal/replay/incremental/plugin-restart
matrix with **557 CGM entries and 271 treatments** including the new historical
state notes. A separate synthetic test against actual Nightscout storage proved
that both REST and internal reconciliation removed a superseded state note,
preserved an unrelated user note, and remained idempotent on replay.
No `cgm-remote-monitor` source changes were made; display uses its existing
duration-note renderer. The local account snapshot was then rebuilt for user
visual review.

### Configurable glucose history follow-up

The credential-free suite now has **122 tests**, passing locally on Node
22.23.2 and 24.20.0. New coverage includes bounded CGM pagination, preserving
recent glucose during backfill, lookback changes (including decrease/re-increase),
account/timezone isolation, skipped glucose, interrupted fetches, independent
graph-only history slices, malformed graphs, checkpoint read/write failures,
cleanup recovery, duplicate replay and restart restoration in both outputs.
These tests run under the existing PR `npm test` workflow; no new hosted CI run
was triggered by this local validation.

Account 3 passed the REST/internal/replay/incremental and actual embedded-plugin
startup/restart matrix with the new persisted checkpoints. A separate live
history test increased a two-day installation to **90 days**, importing **25,624
glucose readings in 13 bounded cycles**. Each cycle recreated the REST output,
restored the database checkpoint, replayed its write and checked for duplicates.
All stored glucose timestamps/values matched the mapped input. The completed
import's next incremental cycle returned zero glucose records. Only one sync
checkpoint remained. That temporary 90-day dataset was cleared afterwards.

The local manual-review snapshot was then rebuilt with the default **14-day**
window: **3,965 glucose entries, 1,456 treatments and one profile**, with one
non-clinical sync checkpoint. These counts are point-in-time observations, not
fixture expectations. No production writes or Nightscout source changes occurred.

`scripts/glooko-history-live.js` makes the expansion/restart/replay test repeatable.
It requires `--live --replace-local-data`, an explicit `--account=N`,
`--env-file=...`, `--nightscout=http://127.0.0.1:PORT`, and
`--nightscout-root=...`, plus `GLOOKO_TEST_MONGO_URI` and
`GLOOKO_TEST_API_SECRET`. It only accepts the disposable `glooko_validation`
database on the supported local hosts. `--days=14` is the default target (3–90
for this expansion test); `--initial-days=14` starts directly at that target.
Without `--keep`, it clears the test collections on completion. With `--keep`,
it retains a successful snapshot for authorized manual browser review. Failure
clears the disposable test data. Credentials and patient records are never
printed. The script imports a profile, so it must not target an existing user's
Nightscout installation.
