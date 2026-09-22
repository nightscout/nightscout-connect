'use strict';

// Unit/field contracts adapted from Nocturne's GlookoSettingsProfileMapper.
const { active, dateFor, identifier, numeric } = require('./map');

function schedule(rows, value, allowZero = false) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const out = rows
    .map((row) => ({ start: numeric(row.start), value: numeric(value(row)) }))
    .sort((a, b) => a.start - b.start);
  if (
    out[0].start !== 0 ||
    out.some(
      (r, i) =>
        r.start === null ||
        r.start < 0 ||
        r.start >= 86400 ||
        r.start % 60 ||
        r.value === null ||
        (allowZero ? r.value < 0 : r.value <= 0) ||
        (i && r.start === out[i - 1].start)
    )
  )
    return null;
  return out.map((r) => ({
    time:
      String(Math.floor(r.start / 3600)).padStart(2, '0') +
      ':' +
      String((r.start / 60) % 60).padStart(2, '0'),
    timeAsSeconds: r.start,
    value: r.value
  }));
}

function mapProfiles(records, opts) {
  if (!opts.glookoTimezone) return []; // Never invent a profile timezone.
  const rows = records
    .filter(active)
    .map((row) => ({ row, date: dateFor(row, opts) }))
    .filter((r) => r.date)
    .sort((a, b) => b.date - a.date);
  if (!rows.length) return [];
  const { row, date } = rows[0];
  const dia = numeric(row.active_insulin_time);
  if (!(dia > 0)) return [];
  const selected = (programs, flag) => {
    const current = programs.filter((p) => p[flag]);
    return current.length === 1 ? current[0] : programs.length === 1 ? programs[0] : null;
  };
  const basal = selected(row.basal_settings || [], 'is_current');
  const bolus = selected(row.bolus_settings || [], 'current');
  if (!basal || !bolus) return [];
  const values = {
    basal: schedule(basal.segments, (r) => r.rate, true),
    sens: schedule(bolus.isf_segments, (r) =>
      numeric(r.insulin_sensitivity_factor) === null
        ? null
        : Number(r.insulin_sensitivity_factor) / 100
    ),
    carbratio: schedule(bolus.insulin_to_carb_ratio_segments, (r) => r.insulin_to_carbs_ratio),
    target_low: schedule(bolus.target_bg_segments, (r) =>
      numeric(r.target_bg_low ?? r.target_bg) === null
        ? null
        : Number(r.target_bg_low ?? r.target_bg) / 100
    ),
    target_high: schedule(bolus.target_bg_segments, (r) =>
      numeric(r.target_bg_high ?? r.target_bg) === null
        ? null
        : Number(r.target_bg_high ?? r.target_bg) / 100
    )
  };
  if (Object.values(values).some((v) => !v)) return []; // Incomplete settings cannot safely replace a profile.
  const data = { ...values, dia: dia / 3600, units: 'mg/dl', timezone: opts.glookoTimezone };
  return [
    {
      identifier: identifier('profile', [row.guid || row.pump_timestamp, data], opts),
      startDate: date.toISOString(),
      created_at: date.toISOString(),
      mills: date.getTime(),
      defaultProfile: 'Glooko',
      units: 'mg/dl',
      enteredBy: 'nightscout-connect-glooko',
      store: { Glooko: data }
    }
  ];
}

module.exports = { mapProfiles, schedule };
