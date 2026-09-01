# Glooko: pump events, alarms and guid deduplication

Glooko carries the pump's own event and alarm log, but the driver never
requested either. This adds them, so `cage`, `sage` and `iage` populate from the
pump's own record instead of needing site and sensor changes logged by hand in
careportal.

## Collections added

`/api/v2/pumps/events` and `/api/v2/pumps/alarms`, neither previously fetched,
plus a wide-window fetch of `/api/v2/pumps/scheduled_basals`, which was fetched
but always returned empty.

| Glooko `type` | Nightscout eventType | feeds |
|---|---|---|
| `pod_activating` | `Site Change` | CAGE |
| `cgm_sensor_change` | `Sensor Start` | SAGE |
| `reservoir_change` | `Insulin Change` | IAGE |

Alarms become `Note`, never `Announcement`, so they draw on the graph without
Nightscout raising notifications - this is a record, not an alerting system.
Glooko leaves `alarm_type` null; the machine-readable code is in `value`.

Event types with no Nightscout equivalent (`prime_cannula`, `prime_tubing`,
`pod_deactivated`, `pod_discarded`) are dropped. They are never stored, so they
never enter the guid set and are re-examined each cycle - log noise rather than
a correctness problem, but worth knowing.

## Two things that are easy to get wrong

**These endpoints need their own query window.** The shared `params` object pins
`lastUpdatedAt` near now and collapses `limit`. Against these collections that
returns an empty array, which is indistinguishable from "no data" - which is why
`scheduled_basals` looked broken rather than unfetched.

**Field naming is not consistent across Glooko's endpoints.** `pumps/events` and
`pumps/scheduled_basals` return `pumpTimestamp`; `pumps/alarms` returns
`pump_timestamp`. Both spellings are handled where they occur.

Treatments use `eventTime`, not `created_at`: Nightscout derives `mills` only
from the former, and clients need `mills` to age a treatment.

## Deduplication

Events are deduplicated on Glooko's own `guid`, not on a timestamp. Glooko's
sync lag is around 40 minutes, so an event can arrive after a bolus that
happened later than it did; against a time cursor it is already behind the mark
and is dropped permanently, which is a poor property for a pod change.

Each treatment carries `glookoGuid`. The output layer seeds the known set from a
45-day window at startup and adds to it as it posts, so a restart does not
re-import the whole window. `bookmark.seenGuids` is only created when a source
actually supplies guids, so the persisted bookmark shape is unchanged for
sources that do not.

**Boluses must carry their guid too.** They were the one collection without one,
so the filter could never match a bolus and the wide fetch re-offered every
bolus in the window on every cycle. Identical re-posts collapsed in Nightscout,
which hid it - until the event type started being derived from `carbsInput` and
the same carb-free bolus landed a second time as a `Correction Bolus` beside the
`Meal Bolus` it had been stored as before. Insulin on board then counts it twice.

## devicestatus

The IOB record is derived from the newest bolus in the fetch window, so the same
one is produced on every poll until a newer bolus arrives, and Nightscout does
not deduplicate devicestatus. Records not strictly newer than
`bookmark.devicestatus` - which upstream already seeds and refreshes - are now
skipped.

## Not included here

- **Timestamp conversion** is left exactly as upstream does it, a fixed offset.
  DST-correct conversion is #58's subject and belongs there.
- **Food import and carb-gap flagging** are held back. They are implemented but
  unexercised: the account they were written against logs no food, so the code
  path runs with no input.
