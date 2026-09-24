// Node.js 24 built-ins only. No network requests or real task deletions.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const ORIGIN='https://chief-of-staff-v3-live.vercel.app';
const TASK='12345678-abcd-4000-8000-000000000001';
const TOKEN='synthetic-owner-session-0123456789012345678901234567';
const TIME=new Date('2026-09-24T12:00:00Z');
async function fixture(){
  const [{createNotesHandler},{sha256}]=await Promise.all([import('../../supabase/functions/cos-notes/handler.mjs'),import('../../supabase/functions/cos-google-calendar/google.mjs')]);
  const owner={google_sub:'owner',status:'disconnected'},session={google_sub:'owner',expires_at:'2026-09-25T12:00:00Z'},calls=[];
  const hash=await sha256(TOKEN);
  const store={
    async list(table,query){
      calls.push({operation:'list',table,query});
      if(table==='cos_calendar_connection')return[owner];
      assert.equal(table,'cos_calendar_sessions');
      assert.equal(new URLSearchParams(query).get('token_hash'),'eq.'+hash);
      return[session];
    },
    async rpc(name,args){calls.push({operation:'rpc',name,args});return{ok:true,id:args.p_id}},
  };
  const handler=createNotesHandler({store,now:()=>TIME});
  const request=({method='DELETE',id=TASK,suffix='',body={version:7},origin=ORIGIN,authenticated=true,contentType='application/json',base='/api/notes',headers={}}={})=>new Request(ORIGIN+base+'/tasks/'+id+suffix,{
    method,headers:{...headers,...(authenticated?{Cookie:'__Host-cos-calendar-session='+TOKEN}:{}),...(origin===null?{}:{Origin:origin}),...(contentType?{'Content-Type':contentType}:{})},
    ...(['GET','HEAD'].includes(method)||body===undefined?{}:{body:JSON.stringify(body)}),
  });
  return{handler,request,store,calls,owner,session};
}
const mutations=f=>f.calls.filter(call=>call.operation==='rpc');

test('task deletion requires the exact origin and verified unexpired owner session before mutation',async()=>{
  const f=await fixture();
  for(const origin of [null,'https://evil.invalid',ORIGIN+'.evil.invalid']){
    const response=await f.handler(f.request({origin}));assert.equal(response.status,403);assert.deepEqual(await response.json(),{error:'invalid_origin'});
  }
  const response=await f.handler(f.request({authenticated:false,headers:{apikey:'public',Authorization:'Bearer public','X-Owner-Email':'owner@example.test'}}));
  assert.equal(response.status,401);assert.deepEqual(await response.json(),{error:'unauthorized'});assert.equal(f.calls.length,0);
  for(const change of [{google_sub:'someone-else'},{expires_at:TIME.toISOString()}]){
    const item=await fixture();Object.assign(item.session,change);assert.equal((await item.handler(item.request())).status,401);assert.equal(mutations(item).length,0);
  }
});

test('task deletion accepts only DELETE, valid UUID, no query string and exact bounded integer version',async()=>{
  const f=await fixture();
  for(const method of ['GET','PATCH','POST','PUT','OPTIONS'])assert.equal((await f.handler(f.request({method}))).status,405);
  for(const id of ['bad-id','123','00000000-0000-4000-8000-00000000000z'])assert.equal((await f.handler(f.request({id}))).status,400);
  assert.equal((await f.handler(f.request({suffix:'?force=true'}))).status,400);
  assert.equal((await f.handler(f.request({contentType:'text/plain'}))).status,415);
  for(const body of [{},{version:0},{version:-1},{version:1.5},{version:'7'},{version:null},{version:true},{version:2147483647},{version:Number.MAX_SAFE_INTEGER},{version:7,deleted_at:'2026-09-24'},{version:7,id:TASK},[],null]){
    assert.equal((await f.handler(f.request({body}))).status,400,JSON.stringify(body));
  }
  assert.equal(mutations(f).length,0);
});

test('owner deletion uses one atomic RPC and returns only a confirmed matching task identifier',async()=>{
  for(const base of ['/api/notes','/functions/v1/cos-notes','/cos-notes']){
    const f=await fixture();f.store.rpc=async(name,args)=>{f.calls.push({operation:'rpc',name,args});return{ok:true,id:args.p_id,private_record:'must never be returned'}};
    const response=await f.handler(f.request({id:TASK.toUpperCase(),base}));assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{ok:true,id:TASK});assert.deepEqual(mutations(f),[{operation:'rpc',name:'cos_delete_task',args:{p_id:TASK,p_version:7}}]);
    assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.get('Access-Control-Allow-Origin'),null);
  }
  const f=await fixture();for(const version of [1,2147483646])assert.equal((await f.handler(f.request({body:{version}}))).status,200);
});

test('task RPC status codes map to distinct safe errors without leaking database messages',async()=>{
  for(const [code,status,error] of [['PT400',400,'invalid_task_delete'],['PT404',404,'task_not_found'],['PT409',409,'task_version_conflict'],['PT423',409,'task_timer_running'],['PT410',409,'task_deleted'],['42501',503,'notes_unavailable'],['23503',503,'notes_unavailable'],['__proto__',503,'notes_unavailable'],['constructor',503,'notes_unavailable']]){
    const f=await fixture();f.store.rpc=async()=>{throw Object.assign(Error('PRIVATE DB ERROR AND OWNER DATA'),{code})};
    const response=await f.handler(f.request());assert.equal(response.status,status,code);assert.deepEqual(await response.json(),{error});
  }
});

test('ambiguous or mismatched RPC responses are never reported as deleted; safe retry is passed to the RPC',async()=>{
  for(const result of [undefined,null,{},[],{ok:false,id:TASK},{ok:1,id:TASK},{ok:true,id:'00000000-0000-4000-8000-000000000001'}]){
    const f=await fixture();f.store.rpc=async()=>result;const response=await f.handler(f.request());assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'notes_unavailable'});
  }
  const f=await fixture();for(let attempt=0;attempt<2;attempt++)assert.deepEqual(await (await f.handler(f.request())).json(),{ok:true,id:TASK});
  assert.equal(mutations(f).length,2);assert.deepEqual(mutations(f)[0].args,mutations(f)[1].args);
});
