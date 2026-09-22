const assert = require('node:assert/strict');
const test = require('node:test');

const glookoSource = require('../lib/sources/glooko');
const nightscoutOutput = require('../lib/outputs/nightscout');

test('Glooko records remain deduplicated across polls and output restarts', async () => {
  const stamp = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const bolus = { guid: 'bolus-1', pumpTimestamp: stamp, insulinDelivered: 1, insulinOnBoard: 2, carbsInput: 10 };
  const basal = { guid: 'basal-1', pumpTimestamp: stamp, rate: 0.5, duration: 1800 };
  const event = { guid: 'event-1', pumpTimestamp: stamp, type: 'pod_activating' };
  const alarm = { guid: 'alarm-1', pump_timestamp: stamp, value: 'omnipod_low_reservoir' };
  const source = glookoSource({
    baseURL: 'https://eu.api.glooko.com',
    glookoSkipEntries: true,
    glookoTimezoneOffset: 0
  }, {
    create () {
      return {
        get (path) {
          if (path.startsWith('/api/v2/pumps/normal_boluses')) return Promise.resolve({ data: { normalBoluses: [bolus] } });
          if (path.startsWith('/api/v2/pumps/scheduled_basals')) return Promise.resolve({ data: { scheduledBasals: [basal] } });
          if (path.startsWith('/api/v2/pumps/events')) return Promise.resolve({ data: { events: [event] } });
          if (path.startsWith('/api/v2/pumps/alarms')) return Promise.resolve({ data: { alarms: [alarm] } });
          if (path.startsWith('/api/v2/cgm/readings')) return Promise.resolve({ data: { readings: [] } });
          throw new Error('unexpected Glooko path ' + path);
        }
      };
    }
  });

  const stored = { entries: [], treatments: [], devicestatus: [], profile: [] };
  const posts = [];
  const outputTransport = {
    create () {
      return {
        get (path) {
          const kind = path.match(/^\/api\/v1\/(entries|treatments|devicestatus|profile)\.json$/);
          if (!kind) throw new Error('unexpected Nightscout path ' + path);
          return Promise.resolve({ data: stored[kind[1]] });
        },
        post (path, data) {
          const kind = path.match(/^\/api\/v1\/(entries|treatments|devicestatus|profile)\.json$/);
          if (!kind) throw new Error('unexpected Nightscout path ' + path);
          posts.push({ kind: kind[1], count: data.length });
          const saved = data.map((item) => ({ ...item, created_at: item.created_at || item.eventTime }));
          stored[kind[1]].push(...saved);
          return Promise.resolve({ data: saved });
        }
      };
    }
  };
  const session = { cookies: 'synthetic-session', user: { userLogin: { glookoCode: 'synthetic-patient' } } };
  const output = nightscoutOutput({ url: 'https://staging.example.test', apiSecret: 'synthetic-secret' }, outputTransport);

  let bookmark = await output.gap_for();
  let batch = await source.dataFromSesssion(session, bookmark);
  let transformed = source.transformData(batch);
  assert.equal(transformed.treatments.length, 4);
  assert.equal(transformed.devicestatus.length, 1);
  bookmark = await output(transformed);
  assert.deepEqual(new Set(bookmark.seenGuids), new Set(['bolus-1', 'basal-1', 'event-1', 'alarm-1']));

  batch = await source.dataFromSesssion(session, bookmark);
  transformed = source.transformData(batch);
  assert.deepEqual(transformed.treatments, []);
  assert.equal(transformed.devicestatus, undefined);
  await output(transformed);

  const restartedOutput = nightscoutOutput({ url: 'https://staging.example.test', apiSecret: 'synthetic-secret' }, outputTransport);
  bookmark = await restartedOutput.gap_for();
  assert.deepEqual(new Set(bookmark.seenGuids), new Set(['bolus-1', 'basal-1', 'event-1', 'alarm-1']));
  batch = await source.dataFromSesssion(session, bookmark);
  transformed = source.transformData(batch);
  assert.deepEqual(transformed.treatments, []);
  await restartedOutput(transformed);

  assert.deepEqual(posts, [
    { kind: 'treatments', count: 4 },
    { kind: 'devicestatus', count: 1 }
  ]);
});
