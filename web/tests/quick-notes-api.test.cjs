const {test} = require('node:test');
const assert = require('node:assert/strict');
const implementation = Promise.all([
  import('../../supabase/functions/cos-notes/handler.mjs'),
  import('../../supabase/functions/cos-google-calendar/google.mjs'),
]);
const ORIGIN = 'https://chief-of-staff-v3-live.vercel.app';
const BASE = ORIGIN + '/api/notes';
const TIME = new Date('2026-09-23T12:00:00Z');
const COOKIE_TOKEN = 'synthetic-owner-session-token-012345678901234567890';
const ID = '00000000-0000-4000-8000-000000000001';
const PROJECT = '10000000-0000-4000-8000-000000000001';
const note = (id = ID, other = {}) => ({
  id, title:'', plain_text:'Synthetic note', project_id:null, source:'web', source_message_id:null,
  telegram_chat_id:null, telegram_message_id:null, telegram_update_id:null,
  archived_at:null, created_at:TIME.toISOString(), updated_at:TIME.toISOString(), revision:1, ...other,
});

async function fixture() {
  const [{createNotesHandler}, {sha256}] = await implementation;
  const data = {
    cos_calendar_connection:[{id:'owner', google_sub:'verified-owner-sub', status:'disconnected'}],
    cos_calendar_sessions:[{token_hash:await sha256(COOKIE_TOKEN), google_sub:'verified-owner-sub', expires_at:'2026-09-24T00:00:00Z'}],
    quick_notes:[],
  };
  const calls = [];
  const matches = (row, query) => [...new URLSearchParams(query)].every(([key, condition]) => {
    if (['select','order','offset','limit'].includes(key)) return true;
    if (condition === 'is.null') return row[key] === null;
    if (condition === 'not.is.null') return row[key] !== null;
    const split = condition.indexOf('.');
    const operator = condition.slice(0, split), value = condition.slice(split + 1);
    if (operator === 'eq') return String(row[key]) === value;
    if (operator === 'gt') return String(row[key]) > value;
    throw Error('Unsupported test condition');
  });
  const store = {
    async list(table, query = '') {
      calls.push({operation:'list', table, query});
      return data[table].filter(row => matches(row, query)).map(row => ({...row}));
    },
    async page(table, query = '', options) {
      calls.push({operation:'page', table, query:new URLSearchParams(query), options});
      const params = new URLSearchParams(query);
      const rows = data[table].filter(row => matches(row, query)).sort((a,b) =>
        String(b.created_at).localeCompare(String(a.created_at)) || b.id.localeCompare(a.id));
      const offset = Number(params.get('offset') || 0), limit = Number(params.get('limit') || 50);
      return rows.slice(offset, offset + limit).map(row => ({...row}));
    },
    async insert(table, values) {
      calls.push({operation:'insert', table, values});
      const row = note(ID, values);
      data[table].push(row);
      return {...row};
    },
    async patch(table, query, values) {
      calls.push({operation:'patch', table, query, values});
      const rows = data[table].filter(row => matches(row, query));
      for (const row of rows) Object.assign(row, values, {revision:row.revision + 1, updated_at:TIME.toISOString()});
      return rows.map(row => ({...row}));
    },
  };
  const handler = createNotesHandler({store, now:() => TIME});
  function request({method = 'GET', path = '', body, authenticated = true, origin = ORIGIN, headers = {}} = {}) {
    const h = new Headers(headers);
    if (authenticated) h.set('Cookie', '__Host-cos-calendar-session=' + COOKIE_TOKEN);
    if (method !== 'GET' && origin !== null) h.set('Origin', origin);
    if (body !== undefined) h.set('Content-Type', 'application/json');
    return new Request(BASE + path, {method, headers:h, ...(body === undefined ? {} : {body:JSON.stringify(body)})});
  }
  return {data, calls, store, handler, request};
}

test('notes reject anonymous keys, fabricated identity and expired or wrong-subject sessions', async () => {
  const f = await fixture();
  const anonymous = await f.handler(f.request({authenticated:false, headers:{apikey:'ANON_KEY', Authorization:'Bearer ANON_KEY', 'X-Owner-Email':'owner@example.test'}}));
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), {error:'unauthorized'});
  assert.equal(f.calls.length, 0);
  for (const change of [{expires_at:TIME.toISOString()}, {google_sub:'different-account'}]) {
    const item = await fixture();
    Object.assign(item.data.cos_calendar_sessions[0], change);
    assert.equal((await item.handler(item.request())).status, 401);
    assert.equal(item.calls.some(call => call.table === 'quick_notes'), false);
  }
  const missing = await fixture(); missing.data.cos_calendar_connection.length = 0;
  assert.equal((await missing.handler(missing.request())).status, 401);
});

test('existing verified owner session works while Calendar is disconnected and list uses one bounded page', async () => {
  const f = await fixture();
  f.data.quick_notes.push(note());
  const response = await f.handler(f.request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {notes:[note()], nextOffset:null});
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(f.calls.filter(call => call.table === 'quick_notes').length, 1);
  const page = f.calls.find(call => call.operation === 'page');
  assert.equal(page.query.get('limit'), '51');
  assert.equal(page.options.timeoutMs, 8000);
});

test('active/archive pagination and deep links return only the requested notes', async () => {
  const f = await fixture();
  f.data.quick_notes.push(note(ID), note('00000000-0000-4000-8000-000000000002'),
    note('00000000-0000-4000-8000-000000000003', {archived_at:TIME.toISOString()}));
  const first = await (await f.handler(f.request({path:'?limit=1'}))).json();
  assert.equal(first.notes[0].id, '00000000-0000-4000-8000-000000000002');
  assert.equal(first.nextOffset, 1);
  const second = await (await f.handler(f.request({path:'?limit=1&offset=1'}))).json();
  assert.equal(second.notes[0].id, ID);
  assert.equal(second.nextOffset, null);
  const archived = await (await f.handler(f.request({path:'?archived=true'}))).json();
  assert.equal(archived.notes.length, 1);
  const exact = await (await f.handler(f.request({path:'/' + archived.notes[0].id}))).json();
  assert.equal(exact.note.id, archived.notes[0].id);
  assert.equal(exact.note.archived_at, TIME.toISOString());
});

test('query injection, duplicate pagination and oversized page sizes are rejected', async () => {
  const f = await fixture();
  for (const path of ['?select=*', '?archived=true&archived=false', '?limit=101', '?limit=0', '?offset=-1', '?archived=all']) {
    assert.equal((await f.handler(f.request({path}))).status, 400);
  }
  assert.equal(f.calls.some(call => call.table === 'quick_notes'), false);
});

test('mutations require exact application Origin and cannot use DELETE', async () => {
  const f = await fixture();
  for (const origin of [null, 'null', 'https://other.example']) {
    for (const method of ['POST','PATCH']) {
      const response = await f.handler(f.request({method, path:method === 'PATCH' ? '/' + ID : '', origin, body:{plain_text:'test',revision:1}}));
      assert.equal(response.status, 403);
    }
  }
  assert.equal((await f.handler(f.request({method:'DELETE',path:'/' + ID}))).status, 405);
  assert.equal(f.calls.length, 0);
});

test('create accepts an empty title, keeps note text and optionally links a project', async () => {
  const f = await fixture();
  const response = await f.handler(f.request({method:'POST', body:{plain_text:'  Useful text\nsecond line  ',project_id:PROJECT}}));
  assert.equal(response.status, 201);
  const {note:created} = await response.json();
  assert.equal(created.title, '');
  assert.equal(created.plain_text, '  Useful text\nsecond line  ');
  assert.equal(created.project_id, PROJECT);
  assert.equal(created.source, 'web');
  assert.equal(created.revision, 1);
  assert.deepEqual(f.calls.find(call => call.operation === 'insert').values, {title:'',plain_text:'  Useful text\nsecond line  ',project_id:PROJECT,source:'web'});
});

test('create/PATCH reject empty text, invalid project and caller-controlled source/archival metadata', async () => {
  const f = await fixture();
  for (const body of [{plain_text:' \n '}, {plain_text:'x',source:'telegram'}, {plain_text:'x',project_id:'bad'},
    {plain_text:'x',archived_at:TIME.toISOString()}, {plain_text:'x',title:'a'.repeat(301)}, {plain_text:'x'.repeat(64001)}]) {
    assert.equal((await f.handler(f.request({method:'POST',body}))).status, 400);
  }
  for (const body of [{revision:1,plain_text:''}, {revision:1,source_message_id:ID}, {revision:1,archived_at:null}, {revision:1}, {revision:0,title:'new'}]) {
    assert.equal((await f.handler(f.request({method:'PATCH',path:'/' + ID,body}))).status, 400);
  }
  assert.equal(f.calls.some(call => ['insert','patch'].includes(call.operation)), false);
});

test('body byte limit is enforced for streams with absent or dishonest Content-Length', async () => {
  const f = await fixture();
  const bytes = new TextEncoder().encode(JSON.stringify({plain_text:'漢'.repeat(45000)}));
  for (const declared of [undefined, '1']) {
    let offset = 0;
    const stream = new ReadableStream({pull(controller) {
      if (offset === bytes.length) return controller.close();
      const end = Math.min(offset + 4096, bytes.length);
      controller.enqueue(bytes.slice(offset, end)); offset = end;
    }});
    const headers = {'Content-Type':'application/json',Origin:ORIGIN,Cookie:'__Host-cos-calendar-session=' + COOKIE_TOKEN};
    if (declared) headers['Content-Length'] = declared;
    const response = await f.handler(new Request(BASE, {method:'POST',headers,body:stream,duplex:'half'}));
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), {error:'request_too_large'});
  }
  assert.equal(f.calls.some(call => call.operation === 'insert'), false);
});

test('CAS prevents a concurrent edit from being overwritten and returns the server revision', async () => {
  const f = await fixture(); f.data.quick_notes.push(note());
  const [a,b] = await Promise.all([
    f.handler(f.request({method:'PATCH',path:'/' + ID,body:{revision:1,plain_text:'First edit'}})),
    f.handler(f.request({method:'PATCH',path:'/' + ID,body:{revision:1,plain_text:'Second edit'}})),
  ]);
  assert.deepEqual([a.status,b.status].sort(), [200,409]);
  const conflict = await (a.status === 409 ? a : b).json();
  assert.equal(conflict.error, 'revision_conflict');
  assert.equal(conflict.note.revision, 2);
  assert.equal(conflict.note.plain_text, f.data.quick_notes[0].plain_text);
  assert.equal(f.data.quick_notes[0].revision, 2);
  for (const call of f.calls.filter(call => call.operation === 'patch')) {
    assert.match(call.query, /revision=eq\.1/);
    assert.equal(call.values.revision, undefined);
  }
});

test('archive/restore use server timestamps and preserve text plus Telegram source metadata', async () => {
  const f = await fixture();
  f.data.quick_notes.push(note(ID, {source:'telegram',source_message_id:PROJECT,telegram_chat_id:123,telegram_message_id:456,telegram_update_id:789}));
  const archived = await (await f.handler(f.request({method:'PATCH',path:'/' + ID,body:{revision:1,archived:true}}))).json();
  assert.equal(archived.note.archived_at, TIME.toISOString());
  const restored = await (await f.handler(f.request({method:'PATCH',path:'/' + ID,body:{revision:2,archived:false,project_id:PROJECT}}))).json();
  assert.equal(restored.note.archived_at, null);
  assert.equal(restored.note.revision, 3);
  assert.equal(restored.note.plain_text, 'Synthetic note');
  assert.equal(restored.note.source, 'telegram');
  assert.equal(restored.note.telegram_message_id, 456);
});

test('missing notes and foreign-key errors return useful safe errors', async () => {
  const f = await fixture();
  assert.equal((await f.handler(f.request({path:'/' + ID}))).status, 404);
  const missing = await f.handler(f.request({method:'PATCH',path:'/' + ID,body:{revision:1,title:'x'}}));
  assert.equal(missing.status, 404);
  f.store.insert = async () => {throw {code:'23503', message:'SENSITIVE_DB_DETAIL'};};
  const foreign = await f.handler(f.request({method:'POST',body:{plain_text:'x',project_id:PROJECT}}));
  assert.equal(foreign.status, 400);
  assert.deepEqual(await foreign.json(), {error:'invalid_project'});
});

test('responses never expose database secrets or unexpected row fields', async () => {
  const f = await fixture();
  f.data.quick_notes.push(note(ID, {refresh_token:'SECRET_ROW_FIELD'}));
  const ok = await f.handler(f.request());
  assert.ok(!(await ok.text()).includes('SECRET_ROW_FIELD'));
  f.store.page = async () => {throw Error('SERVICE_ROLE_SECRET user text SQL');};
  const failed = await f.handler(f.request());
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), {error:'notes_unavailable'});
});

test('Supabase function path and rejected malformed JSON have the same owner-only behavior', async () => {
  const f = await fixture();
  const auth = {Cookie:'__Host-cos-calendar-session=' + COOKIE_TOKEN};
  const upstream = await f.handler(new Request('https://example.supabase.co/functions/v1/cos-notes', {headers:auth}));
  assert.equal(upstream.status, 200);
  for (const body of ['null','[]','{broken','{"__proto__":{"polluted":true},"plain_text":"x"}']) {
    const response = await f.handler(new Request(BASE,{method:'POST',headers:{...auth,Origin:ORIGIN,'Content-Type':'application/json'},body}));
    assert.equal(response.status, 400);
  }
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(f.calls.some(call => call.operation === 'insert'), false);
});
