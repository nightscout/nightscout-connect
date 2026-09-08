const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {createRequire} = require('node:module');
const internal = require('../lib/outputs/internal');

function context() {
  return {bus: new EventEmitter(), bootErrors: [], entries: {create(rows, callback) {callback(null, rows);}},
    treatments: {create(rows, callback) {callback(null, rows);}}, profile: {create(rows, callback) {callback(null, rows);}},
    devicestatus: {create(rows, callback) {callback(null, rows);}}};
}
function processed(ctx) {
  const data = {sgvs: [{mills: 1}], treatments: [], devicestatus: [], profile: []};
  ctx.bus.emit('data-processed', {data, lastEntry: rows => rows.at(-1)});
}
function wrapper({valid = true, generateError = false} = {}) {
  const filename = path.resolve(__dirname, '../index.js'), localRequire = createRequire(filename);
  const state = {starts: 0, stops: 0, sends: 0};
  const actor = {start() {state.starts++;}, stop() {state.stops++;}, send() {state.sends++;}};
  const driver = () => ({generate_driver() {if (generateError) throw new Error('fixture setup failed');}});
  driver.validate = () => ({ok: valid, config: {}, errors: valid ? [] : ['fixture invalid']});
  const sandbox = {module: {exports: {}}, console: {log() {}}, require(name) {
    if (name === 'xstate') return {interpret: () => actor};
    if (name === './lib/sources') return () => driver;
    if (name === './lib/builder') return () => () => ({});
    return localRequire(name);
  }};
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, {filename});
  return {manage: sandbox.module.exports, state};
}
const env = {extendedSettings: {connect: {source: 'fixture'}}};

test('output close removes permanent/bookmark listeners and settles bookmark waits', async () => {
  const ctx = context(), output = internal({}, ctx), waiting = output.gap_for();
  assert.equal(typeof output.close, 'function');
  output.close(); output.close();
  assert.equal(ctx.bus.listenerCount('data-processed'), 0);
  assert.equal(await waiting, null);
  assert.equal(await output.gap_for(), null);
});

test('output close settles pending storage waits without accepting later data', async () => {
  const ctx = context(); let complete;
  ctx.entries.create = (rows, callback) => {complete = callback;};
  const output = internal({}, ctx), waiting = output({entries: [{sgv: 100}]});
  assert.equal(typeof output.close, 'function');
  output.close();
  assert.equal(await waiting, null);
  processed(ctx); complete(null, []);
  assert.equal(await output({entries: [{sgv: 120}]}), null);
  assert.equal(ctx.bus.listenerCount('data-processed'), 0);
});

test('failed storage removes its data-processed waiter without needing another event', async () => {
  const ctx = context(); ctx.entries.create = (rows, callback) => callback(new Error('fixture failure'));
  const output = internal({}, ctx);
  assert.equal(await output({entries: [{sgv: 100}]}), null);
  assert.equal(ctx.bus.listenerCount('data-processed'), 1);
  if (output.close) output.close();
});

test('successful output remains usable over two processing cycles', async () => {
  const ctx = context(), output = internal({}, ctx);
  for (let cycle = 0; cycle < 2; cycle++) {
    const result = output({entries: [{sgv: 100}]}); processed(ctx);
    assert.equal((await result).entries.getTime(), 1);
    assert.equal(ctx.bus.listenerCount('data-processed'), 1);
  }
  if (output.close) output.close();
});

test('null collection fields still represent an empty batch', async () => {
  const ctx = context(), output = internal({}, ctx);
  assert.equal(await output({entries: null, treatments: null, profiles: null, devicestatus: null}), null);
  assert.equal(ctx.bus.listenerCount('data-processed'), 1);
  if (output.close) output.close();
});

test('wrapper stop detaches all owned listeners over two cycles and prevents later starts', async () => {
  const ctx = context(), {manage, state} = wrapper();
  for (let cycle = 0; cycle < 2; cycle++) {
    const handle = manage(env, ctx);
    await handle.stop(); await handle.stop();
    await handle.run(); processed(ctx);
    assert.equal(ctx.bus.listenerCount('data-processed'), 0);
    assert.equal(ctx.bus.listenerCount('tearDown'), 0);
    assert.equal(ctx.bus.listenerCount('teardown'), 0);
    assert.equal(state.stops, cycle + 1);
    assert.equal(state.sends, 0);
  }
});

test('wrapper responds to both teardown spellings exactly once', async () => {
  for (const event of ['teardown', 'tearDown']) {
    const ctx = context(), {manage, state} = wrapper();
    manage(env, ctx); ctx.bus.emit(event); ctx.bus.emit(event);
    assert.equal(state.stops, 1);
    assert.equal(ctx.bus.listenerCount('data-processed'), 0);
  }
});

test('invalid configuration allocates no output listeners', () => {
  const ctx = context(), {manage, state} = wrapper({valid: false});
  assert.equal(manage(env, ctx), undefined);
  assert.equal(ctx.bus.listenerCount('data-processed'), 0);
  assert.equal(state.starts, 0);
});

test('driver setup failure closes the allocated output', () => {
  const ctx = context(), {manage} = wrapper({generateError: true});
  assert.throws(() => manage(env, ctx), /fixture setup failed/);
  assert.equal(ctx.bus.listenerCount('data-processed'), 0);
});
