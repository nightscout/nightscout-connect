const assert = require('node:assert/strict');
const test = require('node:test');
const axios = require('axios');
const carelink = require('../lib/sources/minimedcarelink');
const timestamp = '2026-09-01T12:00:00.000Z';
const milliseconds = Date.parse(timestamp);
function payload() {
  return {medicalDeviceFamily: 'MINIMED', lastMedicalDeviceDataUpdateServerTime: milliseconds,
    currentServerTime: milliseconds, sMedicalDeviceTime: timestamp,
    medicalDeviceBatteryLevelPercent: 80, conduitBatteryLevel: 60, reservoirRemainingUnits: 100,
    activeInsulin: {amount: 1.2}, sgs: [{kind: 'SG', sg: 123, datetime: timestamp}],
    lastSG: {sg: 123}, lastSGTrend: 'UP', markers: []};
}
function source() { return carelink({carelinkServer: 'owned.example.invalid'}, axios); }

test('preserves newest glucose when lastSG differs or is missing', t => {
  t.mock.method(console, 'log', () => {});
  for (const lastSG of [{sg: 124}, undefined]) {
    const data = payload(); data.lastSG = lastSG;
    const output = source().transformPayload(data, {});
    assert.equal(output.entries.length, 1);
    assert.equal(output.entries[0].sgv, 123);
    assert.equal(output.entries[0].direction, undefined);
  }
});

test('excludes zero and non-sensor readings while preserving valid glucose and its trend', t => {
  t.mock.method(console, 'log', () => {});
  const data = payload();
  data.sgs.unshift({kind: 'SG', sg: 0, datetime: '2026-09-01T11:50:00Z'}, {kind: 'BG', sg: 150, datetime: '2026-09-01T11:55:00Z'});
  const output = source().transformPayload(data, {});
  assert.equal(output.entries.length, 1);
  assert.equal(output.entries[0].direction, 'SingleUp');
});

test('uses measurement time for device status and preserves legacy pump IOB and uploader battery fields', t => {
  t.mock.method(console, 'log', () => {});
  const output = source().transformPayload(payload(), {});
  const status = output.devicestatus[0];
  assert.equal(status.created_at, timestamp);
  assert.equal(status.pump.iob.timestamp, timestamp);
  assert.equal(status.pump.iob.bolusiob, 1.2);
  assert.equal(status.pump.battery.percent, 80);
  assert.equal(status.uploader.battery, 60);
  assert.equal(status.pump.reservoir, 100);
});

test('suppresses already-stored device status and glucose across cutover', t => {
  t.mock.method(console, 'log', () => {});
  const output = source().transformPayload(payload(), {entries: new Date(milliseconds), devicestatus: new Date(milliseconds)});
  assert.deepEqual(output.entries, []);
  assert.deepEqual(output.devicestatus, []);
});

test('does not label a status with an invalid measurement timestamp as fresh', t => {
  t.mock.method(console, 'log', () => {});
  for (const value of [undefined, null, '', 'invalid']) {
    const data = payload(); data.lastMedicalDeviceDataUpdateServerTime = value;
    const output = source().transformPayload(data, {});
    assert.equal(output.entries.length, 1);
    assert.deepEqual(output.devicestatus, []);
  }
});

test('accepts UTC conduit timestamps and leaves input reusable', t => {
  t.mock.method(console, 'log', () => {});
  const data = payload(); data.lastConduitDateTime = timestamp;
  const before = structuredClone(data);
  for (let cycle = 0; cycle < 2; cycle++) {
    const output = source().transformPayload(data, {});
    assert.equal(output.entries[0].date, milliseconds);
    assert.equal(Date.parse(output.devicestatus[0].pump.clock), milliseconds);
    assert.deepEqual(data, before);
  }
});

test('retains Guardian status without inventing pump fields', t => {
  t.mock.method(console, 'log', () => {});
  const data = payload(); data.medicalDeviceFamily = 'GUARDIAN';
  const status = source().transformPayload(data, {}).devicestatus[0];
  assert.equal(status.created_at, timestamp);
  assert.equal(status.uploader.battery, 80);
  assert.equal(status.pump, undefined);
});
