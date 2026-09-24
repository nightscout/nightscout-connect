'use strict';

// Reconcile ONLY this account's historical state notes, after successful writes.
// A later graph can extend/repartition an interval; stale notes must not remain
// underneath its replacement. No doses, basal treatments or user notes qualify.
async function reconcile(window, list, remove) {
  if (!window) return;
  const find = {
    eventType: 'Note',
    glookoSource: 'pump-state',
    'glookoPumpState.accountKey': window.accountKey,
    created_at: { $gte: window.from, $lt: window.to }
  };
  const existing = await list({ count: 5000, find });
  if (existing.length >= 5000)
    throw Object.assign(new Error('GLOOKO_STATE_RECONCILE_LIMIT'), {
      code: 'GLOOKO_STATE_RECONCILE_LIMIT'
    });
  const expected = new Set(window.identifiers);
  const obsolete = existing.filter(
    (r) => r.identifier?.startsWith('glooko:pump-state:') && !expected.has(r.identifier)
  );
  for (let i = 0; i < obsolete.length; i += 20) {
    await remove({
      find: { ...find, identifier: { $in: obsolete.slice(i, i + 20).map((r) => r.identifier) } }
    });
  }
}
module.exports = reconcile;
