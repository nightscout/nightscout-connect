# Glooko integration test plan

This plan tests the `wip/glooko-work` branch without exposing credentials or
writing health data to an unintended Nightscout instance. Automated tests use
synthetic fixtures only; a green CI run is not proof that Glooko's live API or
Nightscout persistence works.

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
The web-login and pump-event error paths now fail visibly in unit tests, but
the combined PR remains unready for merge until those behaviors and an
end-to-end staging import are validated against live services.
