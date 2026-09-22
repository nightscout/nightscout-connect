# Glooko sync: data mapping and safeguards

The `wip/glooko-work` branch uses paginated sync feeds by default. Authentication,
transport/pagination, clinical mapping, profile mapping and Nightscout persistence
are separated so synthetic tests can exercise each contract independently.
`CONNECT_GLOOKO_DATA_MODE=legacy` keeps the earlier fetcher available for diagnosis.

## Sources reviewed and credit

- The existing Nightscout Connect implementation and other work done locally.
- Original contributors: **ryceg** ([#46](https://github.com/nightscout/nightscout-connect/pull/46)),
  **lsandini** ([#51](https://github.com/nightscout/nightscout-connect/pull/51)),
  **HockeyTrafalgar** ([#56](https://github.com/nightscout/nightscout-connect/pull/56)),
  **lukas-slansky** ([#58](https://github.com/nightscout/nightscout-connect/pull/58),
  [#60](https://github.com/nightscout/nightscout-connect/pull/60)), and
  **erikpendragon** ([#63](https://github.com/nightscout/nightscout-connect/pull/63)).
  Their contributions and existing commit credits remain part of this branch.
- [Nocturne's Glooko connector](https://github.com/nightscout/nocturne/tree/87090087ef7ee8dd9e5afa77e22f29bb804029f4/src/Connectors/Nocturne.Connectors.Glooko),
  particularly its sync envelopes, raw resource models, unit contracts, profile
  settings and V4 mapping. Credit to the Nocturne contributors (AGPL-3.0).
  Nocturne's V4-only collections are not assumed to exist in Nightscout.
- [Jeremy Pollock's earlier bridge](https://github.com/jpollock/glooko2nightscout-bridge):
  useful historical food/injection support, but its time-proximity dose matching
  and fixed fetch limits are not suitable for the new mapper.
- Nightscout `dev` storage, careportal, basal renderer and IOB consumption at
  `59430336dac0d75cdc7622725225b7ab774d788e`, verified with real local writes.

## Mapping

| Glooko data | Nightscout representation | Important semantics |
| --- | --- | --- |
| Raw CGM EGVs; graph fallback | `entries`, `sgv` | Integer mg/dL; local display clock corrected once; calculated/deleted duplicates excluded; supplied trend retained |
| Meter readings | `BG Check` | Fingerstick, mg/dL; not confused with CGM |
| Normal bolus | `Meal Bolus` / `Correction Bolus` | Actual delivered insulin, not programmed dose; carb-only records remain `Carb Correction` |
| Scheduled/temporary/suspended delivery | `Temp Basal` | U/hour and duration in minutes; zero delivery preserved; `glookoBasalType` distinguishes provenance |
| Extended bolus | `Combo Bolus`, or informational `Note` | Requires verified duration unit and consistent delivered split; note otherwise, with original dose metadata |
| Foods / CGM carb events | `Carb Correction` | Nutrition fields, description and serving metadata retained; no guessed insulin pairing |
| Rapid injection | `Correction Bolus` | Actual dose |
| Basal or unknown-class injection | `Note` plus `glookoInsulin` | Does not enter Nightscout's rapid-insulin IOB calculation |
| Site/reservoir/sensor/battery events | Standard careportal event | Feeds relevant age indicators; unsupported kinds preserved as notes |
| Alarms, ordinary notes, pump modes | `Note` | Human-readable text; alarms never become `Announcement` notifications |
| Automated delivery / maximum delivery / pause bands | `Note` with duration | Historical chart annotations only; graph coordinates are not insulin rates |
| Exercise | `Exercise` | Duration normalized to minutes |
| Pump IOB | `devicestatus.pump.iob` | Timestamp of the source snapshot, never the import time |
| Complete active pump settings | Optional profile named `Glooko` | IANA timezone, basal, ISF, carb ratio, targets and DIA; no invented missing settings |

Profile import is **off by default**. Turning it on can affect Nightscout's
active profile and derived IOB/COB calculations. Review the settings first.
Ambiguous active programs or incomplete schedules are not imported.

Nightscout has no independent delivered-basal collection: delivered segments
use its existing basal representation and retain their actual origin in metadata.
They are not claimed to be manually selected temporary basal commands.

### Historical delivery-state bars

The connector requests `basalBarAutomated`, `basalBarAutomatedMax` and
`basalBarAutomatedSuspend`. The verified graph format draws each interval using
five points with Y coordinates `0, 1, 1, 0, null`. These become one **Note with
duration**, not five treatments and never a `Temp Basal` or insulin dose.

Labels are **Automated delivery**, **Maximum automated delivery** and
**Automated delivery paused**. Omnipod mode intervals are combined into the same
timeline, with limited/activity context retained where available. Pause takes
precedence over maximum delivery, which takes precedence over ordinary delivery.
Adjacent identical states are merged, gaps remain gaps, and local-midnight
boundaries keep successive graph windows consistent. Nightscout's existing
duration-note bars and tooltips display these without any server/client changes.
They share the ordinary note styling; no custom colours or separate lane are
claimed. Short intervals may need zooming to read their labels.

`glookoPumpState` retains the state, mode, source series, end time, account-scoped
owner key and `historical: true` for a future dedicated display. No live pump
status, alerts, insulin, carbohydrate or basal-rate fields are emitted.

The graph window starts at local midnight two days back (up to three calendar
days). The latest data can still be delayed. Repeated graph reads can extend or
repartition a band, so after successful writes the connector removes obsolete
**pump-state notes owned by the same account within that window**. Other notes,
doses and basal records are not eligible. This requires treatment-delete access
for the REST output. Failed reconciliation prevents cursor acknowledgement;
malformed rectangles fail mapping rather than guessing or deleting data.

## Completeness and persistence

- Each resource has its own `(lastUpdatedAt, lastGuid)` cursor. Treatments
  exhaust 500-record pages, with a bounded 200-page safety limit and detection
  of stalled/cyclic cursors. CGM yields after four pages per cycle, committing
  that progress only after successful writes; the 200-page safety limit applies
  across an unfinished raw-CGM backfill. Hitting that safety limit is an error.
- `CONNECT_GLOOKO_LOOKBACK_DAYS=14` controls glucose history and the initial
  treatment update lookback (integer 1–90, sync mode). Treatment update dates
  are not necessarily their clinical event dates. Settings are independent.
  Update cursors are UTC; clinical request windows and display clocks are local.
- Changing the setting re-reads the requested glucose window, including on an
  existing installation. Reducing it does not delete previously imported data.
  While historical pages remain, an additional bounded two-day read keeps recent
  glucose available. Afterwards, normal polling uses the saved update cursor.
  Large imports finish over multiple polling cycles, not necessarily immediately.
- If raw CGM is unavailable, the graph fallback backfills in two-day slices.
  Historical CGM-only graph requests are separate from the short pump-mode and
  delivery-state graph window; they cannot delete or extend historical state notes.
- At most three resource fetches run concurrently per account. HTTP 401, 403,
  429 and server failures fail the frame. Optional 404/422 feeds are reported.
- Cursors advance only after all Nightscout collection writes acknowledge.
  A small `devicestatus` record with device `nightscout-connect-glooko-sync`
  stores versioned progress, cursors and a hashed account/region/timezone owner.
  It contains no credentials, glucose values, insulin values or current pump state.
  It is not a clinical pump-status record. Both embedded and REST outputs restore
  this checkpoint on restart and keep one per owner, saving the new one before
  deleting its predecessor. One writer per owner/destination is required.
  REST credentials need read/create/delete access to `devicestatus`, in addition
  to the clinical collections. Checkpoint failures fail the cycle; replay is safe.
  Missing checkpoints cause a bounded replay, not skipped history. If manually
  clearing clinical data, clear this connector's checkpoint too to request a full
  re-import. Imported history is limited to what the account's Glooko feed retains.
- New treatments use stable, account-namespaced source identities. Editing a
  dose with the same GUID updates that treatment instead of adding another.
  CGM identity is consistent between raw and graph paths.
- Earlier imported treatments with `glookoGuid` but no `identifier` are updated
  through their existing `_id`. Their new identity is retained in
  `glookoIdentifier`. Already-duplicated legacy GUIDs fail with
  `GLOOKO_LEGACY_DUPLICATES_REQUIRE_REVIEW`; the connector does not guess which
  historical insulin record to remove.
- Pump-status deduplication queries this uploader explicitly, including a date
  bound. This avoids Nightscout's runtime cache and default four-day query window
  hiding an older snapshot. Profile identities prevent repeated profile inserts.
- Internal writes finish on storage callbacks, including treatment-only frames.
  Failed writes reject; HTTP/database error objects containing credentials or
  medical records are not forwarded into connector logs.

Run one Glooko writer per destination. Use `CONNECT_GLOOKO_SKIP_ENTRIES=true`
when another source already supplies CGM. Do not switch source accounts in one
production destination without a deliberate data-separation plan.

## Known boundaries

- This is not an official supported Glooko API contract. Synthetic CI detects
  regressions against known contracts; only opted-in live checks detect server
  changes. No promise of future server compatibility is implied.
- Soft-deleted records are excluded on import, but upstream deletions are **not
  yet propagated** to previously stored Nightscout records. This remains an
  explicit reconciliation limitation; do not use it as a bidirectional sync.
- Separately entered food and pump carbohydrate logs may describe the same meal.
  Without a trustworthy shared identity we preserve the source events and do not
  merge them using a time-proximity guess. Avoid logging the same carbs twice.
- A repeated DST wall-clock hour cannot be uniquely reconstructed if the source
  omits a real offset. Explicit offsets are respected; ordinary summer/winter
  and transition-adjacent times are tested. Travel/device-timezone changes need
  account-specific review rather than assuming the configured zone always fits.
- Extended-bolus duration remains unverified in the live sample. Keep
  `CONNECT_GLOOKO_EXTENDED_BOLUS_DURATION_UNIT` unset until confirmed for the
  actual device. Informational notes do not contribute that dose to calculated IOB.
- Nine pump/CGM accounts do not prove all hardware or MDI scenarios. Exercise,
  extended-bolus and injection mapping have synthetic coverage, not verified
  live examples in this sample. V3 summary histories, hardware inventories and
  Nocturne-specific health/food-catalog collections are not blindly duplicated
  into Nightscout treatments.
- Older Nightscout releases have not been certified by this test run. Validate
  the deployed version and take a backup before production rollout. Legacy
  records lacking both source GUID and stable identity need manual migration
  review; their ownership cannot safely be inferred from a timestamp alone.

See [the live test plan and results](glooko-live-test-plan.md) for reproducible
commands, account-region coverage and the distinction between tested behavior
and remaining device-specific validation.
