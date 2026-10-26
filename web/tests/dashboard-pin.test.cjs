const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const origin='https://nikodim.vercel.app',token='a'.repeat(43),unlock='b'.repeat(43),cookie='__Host-cos-calendar-session='+token;
async function fixture({unlocked=false,setup=false,result={ok:true}}={}){
 const {createDashboardHandler}=await import('../../supabase/functions/cos-dashboard/handler.mjs');const calls=[],upstream=[],removed=[];
 const store={list:async table=>table==='cos_calendar_connection'?[{google_sub:'owner',email:'owner@example.test'}]:[{google_sub:'owner',expires_at:'2099-01-01T00:00:00Z'}],page:async()=>[],remove:async(...a)=>removed.push(a),rpc:async(name,args)=>{calls.push([name,args]);if(name==='cos_calendar_get_config')return {tokenKey:'test-only-private-key-'.repeat(3)};if(name==='cos_dashboard_pin_status')return {authenticated:true,unlocked,setupRequired:setup,retryAfter:0};return result}};
 const handler=createDashboardHandler({store,url:'https://db.example.test',serviceKey:'server-secret',fetchImpl:async(...a)=>{upstream.push(a);return new Response('[]')}});
 const request=(route,body,headers={})=>new Request(origin+route,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return {store,handler,request,calls,upstream,removed};
}
test('owner Google login alone cannot access data, media, AI or private tables',async()=>{
 const f=await fixture();const state=await (await f.handler(f.request('/api/session'))).json();assert.equal(state.pinRequired,true);assert.equal(state.pinSetupRequired,false);
 for(const route of ['/rest/v1/projects','/rest/v1/commitments','/storage/v1/object/authenticated/project-media/a','/ai/cos-capture-chat']){const r=await f.handler(f.request('/api/data'+route,route.startsWith('/ai')?{}:undefined));assert.equal(r.status,423);assert.equal((await r.json()).error,'pin_required')}
 assert.equal(f.upstream.length,0);
});
test('PIN setup validates exactly four digits including leading zeros, confirmation and owner identity',async()=>{
 const f=await fixture({setup:true});
 for(const body of [{pin:'123',confirmation:'123'},{pin:'12345',confirmation:'12345'},{pin:1234,confirmation:1234},{pin:'abcd',confirmation:'abcd'},{pin:'0123',confirmation:'1230'},{pin:'0123',confirmation:'0123',email:'owner@example.test'}])assert.equal((await f.handler(f.request('/api/session/pin/setup',body))).status,400);
 assert.equal(f.calls.length,0);
 assert.equal((await f.handler(f.request('/api/session/pin/setup',{pin:'0123',confirmation:'0123'},{Cookie:''}))).status,401);
 assert.equal((await f.handler(f.request('/api/session/pin/setup',{pin:'0123',confirmation:'0123'},{Origin:'https://evil.test'}))).status,403);
 const r=await f.handler(f.request('/api/session/pin/setup',{pin:'0123',confirmation:'0123'}));assert.equal(r.status,200);assert.deepEqual(await r.json(),{ok:true});
 assert.match(r.headers.get('Set-Cookie'),/^__Host-cos-pin-session=[A-Za-z0-9_-]{32,200}; Path=\/; Secure; HttpOnly; SameSite=Strict$/);
 const args=f.calls.find(([n])=>n==='cos_dashboard_pin_unlock')[1];assert.equal(args.p_setup,true);assert.match(args.p_proof,/^[a-f0-9]{64}$/);assert.match(args.p_unlock_hash,/^[a-f0-9]{64}$/);assert.equal(JSON.stringify(f.calls).includes('0123'),false);
});
test('incorrect PIN and shared lockout do not issue an unlock cookie',async()=>{
 for(const [result,status] of [[{error:'pin_incorrect'},400],[{error:'pin_locked',retryAfter:900},429],[{error:'pin_already_configured'},409]]){
  const f=await fixture({result}),r=await f.handler(f.request('/api/session/pin/unlock',{pin:'0123'}));assert.equal(r.status,status);assert.equal(r.headers.get('Set-Cookie'),null);assert.equal((await r.json()).error,result.error);if(status===429)assert.equal(r.headers.get('Retry-After'),'900');
 }
});
test('lock and logout revoke the current session proof, leaving other browsers alone',async()=>{
 const f=await fixture();const r=await f.handler(f.request('/api/session/pin/lock',{}));assert.equal(r.status,200);assert.equal(f.removed[0][0],'cos_dashboard_pin_sessions');assert.match(f.removed[0][1],/^session_hash=eq\.[a-f0-9]{64}$/);assert.match(r.headers.get('Set-Cookie'),/Max-Age=0/);
});
test('PIN gate protects notes and Gmail even via direct Supabase paths; only OAuth and authenticated jobs bypass it',async()=>{
 const {withPinGate}=await import('../../supabase/functions/_shared/dashboard-pin.mjs');const f=await fixture(),allowed=[];
 const next=async r=>{allowed.push(new URL(r.url).pathname);return new Response('delegated')},gate=withPinGate(next,{store:f.store,google:true});
 for(const route of ['/api/gmail/thread','/functions/v1/cos-google-calendar/gmail/status','/api/google-calendar/status','/api/google-calendar/sync'])assert.equal((await gate(f.request(route,route.endsWith('/sync')?{}:undefined))).status,423);
 assert.deepEqual(allowed,[]);
 for(const [route,body] of [['/api/google-calendar/start',{}],['/api/google-calendar/callback',undefined],['/functions/v1/cos-google-calendar/gmail/tick',{}]])assert.equal((await gate(f.request(route,body))).status,200);
 const notes=withPinGate(next,{store:f.store});assert.equal((await notes(f.request('/functions/v1/cos-notes'))).status,423);assert.equal((await notes(f.request('/functions/v1/cos-notes/tick',{}))).status,423);
});
test('PIN proof is server-bound; cookie parsing rejects duplicate and forged unlock cookies',async()=>{
 const {pinProof,pinToken,pinStatus,withPinGate}=await import('../../supabase/functions/_shared/dashboard-pin.mjs');
 assert.notEqual(await pinProof('0123','a'.repeat(32)),await pinProof('0123','b'.repeat(32)));await assert.rejects(pinProof('0123','short'));
 assert.equal(pinToken(new Request(origin,{headers:{Cookie:'__Host-cos-pin-session='+unlock}})),unlock);
 assert.equal(pinToken(new Request(origin,{headers:{Cookie:'__Host-cos-pin-session='+unlock+'; __Host-cos-pin-session='+unlock}})),null);
 const f=await fixture();await pinStatus(f.store,f.request('/api/session',undefined,{Cookie:cookie+'; __Host-cos-pin-session='+unlock}));const args=f.calls[0][1];assert.match(args.p_unlock_hash,/^[a-f0-9]{64}$/);assert.notEqual(args.p_unlock_hash,unlock);
 const gate=withPinGate(()=>{throw Error('must not run')},{store:{rpc:async()=>{throw Error('offline')}}});assert.equal((await gate(f.request('/api/notes'))).status,503);
});
test('production entrypoints install PIN gates for all browser services',()=>{
 for(const file of ['cos-notes','cos-google-calendar']){const source=fs.readFileSync(path.join(__dirname,'../../supabase/functions',file,'index.ts'),'utf8');assert.match(source,/import \{withPinGate\}/);assert.match(source,/handler\s*=\s*withPinGate|cachedHandler=withPinGate/)}
 const config=require('../vercel.json');assert.ok(config.rewrites.some(x=>x.source==='/api/session/pin/:path*'));
});
