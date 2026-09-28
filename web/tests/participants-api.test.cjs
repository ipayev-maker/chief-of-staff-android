// Synthetic store only: never creates or changes real participant records.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const implementation = Promise.all([
  import('../../supabase/functions/cos-notes/handler.mjs'),
  import('../../supabase/functions/cos-google-calendar/google.mjs'),
]);
const ORIGIN = 'https://chief-of-staff-v3-live.vercel.app';
const NOW = '2026-09-28T10:00:00Z';
const TOKEN = 'synthetic-participant-owner-token-012345678901234567890';
const ID = '01234567-abcd-4000-8000-000000000001';
const OTHER = '01234567-abcd-4000-8000-000000000002';
const row = (changes = {}) => ({id: ID, name: 'Олег Иванов', created_at: NOW, ...changes});

async function fixture() {
  const [{createNotesHandler}, {sha256}] = await implementation;
  const data = {
    cos_calendar_connection: [{id: 'owner', google_sub: 'verified-owner', status: 'disconnected'}],
    cos_calendar_sessions: [{token_hash: await sha256(TOKEN), google_sub: 'verified-owner', expires_at: '2026-09-29T10:00:00Z'}],
    participants: [],
  };
  const calls = [];
  const matches = (item, query) => [...new URLSearchParams(query)].every(([key, condition]) => {
    if (['select', 'order', 'offset', 'limit'].includes(key)) return true;
    if (condition.startsWith('eq.')) return String(item[key]) === condition.slice(3);
    if (condition.startsWith('gt.')) return String(item[key]) > condition.slice(3);
    throw Error('Unsupported fixture filter');
  });
  const store = {
    async list(table, query = '') {
      calls.push({operation: 'list', table, query});
      return data[table].filter(item => matches(item, query)).map(item => ({...item}));
    },
    async page(table, query = '') {
      calls.push({operation: 'page', table, query});
      return data[table].filter(item => matches(item, query)).slice(0, Number(new URLSearchParams(query).get('limit') || 50)).map(item => ({...item}));
    },
    async insert(table, values) {
      calls.push({operation: 'insert', table, values});
      if (data[table].some(item => item.id === values.id)) throw Object.assign(Error('PRIVATE constraint details'), {code: '23505'});
      const inserted = row(values); data[table].push(inserted); return {...inserted};
    },
    async patch(table, query, values) {
      calls.push({operation: 'patch', table, query, values});
      const rows = data[table].filter(item => matches(item, query));
      rows.forEach(item => Object.assign(item, values));
      return rows.map(item => ({...item}));
    },
  };
  const handler = createNotesHandler({store, now: () => new Date(NOW)});
  function request({method = 'POST', path = '/participants', body = {id: ID, name: 'Олег Иванов'},
    authenticated = true, origin = ORIGIN, headers = {}} = {}) {
    const h = new Headers(headers);
    if (authenticated) h.set('Cookie', '__Host-cos-calendar-session=' + TOKEN);
    if (origin !== null) h.set('Origin', origin);
    if (!h.has('Content-Type')) h.set('Content-Type', 'application/json');
    return new Request(ORIGIN + '/api/notes' + path, {method, headers: h,
      ...(['GET', 'HEAD'].includes(method) ? {} : {body: JSON.stringify(body)})});
  }
  const call = async options => {
    const response = await handler(request(options));
    return {status: response.status, body: await response.json(), headers: response.headers};
  };
  const mutations = () => calls.filter(call => ['insert', 'patch'].includes(call.operation));
  return {data, calls, store, handler, request, call, mutations};
}

test('participant create and edit require verified owner session and exact application origin', async () => {
  for (const method of ['POST', 'PATCH']) {
    const path = '/participants' + (method === 'PATCH' ? '/' + ID : '');
    for (const origin of [null, 'null', 'https://untrusted.test', ORIGIN + '/']) {
      const f = await fixture(); const result = await f.call({method, path, origin});
      assert.equal(result.status, 403); assert.equal(f.calls.length, 0);
    }
    const f = await fixture();
    const result = await f.call({method, path, authenticated: false,
      headers: {apikey: 'ANON', Authorization: 'Bearer ANON', 'X-Owner-Email': 'owner@example.test'}});
    assert.equal(result.status, 401); assert.equal(f.calls.length, 0);
  }
  for (const change of [{expires_at: NOW}, {google_sub: 'another-owner'}]) {
    const f = await fixture(); Object.assign(f.data.cos_calendar_sessions[0], change);
    assert.equal((await f.call()).status, 401);
    assert.ok(!f.calls.some(call => call.table === 'participants'));
  }
});

test('create normalizes name, keeps stable client UUID, and only exposes participant fields', async () => {
  const f = await fixture();
  const insert = f.store.insert;
  f.store.insert = async (...args) => ({...await insert(...args), internal_secret: 'PRIVATE'});
  const result = await f.call({body: {id: ID.toUpperCase(), name: '  Олег   Иванов  '}});
  assert.equal(result.status, 201); assert.deepEqual(result.body, {participant: row(), replayed: false});
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.equal(result.headers.get('Access-Control-Allow-Origin'), null);
  assert.deepEqual(f.mutations(), [{operation: 'insert', table: 'participants', values: {id: ID, name: 'Олег Иванов'}}]);
});

test('invalid names, identities, arbitrary fields, query strings and methods do not mutate data', async () => {
  const f = await fixture();
  const invalid = [null, [], {}, {name: 'Name'}, {id: 'bad', name: 'Name'}, {id: ID, name: ''},
    {id: ID, name: ' '}, {id: ID, name: null}, {id: ID, name: 'x'.repeat(201)},
    {id: ID, name: 'Line\nBreak'}, {id: ID, name: '\0'}, {id: ID, name: '\ud800'},
    {id: ID, name: 'Name', created_at: NOW}, {id: ID, name: 'Name', owner_id: OTHER}];
  for (const body of invalid) assert.equal((await f.call({body})).status, 400);
  assert.equal((await f.call({path: '/participants?select=*'})).status, 400);
  assert.equal((await f.call({method: 'GET'})).status, 405);
  assert.equal((await f.call({method: 'DELETE', path: '/participants/' + ID})).status, 405);
  assert.equal((await f.call({headers: {'Content-Type': 'text/plain'}})).status, 415);
  assert.equal(f.mutations().length, 0);
});

test('existing normalized name produces an explicit duplicate choice, never an automatic merge', async () => {
  const f = await fixture(); f.data.participants.push(row({id: OTHER, name: '  ОЛЕГ   Иванов  '}));
  const result = await f.call();
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, {error: 'participant_exists', participant: f.data.participants[0]});
  assert.equal(f.mutations().length, 0);
  f.data.participants[0].name = 'И\u0306ван';
  assert.equal((await f.call({body: {id: ID, name: 'Йван'}})).body.error, 'participant_exists');
});

test('create retry uses the same row and never overwrites a later rename', async () => {
  const f = await fixture();
  assert.equal((await f.call()).status, 201);
  const replay = await f.call();
  assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true);
  assert.equal(f.data.participants.length, 1); assert.equal(f.mutations().length, 1);
  f.data.participants[0].name = 'Олег Петров';
  const stale = await f.call();
  assert.equal(stale.status, 409); assert.equal(stale.body.error, 'participant_request_conflict');
  assert.equal(stale.body.participant.name, 'Олег Петров'); assert.equal(f.mutations().length, 1);
});

test('concurrent creates with one UUID settle as created and replayed', async () => {
  const f = await fixture();
  const results = await Promise.all([f.call(), f.call()]);
  assert.deepEqual(results.map(item => item.status).sort(), [200, 201]);
  assert.equal(f.data.participants.length, 1);
  assert.deepEqual(results.map(item => item.body.replayed).sort(), [false, true]);
});

test('renaming preserves identity and uses exact old name as an atomic comparison token', async () => {
  const f = await fixture(); f.data.participants.push(row({name: '  Олег & Иванов, "поставщик"  '}));
  const before = f.data.participants[0].name;
  const result = await f.call({method: 'PATCH', path: '/participants/' + ID,
    body: {name: 'Олег Петров', expected_name: before}});
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.participant, row({name: 'Олег Петров'}));
  const mutation = f.mutations()[0], params = new URLSearchParams(mutation.query);
  assert.equal(params.get('id'), 'eq.' + ID); assert.equal(params.get('name'), 'eq.' + before);
  assert.deepEqual(mutation.values, {name: 'Олег Петров'});
});

test('edit rejects missing records, invalid comparison tokens, duplicate and stale names', async () => {
  const f = await fixture();
  const options = {method: 'PATCH', path: '/participants/' + ID, body: {name: 'Новое имя', expected_name: 'Олег Иванов'}};
  assert.equal((await f.call(options)).status, 404);
  f.data.participants.push(row());
  for (const expected_name of [null, '', 12, 'x'.repeat(2001), '\0', '\ud800']) {
    assert.equal((await f.call({...options, body: {...options.body, expected_name}})).status, 400);
  }
  f.data.participants.push(row({id: OTHER, name: 'Новое имя'}));
  assert.equal((await f.call(options)).body.error, 'participant_exists');
  f.data.participants[0].name = 'Имя из другого окна';
  const result = await f.call(options);
  assert.equal(result.body.error, 'participant_conflict');
  assert.equal(result.body.participant.name, 'Имя из другого окна');
  assert.equal(f.mutations().length, 0);
});

test('concurrent edits cannot silently overwrite each other and exact replay is harmless', async () => {
  const f = await fixture(); f.data.participants.push(row());
  const edit = name => f.call({method: 'PATCH', path: '/participants/' + ID,
    body: {name, expected_name: 'Олег Иванов'}});
  const results = await Promise.all([edit('Олег Петров'), edit('Олег Смирнов')]);
  assert.deepEqual(results.map(item => item.status).sort(), [200, 409]);
  const winner = results.find(item => item.status === 200).body.participant;
  assert.equal(f.data.participants[0].name, winner.name);
  const replay = await edit(winner.name);
  assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true);
});

test('lost insert response can be recovered by an exact retry without creating another person', async () => {
  const f = await fixture(), insert = f.store.insert;
  f.store.insert = async (...args) => { await insert(...args); throw Error('PRIVATE uncertain network'); };
  const uncertain = await f.call(); assert.equal(uncertain.status, 503);
  assert.deepEqual(uncertain.body, {error: 'participants_unavailable'});
  const retry = await f.call(); assert.equal(retry.status, 200); assert.equal(retry.body.replayed, true);
  assert.equal(f.data.participants.length, 1);
});

test('database failures and unconfirmed responses never disclose private details or report success', async () => {
  for (const failure of ['23503', 'STORE_NETWORK', 'constructor', '__proto__']) {
    const f = await fixture(); f.store.insert = async () => { throw Object.assign(Error('PRIVATE'), {code: failure}); };
    const result = await f.call(); assert.equal(result.status, 503);
    assert.deepEqual(result.body, {error: 'participants_unavailable'});
  }
  for (const invalid of [null, {}, row({id: OTHER}), row({name: 'Wrong name'})]) {
    const f = await fixture(); f.store.insert = async () => invalid;
    assert.deepEqual((await f.call()).body, {error: 'participants_unavailable'});
  }
});
