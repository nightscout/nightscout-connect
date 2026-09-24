'use strict';

const { createHash } = require('node:crypto');
const { timestampWithOffset } = require('./timezone');
const { MODE_SERIES, CGM_SERIES } = require('./sync');
const { mapStateNotes, OP5_MODE_SERIES } = require('./pump-state');

const DEVICE = 'nightscout-connect-glooko';
const numeric = (value) =>
  (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) &&
  Number.isFinite(Number(value))
    ? Number(value)
    : null;
const active = (row) => row && !row.softDeleted && !row.soft_deleted && !row.duplicate;
const rawTime = (row) =>
  row.pumpTimestamp ||
  row.pump_timestamp ||
  row.displayTime ||
  row.display_time ||
  row.timestamp ||
  row.eventTime ||
  row.event_time ||
  (Number.isFinite(row.x) ? new Date(row.x * 1000).toISOString() : null);

function dateFor(row, opts) {
  const raw = rawTime(row);
  if (!raw || !Number.isFinite(Date.parse(raw))) return null;
  // An explicit non-Z offset is meaningful. Glooko's Z-suffixed pump/display
  // clocks (including graph x) are local wall time, verified across regions.
  return /[+-]\d{2}:?\d{2}$/.test(raw)
    ? new Date(raw)
    : timestampWithOffset(raw, opts.glookoTimezoneOffset, opts.glookoTimezone);
}

function identifier(kind, key, opts) {
  const digest = createHash('sha256')
    .update(JSON.stringify([opts.glookoEmail || '', kind, key]))
    .digest('hex');
  return 'glooko:' + kind + ':' + digest;
}

function direction(value) {
  const key = String(value || '')
    .replace(/[ _-]/g, '')
    .toLowerCase();
  return (
    {
      doubleup: 'DoubleUp',
      singleup: 'SingleUp',
      fortyfiveup: 'FortyFiveUp',
      flat: 'Flat',
      fortyfivedown: 'FortyFiveDown',
      singledown: 'SingleDown',
      doubledown: 'DoubleDown',
      notcomputable: 'NOT COMPUTABLE',
      rateoutofrange: 'RATE OUT OF RANGE'
    }[key] || 'NONE'
  );
}

function transform(batch, opts) {
  const entries = [],
    treatments = [],
    warnings = {};
  const warn = (code) => {
    warnings[code] = (warnings[code] || 0) + 1;
  };
  const each = (key, fn) =>
    (batch[key] || []).filter(active).forEach((row) => {
      const date = dateFor(row, opts);
      if (!date || !Number.isFinite(date.getTime())) {
        warn(key + '_invalid_timestamp');
        return;
      }
      fn(row, date);
    });
  function treatment(kind, row, date, fields) {
    const key = row.guid || row.id || row._id || [rawTime(row), row.type || row.value || ''];
    const out = {
      identifier: identifier(kind, key, opts),
      eventTime: date.toISOString(),
      created_at: date.toISOString(),
      enteredBy: DEVICE,
      ...fields
    };
    if (row.guid) out.glookoGuid = row.guid;
    out.glookoSource = kind;
    treatments.push(out);
    return out;
  }
  function glucose(row, date, value) {
    if (row.calculated || !(value > 0) || !Number.isFinite(value)) return;
    entries.push({
      identifier: identifier('sgv', new Date(rawTime(row)).toISOString(), opts),
      type: 'sgv',
      device: DEVICE,
      date: date.getTime(),
      dateString: date.toISOString(),
      sgv: Math.round(value),
      direction: direction(row.trendArrow || row.trend)
    });
  }
  if (!opts.glookoSkipEntries) {
    each('egvs', (row, date) => {
      if (row.calculated) return;
      const value = numeric(row.glucoseValue);
      if (!(value > 0)) {
        warn('egvs_invalid_glucose');
        return;
      }
      glucose(row, date, value / 100);
    });
    if (!entries.length) {
      const profile =
        (batch.userProfile &&
          (batch.userProfile.currentUser || batch.userProfile.currentPatient)) ||
        {};
      const units = profile.meterUnits || profile.meter_units;
      for (const name of CGM_SERIES) {
        for (const row of [...(batch.v3Graph?.series[name] || []), ...(batch.cgmHistoryGraph?.series[name] || [])]) {
          if (!active(row) || row.calculated) continue;
          const date = dateFor(row, opts);
          const raw = numeric(row.value);
          const display = numeric(row.y);
          const value =
            raw !== null
              ? raw / 100
              : /^mmol/i.test(units || '')
                ? display * 18.0143
                : /mg/i.test(units || '')
                  ? display
                  : null;
          if (date && value !== null) glucose(row, date, value);
          else warn('graph_glucose_missing_time_or_units');
        }
      }
    }
  }
  each('meterReadings', (row, date) => {
    const value = numeric(row.value);
    if (value > 0)
      treatment('meter', row, date, {
        eventType: 'BG Check',
        glucose: value / 100,
        glucoseType: 'Finger',
        units: 'mg/dl'
      });
  });
  const extendedIds = new Set(
    (batch.extendedBoluses || [])
      .filter(active)
      .map((r) => r.guid)
      .filter(Boolean)
  );
  each('normalBoluses', (row, date) => {
    if (row.guid && extendedIds.has(row.guid)) return;
    const insulin = numeric(row.insulinDelivered),
      carbs = numeric(row.carbsInput);
    if (!(insulin > 0) && !(carbs > 0)) return;
    treatment('bolus', row, date, {
      eventType: insulin > 0 ? (carbs > 0 ? 'Meal Bolus' : 'Correction Bolus') : 'Carb Correction',
      ...(insulin > 0 ? { insulin } : {}),
      ...(carbs > 0 ? { carbs } : {})
    });
  });
  each('extendedBoluses', (row, date) => {
    const initial = numeric(row.initialDelivery),
      extended = numeric(row.extendedDelivery);
    const delivered = numeric(row.insulinDelivered);
    const duration = numeric(row.extendedBolusDuration);
    const factor = { seconds: 1 / 60, minutes: 1 }[opts.glookoExtendedBolusDurationUnit];
    // The upstream reference explicitly calls this unit unverified. Preserve
    // the dose as a visible note until the user selects the confirmed unit.
    if (
      !factor ||
      !(duration > 0) ||
      initial === null ||
      extended === null ||
      initial < 0 ||
      extended < 0 ||
      !(initial + extended > 0) ||
      (delivered !== null && Math.abs(delivered - initial - extended) > 0.01)
    ) {
      warn('extended_bolus_requires_verified_delivery');
      treatment('extended-bolus', row, date, {
        eventType: 'Note',
        notes:
          'Glooko extended bolus: ' +
          (delivered === null ? 'unknown delivered dose' : delivered + ' U delivered') +
          '; delivery duration requires verification.',
        glookoExtendedBolus: { delivered, initial, extended, duration }
      });
      return;
    }
    const total = initial + extended,
      minutes = duration * factor;
    treatment('extended-bolus', row, date, {
      eventType: 'Combo Bolus',
      insulin: initial,
      enteredinsulin: total,
      relative: (extended * 60) / minutes,
      duration: minutes,
      splitNow: (100 * initial) / total,
      splitExt: (100 * extended) / total,
      ...(numeric(row.carbsInput) > 0 ? { carbs: Number(row.carbsInput) } : {})
    });
  });

  // Keep actual delivery available to Nightscout's existing basal renderer.
  // Its storage schema has no separate delivered-basal collection. Provenance
  // is retained instead of falsely claiming every segment was a manual temp.
  for (const [key, kind, label] of [
    ['scheduledBasals', 'delivered', 'Delivered basal'],
    ['temporaryBasals', 'temporary', 'Temporary basal'],
    ['suspendBasals', 'suspended', 'Insulin delivery suspended']
  ])
    each(key, (row, date) => {
      const rate = key === 'suspendBasals' ? 0 : numeric(row.rate),
        seconds = numeric(row.duration);
      if (rate === null || rate < 0 || !(seconds > 0)) {
        warn('basal_invalid_rate_or_duration');
        return;
      }
      treatment('basal-' + kind, row, date, {
        eventType: 'Temp Basal',
        absolute: rate,
        rate,
        duration: seconds / 60,
        glookoBasalType: kind,
        notes: 'Glooko: ' + label
      });
    });

  // Use source identity, not a 46-minute proximity guess, to associate food
  // with insulin. Proximity matching can duplicate one dose across many foods.
  each('foods', (row, date) => {
    const carbs = numeric(row.carbs) > 0 ? Number(row.carbs) : numeric(row.carbohydrateGrams);
    if (!(carbs > 0)) return;
    const t = treatment('food', row, date, { eventType: 'Carb Correction', carbs });
    if (row.name || row.description) t.notes = String(row.name || row.description);
    for (const field of ['fat', 'protein', 'calories'])
      if (numeric(row[field]) !== null) t[field] = Number(row[field]);
    t.glookoFood = Object.fromEntries(
      ['mealGuid', 'servingQuantity', 'servingUnit', 'numberOfServings', 'brand']
        .filter((field) => row[field] !== undefined && row[field] !== null)
        .map((field) => [field, row[field]])
    );
  });
  each('carbsEvents', (row, date) => {
    const carbs = numeric(row.carbs);
    if (carbs > 0) treatment('carbs', row, date, { eventType: 'Carb Correction', carbs });
  });
  function injection(row, date, kind, insulin, rapid) {
    if (!(insulin > 0)) return;
    if (rapid)
      treatment(kind, row, date, {
        eventType: 'Correction Bolus',
        insulin,
        notes: row.name ? String(row.name) : 'Glooko rapid-acting injection'
      });
    else
      treatment(kind, row, date, {
        eventType: 'Note',
        notes:
          'Glooko injection: ' +
          insulin +
          ' U (' +
          (row.name || row.insulin_type || 'basal insulin') +
          ')',
        glookoInsulin: { units: insulin, type: row.insulin_type || 'basal', name: row.name || null }
      });
  }
  each('injectionBoluses', (row, date) =>
    injection(row, date, 'injection-bolus', numeric(row.insulinDelivered), true)
  );
  each('injectionBasals', (row, date) =>
    injection(row, date, 'injection-basal', numeric(row.insulinDelivered), false)
  );
  each('insulinEvents', (row, date) =>
    injection(
      row,
      date,
      'insulin-event',
      numeric(row.insulin),
      ['fast_acting', 'rapid', 'rapid_acting', 'short_acting'].includes(row.insulin_type)
    )
  );

  const events = {
    pod_activating: 'Site Change',
    pod_activated: 'Site Change',
    pod_change: 'Site Change',
    set_site_change: 'Site Change',
    site_change: 'Site Change',
    infusion_set_change: 'Site Change',
    cannula_change: 'Site Change',
    reservoir_change: 'Insulin Change',
    insulin_change: 'Insulin Change',
    cgm_sensor_change: 'Sensor Start',
    battery_change: 'Pump Battery Change',
    pump_battery_change: 'Pump Battery Change'
  };
  each('pumpEvents', (row, date) =>
    treatment('pump-event', row, date, {
      eventType: events[row.type] || 'Note',
      notes: 'Glooko: ' + String(row.type || 'pump event').replace(/_/g, ' ')
    })
  );
  each('pumpAlarms', (row, date) => {
    if (!row.value) return;
    const alarm = require('./alarm-labels').describe(row.value);
    treatment('alarm', row, date, {
      eventType: 'Note',
      notes: 'Glooko: ' + alarm.label,
      glookoAlarm: {
        code: row.value,
        severity: row.alarm_severity || 'alert',
        device: alarm.device
      }
    });
  });
  each('notes', (row, date) => {
    if (row.value) treatment('note', row, date, { eventType: 'Note', notes: String(row.value) });
  });
  for (const key of ['exercises', 'exerciseEvents'])
    each(key, (row, date) => {
      const duration = numeric(row.duration);
      if (!(duration > 0)) return;
      treatment(key, row, date, {
        eventType: 'Exercise',
        duration: key === 'exercises' ? duration / 60 : duration,
        notes: [
          row.name || 'Glooko exercise',
          row.intensity == null ? '' : 'intensity: ' + row.intensity
        ]
          .filter(Boolean)
          .join('; ')
      });
    });
  const pumpStates = mapStateNotes(batch, opts, { dateFor, identifier });
  if (pumpStates) treatments.push(...pumpStates.notes);
  for (const name of MODE_SERIES) {
    if (pumpStates && OP5_MODE_SERIES.includes(name)) continue;
    for (const row of (batch.v3Graph && batch.v3Graph.series[name]) || []) {
      const date = dateFor(row, opts);
      if (!active(row) || !date || row.interpolated) continue;
      treatment('mode-' + name, row, date, {
        eventType: 'Note',
        notes:
          'Glooko pump mode: ' +
          name
            .replace(/^pump/, '')
            .replace(/Mode$/, '')
            .replace(/([a-z])([A-Z])/g, '$1 $2'),
        ...(numeric(row.duration) > 0 ? { duration: Number(row.duration) / 60 } : {})
      });
    }
  }
  const unique = (rows) => [...new Map(rows.map((row) => [row.identifier, row])).values()];
  const out = {
    entries: unique(entries).sort((a, b) => a.date - b.date),
    treatments: unique(treatments).sort(
      (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)
    ),
    glookoSync: { cursors: batch.glookoCursors, warnings,
      ...(batch.glookoSyncState ? { state: batch.glookoSyncState } : {}),
      ...(pumpStates?.reconcile ? { pumpStateWindow: pumpStates.reconcile } : {}) }
  };
  // A pump IOB field is a timestamped snapshot, never a value stamped "now".
  const boluses = (batch.normalBoluses || [])
    .filter(active)
    .filter((r) => numeric(r.insulinOnBoard) !== null && Number(r.insulinOnBoard) >= 0)
    .map((r) => ({ row: r, date: dateFor(r, opts) }))
    .filter((r) => r.date)
    .sort((a, b) => b.date - a.date);
  if (boluses.length) {
    const latest = boluses[0],
      stamp = latest.date.toISOString();
    out.devicestatus = [
      {
        device: DEVICE,
        created_at: stamp,
        pump: { clock: stamp, iob: { iob: Number(latest.row.insulinOnBoard), timestamp: stamp } }
      }
    ];
  }
  if (opts.glookoImportProfile)
    out.profiles = require('./profile').mapProfiles(batch.settings || [], opts);
  return out;
}

module.exports = { transform, dateFor, identifier, direction, numeric, active };
