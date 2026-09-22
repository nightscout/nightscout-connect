'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { fetchPages, collect, RESOURCES } = require('../lib/sources/glooko/sync');
const { transform, dateFor } = require('../lib/sources/glooko/map');
const { toGlookoTime } = require('../lib/sources/glooko/timezone');
const restOutput = require('../lib/outputs/nightscout');
const internalOutput = require('../lib/outputs/internal');
const stamp = '2026-07-01T12:00:00.000Z';
const opts = { glookoEmail: 'synthetic@example.test', glookoTimezone: 'Europe/Berlin' };
const cursor = { lastGuid: 'start', lastUpdatedAt: stamp, limit: 500 };

test('sync exhausts more than 1,000 records and advances even on its final page', async () => {
  let calls = 0;
  const result = await fetchPages(
    async (path, p) => {
      assert.equal(p.lastGuid, calls ? 'page-' + calls : 'start');
      calls++;
      return {
        rows: Array.from({ length: calls === 3 ? 5 : 500 }, (_, i) => ({ guid: `${calls}-${i}` })),
        lastPage: calls === 3,
        lastGuid: 'page-' + calls,
        lastUpdatedAt: stamp
      };
    },
    '/synthetic',
    'rows',
    cursor
  );
  assert.equal(result.records.length, 1005);
  assert.equal(result.cursor.lastGuid, 'page-3');
});
test('sync rejects malformed, stalled, cyclic and capped pagination without partial success', async () => {
  for (const body of [
    {},
    { rows: [{ guid: 'a' }], lastPage: false },
    { rows: [{ guid: 'a' }], lastPage: false, ...cursor }
  ]) {
    await assert.rejects(
      fetchPages(async () => body, '/synthetic', 'rows', cursor),
      /INVALID_RESPONSE_SHAPE|PAGINATION_STALLED/
    );
  }
  let i = 0;
  await assert.rejects(
    fetchPages(
      async () => ({
        rows: [{ guid: String(i++) }],
        lastPage: false,
        lastGuid: String(i % 2),
        lastUpdatedAt: stamp
      }),
      '/x',
      'rows',
      cursor
    ),
    /PAGINATION_STALLED/
  );
  i = 0;
  await assert.rejects(
    fetchPages(
      async () => ({
        rows: [{ guid: String(i++) }],
        lastPage: false,
        lastGuid: String(i),
        lastUpdatedAt: stamp
      }),
      '/x',
      'rows',
      cursor,
      2
    ),
    /PAGINATION_LIMIT/
  );
});
test('sync uses independent resource cursors and local clinical windows', async () => {
  const calls = [];
  const get = async (path, p) => {
    calls.push({ path, p });
    if (path.includes('/graph/')) return { series: { cgmHigh: [], cgmNormal: [], cgmLow: [] } };
    const [key, , prop] = RESOURCES.find((r) => r[1] === path);
    return { [prop || key]: [], lastPage: true, lastGuid: key, lastUpdatedAt: stamp };
  };
  const result = await collect(
    get,
    { user: { userLogin: { glookoCode: 'synthetic' } } },
    opts,
    { glookoCursors: { normalBoluses: { lastGuid: 'bolus-cursor', lastUpdatedAt: stamp } } },
    new Date(stamp)
  );
  assert.equal(calls.find((c) => c.path.endsWith('normal_boluses')).p.lastGuid, 'bolus-cursor');
  assert.equal(calls.find((c) => c.path.endsWith('egvs')).p.startDate, '2026-06-17T14:00:00.000Z');
  assert.equal(result.glookoCursors.normalBoluses.lastGuid, 'normalBoluses');
  assert.equal(calls.find((c) => c.path.includes('/graph/')).p.endDate, '2026-07-01T14:00:00.000Z');
});
test('timezone conversion covers winter, summer, Australia and explicit offsets', () => {
  for (const [zone, raw, expected] of [
    ['Europe/Berlin', '2026-01-01T12:00:00Z', '2026-01-01T11:00:00.000Z'],
    ['Europe/Berlin', stamp, '2026-07-01T10:00:00.000Z'],
    ['America/New_York', stamp, '2026-07-01T16:00:00.000Z'],
    ['Australia/Sydney', '2026-01-01T12:00:00Z', '2026-01-01T01:00:00.000Z']
  ]) {
    const date = dateFor({ timestamp: raw }, { glookoTimezone: zone });
    assert.equal(date.toISOString(), expected);
    assert.equal(toGlookoTime(date, 0, zone).toISOString(), new Date(raw).toISOString());
  }
  assert.equal(
    dateFor({ timestamp: '2026-07-01T12:00:00+02:00' }, opts).toISOString(),
    '2026-07-01T10:00:00.000Z'
  );
  assert.equal(dateFor({ timestamp: 'broken' }, opts), null);
});
test('CGM values, trend, calculated/deleted filtering and fallback identity are consistent', () => {
  const row = { guid: 'egv', displayTime: stamp, glucoseValue: 17601, trendArrow: 'SINGLE_UP' };
  const a = transform(
    {
      egvs: [
        row,
        { ...row, guid: 'calc', calculated: true },
        { ...row, guid: 'del', softDeleted: true }
      ]
    },
    opts
  );
  assert.equal(a.entries.length, 1);
  assert.equal(a.entries[0].sgv, 176);
  assert.equal(a.entries[0].direction, 'SingleUp');
  assert.equal(a.entries[0].dateString, '2026-07-01T10:00:00.000Z');
  const b = transform(
    {
      v3Graph: { series: { cgmNormal: [{ x: Date.parse(stamp) / 1000, value: 17601, y: 9.77 }] } }
    },
    opts
  );
  assert.equal(b.entries[0].identifier, a.entries[0].identifier);
  assert.equal(b.entries[0].date, a.entries[0].date);
  assert.equal(b.entries[0].direction, 'NONE');
  assert.equal(transform({ egvs: [row] }, { ...opts, glookoSkipEntries: true }).entries.length, 0);
});
test('graph display values require known units and accept mmol spellings', () => {
  for (const units of ['mmol', 'mmoll', 'mmol/L']) {
    const out = transform(
      {
        v3Graph: { series: { cgmNormal: [{ timestamp: stamp, y: 5.5 }] } },
        userProfile: { currentUser: { meterUnits: units } }
      },
      opts
    );
    assert.equal(out.entries[0].sgv, 99);
  }
  assert.equal(
    transform({ v3Graph: { series: { cgmNormal: [{ timestamp: stamp, y: 5.5 }] } } }, opts).entries
      .length,
    0
  );
});
test('treatments preserve delivery, separate carb-only events, meter units and zero basal', () => {
  const out = transform(
    {
      normalBoluses: [
        { guid: 'meal', pumpTimestamp: stamp, insulinDelivered: 2, carbsInput: 20 },
        { guid: 'carb', pumpTimestamp: stamp, insulinDelivered: 0, carbsInput: 10 },
        { guid: 'bad', pumpTimestamp: 'invalid', insulinDelivered: 2 }
      ],
      meterReadings: [{ guid: 'meter', timestamp: stamp, value: 12050 }],
      scheduledBasals: [{ guid: 'base', pumpTimestamp: stamp, rate: 0, duration: 125 }],
      injectionBasals: [
        { guid: 'long', pumpTimestamp: stamp, insulinDelivered: 15, name: 'Long acting' }
      ]
    },
    opts
  );
  const find = (guid) => out.treatments.find((t) => t.glookoGuid === guid);
  assert.equal(find('meal').insulin, 2);
  assert.equal(find('meal').carbs, 20);
  assert.equal(find('carb').eventType, 'Carb Correction');
  assert.equal(find('carb').insulin, undefined);
  assert.equal(find('meter').glucose, 120.5);
  assert.equal(find('meter').units, 'mg/dl');
  assert.equal(find('base').absolute, 0);
  assert.equal(find('base').duration, 125 / 60);
  assert.equal(find('long').eventType, 'Note');
  assert.equal(find('long').insulin, undefined);
  assert.equal(find('long').glookoInsulin.units, 15);
  assert.equal(find('bad'), undefined);
});
test('extended boluses require known units and produce Nightscout split delivery fields', () => {
  const batch = {
    extendedBoluses: [
      {
        guid: 'ext',
        pumpTimestamp: stamp,
        initialDelivery: 1,
        extendedDelivery: 2,
        insulinDelivered: 3,
        extendedBolusDuration: 1800
      }
    ]
  };
  assert.equal(transform(batch, opts).treatments[0].eventType, 'Note');
  const t = transform(batch, { ...opts, glookoExtendedBolusDurationUnit: 'seconds' }).treatments[0];
  assert.equal(t.eventType, 'Combo Bolus');
  assert.equal(t.insulin, 1);
  assert.equal(t.enteredinsulin, 3);
  assert.equal(t.relative, 4);
  assert.equal(t.duration, 30);
});
test('edits retain stable identifiers and clinical timestamp is never replaced by updatedAt', () => {
  const row = { guid: 'same', pumpTimestamp: stamp, insulinDelivered: 1 };
  const a = transform({ normalBoluses: [row] }, opts).treatments[0];
  const b = transform({ normalBoluses: [{ ...row, insulinDelivered: 2 }] }, opts).treatments[0];
  assert.equal(a.identifier, b.identifier);
  assert.notEqual(a.insulin, b.insulin);
  assert.equal(
    transform({ normalBoluses: [{ guid: 'x', updatedAt: stamp, insulinDelivered: 2 }] }, opts)
      .treatments.length,
    0
  );
});
test('REST write failures reject and never acknowledge source cursors', async () => {
  const output = restOutput(
    { url: 'http://localhost', apiSecret: 'synthetic' },
    {
      create: () => ({
        post: async () => {
          throw Object.assign(new Error('secret payload'), { response: { status: 500 } });
        }
      })
    }
  );
  await assert.rejects(
    output({ entries: [{ dateString: stamp }], glookoSync: { cursors: { egvs: cursor } } }),
    (e) => e.message === 'Nightscout write failed' && e.status === 500
  );
  assert.equal((await output({})).glookoCursors, undefined);
});
test('internal treatment-only writes complete and failures retain previous cursors', async () => {
  let fail = false;
  const ctx = { bus: new EventEmitter() };
  for (const key of ['entries', 'treatments', 'devicestatus', 'profile'])
    ctx[key] = { create: (rows, cb) => cb(fail ? new Error('write failed') : null, rows) };
  const output = internalOutput({}, ctx);
  const first = await output({
    treatments: [{ created_at: stamp }],
    glookoSync: { cursors: { normalBoluses: cursor } }
  });
  assert.equal(first.glookoCursors.normalBoluses.lastGuid, 'start');
  fail = true;
  await assert.rejects(
    output({
      treatments: [{ created_at: stamp }],
      glookoSync: { cursors: { normalBoluses: { lastGuid: 'wrong' } } }
    }),
    /write failed/
  );
  assert.equal((await output.gap_for()).glookoCursors.normalBoluses.lastGuid, 'start');
});

test('profile import preserves pump units and rejects incomplete settings', () => {
  const { mapProfiles } = require('../lib/sources/glooko/profile');
  const settings = {
    guid: 'profile',
    pump_timestamp: stamp,
    active_insulin_time: 14400,
    basal_settings: [
      {
        is_current: true,
        segments: [
          { start: 0, rate: 0.7 },
          { start: 21600, rate: 0.9 }
        ]
      }
    ],
    bolus_settings: [
      {
        current: true,
        isf_segments: [{ start: 0, insulin_sensitivity_factor: 5000 }],
        insulin_to_carb_ratio_segments: [{ start: 0, insulin_to_carbs_ratio: 10 }],
        target_bg_segments: [{ start: 0, target_bg_low: 9000, target_bg_high: 11000 }]
      }
    ]
  };
  const [p] = mapProfiles([settings], opts);
  assert.equal(p.store.Glooko.dia, 4);
  assert.equal(p.store.Glooko.sens[0].value, 50);
  assert.equal(p.store.Glooko.basal[1].time, '06:00');
  assert.equal(p.store.Glooko.target_low[0].value, 90);
  assert.equal(p.startDate, '2026-07-01T10:00:00.000Z');
  assert.deepEqual(mapProfiles([{ ...settings, active_insulin_time: null }], opts), []);
  assert.deepEqual(mapProfiles([{ ...settings, bolus_settings: [] }], opts), []);
  assert.deepEqual(mapProfiles([settings], { ...opts, glookoTimezone: undefined }), []);
});
test('exercise units, ordinary notes and pump events keep their Nightscout meanings', () => {
  const out = transform(
    {
      exercises: [{ guid: 'exercise', timestamp: stamp, name: 'Walk', duration: 3600 }],
      exerciseEvents: [{ guid: 'exercise2', display_time: stamp, duration: 30 }],
      notes: [{ guid: 'note', timestamp: stamp, value: 'Synthetic note' }],
      pumpEvents: [
        { guid: 'site', pumpTimestamp: stamp, type: 'pod_activating' },
        { guid: 'unknown', pumpTimestamp: stamp, type: 'unrecognised_event' }
      ],
      pumpAlarms: [
        { guid: 'alarm', pump_timestamp: stamp, value: 'occlusion', alarm_severity: 'hazard' }
      ]
    },
    opts
  );
  const byGuid = Object.fromEntries(out.treatments.map((t) => [t.glookoGuid, t]));
  assert.equal(byGuid.exercise.duration, 60);
  assert.equal(byGuid.exercise2.duration, 30);
  assert.equal(byGuid.site.eventType, 'Site Change');
  assert.equal(byGuid.unknown.eventType, 'Note');
  assert.equal(byGuid.alarm.eventType, 'Note');
  assert.equal(byGuid.alarm.glookoAlarm.severity, 'hazard');
  assert.equal(byGuid.note.notes, 'Synthetic note');
});
test('unavailable optional feeds are reported but HTTP errors and changed schemas fail sync', async () => {
  const session = { user: { userLogin: { glookoCode: 'synthetic' } } };
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(
      collect(
        async () => {
          throw Object.assign(new Error('synthetic'), { response: { status } });
        },
        session,
        opts,
        {}
      ),
      (e) => e.response.status === status
    );
  }
  const result = await collect(
    async (path) => {
      if (path.includes('/graph/'))
        return { series: { cgmHigh: [], cgmLow: [], cgmNormal: [{ timestamp: stamp, value: 12000 }] } };
      throw Object.assign(new Error('unavailable'), { response: { status: 404 } });
    },
    session,
    opts,
    {}
  );
  assert.equal(result.diagnostics.egvs.unavailable, 404);
  assert.equal(transform(result, opts).entries.length, 1);
  await assert.rejects(
    collect(async () => ({ unexpected: [] }), session, opts, {}),
    /INVALID_RESPONSE_SHAPE/
  );
});
test('credentials and cookies are absent from propagated Glooko transport errors', async () => {
  const glooko = require('../lib/sources/glooko');
  const source = glooko(
    {
      baseURL: 'https://example.test',
      glookoEmail: 'hidden@example.test',
      glookoPassword: 'hidden-password'
    },
    {
      create: () => ({
        post: async () => {
          throw Object.assign(new Error('hidden-password'), {
            isAxiosError: true,
            config: { headers: { Cookie: 'hidden-cookie' } },
            response: { status: 401, data: { secret: 'hidden-body' } }
          });
        }
      })
    }
  );
  await assert.rejects(source.authFromCredentials(), (e) => {
    assert.equal(e.response.status, 401);
    assert.equal(e.message, 'Glooko request failed');
    assert.doesNotMatch(JSON.stringify(e), /hidden/);
    return true;
  });
});
test('a real .env matrix is parsed without requiring uncommenting credentials', () => {
  const { accountsFrom } = require('../scripts/glooko-live-matrix');
  const rows = accountsFrom(
    'CONNECT_SOURCE=glooko\n\nCONNECT_GLOOKO_EMAIL=first@example.test\nCONNECT_GLOOKO_PASSWORD="a#b"\n\n# CONNECT_GLOOKO_EMAIL=second@example.test\n# CONNECT_GLOOKO_PASSWORD="c=d"\n'
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].CONNECT_GLOOKO_PASSWORD, 'a#b');
  assert.equal(rows[1].CONNECT_GLOOKO_PASSWORD, 'c=d');
});

test('legacy treatment identities survive upgrades and ambiguous duplicates fail safely', async () => {
  const prepare = require('../lib/outputs/glooko-legacy');
  let calls = 0;
  const migrate = prepare(async (params) => {
    calls++;
    assert.equal(params.find.created_at.$gte, '1970-01-01T00:00:00.000Z');
    return [{ glookoGuid: 'previous', _id: 'old-mongo-id' }];
  });
  const rows = [
    { glookoGuid: 'previous', identifier: 'glooko:bolus:stable', insulin: 3 },
    { glookoGuid: 'new', identifier: 'glooko:bolus:new', insulin: 1 }
  ];
  const out = await migrate(rows);
  assert.equal(out[0]._id, 'old-mongo-id');
  assert.equal(out[0].identifier, undefined);
  assert.equal(out[0].glookoIdentifier, rows[0].identifier);
  assert.equal(out[0].insulin, 3);
  assert.equal(out[1].identifier, rows[1].identifier);
  assert.equal(rows[0].identifier, 'glooko:bolus:stable');
  await migrate(rows);
  assert.equal(calls, 2);
  const ambiguous = prepare(async () => [
    { glookoGuid: 'previous', _id: 'one' },
    { glookoGuid: 'previous', _id: 'two' }
  ]);
  await assert.rejects(ambiguous(rows), /LEGACY_DUPLICATES_REQUIRE_REVIEW/);
});

test('old pump status is deduplicated outside Nightscout default date window', async () => {
  const old = '2020-01-01T00:00:00.000Z';
  let writes = 0;
  const status = { created_at: old, device: 'nightscout-connect-glooko' };
  const http = {
    get: async (path, { params }) => {
      assert.equal(params['find[device]'], status.device);
      assert.equal(params['find[created_at][$gte]'], old);
      return { data: [status] };
    },
    post: async () => {
      writes++;
      return { data: [] };
    }
  };
  await restOutput(
    { url: 'http://localhost', apiSecret: 'synthetic' },
    { create: () => http }
  )({ devicestatus: [status] });
  const ctx = {
    bus: new EventEmitter(),
    devicestatus: {
      list: (params, cb) => {
        assert.equal(params.find.device, status.device);
        assert.equal(params.find.created_at.$gte, old);
        cb(null, [status]);
      },
      create: () => {
        writes++;
      }
    }
  };
  await internalOutput({}, ctx)({ devicestatus: [status] });
  assert.equal(writes, 0);
});

test('corrupt numeric fields are not accepted as clinical values', () => {
  const out = transform(
    {
      egvs: [{ displayTime: stamp, glucoseValue: true }],
      scheduledBasals: [{ guid: 'bad', pumpTimestamp: stamp, rate: false, duration: 60 }]
    },
    opts
  );
  assert.equal(out.entries.length, 0);
  assert.equal(out.treatments.length, 0);
  assert.equal(out.glookoSync.warnings.egvs_invalid_glucose, 1);
  assert.equal(out.glookoSync.warnings.basal_invalid_rate_or_duration, 1);
});

test('DST transitions preserve unambiguous clinical instants on both sides', () => {
  for (const [raw, utc] of [
    ['2026-03-29T01:55:00Z', '2026-03-29T00:55:00.000Z'],
    ['2026-03-29T03:05:00Z', '2026-03-29T01:05:00.000Z'],
    ['2026-10-25T01:55:00Z', '2026-10-24T23:55:00.000Z'],
    ['2026-10-25T03:05:00Z', '2026-10-25T02:05:00.000Z']
  ]) {
    assert.equal(dateFor({ timestamp: raw }, opts).toISOString(), utc);
  }
});

test('internal persistence errors never expose a failed medical document', async () => {
  const ctx = {
    bus: new EventEmitter(),
    entries: {
      create: (rows, cb) =>
        cb(
          Object.assign(new Error('private-value'), {
            writeErrors: [{ private: 'private-value' }],
            code: 11000
          })
        )
    }
  };
  await assert.rejects(internalOutput({}, ctx)({ entries: [{}] }), (error) => {
    assert.equal(error.message, 'Nightscout internal write failed');
    assert.equal(error.code, 11000);
    assert.doesNotMatch(JSON.stringify(error), /private/);
    return true;
  });
});

test('automatic authentication prefers JSON v3 and does not retry invalid credentials', async () => {
  const sourceFactory = require('../lib/sources/glooko');
  for (const status of [422, 401, 403]) {
    const calls = [];
    const source = sourceFactory(
      { baseURL: 'https://example.test', glookoAuthMode: 'auto' },
      {
        create: () => ({
          post: async (path) => {
            calls.push(path);
            if (path === '/api/v2/users/sign_in')
              throw Object.assign(new Error('synthetic'), { response: { status } });
            assert.equal(path, '/api/v3/users/sign_in');
            return {
              headers: { 'set-cookie': ['_logbook-web_session=synthetic; path=/'] },
              data: {}
            };
          }
        })
      }
    );
    if (status === 422) {
      assert.equal((await source.authFromCredentials()).cookies, '_logbook-web_session=synthetic');
      assert.equal(calls.length, 2);
    } else {
      await assert.rejects(source.authFromCredentials(), (e) => e.response.status === status);
      assert.equal(calls.length, 1);
    }
  }
});

test('food nutrition is preserved without pairing nearby foods to the same dose', () => {
  const out = transform(
    {
      foods: [
        {
          guid: 'f1',
          timestamp: stamp,
          carbs: 0,
          carbohydrateGrams: 12,
          protein: 2,
          fat: 3,
          calories: 100,
          name: 'Synthetic snack',
          servingUnit: 'g',
          servingQuantity: 40,
          mealGuid: 'meal'
        },
        { guid: 'f2', timestamp: stamp, carbs: 8 }
      ],
      injectionBoluses: [{ guid: 'i', pumpTimestamp: stamp, insulinDelivered: 2 }]
    },
    opts
  );
  assert.equal(out.treatments.length, 3);
  assert.equal(out.treatments.filter((t) => t.insulin).length, 1);
  const food = out.treatments.find((t) => t.glookoGuid === 'f1');
  assert.equal(food.carbs, 12);
  assert.equal(food.fat, 3);
  assert.equal(food.protein, 2);
  assert.equal(food.glookoFood.mealGuid, 'meal');
  assert.equal(food.glookoFood.servingQuantity, 40);
});

test('sync mode defaults and unsafe configuration are validated', () => {
  const validate = require('../lib/sources/glooko').validate;
  const base = { glookoEmail: 'synthetic@example.test', glookoPassword: 'synthetic' };
  const valid = validate(base);
  assert.equal(valid.ok, true);
  assert.equal(valid.config.glookoDataMode, 'sync');
  assert.equal(valid.config.glookoImportProfile, false);
  for (const extra of [
    { glookoDataMode: 'unknown' },
    { glookoLookbackDays: 91 },
    { glookoExtendedBolusDurationUnit: 'guess' }
  ])
    assert.equal(validate({ ...base, ...extra }).ok, false);
});
