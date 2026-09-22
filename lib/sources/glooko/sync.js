'use strict';

// Glooko mobile sync envelopes and resource names are also documented by
// nightscout/nocturne's GlookoSsv2Models and GlookoConnectorService (AGPL-3.0).
// Keep transport separate from the Nightscout mapping so recorded synthetic
// contracts can exercise both without credentials or a running destination.
const { toGlookoTime } = require('./timezone');
const { DELIVERY_SERIES } = require('./pump-state');
const { createHash } = require('node:crypto');

const RESOURCES = [
  ['egvs', '/api/v2/cgm/egvs'],
  ['normalBoluses', '/api/v2/pumps/normal_boluses'],
  ['scheduledBasals', '/api/v2/pumps/scheduled_basals'],
  ['temporaryBasals', '/api/v2/pumps/temporary_basals'],
  ['suspendBasals', '/api/v2/pumps/suspend_basals'],
  ['meterReadings', '/api/v2/readings', 'readings'],
  ['foods', '/api/v2/foods'],
  ['injectionBoluses', '/api/v2/pumps/injection_boluses'],
  ['injectionBasals', '/api/v2/pumps/injection_basals'],
  ['carbsEvents', '/api/v2/cgm/carbs_events'],
  ['insulinEvents', '/api/v2/cgm/insulin_events'],
  ['extendedBoluses', '/api/v2/pumps/extended_boluses'],
  ['pumpEvents', '/api/v2/pumps/events', 'events'],
  ['pumpAlarms', '/api/v2/pumps/alarms', 'alarms'],
  ['notes', '/api/v2/notes'],
  ['exercises', '/api/v2/exercises'],
  ['exerciseEvents', '/api/v2/cgm/exercise_events']
];
const MODE_SERIES = [
  'pumpCamapsAutomaticMode',
  'pumpCamapsManualMode',
  'pumpCamapsBoostMode',
  'pumpCamapsEaseOffMode',
  'pumpControliqAutomaticMode',
  'pumpControliqManualMode',
  'pumpControliqSleepMode',
  'pumpControliqExerciseMode',
  'pumpOp5AutomaticMode',
  'pumpOp5ManualMode',
  'pumpOp5LimitedMode',
  'pumpOp5HypoprotectMode',
  'pumpBasaliqAutomaticMode',
  'pumpBasaliqManualMode',
  'pumpGenericAutomaticMode',
  'pumpGenericManualMode'
];
const CGM_SERIES = ['cgmHigh', 'cgmNormal', 'cgmLow'];

function syncError(code, resource) {
  const error = new Error('Glooko ' + code + ' (' + resource + ')');
  error.code = code;
  return error;
}

async function fetchPages(
  get,
  path,
  property,
  params,
  maxPages = 200,
  yieldOnLimit = false
) {
  const records = new Map();
  let cursor = {
    lastUpdatedAt: params.lastUpdatedAt,
    lastGuid: params.lastGuid
  };
  const seenCursors = new Set();
  for (let page = 0; page < maxPages; page++) {
    const data = await get(path, { ...params, ...cursor });
    if (!data || !Array.isArray(data[property]))
      throw syncError('INVALID_RESPONSE_SHAPE', property);
    const batch = data[property];
    for (const row of batch) {
      if (!row || typeof row !== 'object')
        throw syncError('INVALID_RECORD_SHAPE', property);
      records.set(row.guid || row._id || JSON.stringify(row), row);
    }
    if (data.lastPage === true || (!batch.length && data.lastPage !== false)) {
      return {
        records: [...records.values()],
        cursor: {
          lastUpdatedAt: data.lastUpdatedAt || cursor.lastUpdatedAt,
          lastGuid: data.lastGuid || cursor.lastGuid
        },
        pages: page + 1,
        complete: true
      };
    }
    // Never silently accept a full legacy response as a complete sync page.
    if (data.lastPage === undefined && batch.length < params.limit) {
      return {
        records: [...records.values()],
        cursor,
        pages: page + 1,
        complete: true
      };
    }
    const next = { lastUpdatedAt: data.lastUpdatedAt, lastGuid: data.lastGuid };
    const key = JSON.stringify(next);
    if (
      !next.lastUpdatedAt ||
      !next.lastGuid ||
      key === JSON.stringify(cursor) ||
      seenCursors.has(key)
    ) {
      throw syncError('PAGINATION_STALLED', property);
    }
    seenCursors.add(key);
    cursor = next;
  }
  if (yieldOnLimit)
    return {
      records: [...records.values()],
      cursor,
      pages: maxPages,
      complete: false
    };
  throw syncError('PAGINATION_LIMIT', property);
}

async function collect(get, session, opts, bookmark, now = new Date()) {
  const days = opts.glookoLookbackDays || 14;
  const floor = new Date(now.getTime() - days * 86400000);
  const graphFloor = new Date(now.getTime() - Math.min(days, 2) * 86400000);
  const owner = createHash('sha256')
    .update(
      JSON.stringify([
        opts.glookoEmail,
        opts.baseURL,
        opts.glookoTimezone,
        opts.glookoTimezoneOffset
      ])
    )
    .digest('hex');
  const saved = bookmark?.glookoSyncStates?.[owner];
  const cursors =
    saved?.cursors || (!bookmark?.glookoSyncStates && bookmark?.glookoCursors) || {};
  let history = saved?.cgmHistory;
  const resized = !history || days !== history.days;
  if (resized) history = { days, floor: floor.toISOString(), complete: false };
  else history = { ...history };
  const cgmFloor = history.complete ? floor : new Date(history.floor);
  const batch = {
    syncVersion: 1,
    diagnostics: {},
    glookoCursors: {},
    userProfile: session.userProfile
  };
  const resources = RESOURCES.filter(
    ([key]) => key !== 'egvs' || !opts.glookoSkipEntries
  );
  if (opts.glookoImportProfile) resources.push(['settings', '/api/v2/pumps/settings']);
  // Limit concurrency: a single account should not issue an unbounded burst.
  let position = 0;
  async function worker() {
    while (position < resources.length) {
      const [key, path, property = key] = resources[position++];
      const previous = key === 'egvs' && resized ? null : cursors[key];
      const start = key === 'egvs' ? cgmFloor : floor;
      const params = {
        lastUpdatedAt:
          (previous && previous.lastUpdatedAt) ||
          (key === 'settings' ? '1970-01-01T00:00:00.000Z' : start.toISOString()),
        lastGuid:
          (previous && previous.lastGuid) || '00000000-0000-0000-0000-000000000000',
        limit: 500,
        sendSoftDeleted: false,
        allDevicesFlag: true
      };
      // Sync/update cursors are genuine UTC. Only clinical window parameters
      // use Glooko's local-clock encoding. Other resources need no startDate.
      if (key === 'egvs')
        params.startDate = toGlookoTime(
          start,
          opts.glookoTimezoneOffset,
          opts.glookoTimezone
        ).toISOString();
      try {
        const result = await fetchPages(
          get,
          path,
          property,
          params,
          key === 'egvs' ? 4 : 200,
          key === 'egvs'
        );
        batch[key] = result.records;
        batch.glookoCursors[key] = result.cursor;
        batch.diagnostics[key] = {
          count: result.records.length,
          pages: result.pages
        };
        if (key === 'egvs') {
          history.pages = (history.complete ? 0 : history.pages || 0) + result.pages;
          if (history.pages > 200) throw syncError('PAGINATION_LIMIT', key);
          history.complete = result.complete;
          if (result.complete) history.pages = 0;
          batch.diagnostics[key].complete = result.complete;
          // Keep current glucose available while a large historical import is
          // progressing. This recent read never replaces the history cursor.
          if (!result.complete) {
            const recent = await fetchPages(
              get,
              path,
              property,
              {
                ...params,
                lastUpdatedAt: graphFloor.toISOString(),
                lastGuid: '00000000-0000-0000-0000-000000000000',
                startDate: toGlookoTime(
                  graphFloor,
                  opts.glookoTimezoneOffset,
                  opts.glookoTimezone
                ).toISOString()
              },
              4
            );
            batch[key] = [
              ...new Map(
                [...result.records, ...recent.records].map((r) => [
                  r.guid || JSON.stringify(r),
                  r
                ])
              ).values()
            ];
          }
        }
      } catch (error) {
        const status = error.response && error.response.status;
        // A missing optional feed is different from a failed or malformed feed.
        // Authentication, throttling, server failures and incomplete pagination
        // must fail the frame, retaining the last successfully persisted cursor.
        if (![404, 422].includes(status)) throw error;
        batch[key] = [];
        batch.diagnostics[key] = { unavailable: status };
      }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  const profile = session.userProfile || {};
  const patient = (session.user && (session.user.userLogin || session.user.user)) || {};
  const code =
    patient.glookoCode ||
    (profile.currentUser && profile.currentUser.glookoCode) ||
    (profile.currentPatient && profile.currentPatient.glookoCode);
  const series = [...MODE_SERIES, ...DELIVERY_SERIES];
  const needCgmFallback =
    !opts.glookoSkipEntries &&
    (batch.diagnostics.egvs.unavailable ||
      ((resized || !cursors.egvs || history.graphEnd) &&
        !batch.egvs.some(
          (row) => !row.softDeleted && !row.calculated && row.glucoseValue > 0
        )));
  if (needCgmFallback) series.push(...CGM_SERIES);
  // The graph contributes mode intervals and is a CGM fallback, never a second
  // copy of the same insulin or carbohydrate records.
  try {
    const graphStart = toGlookoTime(
      graphFloor,
      opts.glookoTimezoneOffset,
      opts.glookoTimezone
    );
    graphStart.setUTCHours(0, 0, 0, 0);
    const graphEnd = toGlookoTime(now, opts.glookoTimezoneOffset, opts.glookoTimezone);
    batch.v3Graph = await get('/api/v3/graph/data', {
      patient: code,
      startDate: graphStart.toISOString(),
      endDate: graphEnd.toISOString(),
      'series[]': series,
      locale: 'en',
      insulinTooltips: false,
      filterBgReadings: false,
      splitByDay: false
    });
    if (
      !batch.v3Graph ||
      !batch.v3Graph.series ||
      typeof batch.v3Graph.series !== 'object'
    )
      throw syncError('INVALID_RESPONSE_SHAPE', 'graph');
    batch.glookoGraphWindow = {
      start: graphStart.toISOString(),
      end: graphEnd.toISOString()
    };
  } catch (error) {
    const status = error.response && error.response.status;
    if (![404, 422].includes(status)) throw error;
    if (series.includes('cgmNormal')) throw error;
    batch.diagnostics.graph = { unavailable: status };
  }
  if (needCgmFallback) {
    // CGM-only graph history is separate from the short pump-state window.
    // Walk backwards in two-day slices; never reconcile old pump-state notes
    // using this glucose-only response.
    const end = new Date(history.graphEnd || now.toISOString());
    if (!history.graphComplete) {
      const start = new Date(
        Math.max(new Date(history.floor).getTime(), end.getTime() - 2 * 86400000)
      );
      batch.cgmHistoryGraph = await get('/api/v3/graph/data', {
        patient: code,
        startDate: toGlookoTime(
          start,
          opts.glookoTimezoneOffset,
          opts.glookoTimezone
        ).toISOString(),
        endDate: toGlookoTime(
          end,
          opts.glookoTimezoneOffset,
          opts.glookoTimezone
        ).toISOString(),
        'series[]': CGM_SERIES,
        locale: 'en',
        filterBgReadings: false,
        splitByDay: false
      });
      if (
        !batch.cgmHistoryGraph?.series ||
        CGM_SERIES.some((k) => !Array.isArray(batch.cgmHistoryGraph.series[k]))
      )
        throw syncError('INVALID_RESPONSE_SHAPE', 'cgmHistoryGraph');
      history.graphEnd = start.toISOString();
      history.graphComplete = start.getTime() <= Date.parse(history.floor);
    }
    history.complete = !!history.graphComplete;
  }
  batch.glookoSyncState = {
    version: 1,
    owner,
    cursors: { ...cursors, ...batch.glookoCursors },
    ...(!opts.glookoSkipEntries
      ? { cgmHistory: history }
      : saved?.cgmHistory
        ? { cgmHistory: saved.cgmHistory }
        : {})
  };
  return batch;
}

module.exports = { collect, fetchPages, RESOURCES, MODE_SERIES, CGM_SERIES };
