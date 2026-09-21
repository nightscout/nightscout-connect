# PR #52 refresh and review

Status: **not ready to merge**. Updating the branch and passing the contract
tests must not be interpreted as end-to-end approval of this feature.

## Attribution and scope

Thanks to [Patrick Sonnerat (@psonnera)](https://github.com/psonnera) for
[PR #52, API V3 support for nightscout data source](https://github.com/nightscout/nightscout-connect/pull/52).
The original commits are preserved. The LibreLinkUp adaptation also retains
its attribution and MIT notice for
[Timo Schlueter's implementation](https://github.com/timoschlueter/nightscout-librelink-up).

This refresh merges `dev` at `fe51c6df41e36aa071ff5ec7b24d2e1ee9a77fa9`
into the original PR head `83c7b1bb8b8608703823337827d830a11a76b617`.
It does not merge the PR into `dev` or release it.

The PR includes API v3, LibreLinkUp authentication and transport changes,
legacy bridge compatibility, debug logging, process lifecycle changes,
Docker packaging, and capture tooling. These deserve separate review scopes.

## Conflict-resolution decisions

- Keep version 0.0.14, the restored CI matrix, current dependency versions,
  and the complete Glooko integration and tests from `dev`.
- Keep `dev`'s Dexcom rejection handling and Glooko authentication/privacy fixes.
- Keep `dev`'s REST/plugin write completion, Glooko checkpoints, reconciliation,
  profile handling and deduplication. Preserve the proposed 50-record REST
  device-status chunks, but reject failed chunks instead of reporting success.
- Preserve the all-collection Nightscout source contract and collection
  selection. API v1 retains its current implementation; v3 feeds join a single
  frame. Profiles still use API v1. Do not register duplicate treatment/status
  loops alongside the aggregate loop.
- Retain LibreLinkUp's configurable interval, timezone-aware timestamp parsing,
  unmatched-patient guard and `glucoseItem` support while also accepting the
  proposed `glucoseMeasurement` field. Preserve historical trend arrows.
- Combine the example configuration and documentation, keeping one active
  source example. Preserve the original author's other proposed features for
  review rather than silently removing them.

## Validation performed

- 131 tests passed on Node 22.23.2 and Node 24.20.0, including eight new
  synthetic tests for v3 detection, token exchange, collection shape and
  selection, failed reads, aggregate-loop registration, bounded status uploads
  and failed-chunk propagation.
- Existing legacy source tests explicitly emulate an absent `/api/v3/version`.
- Read checks against local Nightscout dev 15.0.9, API 3.0.5, backed by
  disposable MongoDB 6.0.27. A local reader subject was provisioned for JWT
  authentication; no patient records were changed or cleared by this review.
- Synthetic LibreLinkUp authentication/logging and timer probes.
- Dependency audit: four reported vulnerabilities. The new development-only
  `axios-har-tracker` dependency introduces two high and one low findings via
  its dependency tree. The moderate `qs` finding also affects the current
  inherited lockfile; it is not introduced by the v3 feature.

The root `test-compat.js` remains the author's standalone script and is counted
as one test file by Node. Its `console.assert` calls do not enforce a failing
exit status and should be converted into real assertions before relying on it.
These tests do not exercise live LibreLinkUp, Docker startup, every source's
full state-machine lifecycle, or full destination writes for this PR.

## Merge blockers and recommendations

1. **P1: missing legacy treatments and device status.** Both v3 requests filter
   on `date$gt`, but normal v1-written records can have only `created_at` in
   storage. On the local server, unfiltered and `created_at$gt` v3 searches
   returned records while `date$gt=0` returned none for both collections.
   The connector then reported a successful frame with neither collection.
   Nightscout's [search operation](https://github.com/nightscout/cgm-remote-monitor/blob/59430336dac0d75cdc7622725225b7ab774d788e/lib/api3/generic/search/operation.js)
   applies storage filters before normalizing response dates. Support both
   persisted date representations and test mixed v1/v3-written collections.

2. **P1: LibreLinkUp timer overflow.** The proposed refresh and expiry delays
   are 15,551,400,000 and 15,552,000,000 ms. Native Node timers turn both into
   1 ms, confirmed by a synthetic probe. Use bounded scheduling and the
   actual ticket lifetime; verify refresh/expiry in the state machine.

3. **P1: debug output exposes authentication material.** A synthetic token
   appeared in the LibreLinkUp auth-response and request-header debug logs.
   Optional logging is not redaction. The new global exception/rejection
   handlers also print complete error objects, which can contain HTTP secrets.
   Log only sanitized metadata and add debug-enabled privacy tests.

4. **P1: credential-free mirroring regresses.** Detection of v3 unconditionally
   selects subject-based authentication. A publicly readable local site that
   works through v1 failed with HTTP 401 when no token/secret was configured.
   Preserve anonymous v1 fallback or make v3 selection explicitly opt-in.

5. **P1: bounded reads are not complete backfill.** Entries infer a count from
   five-minute sampling; treatments/status use one descending page of 1,000.
   There is no pagination. Advancing to the newest destination timestamp can
   permanently skip older records, including one-minute CGM data. Implement
   deterministic paging and durable progress, including equal timestamps,
   before promising a faithful mirror. The v3 paths also ignore sourceMaxCount.

6. **P2: lifecycle and packaging require separate work.** Continuing after an
   uncaught exception can leave a broken process appearing healthy. Replace
   this with sanitized failure and supervised restart, and test shutdown.
   The Dockerfile uses Node 18, which is
   [end of life](https://nodejs.org/en/about/previous-releases); use the supported
   test matrix. Update or remove the vulnerable capture-only dependency.

7. **P2: maintainability and scope.** There are duplicated v1/v3 auth, alignment,
   conversion and collection routines, including legacy methods no longer
   registered as separate loops after reconciliation with `dev`. Consolidate
   shared code and separate the unrelated connector/lifecycle/packaging work.
   Do not treat this PR as resolving other connector issues without their own
   focused validation.

## Value and next acceptance tests

API v3 support is a useful enhancement for authenticated Nightscout-to-Nightscout
mirroring and local development. Current `dev` already copies entries,
treatments, device status and profiles through API v1, so those collections
alone are not a new capability. The new value is the v3 transport and its
potential for reliable, incremental replication, not a proven more complete
import today. No issue should be closed on the strength of this refresh.

Before approval, use separate disposable source and destination databases to:

1. Seed a mixture of v1/v3 records in all four collections; compare identities,
   timestamps and clinical payloads after REST and plugin writes.
2. Test anonymous v1 access, reader-token v3 access, secret-provisioned access,
   rejected credentials, expired JWTs and a transient capability-probe failure.
3. Backfill more than one page, one-minute CGM and equal-timestamp records;
   restart mid-import and retry after an intentionally failed status chunk.
   Confirm no losses or duplicates before advancing progress.
4. Run the real state machines through multiple polls, refresh, expiry and
   shutdown with a fake clock. Test LibreLinkUp independently if retained.
5. Check logs with debug both enabled and disabled using synthetic credential
   and medical-data markers; then test the supported-runtime Docker image.

Recommendation: keep the PR open, narrow it to the Nightscout API v3 feature,
address these blockers, and repeat end-to-end validation before merging.
