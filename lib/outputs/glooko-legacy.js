'use strict';

// Older Glooko imports have a source GUID but no Nightscout identifier.
// Reuse their Mongo identity rather than inserting a second insulin dose.
// Nightscout prioritizes identifier over _id, so migrated rows continue using
// _id; the desired identifier is retained separately for audit/verification.
function legacyTreatments(list) {
  const duplicateError = () =>
    Object.assign(new Error('GLOOKO_LEGACY_DUPLICATES_REQUIRE_REVIEW'), {
      code: 'GLOOKO_LEGACY_DUPLICATES_REQUIRE_REVIEW'
    });
  let hasLegacy;
  const known = new Map();
  const base = {
    identifier: { $exists: false },
    glookoGuid: { $exists: true },
    created_at: { $gte: '1970-01-01T00:00:00.000Z' }
  };
  return async function prepare(rows) {
    const candidates = rows.filter((r) => r.glookoGuid && r.identifier?.startsWith('glooko:'));
    if (!candidates.length) return rows;
    if (hasLegacy === undefined) hasLegacy = (await list({ count: 1, find: base })).length > 0;
    if (!hasLegacy) return rows;
    const missing = [...new Set(candidates.map((r) => r.glookoGuid))].filter((g) => !known.has(g));
    // Keep query arrays below the v1 parser's array-length threshold.
    for (let start = 0; start < missing.length; start += 20) {
      const guids = missing.slice(start, start + 20);
      const stored = await list({ count: 100, find: { ...base, glookoGuid: { $in: guids } } });
      if (stored.length >= 100) throw duplicateError();
      const matches = new Map();
      for (const row of stored) {
        if (matches.has(row.glookoGuid)) throw duplicateError();
        matches.set(row.glookoGuid, row._id);
      }
      guids.forEach((g) => known.set(g, matches.get(g) || null));
    }
    return rows.map((row) => {
      const id = row.glookoGuid && known.get(row.glookoGuid);
      if (!id || !row.identifier?.startsWith('glooko:')) return row;
      const { identifier, ...rest } = row;
      return { ...rest, _id: id, glookoIdentifier: identifier };
    });
  };
}

module.exports = legacyTreatments;
