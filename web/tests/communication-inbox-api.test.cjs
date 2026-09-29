const test=require('node:test');const assert=require('node:assert/strict');
const ID='00000000-0000-4000-8000-000000000001',ORIGIN='https://chief-of-staff-v3-live.vercel.app',TOKEN='synthetic-inbox-cookie-0123456789012345678901234567';
async function fixture(){
 const {createNotesHandler}=await import('../../supabase/functions/cos-notes/handler.mjs');const {CommunicationInboxError}=await import('../../supabase/functions/cos-notes/communication-inbox.mjs');const calls=[];
 const store={async list(table){return table==='cos_calendar_connection'?[{google_sub:'owner'}]:[{google_sub:'owner',expires_at:'2027-01-01T00:00:00Z'}]}};
 const inbox={};for(const method of ['list','get','analyze','apply','defer'])inbox[method]=async(...args)=>{calls.push([method,...args]);return method==='list'?{items:[],nextOffset:null}:{item:{id:ID,revision:2,status:'ready'}}};inbox.audio=async id=>{calls.push(['audio',id]);return new Response(new Uint8Array([79,103,103,83]),{headers:{'Content-Type':'audio/ogg','Cache-Control':'private, no-store'}})};
 const handler=createNotesHandler({store,inbox,now:()=>new Date('2026-09-29T12:00:00Z')});
 const request=(path,{method='GET',owner=true,origin=ORIGIN,body}={})=>new Request(ORIGIN+'/api/notes'+path,{method,headers:{...(owner?{Cookie:'__Host-cos-calendar-session='+TOKEN}:{}),Origin:origin,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 return{handler,inbox,calls,request,CommunicationInboxError};
}
test('inbox source, analysis, confirmation and audio require existing owner session',async()=>{
 const f=await fixture();for(const [path,method]of [['/inbox','GET'],['/inbox/'+ID,'GET'],['/inbox/'+ID+'/audio','GET'],['/inbox/'+ID+'/apply','POST'],['/inbox/'+ID+'/analyze','POST']]){const response=await f.handler(f.request(path,{method,owner:false,body:method==='POST'?{revision:1}:undefined}));assert.equal(response.status,401)}assert.equal(f.calls.length,0);
});
test('inbox writes reject cross-origin requests and malformed route IDs before service',async()=>{
 const f=await fixture();assert.equal((await f.handler(f.request('/inbox/'+ID+'/apply',{method:'POST',origin:'https://evil.invalid',body:{revision:1}}))).status,403);assert.equal((await f.handler(f.request('/inbox/not-uuid'))).status,400);assert.equal(f.calls.length,0);
});
test('list passes server pagination and rejects unknown/duplicated query controls',async()=>{
 const f=await fixture();assert.equal((await f.handler(f.request('/inbox?status=deferred&limit=50&offset=50'))).status,200);assert.deepEqual(f.calls[0],['list',{status:'deferred',limit:50,offset:50}]);for(const suffix of ['?owner=email','?limit=1&limit=2','?limit=NaN'])assert.equal((await f.handler(f.request('/inbox'+suffix))).status,400);
});
test('confirmed body reaches exactly one service operation, audio is binary',async()=>{
 const f=await fixture();const body={revision:3,request_id:ID,proposal:{version:1,changes:[]}};const response=await f.handler(f.request('/inbox/'+ID+'/apply',{method:'POST',body}));assert.equal(response.status,200);assert.deepEqual(f.calls[0],['apply',ID,body]);const audio=await f.handler(f.request('/inbox/'+ID+'/audio'));assert.equal(audio.headers.get('Content-Type'),'audio/ogg');assert.equal(audio.headers.get('Cache-Control'),'private, no-store');assert.deepEqual([...new Uint8Array(await audio.arrayBuffer())],[79,103,103,83]);
});
test('service conflicts expose a safe stable code without private data',async()=>{
 const f=await fixture();f.inbox.apply=async()=>{throw new f.CommunicationInboxError(409,'inbox_conflict')};const response=await f.handler(f.request('/inbox/'+ID+'/apply',{method:'POST',body:{revision:1}}));assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:'inbox_conflict'});
});
