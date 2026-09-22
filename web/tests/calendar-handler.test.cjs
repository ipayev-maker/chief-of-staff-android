const {test} = require('node:test');
const assert = require('node:assert/strict');
const implementation = Promise.all([
  import('../../supabase/functions/cos-google-calendar/handler.mjs'),
  import('../../supabase/functions/cos-google-calendar/google.mjs')
]);
const ORIGIN = 'https://chief-of-staff-v3-live.vercel.app';
const BASE = ORIGIN + '/api/google-calendar/';
const TIME = new Date('2026-09-22T12:00:00Z');

async function fixture() {
  const [{createHandler},helpers] = await implementation;
  const data = new Map();
  const table = name => { if (!data.has(name)) data.set(name,[]); return data.get(name); };
  const match = (row,query) => [...new URLSearchParams(query)].every(([key,value]) => {
    if (['order','select','limit','offset'].includes(key)) return true;
    const split = value.indexOf('.'); const op = value.slice(0,split), v = value.slice(split+1);
    return op === 'eq' ? String(row[key]) === v : op === 'gt' ? row[key] > v : op === 'lt' ? row[key] < v : false;
  });
  const store = {
    async list(name,query='') { return table(name).filter(row=>match(row,query)).map(row=>({...row})); },
    async insert(name,row) { table(name).push({...row}); return {...row}; },
    async upsert(name,row) { const found=table(name).find(r=>r.id===row.id); if(found)Object.assign(found,row);else table(name).push({...row}); return {...row}; },
    async patch(name,query,values) {const rows=table(name).filter(r=>match(r,query));rows.forEach(r=>Object.assign(r,values));return rows;},
    async remove(name,query) {const rows=table(name).filter(r=>match(r,query));data.set(name,table(name).filter(r=>!rows.includes(r)));return rows;},
    async rpc(name) { if(name==='cos_calendar_claim_lock')return true;if(name==='cos_calendar_release_lock')return true;throw Error('unexpected_rpc'); }
  };
  const config={allowedEmail:'owner@example.com',tokenKey:Buffer.alloc(32,7).toString('base64'),cronSecret:'synthetic-cron-secret'};
  const calls={exchange:0,calendar:0,sync:0};
  const identity={sub:'synthetic-sub',email:'owner@example.com',email_verified:true};
  const google={
    async authorizationUrl({state}) { return 'https://accounts.google.com/o/oauth2/v2/auth?state='+state; },
    async exchangeCode() {calls.exchange++;return {access_token:'synthetic-access',refresh_token:'synthetic-refresh'};},
    async userInfo() {return {...identity};},
    async refresh() {return {access_token:'synthetic-access'};},
    calendar() {return {async request() {calls.calendar++;return {id:'synthetic-calendar',timeZone:'Europe/Berlin'};}};}
  };
  let clock=TIME;
  const handler=createHandler({store,google,config,now:()=>clock,runSync:async()=>{calls.sync++;return {errors:0,conflicts:0};}});
  async function begin() {
    const response=await handler(new Request(BASE+'start',{method:'POST',headers:{Origin:ORIGIN},body:new URLSearchParams({time_zone:'Europe/Berlin'})}));
    assert.equal(response.status,303);
    const state=new URL(response.headers.get('Location')).searchParams.get('state');
    const flow=response.headers.getSetCookie()[0].split(';')[0];
    return {state,flow};
  }
  async function finish(flow) {return handler(new Request(BASE+'callback?state='+flow.state+'&code=synthetic-code',{headers:{Cookie:flow.flow}}));}
  async function connect() {const response=await finish(await begin());assert.equal(new URL(response.headers.get('Location')).searchParams.get('calendar'),'connected');return response;}
  return {handler,store,table,data,google,config,calls,identity,begin,finish,connect,helpers,setTime:value=>{clock=value;}};
}

test('anonymous status does not disclose owner, connection or task data',async()=>{
  const f=await fixture(); await f.connect();
  const response=await f.handler(new Request(BASE+'status'));
  assert.deepEqual(await response.json(),{authenticated:false,configured:true});
});
test('cross-site start/sync/disconnect are rejected before any mutation',async()=>{
  const f=await fixture();
  for(const route of ['start','sync','disconnect']){
    const r=await f.handler(new Request(BASE+route,{method:'POST',headers:{Origin:'https://other.example'}}));
    assert.equal(r.status,403);
  }
  assert.equal(f.data.size,0);
});
test('callback needs a browser-bound, unexpired, one-use state',async()=>{
  const f=await fixture();const flow=await f.begin();
  const bad=await f.handler(new Request(BASE+'callback?state='+flow.state+'&code=synthetic-code'));
  assert.ok(bad.headers.get('Location').includes('invalid_state'));assert.equal(f.calls.exchange,0);
  await f.finish(flow);const replay=await f.finish(flow);
  assert.ok(replay.headers.get('Location').includes('invalid_state'));assert.equal(f.calls.exchange,1);
});
test('expired flow cannot exchange its authorization code',async()=>{
  const f=await fixture();const flow=await f.begin();f.setTime(new Date(TIME.getTime()+601000));
  const response=await f.finish(flow);assert.ok(response.headers.get('Location').includes('invalid_state'));assert.equal(f.calls.exchange,0);
});
test('wrong account and unverified email cannot create calendar or save connection',async()=>{
  for(const change of [{email:'other@example.com'},{email_verified:false}]){
    const f=await fixture();Object.assign(f.identity,change);const response=await f.finish(await f.begin());
    assert.ok(response.headers.get('Location').includes('wrong_account'));
    assert.equal(f.calls.calendar,0);assert.equal(f.table('cos_calendar_connection').length,0);
  }
});
test('connection persists encrypted token and only hashed browser session',async()=>{
  const f=await fixture();const response=await f.connect();const current=f.table('cos_calendar_connection')[0];
  assert.equal(current.status,'connected');assert.equal(current.time_zone,'Europe/Berlin');
  assert.ok(!current.refresh_token_cipher.includes('synthetic-refresh'));
  assert.equal(await f.helpers.decryptSecret(current.refresh_token_cipher,f.config.tokenKey),'synthetic-refresh');
  const sessionCookie=response.headers.getSetCookie().find(s=>s.startsWith('__Host-cos-calendar-session='));
  assert.match(sessionCookie,/Secure; HttpOnly; SameSite=Lax/);
  const raw=sessionCookie.split(';')[0].split('=')[1];
  assert.equal(f.table('cos_calendar_sessions')[0].token_hash,await f.helpers.sha256(raw));
  assert.ok(!response.headers.get('Location').includes('synthetic'));
});
test('owner session can view status and trigger sync; anonymous user cannot',async()=>{
  const f=await fixture();const connected=await f.connect();
  const session=connected.headers.getSetCookie().find(s=>s.startsWith('__Host-cos-calendar-session=')).split(';')[0];
  const status=await f.handler(new Request(BASE+'status',{headers:{Cookie:session}}));
  assert.equal((await status.json()).authenticated,true);
  const anonymous=await f.handler(new Request(BASE+'sync',{method:'POST',headers:{Origin:ORIGIN}}));assert.equal(anonymous.status,401);
  await f.handler(new Request(BASE+'sync',{method:'POST',headers:{Origin:ORIGIN,Cookie:session}}));assert.equal(f.calls.sync,1);
});
test('cron requires exact internal bearer secret even without owner cookie',async()=>{
  const f=await fixture();await f.connect();
  const bad=await f.handler(new Request(BASE+'tick',{method:'POST',headers:{Authorization:'Bearer wrong'}}));assert.equal(bad.status,401);
  const good=await f.handler(new Request(BASE+'tick',{method:'POST',headers:{Authorization:'Bearer '+f.config.cronSecret}}));assert.equal((await good.json()).ok,true);assert.equal(f.calls.sync,1);
});
test('disconnect erases refresh credential and sessions, preserving events and bindings',async()=>{
  const f=await fixture();const connected=await f.connect();
  const session=connected.headers.getSetCookie().find(s=>s.startsWith('__Host-cos-calendar-session=')).split(';')[0];
  const response=await f.handler(new Request(BASE+'disconnect',{method:'POST',headers:{Origin:ORIGIN,Cookie:session}}));
  assert.equal((await response.json()).ok,true);assert.equal(f.table('cos_calendar_connection')[0].refresh_token_cipher,null);
  assert.equal(f.table('cos_calendar_connection')[0].status,'disconnected');assert.equal(f.table('cos_calendar_sessions').length,0);
  await f.handler(new Request(BASE+'tick',{method:'POST',headers:{Authorization:'Bearer '+f.config.cronSecret}}));assert.equal(f.calls.sync,0);
});
test('reconnect reuses dedicated calendar and rejects changed Google subject',async()=>{
  const f=await fixture();await f.connect();await f.connect();assert.equal(f.calls.calendar,1);
  f.identity.sub='different-sub';const response=await f.finish(await f.begin());assert.ok(response.headers.get('Location').includes('wrong_account'));assert.equal(f.calls.calendar,1);
});
test('uncertain calendar provisioning is held instead of creating duplicate calendars',async()=>{
  const f=await fixture();f.google.calendar=()=>({request:async()=>{f.calls.calendar++;throw Error('network_timeout');}});
  await f.finish(await f.begin());assert.equal(f.table('cos_calendar_connection')[0].status,'provisioning');
  const retry=await f.finish(await f.begin());assert.ok(retry.headers.get('Location').includes('calendar_setup_failed'));assert.equal(f.calls.calendar,1);
});
test('raw provider and database errors are never reflected to the browser',async()=>{
  const f=await fixture();f.google.exchangeCode=async()=>{throw Error('raw-secret-sensitive-text');};
  const response=await f.finish(await f.begin());assert.ok(!response.headers.get('Location').includes('raw-secret'));
  f.store.list=async()=>{throw Error('database-secret-sensitive-text');};
  const status=await f.handler(new Request(BASE+'status'));assert.deepEqual(await status.json(),{error:'calendar_request_failed'});
});
test('explicit rejected calendar creation permits retry after configuration is fixed',async()=>{
  const f=await fixture();const normal=f.google.calendar;
  f.google.calendar=()=>({request:async()=>{throw Object.assign(Error('forbidden'),{status:403});}});
  await f.finish(await f.begin());assert.equal(f.table('cos_calendar_connection')[0].status,'needs_reconnect');
  f.google.calendar=normal;await f.connect();assert.equal(f.calls.calendar,1);
});
