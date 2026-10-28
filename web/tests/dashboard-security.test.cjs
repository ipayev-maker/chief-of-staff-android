const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const token='a'.repeat(43),origin='https://nikodim.vercel.app',now=()=>new Date('2026-10-26T12:00:00Z');
async function fixture({session='owner',expires='2026-11-01T00:00:00Z',unlocked=true}={}){
 const {createDashboardHandler}=await import('../../supabase/functions/cos-dashboard/handler.mjs');const reads=[],calls=[],removed=[];
 const store={rpc:async()=>({authenticated:true,unlocked,setupRequired:false,retryAfter:0}),list:async(t,q)=>{reads.push([t,q]);return t==='cos_calendar_connection'?[{google_sub:'owner',email:'owner@example.test'}]:session?[{google_sub:session,expires_at:expires}]:[]},remove:async(...args)=>removed.push(args),page:async()=>[]};
 const handler=createDashboardHandler({store,url:'https://db.example.test',serviceKey:'server-only-secret',now,fetchImpl:async(url,opt)=>{calls.push({url:String(url),...opt});return new Response('[]',{headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Content-Range':'0-0/1'}})}});
 const request=(route,options={})=>new Request(origin+'/api/data'+route,{...options,headers:{Cookie:'__Host-cos-calendar-session='+token,...(options.method&&options.method!=='GET'?{Origin:origin}:{}),...options.headers}});
 return {handler,request,reads,calls,removed};
}
test('anonymous and public-key requests cannot reach data, media or AI; session check leaks no owner identity',async()=>{
 const f=await fixture();for(const route of ['/rest/v1/projects','/rest/v1/commitments','/storage/v1/object/authenticated/project-media/a','/functions/v1/cos-capture-chat']){
  const r=await f.handler(new Request(origin+'/api/data'+route,{headers:{apikey:'public-key',Authorization:'Bearer public-jwt'}}));assert.equal(r.status,401);
 }
 assert.equal(f.reads.length,0);assert.equal(f.calls.length,0);
 const status=await f.handler(new Request(origin+'/api/session'));assert.deepEqual(await status.json(),{authenticated:false});
});
test('foreign, expired and duplicate-cookie sessions fail closed',async()=>{
 for(const options of [{session:'other'},{expires:'2026-10-01T00:00:00Z'},{session:null}]){const f=await fixture(options);assert.equal((await f.handler(f.request('/rest/v1/projects'))).status,401);assert.equal(f.calls.length,0)}
 const f=await fixture();assert.equal((await f.handler(f.request('/rest/v1/projects',{headers:{Cookie:'__Host-cos-calendar-session='+token+'; __Host-cos-calendar-session='+token}}))).status,401);assert.equal(f.reads.length,0);
});
test('owner requests use a fixed upstream, server credentials and public schema; responses are private',async()=>{
 const f=await fixture();const r=await f.handler(f.request('/rest/v1/projects?select=id&limit=1',{headers:{apikey:'attacker',Authorization:'Bearer attacker','Accept-Profile':'vault'}}));
 assert.equal(r.status,200);assert.equal(f.calls[0].url,'https://db.example.test/rest/v1/projects?select=id&limit=1');assert.equal(f.calls[0].headers.get('Authorization'),'Bearer server-only-secret');assert.equal(f.calls[0].headers.get('Accept-Profile'),'public');assert.match(r.headers.get('Cache-Control'),/no-store/);assert.equal(r.headers.get('Access-Control-Allow-Origin'),null);assert.equal(r.headers.get('Authorization'),null);
});
test('private tables, RPCs, arbitrary functions, external media buckets and cross-site writes are rejected',async()=>{
 const f=await fixture();for(const route of ['/rest/v1/cos_calendar_sessions','/rest/v1/cos_settings','/rest/v1/rpc/cos_calendar_get_config','/functions/v1/cos-v3-export','/storage/v1/object/authenticated/cos-v3-preview/source'])assert.equal((await f.handler(f.request(route))).status,404);
 for(const headers of [{Origin:'https://attacker.example'},{Origin:'null'},{Origin:'', 'Sec-Fetch-Site':'cross-site'}])assert.equal((await f.handler(f.request('/rest/v1/projects',{method:'POST',headers,body:'{}'}))).status,403);
 assert.equal(f.calls.length,0);
});
test('media URLs require the owner session and do not mint reusable bearer signatures',async()=>{
 const f=await fixture();const sign=await f.handler(f.request('/storage/v1/object/sign/project-media/folder/a%20b.png',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"expiresIn":31536000}'}));
 assert.deepEqual(await sign.json(),{signedURL:'/storage/v1/object/authenticated/project-media/folder/a%20b.png'});assert.equal(f.calls.length,0);
 assert.equal((await f.handler(f.request('/storage/v1/object/authenticated/project-media/folder/a%20b.png'))).status,200);
 assert.equal(f.calls[0].url,'https://db.example.test/storage/v1/object/authenticated/project-media/folder/a%20b.png');
 assert.equal((await f.handler(f.request('/storage/v1/object/project-media/file.js',{method:'POST',headers:{'Content-Type':'application/javascript'},body:'alert(1)'}))).status,415);
});
test('logout deletes only the current hashed session and clears its secure HttpOnly cookie',async()=>{
 const f=await fixture();const r=await f.handler(f.request('/logout',{method:'POST'}));assert.equal(r.status,200);assert.equal(f.removed.length,1);assert.equal(f.removed[0][0],'cos_calendar_sessions');assert.match(f.removed[0][1],/^token_hash=eq\.[a-f0-9]{64}$/);assert.match(r.headers.get('Set-Cookie'),/Secure; HttpOnly; SameSite=Lax; Max-Age=0/);assert.equal(f.calls.length,0);
});
test('AI proxy uses a non-nested Edge route and maps only allowed functions upstream',async()=>{
 const f=await fixture();
 assert.equal((await f.handler(f.request('/ai/cos-capture-chat',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}))).status,200);
 assert.equal(f.calls[0].url,'https://db.example.test/functions/v1/cos-capture-chat');
 assert.equal((await f.handler(f.request('/ai/cos-v3-export',{method:'POST',body:'{}'}))).status,404);
 assert.equal((await f.handler(new Request(origin+'/api/data/ai/cos-capture-chat',{method:'POST',headers:{Origin:origin},body:'{}'}))).status,401);
});
test('every legacy deployed handler is service-guarded; public keys are absent from the release client',()=>{
 const root=path.resolve(__dirname,'../../supabase/functions');
 for(const slug of ['rapid-task','parse-dates','voice-ui','dynamic-action','morning-digest','dashboard','capture','cos-capture','cos-v3-preview','cos-v3-xhtml-test','cos-meeting-minutes','cos-capture-v25','cos-capture-chat','cos-v3-export']){
  const code=fs.readFileSync(path.join(root,slug,'index.ts'),'utf8');assert.match(code,/import \{serveProtected\}/);assert.match(code,/serveProtected\(/);assert.doesNotMatch(code,/(?:Deno\.)?\bserve\(/);assert.doesNotMatch(code,/SUPABASE_ANON_KEY/);
 }
 const html=fs.readFileSync(path.resolve(__dirname,'../index.html'),'utf8');assert.doesNotMatch(html,/const (?:KEY|ANON)=|sb_publishable_|eyJhbGci/);assert.match(html,/if\(!await authorizeDashboard\(\)\)return/);
});

test('legacy guard rejects missing/public credentials before invoking the protected handler',async()=>{
 const secret='server-only-'.repeat(5),previous=global.Deno;let served,calls=0;
 global.Deno={env:{get:name=>name==='SUPABASE_SERVICE_ROLE_KEY'?secret:'https://db.example.test'},serve:handler=>{served=handler}};
 try{const {serveProtected}=await import('../../supabase/functions/_shared/legacy-auth.ts');serveProtected(()=>{calls++;return new Response('owner operation')});
  for(const headers of [{},{apikey:'public'},{Authorization:'Bearer '+('public'.repeat(10))}])assert.equal((await served(new Request(origin,{headers}))).status,401);
  assert.equal(calls,0);assert.equal((await served(new Request(origin,{headers:{Authorization:'Bearer '+secret}}))).status,200);assert.equal(calls,1);
 }finally{global.Deno=previous}
});

test('the shipped Android startup URL is deployed and retains Google, PIN and private-table guards',async()=>{
 const client=fs.readFileSync(path.resolve(__dirname,'../../app/src/main/java/ru/ipayev/chiefofstaff/ApiClient.kt'),'utf8');
 const literal=client.match(/connection\("GET", "([^"]*commitments\?[^"]*)"\)/)?.[1];
 assert.ok(literal,'read the actual URL used by the shipped app, not a second test-only URL');
 const url=new URL(literal.replace('$limit','1'),origin),config=require('../vercel.json');
 function rewritten(input){
  const rule=config.rewrites.find(r=>r.source.endsWith(':path*')&&input.pathname.startsWith(r.source.split(':path*')[0]));
  assert.ok(rule,'native startup URL must have a deployed rewrite; otherwise 404 prevents opening LoginActivity');
  const destination=new URL(rule.destination.replace(':path*',input.pathname.slice(rule.source.split(':path*')[0].length)));destination.search=input.search;return destination;
 }
 const destination=rewritten(url);
 assert.equal(destination.origin,'https://spabmyyxiufuzsaydrmx.supabase.co');
 assert.equal(destination.pathname,'/functions/v1/cos-dashboard/rest/v1/commitments');
 const makeRequest=(target,owner=true)=>new Request(target,{headers:{Origin:origin,...(owner?{Cookie:'__Host-cos-calendar-session='+token}:{})}});
 const anonymous=await fixture();assert.equal((await anonymous.handler(makeRequest(destination,false))).status,401);assert.equal(anonymous.calls.length,0);
 const locked=await fixture({unlocked:false});assert.equal((await locked.handler(makeRequest(destination))).status,423);assert.equal(locked.calls.length,0);
 const owner=await fixture();assert.equal((await owner.handler(makeRequest(destination))).status,200);assert.equal(owner.calls[0].url,'https://db.example.test/rest/v1/commitments'+url.search);
 const privateTarget=rewritten(new URL('/api/data/rest/v1/cos_calendar_sessions',origin));assert.equal((await owner.handler(makeRequest(privateTarget))).status,404);assert.equal(owner.calls.length,1);
 const cache=config.headers.find(r=>r.source==='/api/data/rest/v1/:path*');assert.ok(cache);assert.ok(cache.headers.some(h=>h.key==='Cache-Control'&&h.value.includes('no-store')));
});
