'use strict';
// Loaded only by the synthetic plugin boot test. Fail closed: no Abbott traffic.
const axios = require('axios');
const original = axios.create.bind(axios);
const fake = require('./fixture').fixtureAxios(Number(process.env.LLU_FIXTURE_NOW));
axios.create = options => {
  if (/libreview|myfreestyle/.test(options?.baseURL || '')) return fake.create(options);
  return original(options);
};
