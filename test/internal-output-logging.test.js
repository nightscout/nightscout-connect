const assert = require('node:assert/strict');
const test = require('node:test');
const {EventEmitter} = require('node:events');
const {inspect} = require('node:util');
const internal = require('../lib/outputs/internal');

test('internal output preserves records and bookmarks without logging health-data payloads', async t => {
  const privateValue = 'owned-private-patient-data';
  const logs = [];
  for (const method of ['log', 'error', 'warn', 'debug']) t.mock.method(console, method, (...args) => logs.push(inspect(args, {depth: 20})));
  for (let cycle = 0; cycle < 2; cycle++) {
    const bus = new EventEmitter();
    const sg = {mills: 1788264000000, sgv: 123, private: privateValue};
    const sbx = {data: {sgvs: [sg], treatments: [], devicestatus: [], profile: []}, lastEntry: items => items[items.length - 1]};
    const recorded = {};
    const ctx = {bus};
    for (const collection of ['entries', 'treatments', 'devicestatus', 'profile']) {
      ctx[collection] = {create(items, callback) {recorded[collection] = items; callback(null, items); if (collection === 'entries') setImmediate(() => bus.emit('data-processed', sbx));}};
    }
    const output = internal({}, ctx);
    try {
      const gap = output.gap_for();
      bus.emit('data-processed', sbx);
      assert.equal((await gap).sgvs.private, privateValue);
      const batch = {entries: [{...sg}], devicestatus: [{created_at: new Date(sg.mills).toISOString(), private: privateValue}]};
      const result = await output(batch);
      assert.equal(recorded.entries, batch.entries);
      assert.equal(recorded.devicestatus, batch.devicestatus);
      assert.equal(result.sgvs.private, privateValue);
      assert.equal((await output.gap_for()).entries.getTime(), sg.mills);
      assert.ok(!logs.join('\n').includes(privateValue));
    } finally {bus.removeAllListeners();}
  }
});
