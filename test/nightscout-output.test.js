const assert = require('node:assert/strict');
const test = require('node:test');

const nightscoutOutput = require('../lib/outputs/nightscout');

function fakeAxios () {
  return {
    create () {
      return {
        get () {
          return Promise.resolve({ data: [] });
        },
        post () {
          return Promise.resolve({ data: [] });
        }
      };
    }
  };
}

test('Nightscout output requires an endpoint', () => {
  assert.throws(() => nightscoutOutput({ apiSecret: 'secret' }, fakeAxios()), /CONNECT_NIGHTSCOUT_ENDPOINT/);
});

test('Nightscout output requires an API secret', () => {
  assert.throws(() => nightscoutOutput({ url: 'https://example.test' }, fakeAxios()), /CONNECT_API_SECRET/);
});

test('Nightscout output tolerates batches with omitted collections', async () => {
  const output = nightscoutOutput({ url: 'https://example.test', apiSecret: 'secret' }, fakeAxios());

  assert.deepEqual(await output({}), {});
});
