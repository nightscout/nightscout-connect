# LibreLinkUp v4 validation results

Validation date: **22 September 2026**. Implementation tested: `bc41fad`.
PR #73 is ready for review with the limitations below recorded explicitly.
This report contains aggregate results only; credentials, account identifiers,
patient data and private response captures are not published.

## Compatibility correction after review

Automatic timezone-to-region selection was removed from this PR after review
identified that it would send existing Shanghai-timezone accounts from their
working EU-to-DE route to CN. LibreLinkUp now retains the EU starting endpoint
when no region/server is configured, irrespective of shared timezone settings.
Explicit region and server overrides and Abbott's redirects remain supported.
The shared `CONNECT_TIMEZONE` design is deferred to a separate PR covering
compatibility across data sources.

Regression tests reproduce the Shanghai-timezone EU-to-DE login, preserve
explicit CN/US and custom-server settings, and ensure unrelated timezone values
cannot disable LibreLinkUp. The live results below describe the earlier tested
implementation; these routing corrections are additionally verified synthetically.
The full local suite passes **164 tests** after this correction.

## Live glucose and Nightscout validation

Thirteen real accounts were exercised against Abbott's service and a local,
pinned Nightscout installation. **All twelve non-CN regional configurations
passed**, including the redirects returned by Abbott. The thirteenth account
passed through an alternative EU-to-DE route, which does not validate CN.

| Starting region | Observed successful route | Glucose and Nightscout result |
| --- | --- | --- |
| EU2 (UK) | EU2 | Passed |
| EU | EU | Passed |
| US | US | Passed |
| CA | CA → US | Passed after redirect |
| AU | AU | Passed |
| AP | AP → EU2 | Passed after redirect; sensor caveat below |
| AE | AE → EU | Passed after redirect |
| LA | LA | Passed |
| RU | RU | Passed |
| JP | JP | Passed |
| DE | DE | Passed |
| FR | FR | Passed |
| CN | CN rejected; separate EU → DE diagnostic passed | **CN unverified** |

For all thirteen accounts using their working routes, the checks covered:

- Fresh current and historical readings, with an independent comparison of raw
  glucose values, factory timestamps and trend directions against mapped entries.
- Writes through both the real Nightscout REST API and internal storage, followed
  by database readback.
- Replaying batches and restarting outputs/the REST server without duplicate
  glucose timestamps or duplicate Sensor Start treatments.
- A later fetch containing genuinely new readings: both outputs advanced for
  every account while preserving duplicate protection.
- Local Nightscout API readback matching each database's newest reading after
  restarting the UI services.

Three stale local patient selectors were corrected after the source returned
exactly one connection. The connector's strict configured-patient selection was
not relaxed. Multi-patient selection is covered by automated tests; these live
results do not establish live multi-patient coverage.

A redirect validates the observed route, not a fresh feed hosted on the original
region's endpoint. Additional direct AP logins succeeded, but their accounts had
stale or empty feeds. The live regional results above should not be described as
independent fresh-data validation of every native regional backend.

## CN validation gap

The configured endpoint is `https://api-cn.myfreestyle.cn`; automated tests cover
its mapping. **Native CN authentication, glucose retrieval and CN-to-Nightscout
writes remain unverified.**

The expanded production search included connector and older standalone uploader
configurations, running pods and bounded recent logs. Login routing was checked
for 452 distinct accounts on running deployments:

- 401 authenticated successfully through services outside CN.
- 47 accounts rejected on their configured/default route were tried once against
  CN: 46 returned source status 2 without a ticket and one timed out.
- Four accounts had throttling independently visible in earlier production logs
  and were excluded without retrying them.

No working CN account was found. Earlier Shanghai-timezone candidates and an
additional China-associated email-provider candidate authenticated through DE.
Timezone or email provider is therefore insufficient evidence of CN registration.
These results neither prove the endpoint is defective nor prove that no usable
CN account exists. A known-working mainland CN-service account with fresh data
is still required to close this gap.

## Optional sensor metadata

One fresh account, started through AP and redirected to EU2, returned conflicting
connection-sensor, active-sensor and patient-device metadata. Its glucose values
and storage checks passed. The current reading retained the mismatch marker
instead of receiving an uncertain sensor identity.

The newer connection sensor was absent from the active-sensor list and had a
different device ID. Some historical readings occurred after its activation,
without per-reading sensor IDs. A sensor replacement, delayed metadata or
multiple-device overlap could explain this, but the captures do not resolve it.
Sensor Start and device status reflect the supplied connection metadata; this
account's sensor attribution still needs corroboration. This is not established
as an AP endpoint defect. Optional sensor uploads remain off by default.

## Automated checks and review scope

- `npm test`: **162 passed, 0 failed**, rerun before publishing this report.
- GitHub Node 22.23.2 and Node 24.20.0 jobs passed for implementation `bc41fad`,
  including LibreLinkUp checks under London, New York and Tokyo host timezones.
- The real Nightscout storage CI job passed for the same implementation. It uses
  synthetic Abbott responses with real MongoDB, REST and internal storage, and
  embedded-plugin boot/restart checks. CI contains no real account credentials.
- The live tests used the real source and storage paths. An unattended live
  embedded-plugin soak and manual comparison with the official app are not
  claimed complete. Local UI instances contain snapshots rather than continuous
  LibreLinkUp polling.

The changes preserve contributor credit and include no LibreLinkUp v5
implementation. See the [test plan](librelinkup-live-test-plan.md) for reproduction
instructions and PR checks for CI results on subsequent commits.
