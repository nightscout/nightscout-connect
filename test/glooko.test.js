const assert = require('node:assert/strict');
const test = require('node:test');

const glookoSource = require('../lib/sources/glooko');

function fakeAxios (handler) {
  return {
    create (defaults) {
      return {
        get (path, options) {
          return handler({ method: 'get', path, options, defaults });
        },
        post (path, body, options) {
          return handler({ method: 'post', path, body, options, defaults });
        }
      };
    }
  };
}

function assertHasV2SyncParams (call) {
  assert.ok(call.options.params.lastGuid);
  assert.equal(typeof call.options.params.lastUpdatedAt, 'string');
  assert.ok(call.options.params.limit > 0);
}

function assertHasNoV2SyncParams (call) {
  const params = call.options && call.options.params || {};
  assert.equal(params.lastGuid, undefined);
  assert.equal(params.lastUpdatedAt, undefined);
  assert.equal(params.limit, undefined);
}

test('Glooko validation supports default, EU, and explicit servers', () => {
  const common = {
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret'
  };

  assert.equal(glookoSource.validate(common).config.baseURL, 'https://api.glooko.com');
  assert.equal(glookoSource.validate({ ...common, glookoEnv: 'eu' }).config.baseURL, 'https://eu.api.glooko.com');
  const deFr = glookoSource.validate({ ...common, glookoEnv: 'de-fr' });
  assert.equal(deFr.ok, true);
  assert.equal(deFr.config.baseURL, 'https://de-fr.api.glooko.com');
  assert.equal(deFr.config.glookoWebOrigin, 'https://de-fr.my.glooko.com');
  assert.equal(glookoSource.validate({ ...common, glookoEnv: 'ca' }).config.baseURL, 'https://ca.api.glooko.com');
  assert.equal(
    glookoSource.validate({ ...common, glookoServer: 'de-fr.api.glooko.com' }).config.baseURL,
    'https://de-fr.api.glooko.com'
  );
  assert.equal(
    glookoSource.validate({ ...common, glookoServer: 'de-fr.api.glooko.com' }).config.glookoWebOrigin,
    'https://de-fr.my.glooko.com'
  );
});

test('Glooko validation carries stable device identity, auth mode, graph flag, and timezone offset', () => {
  const result = glookoSource.validate({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoTimezoneOffset: 2,
    glookoDeviceId: 'device-123',
    glookoSerialNumber: 'serial-123',
    glookoUseV3Graph: 'true',
    glookoAuthMode: 'auto'
  });

  assert.equal(result.ok, true);
  assert.equal(result.config.glookoTimezoneOffset, -7200000);
  assert.equal(result.config.glookoDeviceId, 'device-123');
  assert.equal(result.config.glookoSerialNumber, 'serial-123');
  assert.equal(result.config.glookoUseV3Graph, true);
  assert.equal(result.config.glookoAuthMode, 'auto');
});

test('Glooko validation keeps unknown auth modes on safe api default', () => {
  const result = glookoSource.validate({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoAuthMode: 'surprise'
  });

  assert.equal(result.config.glookoAuthMode, 'api');
});

test('Glooko auth sends configurable Android device identity', async () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoDeviceId: 'device-123',
    glookoSerialNumber: 'serial-123',
    baseURL: 'https://eu.api.glooko.com'
  }, fakeAxios((call) => {
    assert.equal(call.path, '/api/v2/users/sign_in');
    assert.equal(call.body.deviceInformation.deviceId, 'device-123');
    assert.equal(call.body.deviceInformation.serialNumber, 'serial-123');
    assert.equal(call.body.deviceInformation.applicationType, 'logbook');
    assert.equal(call.defaults.headers.Origin, 'https://eu.my.glooko.com');
    return Promise.resolve({
      headers: { 'set-cookie': ['_logbook-web_session=session-123; path=/'] },
      data: { userLogin: { glookoCode: 'patient-123' } }
    });
  }));

  assert.deepEqual(await source.authFromCredentials(), {
    cookies: '_logbook-web_session=session-123; path=/',
    user: { userLogin: { glookoCode: 'patient-123' } }
  });
});

test('Glooko API auth fails clearly when two-factor is required', async () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    baseURL: 'https://api.glooko.com'
  }, fakeAxios(() => Promise.resolve({
    headers: { 'set-cookie': ['_logbook-web_session=session-123; path=/'] },
    data: { twoFaRequired: true }
  })));

  await assert.rejects(() => source.authFromCredentials(), /two-factor/);
});

test('Glooko auth supports explicit regional web origin overrides', async () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoDeviceId: 'device-123',
    glookoSerialNumber: 'serial-123',
    glookoWebOrigin: 'https://custom.my.glooko.example',
    baseURL: 'https://de-fr.api.glooko.com'
  }, fakeAxios((call) => {
    assert.equal(call.defaults.headers.Origin, 'https://custom.my.glooko.example');
    assert.equal(call.defaults.headers.Referer, 'https://custom.my.glooko.example/');
    return Promise.resolve({
      headers: { 'set-cookie': ['_logbook-web_session=session-123; path=/'] },
      data: { userLogin: { glookoCode: 'patient-123' } }
    });
  }));

  await source.authFromCredentials();
});

test('Glooko web auth mode uses CSRF form login and returns session cookie', async () => {
  const calls = [];
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoAuthMode: 'web',
    baseURL: 'https://eu.api.glooko.com',
    glookoWebOrigin: 'https://eu.my.glooko.com'
  }, fakeAxios((call) => {
    calls.push(call);
    if (call.method === 'get' && call.path === '/users/sign_in?locale=en-GB') {
      return Promise.resolve({
        headers: { 'set-cookie': ['_logbook-web_session=preauth; path=/'] },
        data: '<input type="hidden" name="authenticity_token" value="csrf-123">'
      });
    }
    if (call.method === 'post' && call.path === '/users/sign_in?id=login_form') {
      assert.match(call.body, /authenticity_token=csrf-123/);
      assert.match(call.body, /user%5Bemail%5D=user%40example.com/);
      assert.match(call.body, /language=en/);
      assert.match(call.body, /redirect_to=%2F/);
      assert.equal(call.options.headers.Cookie, '_logbook-web_session=preauth; path=/');
      assert.equal(call.options.headers['Content-Type'], 'application/x-www-form-urlencoded');
      return Promise.resolve({
        headers: { 'set-cookie': ['_logbook-web_session=session-123; path=/'] },
        data: { success: true }
      });
    }
    throw new Error('unexpected call ' + call.method + ' ' + call.path);
  }));

  assert.deepEqual(await source.authFromCredentials(), {
    cookies: '_logbook-web_session=session-123; path=/',
    user: { success: true }
  });
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    'get /users/sign_in?locale=en-GB',
    'post /users/sign_in?id=login_form'
  ]);
});

test('Glooko web auth can extract CSRF token from meta tag', async () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoAuthMode: 'web',
    baseURL: 'https://eu.api.glooko.com'
  }, fakeAxios((call) => {
    if (call.method === 'get') {
      return Promise.resolve({
        headers: { 'set-cookie': ['_logbook-web_session=preauth; path=/'] },
        data: '<meta name="csrf-token" content="csrf-meta-123">'
      });
    }
    assert.match(call.body, /authenticity_token=csrf-meta-123/);
    return Promise.resolve({
      headers: { 'set-cookie': ['_logbook-web_session=session-123; path=/'] },
      data: { success: true }
    });
  }));

  assert.equal((await source.authFromCredentials()).cookies, '_logbook-web_session=session-123; path=/');
});

test('Glooko web auth fails clearly when two-factor is required', async () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoAuthMode: 'web',
    baseURL: 'https://eu.api.glooko.com'
  }, fakeAxios((call) => {
    if (call.method === 'get') {
      return Promise.resolve({
        headers: { 'set-cookie': ['_logbook-web_session=preauth; path=/'] },
        data: '<input type="hidden" name="authenticity_token" value="csrf-123">'
      });
    }
    return Promise.resolve({
      headers: { 'set-cookie': ['_logbook-web_session=session-123; path=/'] },
      data: { two_fa_required: true }
    });
  }));

  await assert.rejects(() => source.authFromCredentials(), /two-factor/);
});

test('Glooko web auth fails clearly when CSRF token is missing', async () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoAuthMode: 'web',
    baseURL: 'https://eu.api.glooko.com'
  }, fakeAxios((call) => {
    if (call.method === 'get') {
      return Promise.resolve({ headers: {}, data: '<html>No token</html>' });
    }
    throw new Error('unexpected call');
  }));

  await assert.rejects(() => source.authFromCredentials(), /authenticity_token/);
});

test('Glooko auto auth mode falls back to web login on 422', async () => {
  const calls = [];
  const err = new Error('InvalidAuthenticityToken');
  err.response = { status: 422, data: 'The change you wanted was rejected' };
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoAuthMode: 'auto',
    baseURL: 'https://eu.api.glooko.com',
    glookoWebOrigin: 'https://eu.my.glooko.com'
  }, fakeAxios((call) => {
    calls.push(call);
    if (call.method === 'post' && call.path === '/api/v2/users/sign_in') {
      return Promise.reject(err);
    }
    if (call.method === 'get' && call.path === '/users/sign_in?locale=en-GB') {
      return Promise.resolve({
        headers: { 'set-cookie': ['_logbook-web_session=preauth; path=/'] },
        data: '<input type="hidden" value="csrf-123" name="authenticity_token">'
      });
    }
    if (call.method === 'post' && call.path === '/users/sign_in?id=login_form') {
      return Promise.resolve({
        headers: { 'set-cookie': ['_logbook-web_session=session-123; path=/'] },
        data: { success: true }
      });
    }
    throw new Error('unexpected call ' + call.method + ' ' + call.path);
  }));

  assert.equal((await source.authFromCredentials()).cookies, '_logbook-web_session=session-123; path=/');
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    'post /api/v2/users/sign_in',
    'get /users/sign_in?locale=en-GB',
    'post /users/sign_in?id=login_form'
  ]);
});

test('Glooko transform maps v2 CGM readings to Nightscout entries', () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoTimezoneOffset: 0,
    baseURL: 'https://api.glooko.com'
  }, fakeAxios(() => Promise.resolve({ data: {} })));

  const result = source.transformData({
    readings: [
      { timestamp: '2025-10-09T08:53:20.000Z', value: 12345, guid: 'reading-1' },
      { timestamp: '2025-10-09T08:58:20.000Z', value: 0, guid: 'zero' },
      { timestamp: '2025-10-09T09:03:20.000Z', value: 13000, softDeleted: true }
    ]
  });

  assert.deepEqual(result.entries, [{
    type: 'sgv',
    device: 'nightscout-connect-glooko',
    date: 1760000000000,
    dateString: '2025-10-09T08:53:20.000Z',
    sgv: 123,
    direction: 'Flat'
  }]);
});

test('Glooko transform maps v3 graph CGM fallback readings', () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoTimezoneOffset: 0,
    glookoUseV3Graph: true,
    baseURL: 'https://api.glooko.com'
  }, fakeAxios(() => Promise.resolve({ data: {} })));

  const result = source.transformData({
    readings: [],
    v3Graph: {
      series: {
        cgmHigh: [{ x: 1760000300, timestamp: '2025-10-09T08:58:20.000Z', value: 18000 }],
        cgmNormal: [{ x: 1760000000, timestamp: '2025-10-09T08:53:20.000Z', value: 12345 }],
        cgmLow: [{ x: 1760000600, timestamp: '2025-10-09T09:03:20.000Z', y: 65, calculated: true }]
      }
    }
  });

  assert.deepEqual(result.entries.map((entry) => ({
    sgv: entry.sgv,
    dateString: entry.dateString,
    device: entry.device
  })), [
    { sgv: 123, dateString: '2025-10-09T08:53:20.000Z', device: 'nightscout-connect-glooko-v3' },
    { sgv: 180, dateString: '2025-10-09T08:58:20.000Z', device: 'nightscout-connect-glooko-v3' }
  ]);
});

test('Glooko v3 graph fallback converts mmol/L display values when value is absent', () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoTimezoneOffset: 0,
    glookoUseV3Graph: true,
    baseURL: 'https://api.glooko.com'
  }, fakeAxios(() => Promise.resolve({ data: {} })));

  const result = source.transformData({
    readings: [],
    userProfile: { currentUser: { meterUnits: 'mmoll' } },
    v3Graph: {
      series: {
        cgmNormal: [{ x: 1760000000, timestamp: '2025-10-09T08:53:20.000Z', y: 6.7 }]
      }
    }
  });

  assert.equal(result.entries[0].sgv, 121);
});

test('Glooko data fetch adds v3 graph fallback when v2 CGM readings are empty', async () => {
  const calls = [];
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoUseV3Graph: true,
    baseURL: 'https://de-fr.api.glooko.com',
    glookoWebOrigin: 'https://de-fr.my.glooko.com'
  }, fakeAxios((call) => {
    calls.push(call);
    assert.equal(call.options.headers.Host, 'de-fr.api.glooko.com');
    if (call.path.startsWith('/api/v2/pumps/scheduled_basals')) {
      assertHasV2SyncParams(call);
      return Promise.resolve({ data: { scheduledBasals: [] } });
    }
    if (call.path.startsWith('/api/v2/pumps/normal_boluses')) {
      assertHasV2SyncParams(call);
      return Promise.resolve({ data: { normalBoluses: [] } });
    }
    if (call.path.startsWith('/api/v2/cgm/readings')) {
      assertHasV2SyncParams(call);
      return Promise.resolve({ data: { readings: [] } });
    }
    if (call.path.startsWith('/api/v2/pumps/events')) {
      return Promise.resolve({ data: { events: [] } });
    }
    if (call.path.startsWith('/api/v2/pumps/alarms')) {
      return Promise.resolve({ data: { alarms: [] } });
    }
    if (call.path.startsWith('/api/v3/graph/data')) {
      assertHasNoV2SyncParams(call);
      assert.match(call.path, /series\[\]=cgmNormal/);
      assert.doesNotMatch(call.path, /series%5B%5D/);
      return Promise.resolve({ data: { series: { cgmNormal: [{ x: 1760000000, value: 12345 }] } } });
    }
    throw new Error('unexpected path ' + call.path);
  }));

  const batch = await source.dataFromSesssion({
    cookies: '_logbook-web_session=session-123',
    user: { userLogin: { glookoCode: 'patient-123' } }
  }, { entries: new Date('2025-10-09T08:48:20.000Z') });

  assert.deepEqual(batch.v3Graph, { series: { cgmNormal: [{ x: 1760000000, value: 12345 }] } });
  // v2 basals + boluses + cgm readings, the pump events/alarms this driver
  // adds, the wide-window basal fetch, and the v3 graph fallback
  assert.deepEqual(calls.map((c) => c.path.split('?')[0]).sort(), [
    '/api/v2/cgm/readings',
    '/api/v2/pumps/alarms',
    '/api/v2/pumps/events',
    '/api/v2/pumps/normal_boluses',
    '/api/v2/pumps/scheduled_basals',
    '/api/v2/pumps/scheduled_basals',
    '/api/v3/graph/data'
  ]);
});

test('Glooko data fetch can resolve patient code from v3 session profile before graph fallback', async () => {
  const calls = [];
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoUseV3Graph: true,
    baseURL: 'https://eu.api.glooko.com'
  }, fakeAxios((call) => {
    calls.push(call);
    if (call.path.startsWith('/api/v2/pumps/scheduled_basals')) {
      return Promise.resolve({ data: { scheduledBasals: [] } });
    }
    if (call.path.startsWith('/api/v2/pumps/normal_boluses')) {
      return Promise.resolve({ data: { normalBoluses: [] } });
    }
    if (call.path.startsWith('/api/v2/cgm/readings')) {
      return Promise.resolve({ data: { readings: [] } });
    }
    if (call.path.startsWith('/api/v2/pumps/events')) {
      return Promise.resolve({ data: { events: [] } });
    }
    if (call.path.startsWith('/api/v2/pumps/alarms')) {
      return Promise.resolve({ data: { alarms: [] } });
    }
    if (call.path === '/api/v3/session/users') {
      assertHasNoV2SyncParams(call);
      return Promise.resolve({ data: { currentUser: { glookoCode: 'patient-from-profile' } } });
    }
    if (call.path.startsWith('/api/v3/graph/data')) {
      assertHasNoV2SyncParams(call);
      assert.match(call.path, /patient=patient-from-profile/);
      return Promise.resolve({ data: { series: { cgmNormal: [{ x: 1760000000, value: 12345 }] } } });
    }
    throw new Error('unexpected path ' + call.path);
  }));

  const session = await source.sessionFromAuth({
    cookies: '_logbook-web_session=session-123',
    user: { success: true }
  });
  const batch = await source.dataFromSesssion(session, null);

  assert.deepEqual(batch.userProfile, { currentUser: { glookoCode: 'patient-from-profile' } });
  assert.deepEqual(batch.v3Graph, { series: { cgmNormal: [{ x: 1760000000, value: 12345 }] } });
  assert.ok(calls.some((call) => call.path.startsWith('/api/v2/pumps/normal_boluses')));
});

test('Glooko refuses an authenticated session without a resolvable patient code', async () => {
  const calls = [];
  const source = glookoSource({ baseURL: 'https://eu.api.glooko.com' }, fakeAxios((call) => {
    calls.push(call);
    assert.equal(call.path, '/api/v3/session/users');
    assertHasNoV2SyncParams(call);
    return Promise.resolve({ data: { currentUser: {} } });
  }));
  await assert.rejects(() => source.sessionFromAuth({ cookies: 'session=x', user: { success: true } }), /patient code/);
  await assert.rejects(() => source.dataFromSesssion({ cookies: 'session=x', user: { success: true } }, null), /patient code/);
  assert.equal(calls.length, 1);
});

test('Glooko falls back to v3 CGM when the v2 CGM request returns 422', async () => {
  const rejected = new Error('Unprocessable');
  rejected.response = { status: 422 };
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoUseV3Graph: true,
    baseURL: 'https://eu.api.glooko.com'
  }, fakeAxios((call) => {
    if (call.path.startsWith('/api/v2/cgm/')) {
      return Promise.reject(rejected);
    }
    if (call.path.startsWith('/api/v2/pumps/scheduled_basals')) return Promise.resolve({ data: { scheduledBasals: [] } });
    if (call.path.startsWith('/api/v2/pumps/normal_boluses')) return Promise.resolve({ data: { normalBoluses: [] } });
    if (call.path.startsWith('/api/v2/pumps/events')) return Promise.resolve({ data: { events: [] } });
    if (call.path.startsWith('/api/v2/pumps/alarms')) return Promise.resolve({ data: { alarms: [] } });
    if (call.path.startsWith('/api/v3/graph/data')) {
      assert.deepEqual(call.options.params, {});
      return Promise.resolve({ data: { series: { cgmNormal: [{ x: 1760000000, value: 12345 }] } } });
    }
    throw new Error('unexpected path ' + call.path);
  }));

  const batch = await source.dataFromSesssion({
    cookies: '_logbook-web_session=session-123',
    user: { userLogin: { glookoCode: 'patient-123' } }
  }, null);

  assert.equal(source.transformData(batch).entries.length, 1);
});

test('Glooko does not report an empty batch when both v2 and v3 CGM fail', async () => {
  const rejected = new Error('Unprocessable');
  rejected.response = { status: 422 };
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoUseV3Graph: true,
    baseURL: 'https://eu.api.glooko.com'
  }, fakeAxios(() => Promise.reject(rejected)));

  await assert.rejects(() => source.dataFromSesssion({
    cookies: '_logbook-web_session=session-123',
    user: { userLogin: { glookoCode: 'patient-123' } }
  }, null), /Unprocessable/);
});

test('Glooko does not silently drop treatments when a pump request returns 422', async () => {
  const rejected = new Error('Pump request rejected');
  rejected.response = { status: 422 };
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoUseV3Graph: true,
    baseURL: 'https://eu.api.glooko.com'
  }, fakeAxios((call) => {
    if (call.path.startsWith('/api/v2/pumps/normal_boluses')) return Promise.reject(rejected);
    if (call.path.startsWith('/api/v2/pumps/scheduled_basals')) return Promise.resolve({ data: { scheduledBasals: [] } });
    if (call.path.startsWith('/api/v2/cgm/readings')) return Promise.resolve({ data: { readings: [] } });
    if (call.path.startsWith('/api/v2/pumps/events')) return Promise.resolve({ data: { events: [] } });
    if (call.path.startsWith('/api/v2/pumps/alarms')) return Promise.resolve({ data: { alarms: [] } });
    throw new Error('unexpected path ' + call.path);
  }));

  await assert.rejects(() => source.dataFromSesssion({
    cookies: '_logbook-web_session=session-123',
    user: { userLogin: { glookoCode: 'patient-123' } }
  }, null), /Pump request rejected/);
});

test('Glooko does not mistake a failed pump-event request for no events', async () => {
  const failure = new Error('Pump events unavailable');
  failure.response = { status: 500 };
  const source = glookoSource({ baseURL: 'https://eu.api.glooko.com' }, fakeAxios((call) => {
    if (call.path.startsWith('/api/v2/pumps/events')) return Promise.reject(failure);
    if (call.path.startsWith('/api/v2/pumps/scheduled_basals')) return Promise.resolve({ data: { scheduledBasals: [] } });
    if (call.path.startsWith('/api/v2/pumps/normal_boluses')) return Promise.resolve({ data: { normalBoluses: [] } });
    if (call.path.startsWith('/api/v2/pumps/alarms')) return Promise.resolve({ data: { alarms: [] } });
    if (call.path.startsWith('/api/v2/cgm/readings')) return Promise.resolve({ data: { readings: [] } });
    throw new Error('unexpected path ' + call.path);
  }));

  await assert.rejects(() => source.dataFromSesssion({
    cookies: 'session=x', user: { userLogin: { glookoCode: 'patient-123' } }
  }, null), /Pump events unavailable/);
});

test('Glooko uses the older treatment bookmark for pump data, not the newer glucose bookmark', async () => {
  const calls = [];
  const treatmentBookmark = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const entryBookmark = new Date(Date.now() - 5 * 60 * 1000);
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'test-password',
    baseURL: 'https://api.glooko.com'
  }, fakeAxios((call) => {
    calls.push(call);
    if (call.path.startsWith('/api/v2/pumps/scheduled_basals')) return Promise.resolve({ data: { scheduledBasals: [] } });
    if (call.path.startsWith('/api/v2/pumps/normal_boluses')) return Promise.resolve({ data: { normalBoluses: [] } });
    if (call.path.startsWith('/api/v2/pumps/events')) return Promise.resolve({ data: { events: [] } });
    if (call.path.startsWith('/api/v2/pumps/alarms')) return Promise.resolve({ data: { alarms: [] } });
    if (call.path.startsWith('/api/v2/cgm/readings')) return Promise.resolve({ data: { readings: [] } });
    throw new Error('unexpected path ' + call.path);
  }));

  await source.dataFromSesssion({
    cookies: '_logbook-web_session=test-session',
    user: { userLogin: { glookoCode: 'test-patient' } }
  }, { entries: entryBookmark, treatments: treatmentBookmark });

  const pumpCalls = calls.filter((call) => /\/api\/v2\/pumps\/(normal_boluses|scheduled_basals)/.test(call.path)
    && !call.options.params.patient);
  const cgmCall = calls.find((call) => call.path.startsWith('/api/v2/cgm/readings'));
  assert.equal(pumpCalls.length, 2);
  for (const call of pumpCalls) {
    assert.equal(call.options.params.lastUpdatedAt, treatmentBookmark.toISOString());
    assert.ok(call.options.params.limit >= 35);
  }
  assert.equal(cgmCall.options.params.lastUpdatedAt, entryBookmark.toISOString());
  assert.ok(cgmCall.options.params.limit <= 2);
});

test('Glooko authentication and fetch logs omit session and patient identifiers', async () => {
  const originalLog = console.log;
  const logged = [];
  console.log = (...args) => logged.push(args.map((arg) => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '));

  try {
    const source = glookoSource({
      glookoEmail: 'user@example.com',
      glookoPassword: 'private-password-marker',
      baseURL: 'https://api.glooko.com'
    }, fakeAxios((call) => {
      if (call.method === 'post') return Promise.resolve({
        headers: { 'set-cookie': ['_logbook-web_session=private-cookie; path=/'] },
        data: { userLogin: { glookoCode: 'private-patient-code' } }
      });
      if (call.path.startsWith('/api/v2/pumps/scheduled_basals')) return Promise.resolve({ data: { scheduledBasals: [] } });
      if (call.path.startsWith('/api/v2/pumps/normal_boluses')) return Promise.resolve({ data: { normalBoluses: [] } });
      if (call.path.startsWith('/api/v2/pumps/events')) return Promise.resolve({ data: { events: [] } });
      if (call.path.startsWith('/api/v2/pumps/alarms')) return Promise.resolve({ data: { alarms: [] } });
      if (call.path.startsWith('/api/v2/cgm/readings')) return Promise.resolve({ data: { readings: [] } });
      throw new Error('unexpected path ' + call.path);
    }));
    const session = await source.authFromCredentials();
    await source.dataFromSesssion(session, null);
  } finally {
    console.log = originalLog;
  }

  const output = logged.join('\n');
  assert.doesNotMatch(output, /private-password-marker|private-cookie|private-patient-code/);
});

test('Glooko skips already imported pump records by source guid', async () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    baseURL: 'https://eu.api.glooko.com'
  }, fakeAxios((call) => {
    if (call.path.startsWith('/api/v2/pumps/scheduled_basals')) {
      return Promise.resolve({ data: { scheduledBasals: [{ guid: 'basal-1', pumpTimestamp: '2026-07-15T09:00:00.000Z' }] } });
    }
    if (call.path.startsWith('/api/v2/pumps/normal_boluses')) {
      return Promise.resolve({ data: { normalBoluses: [{ guid: 'bolus-1', pumpTimestamp: '2026-07-15T09:00:00.000Z' }] } });
    }
    if (call.path.startsWith('/api/v2/cgm/readings')) return Promise.resolve({ data: { readings: [] } });
    if (call.path.startsWith('/api/v2/pumps/events')) {
      return Promise.resolve({ data: { events: [{ guid: 'event-1', type: 'pod_activating', pumpTimestamp: '2026-07-15T09:00:00.000Z' }] } });
    }
    if (call.path.startsWith('/api/v2/pumps/alarms')) {
      return Promise.resolve({ data: { alarms: [{ guid: 'alarm-1', value: 'omnipod_low_reservoir', pump_timestamp: '2026-07-15T09:00:00.000Z' }] } });
    }
    throw new Error('unexpected path ' + call.path);
  }));

  const batch = await source.dataFromSesssion({
    cookies: '_logbook-web_session=session-123',
    user: { userLogin: { glookoCode: 'patient-123' } }
  }, { seenGuids: ['basal-1', 'bolus-1', 'event-1', 'alarm-1'] });

  assert.deepEqual(batch.normalBoluses, []);
  assert.deepEqual(batch.wideBasals, []);
  assert.deepEqual(batch.pumpEvents, []);
  assert.deepEqual(batch.pumpAlarms, []);
});

test('Glooko transform applies configured timezone offset to fake-UTC readings', () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoTimezoneOffset: -7200000,
    baseURL: 'https://eu.api.glooko.com'
  }, fakeAxios(() => Promise.resolve({ data: {} })));

  const result = source.transformData({
    readings: [{ timestamp: '2025-10-09T08:53:20.000Z', value: 11000 }]
  });

  assert.equal(result.entries[0].dateString, '2025-10-09T06:53:20.000Z');
});

test('Glooko validation carries configured IANA timezone', () => {
  const result = glookoSource.validate({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoTimezone: 'Europe/Prague'
  });

  assert.equal(result.ok, true);
  assert.equal(result.config.glookoTimezone, 'Europe/Prague');
});

test('Glooko transform applies DST-aware timezone offset per timestamp', () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoTimezone: 'Europe/Prague',
    baseURL: 'https://eu.api.glooko.com'
  }, fakeAxios(() => Promise.resolve({ data: {} })));

  const result = source.transformData({
    readings: [
      { timestamp: '2026-01-15T08:53:20.000Z', value: 11000 },
      { timestamp: '2026-07-15T08:53:20.000Z', value: 12000 }
    ]
  });

  assert.equal(result.entries[0].dateString, '2026-01-15T07:53:20.000Z');
  assert.equal(result.entries[1].dateString, '2026-07-15T06:53:20.000Z');
});

test('Glooko v3 graph transform applies DST-aware timezone to fake-UTC timestamps', () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoTimezone: 'Europe/Prague',
    glookoUseV3Graph: true,
    baseURL: 'https://eu.api.glooko.com'
  }, fakeAxios(() => Promise.resolve({ data: {} })));

  const result = source.transformData({
    readings: [],
    v3Graph: {
      series: {
        cgmNormal: [
          {
            x: Date.parse('2026-07-15T08:53:20.000Z') / 1000,
            timestamp: '2026-07-15T08:53:20.000Z',
            value: 12000,
            calculated: false
          },
          {
            x: Date.parse('2026-01-15T08:53:20.000Z') / 1000,
            timestamp: '2026-01-15T08:53:20.000Z',
            value: 11000,
            calculated: false
          }
        ]
      }
    }
  });

  assert.equal(result.entries[0].dateString, '2026-01-15T07:53:20.000Z');
  assert.equal(result.entries[1].dateString, '2026-07-15T06:53:20.000Z');
});

test('Glooko v3 graph x coordinates remain absolute Unix timestamps', () => {
  const source = glookoSource({
    glookoTimezone: 'Europe/Prague',
    glookoUseV3Graph: true,
    baseURL: 'https://eu.api.glooko.com'
  }, fakeAxios(() => Promise.resolve({ data: {} })));
  const instant = '2026-07-15T08:53:20.000Z';
  const result = source.transformData({
    readings: [],
    v3Graph: { series: { cgmNormal: [{ x: Date.parse(instant) / 1000, value: 12000 }] } }
  });

  assert.equal(result.entries[0].dateString, instant);
});

test('Glooko IANA timezone takes precedence over fixed timezone offset', () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoTimezone: 'Europe/Prague',
    glookoTimezoneOffset: -3600000,
    baseURL: 'https://eu.api.glooko.com'
  }, fakeAxios(() => Promise.resolve({ data: {} })));

  const result = source.transformData({
    readings: [
      { timestamp: '2026-07-15T08:53:20.000Z', value: 12000 }
    ]
  });

  assert.equal(result.entries[0].dateString, '2026-07-15T06:53:20.000Z');
});

test('Glooko validation rejects invalid IANA timezone', () => {
  const result = glookoSource.validate({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoTimezone: 'Not/A_Timezone'
  });

  assert.equal(result.ok, false);
  assert.equal(result.config.kind, 'disabled');
  assert.ok(result.errors.some((error) => /timezone/i.test(error.desc)));
});

test('Glooko timezone conversion handles DST transition boundaries', () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoTimezone: 'Europe/Prague',
    baseURL: 'https://eu.api.glooko.com'
  }, fakeAxios(() => Promise.resolve({ data: {} })));

  const result = source.transformData({
    readings: [
      { timestamp: '2026-03-29T01:59:59.000Z', value: 11000 },
      { timestamp: '2026-03-29T03:00:00.000Z', value: 12000 }
    ]
  });

  assert.equal(result.entries[0].dateString, '2026-03-29T00:59:59.000Z');
  assert.equal(result.entries[1].dateString, '2026-03-29T01:00:00.000Z');
});

test('Glooko pump treatments apply DST-aware timezone per timestamp', () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoTimezone: 'Europe/Prague',
    glookoTimezoneOffset: 0,
    baseURL: 'https://eu.api.glooko.com'
  }, fakeAxios(() => Promise.resolve({ data: {} })));

  const result = source.transformData({
    readings: [],
    normalBoluses: [
      {
        pumpTimestamp: '2026-01-15T08:53:20.000Z',
        insulinDelivered: 1.0,
        carbsInput: 10
      },
      {
        pumpTimestamp: '2026-07-15T08:53:20.000Z',
        insulinDelivered: 1.5,
        carbsInput: 15
      }
    ],
    scheduledBasals: [
      {
        pumpTimestamp: '2026-07-15T09:00:00.000Z',
        rate: 1.0,
        duration: 1800
      }
    ]
  });

  const boluses = result.treatments.filter((item) => item.eventType === 'Meal Bolus');
  const basals = result.treatments.filter((item) => item.eventType === 'Temp Basal');

  assert.equal(boluses[0].eventTime, '2026-01-15T07:53:20.000Z');
  assert.equal(boluses[1].eventTime, '2026-07-15T06:53:20.000Z');
  assert.equal(basals[0].created_at, '2026-07-15T07:00:00.000Z');
});

test('Glooko pump treatments preserve configured fixed timezone offset', () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoTimezoneOffset: -7200000,
    baseURL: 'https://eu.api.glooko.com'
  }, fakeAxios(() => Promise.resolve({ data: {} })));

  const result = source.transformData({
    readings: [],
    normalBoluses: [{
      pumpTimestamp: '2026-07-15T08:53:20.000Z',
      insulinDelivered: 1
    }]
  });

  assert.equal(result.treatments[0].eventTime, '2026-07-15T06:53:20.000Z');
});

test('Glooko pump events, alarms, and IOB use the configured DST-aware timezone', () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoTimezone: 'Europe/Prague',
    glookoSkipEntries: true,
    baseURL: 'https://eu.api.glooko.com'
  }, fakeAxios(() => Promise.resolve({ data: {} })));

  const result = source.transformData({
    readings: [{ timestamp: '2026-07-15T08:53:20.000Z', value: 11000 }],
    normalBoluses: [{
      guid: 'bolus-1',
      pumpTimestamp: '2026-07-15T08:53:20.000Z',
      insulinDelivered: 1,
      insulinOnBoard: 2,
      carbsInput: 0
    }],
    wideBasals: [{
      guid: 'basal-1',
      pumpTimestamp: '2026-07-15T09:00:00.000Z',
      rate: 1,
      duration: 1800
    }],
    pumpEvents: [{
      guid: 'event-1',
      type: 'pod_activating',
      pumpTimestamp: '2026-07-15T09:05:00.000Z'
    }],
    pumpAlarms: [{
      guid: 'alarm-1',
      value: 'omnipod_low_reservoir',
      pump_timestamp: '2026-07-15T09:10:00.000Z'
    }]
  });

  assert.deepEqual(result.entries, []);
  assert.equal(result.treatments.find((item) => item.glookoGuid === 'bolus-1').eventTime, '2026-07-15T06:53:20.000Z');
  assert.equal(result.treatments.find((item) => item.glookoGuid === 'bolus-1').eventType, 'Correction Bolus');
  assert.equal(result.treatments.find((item) => item.glookoGuid === 'basal-1').created_at, '2026-07-15T07:00:00.000Z');
  assert.equal(result.treatments.find((item) => item.glookoGuid === 'event-1').eventTime, '2026-07-15T07:05:00.000Z');
  assert.equal(result.treatments.find((item) => item.glookoGuid === 'event-1').eventType, 'Site Change');
  assert.equal(result.treatments.find((item) => item.glookoGuid === 'alarm-1').eventTime, '2026-07-15T07:10:00.000Z');
  assert.equal(result.treatments.find((item) => item.glookoGuid === 'alarm-1').eventType, 'Note');
  assert.equal(result.devicestatus[0].created_at, '2026-07-15T06:53:20.000Z');
});

test('Glooko transform tolerates missing readings', () => {
  const source = glookoSource({
    glookoEmail: 'user@example.com',
    glookoPassword: 'secret',
    glookoTimezoneOffset: 0,
    baseURL: 'https://api.glooko.com'
  }, fakeAxios(() => Promise.resolve({ data: {} })));

  assert.deepEqual(source.transformData({}), { entries: [], treatments: [] });
});
