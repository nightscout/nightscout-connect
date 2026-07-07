const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const test = require('node:test');

const axios = require('axios');
const nightscoutOutput = require('../lib/outputs/nightscout');
const nightscoutSource = require('../lib/sources/nightscout');

function sha1 (plain) {
  return crypto.createHash('sha1').update(plain).digest('hex').toLowerCase();
}

function readBody (req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function withServer (handler, run) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      const body = await readBody(req);
      const url = new URL(req.url, 'http://127.0.0.1');
      const record = {
        method: req.method,
        path: url.pathname,
        search: url.search,
        query: Object.fromEntries(url.searchParams.entries()),
        headers: req.headers,
        body
      };
      requests.push(record);
      await handler(record, res);
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { error: err.message });
      } else {
        res.end();
      }
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseURL = `http://127.0.0.1:${port}`;
  try {
    await run({ baseURL, requests });
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

function sendJson (res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

test('Nightscout source recovers from blocked verifyauth by creating a reader token', async () => {
  await withServer(async (req, res) => {
    if (req.path === '/api/v1/verifyauth') {
      sendJson(res, 401, { status: 401, message: 'blocked' });
      return;
    }
    if (req.path === '/api/v2/authorization/subjects') {
      assert.equal(req.headers['api-secret'], sha1('source-secret'));
      sendJson(res, 200, [{ name: 'nightscout-connect-reader', accessToken: 'reader-token' }]);
      return;
    }
    assert.fail(`unexpected request ${req.method} ${req.path}`);
  }, async ({ baseURL, requests }) => {
    const source = nightscoutSource({ url: baseURL, apiSecret: 'source-secret' }, axios);

    assert.equal(await source.authFromCredentials(), 'reader-token');
    assert.deepEqual(requests.map((req) => req.path), [
      '/api/v1/verifyauth',
      '/api/v2/authorization/subjects'
    ]);
  });
});

test('Nightscout source uses bearer token when fetching entries', async () => {
  const entries = [{
    sgv: 101,
    date: 1760000000000,
    dateString: '2025-10-09T08:53:20.000Z',
    type: 'sgv'
  }];

  await withServer(async (req, res) => {
    if (req.path === '/api/v2/authorization/request/reader-token') {
      sendJson(res, 200, { token: 'jwt-token', iat: 100, exp: 160 });
      return;
    }
    if (req.path === '/api/v1/entries.json') {
      assert.equal(req.headers.authorization, 'Bearer jwt-token');
      assert.match(req.search, /dateString/);
      sendJson(res, 200, entries);
      return;
    }
    assert.fail(`unexpected request ${req.method} ${req.path}`);
  }, async ({ baseURL }) => {
    const source = nightscoutSource({ url: `${baseURL}?token=reader-token`, apiSecret: '' }, axios);
    const session = await source.sessionFromAuth(await source.authFromCredentials());
    const data = await source.dataFromSesssion(session, { entries: new Date('2025-10-09T08:48:20.000Z') });

    assert.deepEqual(source.transformGlucose(data), { entries });
  });
});

test('Nightscout source keeps public-readable sites tokenless', async () => {
  await withServer(async (req, res) => {
    if (req.path === '/api/v1/verifyauth') {
      sendJson(res, 200, { status: 200, message: { canRead: true } });
      return;
    }
    if (req.path === '/api/v1/entries.json') {
      assert.equal(req.headers.authorization, undefined);
      sendJson(res, 200, []);
      return;
    }
    assert.fail(`unexpected request ${req.method} ${req.path}`);
  }, async ({ baseURL, requests }) => {
    const source = nightscoutSource({ url: baseURL, apiSecret: '' }, axios);
    const session = await source.sessionFromAuth(await source.authFromCredentials());

    await source.dataFromSesssion(session, null);
    assert.deepEqual(requests.map((req) => req.path), [
      '/api/v1/verifyauth',
      '/api/v1/entries.json'
    ]);
  });
});

test('Nightscout output posts entries and treatments with hashed API secret', async () => {
  await withServer(async (req, res) => {
    assert.equal(req.headers['api-secret'], sha1('output-secret'));
    if (req.path === '/api/v1/entries.json') {
      assert.deepEqual(JSON.parse(req.body), [{ sgv: 123, dateString: '2025-10-09T08:53:20.000Z' }]);
      sendJson(res, 200, [{ dateString: '2025-10-09T08:53:20.000Z' }]);
      return;
    }
    if (req.path === '/api/v1/treatments.json') {
      assert.deepEqual(JSON.parse(req.body), [{ eventType: 'Correction Bolus', insulin: 1 }]);
      sendJson(res, 200, [{ eventType: 'Correction Bolus' }]);
      return;
    }
    assert.fail(`unexpected request ${req.method} ${req.path}`);
  }, async ({ baseURL, requests }) => {
    const output = nightscoutOutput({ url: baseURL, apiSecret: 'output-secret' }, axios);
    const bookmark = await output({
      entries: [{ sgv: 123, dateString: '2025-10-09T08:53:20.000Z' }],
      treatments: [{ eventType: 'Correction Bolus', insulin: 1 }]
    });

    assert.deepEqual(requests.map((req) => `${req.method} ${req.path}`), [
      'POST /api/v1/entries.json',
      'POST /api/v1/treatments.json'
    ]);
    assert.deepEqual(bookmark, { entries: new Date('2025-10-09T08:53:20.000Z') });
  });
});
