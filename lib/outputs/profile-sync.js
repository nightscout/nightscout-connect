'use strict';

// Which source profiles to store, and which stored ones to replace.
//
// A profile the sink does not store is created. A Nightscout profile the
// sink stores under the same _id is replaced when its content differs from
// the version last stored or handled here. Content is compared without the
// fields a server adds (_id, srvModified, srvCreated). created_at is part of
// the content: the profile editor sets it on every save, while a PUT through
// the API can change a profile and leave it alone, so a timestamp alone would
// miss that edit.
//
// A profile matched only by `identifier` (Glooko) is skipped, as before: it
// has no _id to replace it by.

const crypto = require('crypto');

const SERVER_FIELDS = new Set(['_id', 'srvModified', 'srvCreated']);

function profileKeys (p) {
  return [p.identifier, p._id == null ? null : 'id:' + String(p._id)].filter(Boolean);
}

function canonical (value, top) {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (value._bsontype === 'ObjectId' || value._bsontype === 'ObjectID') return String(value);
  if (Array.isArray(value)) return value.map((v) => canonical(v, false));
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (top && SERVER_FIELDS.has(key)) continue;
    if (value[key] === undefined) continue;
    out[key] = canonical(value[key], false);
  }
  return out;
}

function fingerprint (p) {
  return crypto.createHash('sha1').update(JSON.stringify(canonical(p, true))).digest('hex');
}

function remember (known, p, print) {
  const fp = print || fingerprint(p);
  profileKeys(p).forEach((key) => known.set(key, fp));
}

function known (stored) {
  const map = new Map();
  stored.forEach((p) => remember(map, p));
  return map;
}

function plan (rows, stored) {
  const create = [];
  const replace = [];
  for (const p of rows) {
    const keys = profileKeys(p);
    if (!keys.some((key) => stored.has(key))) {
      create.push(p);
      continue;
    }
    const was = stored.get('id:' + String(p._id));
    if (was !== undefined && was !== fingerprint(p)) replace.push(p);
  }
  return { create, replace };
}

// Logged once per output when a changed profile is not copied because the
// destination cannot replace it by _id without keeping a second copy
// (Nightscout that stores a copied profile's _id as a string; the profile
// save then adds an ObjectId copy beside it). No profile content, _id, URL
// or credential is in it.
const NOT_REPLACED = 'A profile changed on the source Nightscout was not copied, because the destination ' +
  'Nightscout cannot replace that profile without keeping a second, outdated copy of it. New profiles are ' +
  'still copied. Updating the destination Nightscout fixes this for later changes; after updating it, saving ' +
  'the profile again on the source copies it.';

module.exports = { profileKeys, fingerprint, remember, known, plan, NOT_REPLACED };
