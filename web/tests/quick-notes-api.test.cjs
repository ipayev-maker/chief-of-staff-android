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
const TASK = '20000000-0000-4000-8000-000000000001';
const REQUEST = '30000000-0000-4000-8000-000000000001';
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
    quick_notes:[], project_notes:[], cos_note_task_links:[],
  };
  const calls = [];
  const matches = (row, query) => [...new URLSearchParams(query)].every(([key, condition]) => {
    if (['select','order','offset','limit'].includes(key)) return true;
    if (condition === 'is.null') return row[key] === null || key === 'deleted_at' && row[key] === undefined;
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
    async rpc(name, args) {
      calls.push({operation:'rpc', name, args});
      return {task:{id:TASK, ...args.p_task},
        source:{kind:args.p_source_kind, id:args.p_source_id, project_id:PROJECT}, replayed:false};
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

test('mutations require exact application Origin and reject unsupported methods', async () => {
  const f = await fixture();
  for (const origin of [null, 'null', 'https://other.example']) {
    for (const method of ['POST','PATCH','DELETE']) {
      const response = await f.handler(f.request({method, path:method === 'POST' ? '' : '/' + ID, origin, body:{plain_text:'test',revision:1}}));
      assert.equal(response.status, 403);
    }
  }
  assert.equal((await f.handler(f.request({method:'PUT',path:'/' + ID}))).status, 405);
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

test('project-filtered notes are the same editable records as global notes, including unassigned and archived filters', async () => {
  const f = await fixture();
  f.data.quick_notes.push(note(ID, {project_id:PROJECT}), note(TASK), note(REQUEST, {project_id:PROJECT, archived_at:TIME.toISOString()}));
  let response = await (await f.handler(f.request({path:'?project_id=' + PROJECT}))).json();
  assert.deepEqual(response.notes.map(row => row.id), [ID]);
  await f.handler(f.request({method:'PATCH', path:'/' + ID, body:{revision:1, plain_text:'Edited from project'}}));
  response = await (await f.handler(f.request())).json();
  assert.equal(response.notes.find(row => row.id === ID).plain_text, 'Edited from project');
  assert.equal(f.data.quick_notes.length, 3);
  const unassigned = await (await f.handler(f.request({path:'?project_id=null'}))).json();
  assert.deepEqual(unassigned.notes.map(row => row.id), [TASK]);
  const archived = await (await f.handler(f.request({path:'?project_id=' + PROJECT + '&archived=true'}))).json();
  assert.deepEqual(archived.notes.map(row => row.id), [REQUEST]);
  for (const path of ['?project_id=not-a-uuid', '?project_id=eq.' + PROJECT, '?project_id=' + PROJECT + '&project_id=null']) {
    assert.equal((await f.handler(f.request({path}))).status, 400);
  }
  assert.equal(f.calls.some(call => call.table === 'project_notes'), false);
});

test('quick and legacy note tasks use one atomic RPC with only confirmed task form fields', async () => {
  const f = await fixture();
  f.data.quick_notes.push(note(ID, {plain_text:'PRIVATE UNSELECTED NOTE TEXT', project_id:PROJECT}));
  for (const [path, kind] of [['/' + ID + '/tasks', 'quick'], ['/project/' + ID + '/tasks', 'project']]) {
    const response = await f.handler(f.request({method:'POST', path, body:{request_id:REQUEST,
      task:{description:'  User-confirmed selection  ', details:'Edited task details', project_id:null, estimate_minutes:15}}}));
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.task.id, TASK);
    assert.equal(result.task.project_id, null);
    assert.deepEqual(result.source, {kind, id:ID, project_id:PROJECT});
    assert.equal(result.replayed, false);
    assert.equal(JSON.stringify(result).includes('PRIVATE UNSELECTED'), false);
  }
  const calls = f.calls.filter(call => call.operation === 'rpc');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, 'cos_notes_create_task');
  assert.deepEqual(calls[0].args, {p_source_kind:'quick', p_source_id:ID, p_request_id:REQUEST,
    p_task:{description:'User-confirmed selection', details:'Edited task details', status:'open', direction:'internal',
      project_id:null, participant_id:null, area_key:null, deadline:null, planned_on:null, next_check_on:null,
      planned_start_at:null, planned_end_at:null, deadline_at:null, next_check_at:null, estimate_minutes:15}});
  assert.equal(calls[1].args.p_source_kind, 'project');
  assert.equal(f.calls.some(call => ['insert','patch','page'].includes(call.operation)), false);
});

test('task creation and source lookup require owner sessions, exact write Origin and fixed route methods', async () => {
  const f = await fixture();
  for (const path of ['/' + ID + '/tasks', '/project/' + ID + '/tasks']) {
    for (const authenticated of [false, true]) {
      const response = await f.handler(f.request({method:'POST', path, authenticated,
        origin:authenticated ? 'https://other.example' : ORIGIN, body:{request_id:REQUEST, task:{description:'Task'}}}));
      assert.equal(response.status, authenticated ? 403 : 401);
    }
    assert.equal((await f.handler(f.request({path}))).status, 405);
  }
  assert.equal((await f.handler(f.request({path:'/tasks/' + TASK + '/source', authenticated:false}))).status, 401);
  assert.equal((await f.handler(f.request({method:'POST', path:'/tasks/' + TASK + '/source', body:{}}))).status, 405);
  assert.equal((await f.handler(f.request({method:'PATCH', path:'/' + ID + '/tasks', body:{}}))).status, 405);
  assert.equal(f.calls.length, 0);
});

test('task allowlist rejects forged identities, metadata, invalid UUIDs and invalid actual dates before RPC', async () => {
  const f = await fixture();
  const invalidTasks = [
    {}, {description:' '}, {description:'x'.repeat(2001)}, {description:'x\0'}, {details:'x'.repeat(64001)},
    {id:TASK}, {source_message_id:ID}, {source_kind:'quick'}, {cos_version:1}, {created_at:TIME.toISOString()},
    {status:'unknown'}, {direction:'unknown'}, {project_id:'bad'}, {participant_id:[]}, {area_key:''},
    {estimate_minutes:0}, {estimate_minutes:525601}, {estimate_minutes:1.5}, {estimate_minutes:'15'},
    {deadline:'2026-02-30'}, {planned_on:'2025-02-29'}, {next_check_on:'0000-01-01'}, {deadline:'2026-1-01'},
    {deadline_at:'2026-09-23T12:00:00'}, {deadline_at:'2026-02-30T12:00:00Z'}, {deadline_at:'2026-09-23T24:00:00Z'},
    {next_check_at:'2026-09-23T12:60:00Z'}, {deadline_at:'2026-09-23T12:00:00+00:60'},
    {planned_end_at:TIME.toISOString()}, {planned_start_at:'2026-09-23T12:00:00Z', planned_end_at:'2026-09-23T12:30:00+01:00'},
  ];
  for (const value of invalidTasks) {
    const task = Object.keys(value).length ? {description:'Task', ...value} : {};
    const response = await f.handler(f.request({method:'POST', path:'/' + ID + '/tasks', body:{request_id:REQUEST, task}}));
    assert.equal(response.status, 400, JSON.stringify(task));
    assert.deepEqual(await response.json(), {error:'invalid_task'});
  }
  for (const body of [{request_id:'bad', task:{description:'x'}}, {request_id:REQUEST, task:[]},
    {request_id:REQUEST, task:{description:'x'}, owner_email:'owner@example.test'}]) {
    assert.equal((await f.handler(f.request({method:'POST', path:'/' + ID + '/tasks', body}))).status, 400);
  }
  assert.equal((await f.handler(f.request({method:'POST', path:'/' + ID + '/tasks?force=true', body:{request_id:REQUEST, task:{description:'x'}}}))).status, 400);
  assert.equal(f.calls.some(call => call.operation === 'rpc'), false);
});

test('task date validation accepts leap days and compares explicit-offset planned instants', async () => {
  const f = await fixture();
  const task = {description:'Valid schedule', deadline:'2028-02-29', planned_on:'2026-09-23', next_check_on:'2026-10-01',
    planned_start_at:'2026-09-23T12:00:00+02:00', planned_end_at:'2026-09-23T10:30:00Z',
    deadline_at:'2028-02-29T18:00:00.123456+02:00', estimate_minutes:525600};
  const response = await f.handler(f.request({method:'POST', path:'/' + ID + '/tasks', body:{request_id:REQUEST, task}}));
  assert.equal(response.status, 201);
  const rpc = f.calls.find(call => call.operation === 'rpc');
  assert.equal(rpc.args.p_task.deadline, task.deadline);
  assert.equal(rpc.args.p_task.deadline_at, task.deadline_at);
  assert.equal(rpc.args.p_task.planned_start_at, task.planned_start_at);
});

test('retries are delegated to atomic RPC and return the existing task even after source archival', async () => {
  const f = await fixture();
  const row = note(ID); f.data.quick_notes.push(row);
  const transactions = [];
  f.store.rpc = async (name, args) => {
    transactions.push({name, args});
    if (transactions.length === 3) throw {code:'PT409', message:'SENSITIVE_PAYLOAD'};
    return {task:{id:TASK, description:'Confirmed task', internal_secret:'DO_NOT_RETURN'},
      source:{kind:'quick', id:ID, project_id:null, plain_text:'PRIVATE_SOURCE_TEXT'}, replayed:transactions.length > 1};
  };
  const body = {request_id:REQUEST, task:{description:'Confirmed task'}};
  const first = await f.handler(f.request({method:'POST', path:'/' + ID + '/tasks', body}));
  assert.equal(first.status, 201);
  row.archived_at = TIME.toISOString();
  const repeated = await f.handler(f.request({method:'POST', path:'/' + ID + '/tasks', body}));
  assert.equal(repeated.status, 200);
  const result = await repeated.json();
  assert.deepEqual(result, {task:{id:TASK, description:'Confirmed task'}, source:{kind:'quick', id:ID, project_id:null}, replayed:true});
  assert.deepEqual(transactions[0], transactions[1]);
  const changed = await f.handler(f.request({method:'POST', path:'/' + ID + '/tasks', body:{...body, task:{description:'Changed task'}}}));
  assert.equal(changed.status, 409);
  assert.deepEqual(await changed.json(), {error:'task_request_conflict'});
  assert.equal(f.calls.some(call => ['insert','patch','page'].includes(call.operation)), false);
});

test('private task source lookup returns only identity and current project, with bounded queries and no note text', async () => {
  const f = await fixture();
  assert.deepEqual(await (await f.handler(f.request({path:'/tasks/' + TASK + '/source'}))).json(), {source:null});
  for (const kind of ['quick','project']) {
    f.data.cos_note_task_links = [{commitment_id:TASK, source_kind:kind, source_id:ID, payload_hash:'SECRET_HASH'}];
    f.data[kind === 'quick' ? 'quick_notes' : 'project_notes'] = [note(ID, {project_id:PROJECT, archived_at:TIME.toISOString(), plain_text:'DO_NOT_RETURN'})];
    const response = await f.handler(f.request({path:'/tasks/' + TASK + '/source'}));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {source:{kind, id:ID, project_id:PROJECT}});
  }
  for (const call of f.calls.filter(call => call.operation === 'page')) {
    assert.equal(call.query.get('limit'), '1');
    assert.equal(call.options.timeoutMs, 8000);
    assert.ok(!call.query.get('select').includes('plain_text'));
    // The link table's primary key is request_id, not the store's default id.
    if (call.table === 'cos_note_task_links') assert.equal(call.query.get('order'), 'request_id.asc');
  }
  assert.equal((await f.handler(f.request({path:'/tasks/' + TASK + '/source?select=*'}))).status, 400);
});

test('task transaction failures return safe source/conflict/validation errors without database details', async () => {
  const f = await fixture();
  for (const [code, status, error] of [['PT400',400,'invalid_task'], ['PT404',404,'note_not_found'],
    ['PT409',409,'task_request_conflict'], ['PT410',409,'source_archived'], ['23503',400,'invalid_task'], ['22008',400,'invalid_task'],
    ['42501',503,'notes_unavailable'], ['XX000',503,'notes_unavailable']]) {
    f.store.rpc = async () => {throw {code, message:'SECRET SQL DETAIL'};};
    const response = await f.handler(f.request({method:'POST', path:'/' + ID + '/tasks', body:{request_id:REQUEST, task:{description:'Task'}}}));
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), {error});
  }
  f.store.rpc = async () => ({task:{id:TASK}, source:{kind:'quick', id:ID, project_id:null}, replayed:'false'});
  assert.equal((await f.handler(f.request({method:'POST', path:'/' + ID + '/tasks', body:{request_id:REQUEST, task:{description:'Task'}}}))).status, 503);
});
