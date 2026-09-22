'use strict';

const { hash } = require('./common');
function payload(now, incremental = false) {
  const start = Math.floor((now - 3600000) / 1000);
  const point = (offset, value, arrow) => ({ FactoryTimestamp: new Date(now + offset).toISOString(),
    ValueInMgPerDl: value, Value: value / 18, TrendArrow: arrow });
  return { status: 0, data: {
    activeSensors: [{ sensor: { sn: 'SYNTHETIC-OLD', a: start - 86400 } },
      { sensor: { sn: 'SYNTHETIC-NEW', a: start } }],
    graphData: [point(-3900000, 90, 2), point(-600000, 108, 3), point(-300000, 126, 4),
      null, { FactoryTimestamp: 'invalid', ValueInMgPerDl: 999 }],
    connection: { [incremental ? 'glucoseItem' : 'glucoseMeasurement']: point(incremental ? 60000 : 0, incremental ? 144 : 135, 5),
      sensor: { sn: 'SYNTHETIC-NEW', a: start, w: 60, s: true, lj: false, pt: 4 },
      patientDevice: { did: 'SYNTHETIC-PHONE', dtid: 1, v: '4.16.0', ll: 70, hl: 250,
        l: true, h: false, alarms: true, u: Math.floor(now / 1000),
        fixedLowAlarmValues: { mgdl: 55, mmoll: 3.1 }, fixedLowThreshold: 55 } }
  } };
}
function fixtureAxios(now, incremental = false) {
  return { create(defaults) {
    async function request(path, options) {
      if (path === '/llu/auth/login') return { data: { status: 0, data: {
        user: { id: 'synthetic-user' }, authTicket: { token: 'synthetic-ticket' }
      } } };
      if (options?.headers?.['Account-Id'] !== hash('synthetic-user')) throw new Error('fixture account header missing');
      if (path === '/llu/connections') return { data: { status: 0, data: [{ patientId: 'synthetic-patient' }] } };
      if (path === '/llu/connections/synthetic-patient/graph') return { data: payload(now, incremental) };
      throw new Error('Unexpected synthetic request');
    }
    return { defaults, interceptors: { request: { use() {} }, response: { use() {} } },
      post: path => request(path), get: (path, options) => request(path, options) };
  } };
}
module.exports = { payload, fixtureAxios };
