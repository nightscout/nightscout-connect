'use strict';

// Private connector bookkeeping, not a pump/current-health status. Persist only
// after the corresponding clinical writes succeed. Keep one record per owner.
const DEVICE = 'nightscout-connect-glooko-sync';
const epoch = '1970-01-01T00:00:00.000Z';
const find = (owner) => ({
  device: DEVICE,
  created_at: { $gte: epoch },
  ...(owner ? { 'glookoSyncState.owner': owner } : {})
});
function valid(state) {
  return (
    state?.version === 1 &&
    /^[a-f0-9]{64}$/.test(state.owner || '') &&
    state.cursors &&
    typeof state.cursors === 'object'
  );
}
async function load(list) {
  const rows = await list({ find: find(), count: 100 });
  if (rows.length >= 100) throw new Error('GLOOKO_CHECKPOINT_LIMIT');
  const states = {};
  for (const row of rows) {
    const state = row.glookoSyncState;
    if (valid(state) && !states[state.owner]) states[state.owner] = state;
  }
  return states;
}
async function save(state, list, create, remove) {
  if (!state) return;
  if (!valid(state)) throw new Error('GLOOKO_INVALID_CHECKPOINT');
  const query = find(state.owner);
  const previous = await list({ find: query, count: 100 });
  if (previous.length >= 100) throw new Error('GLOOKO_CHECKPOINT_LIMIT');
  const unchanged =
    JSON.stringify(previous[0]?.glookoSyncState) === JSON.stringify(state);
  if (!unchanged) {
    const latest = Date.parse(previous[0]?.created_at) || 0;
    await create([
      {
        device: DEVICE,
        created_at: new Date(Math.max(Date.now(), latest + 1)).toISOString(),
        glookoSyncState: state
      }
    ]);
  }
  const obsolete = (unchanged ? previous.slice(1) : previous)
    .map((r) => r._id)
    .filter(Boolean);
  if (obsolete.length) await remove({ find: { ...query, _id: { $in: obsolete } } });
}
module.exports = { DEVICE, load, save };
