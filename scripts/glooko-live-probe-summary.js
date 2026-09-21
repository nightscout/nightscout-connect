function count (items) {
  return Array.isArray(items) ? items.length : 0;
}

function summarizeBatch (batch, transformed) {
  const series = batch.v3Graph && batch.v3Graph.series || {};
  const v3Readings = count(series.cgmHigh) + count(series.cgmNormal) + count(series.cgmLow);
  const wideBasals = count(batch.wideBasals);
  const warnings = [];
  if (batch.syncVersion === 1) {
    return {
      sourceCounts: Object.fromEntries(Object.entries(batch.diagnostics || {}).map(([key,value])=>[key,value.count || 0])),
      pages: Object.fromEntries(Object.entries(batch.diagnostics || {}).filter(([,value])=>value.pages).map(([key,value])=>[key,value.pages])),
      transformedCounts: { entries: count(transformed.entries), treatments: count(transformed.treatments), devicestatus: count(transformed.devicestatus), profiles: count(transformed.profiles) },
      warnings: [...Object.keys(transformed.glookoSync && transformed.glookoSync.warnings || {}),
        ...Object.entries(batch.diagnostics || {}).filter(([,value])=>value.unavailable).map(([key])=>key+'_unavailable')]
    };
  }

  if (count(batch.readings) > 0 && v3Readings > 0) {
    warnings.push('v2_readings_unusable_v3_fallback');
  }
  if (wideBasals >= 1000) {
    warnings.push('scheduled_basals_at_request_limit');
  }

  return {
    sourceCounts: {
      v2Readings: count(batch.readings),
      v3Readings,
      boluses: count(batch.normalBoluses),
      scheduledBasals: wideBasals,
      pumpEvents: count(batch.pumpEvents),
      pumpAlarms: count(batch.pumpAlarms)
    },
    transformedCounts: {
      entries: count(transformed.entries),
      treatments: count(transformed.treatments),
      devicestatus: count(transformed.devicestatus)
    },
    warnings
  };
}

module.exports = { summarizeBatch };
