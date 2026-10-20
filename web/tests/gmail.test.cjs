const test=require('node:test');const assert=require('node:assert/strict');
const path=require('node:path');const fs=require('node:fs');
const base='../../supabase/functions/cos-gmail/';
const NOW=new Date('2026-10-20T18:00:00Z');
const encode=text=>Buffer.from(text).toString('base64url');
function message(id,date,text='Пришлю образец завтра.',from='Антон <anton@example.com>',labels=['Label_work']){return{id,threadId:'thread1',internalDate:String(+new Date(date)),labelIds:labels,payload:{mimeType:'text/plain',headers:[{name:'From',value:from},{name:'To',value:'Owner <owner@example.com>'},{name:'Subject',value:'Образец'}],body:{data:encode(text)}}};}
const clone=v=>JSON.parse(JSON.stringify(v));
function memory(initial={}){
 const db=clone(initial),calls=[];
 const matching=(table,q)=>{const params=new URLSearchParams(q);let rows=[...(db[table]||[])];const field=(r,k)=>k.split(/->>?/).reduce((value,key)=>value?.[key],r);for(const [k,v]of params){if(['select','limit','order','offset'].includes(k))continue;if(k==='or'){rows=rows.filter(r=>v.slice(1,-1).split(',').some(condition=>condition.endsWith('.is.null')?field(r,condition.slice(0,-8))==null:condition.endsWith('.eq.1')&&String(field(r,condition.slice(0,-5)))==='1'));continue;}if(v.startsWith('eq.'))rows=rows.filter(r=>String(field(r,k))===v.slice(3));if(v.startsWith('gt.'))rows=rows.filter(r=>field(r,k)>v.slice(3));if(v.startsWith('in.'))rows=rows.filter(r=>v.slice(4,-1).split(',').includes(String(field(r,k))));}return rows.slice(0,Number(params.get('limit')||1000));};
 return {db,calls,async page(t,q){calls.push(['page',t,q]);return clone(matching(t,q))},async list(t,q){return this.page(t,q)},async insert(t,v){calls.push(['insert',t]);(db[t]??=[]).push(clone(v));return clone(v)},async patch(t,q,v){calls.push(['patch',t,clone(v)]);const rows=matching(t,q);for(const r of rows)Object.assign(r,clone(v));return clone(rows)},async upsert(t,v,key){const r=(db[t]||[]).find(r=>r[key]===v[key]);if(r){Object.assign(r,clone(v));return clone(r)}return this.insert(t,v)},async remove(t,q){const rows=matching(t,q);db[t]=(db[t]||[]).filter(r=>!rows.includes(r));return clone(rows)},async rpc(name,args){calls.push(['rpc',name,clone(args)]);if(name==='cos_gmail_claim_lock')return true;if(name==='cos_gmail_release_lock')return null;if(name==='cos_gmail_capture')return {item:{id:'11111111-1111-4111-8111-111111111111',revision:1},duplicate:false};throw Error(name)}};
}
test('empty scope fails closed; settings reject search operators and broad domains',async()=>{
 const m=await import(base+'mail.mjs');assert.throws(()=>m.settings({...m.DEFAULT_SETTINGS,enabled:true}),/scope_required/);assert.throws(()=>m.settings({...m.DEFAULT_SETTINGS,emails:['example.com']}),/invalid_settings/);assert.throws(()=>m.settings({...m.DEFAULT_SETTINGS,emails:['a@example.com OR in:all']}),/invalid_settings/);assert.equal(m.settings({...m.DEFAULT_SETTINGS,emails:['A@example.com']}).emails[0],'a@example.com');
});
test('scope is exact approved address or label; spam trash draft excluded',async()=>{
 const m=await import(base+'mail.mjs'),config={...m.DEFAULT_SETTINGS,emails:['anton@example.com']};
 assert.equal(m.inScope([message('1',NOW,'x','Антон <notanton@example.com>',[])],config),false);
 assert.equal(m.inScope([message('1',NOW,'x','Антон <anton@example.com>',[])],config),true);
 assert.equal(m.inScope([message('1',NOW,'x','Антон <anton@example.com>',['TRASH'])],config),false);
});
test('body selection uses 90-day boundary and latest ten incl sent, not all thread bodies',async()=>{
 const m=await import(base+'mail.mjs');const rows=Array.from({length:15},(_,i)=>message(String(i),new Date(+NOW-i*86400000),'x','owner@example.com',['SENT']));rows.push(message('old',new Date(+NOW-91*86400000)));
 const selected=m.selectMessages(rows,{now:NOW});assert.equal(selected.selected.length,10);assert.equal(selected.eligible,15);assert.equal(selected.omitted,6);assert.equal(selected.selected.at(-1).id,'0');assert.ok(!selected.selected.some(x=>x.id==='old'));
 assert.throws(()=>m.selectMessages(rows,{contextDays:365}),/invalid_depth/);
});
test('Gmail search uses epoch seconds, not Gmail PST date strings',async()=>{
 const m=await import(base+'mail.mjs');const q=m.searchQuery({...m.DEFAULT_SETTINGS,emails:['a@example.com']},NOW);assert.match(q,/after:\d+ -in:spam -in:trash -in:drafts/);assert.ok(q.includes(String(Math.floor((+NOW-30*86400000)/1000))));
});
test('MIME keeps one alternative, ignores attachments and never returns executable HTML',async()=>{
 const {messageText}=await import(base+'mail.mjs');const body=message('1',NOW);body.payload={mimeType:'multipart/mixed',parts:[{mimeType:'multipart/alternative',parts:[{mimeType:'text/plain',body:{data:encode('Ответ\n> цитата\nВстроенный ответ')}},{mimeType:'text/html',body:{data:encode('<script>bad()</script><p>Duplicate</p>')}}]},{mimeType:'application/pdf',filename:'offer.pdf',body:{data:encode('SECRET FILE CONTENT')}}]};
 const result=messageText(body);assert.match(result.text,/Встроенный ответ/);assert.doesNotMatch(result.text,/SECRET|Duplicate/);assert.deepEqual(result.attachments,['offer.pdf']);
 body.payload={mimeType:'text/html',body:{data:encode('<script>alert(1)</script><p>Привет &amp; спасибо</p><img src="https://tracking.invalid/pixel">')}};assert.equal(messageText(body).text,'Привет & спасибо');
});
test('snapshot identifies new email and reports incomplete history/oversized text',async()=>{
 const m=await import(base+'mail.mjs');const messages=[message('old',new Date(+NOW-86400000)),message('new',NOW,'a'.repeat(15000))];const selection=m.selectMessages(messages,{now:NOW});const s=m.snapshot(messages,{threadId:'thread1',selection,ownerEmail:'owner@example.com',processedIds:['old']});assert.deepEqual(s.meta.new_message_ids,['new']);assert.equal(s.meta.partial,true);assert.equal(s.meta.messages[1].truncated,true);assert.ok(s.source.length<64000);assert.equal(s.meta.messages[0].date,'2026-10-19T18:00:00.000Z');
});
test('client cannot POST, follow links or fetch attachments',async()=>{
 const {createMailClient}=await import(base+'client.mjs');const calls=[];const api=createMailClient('token',{fetchImpl:async(url,init)=>{calls.push([url.toString(),init]);return new Response('{}')}});await api.thread('thread1');assert.match(calls[0][0],/format=metadata/);assert.equal(calls[0][1].method,'GET');assert.equal(calls[0][1].redirect,'error');await assert.rejects(api.get('https://evil.invalid'),/invalid_gmail_path/);await assert.rejects(api.get('messages/x/attachments/y'),/invalid_gmail_path/);
});
test('Gmail OAuth uses same registered callback but only readonly Gmail scopes',async()=>{
 const {createGoogle,CALLBACK_URL}=await import('../../supabase/functions/cos-google-calendar/google.mjs');const {GMAIL_SCOPES}=await import(base+'mail.mjs');const g=createGoogle({config:{clientId:'id',clientSecret:'secret',allowedEmail:'owner@example.com'},scopes:GMAIL_SCOPES});const u=new URL(await g.authorizationUrl({state:'gmail.'+'s'.repeat(40),verifier:'v'.repeat(64)}));assert.equal(u.searchParams.get('redirect_uri'),CALLBACK_URL);assert.match(u.searchParams.get('scope'),/gmail.readonly/);assert.doesNotMatch(u.searchParams.get('scope'),/calendar|gmail.modify|gmail.send/);assert.equal(u.searchParams.get('code_challenge_method'),'S256');
});
test('pending review blocks body download and preserves editor',async()=>{
 const {importThread}=await import(base+'sync.mjs');const m=await import(base+'mail.mjs');let bodies=0;const store=memory({cos_communication_inbox:[{id:'pending',status:'ready'}]});const result=await importThread({store,mail:{thread:async()=>({messages:[message('new',NOW)]}),message:async()=>{bodies++;}},connection:{settings:{...m.DEFAULT_SETTINGS,label_ids:['Label_work']}},thread:{thread_id:'thread1',inbox_id:'pending',context_days:90,message_limit:10,message_ids:['previous']},now:()=>NOW});assert.equal(result.waiting,true);assert.equal(bodies,0);assert.equal(store.calls.some(c=>c[0]==='rpc'),false);
});
test('import only downloads selected IDs; previously reviewed IDs are context only',async()=>{
 const {importThread}=await import(base+'sync.mjs'),m=await import(base+'mail.mjs');const rows=Array.from({length:12},(_,i)=>message(String(i),new Date(+NOW-(11-i)*86400000)));const read=[];const store=memory({cos_communication_inbox:[{id:'done',status:'applied'}]});await importThread({store,mail:{thread:async()=>({messages:rows,historyId:'123'}),message:async id=>{read.push(id);return rows.find(r=>r.id===id)}},connection:{email:'owner@example.com',settings:{...m.DEFAULT_SETTINGS,label_ids:['Label_work']}},thread:{thread_id:'thread1',inbox_id:'done',context_days:90,message_limit:10,message_ids:rows.slice(0,-1).map(r=>r.id),processed_ids:[]},now:()=>NOW});assert.equal(read.length,10);assert.equal(read.includes('0'),false);const args=store.calls.find(c=>c[1]==='cos_gmail_capture')[2];assert.deepEqual(args.p_meta.new_message_ids,['11']);
});
test('out of scope thread never downloads bodies',async()=>{
 const {importThread}=await import(base+'sync.mjs'),m=await import(base+'mail.mjs');let bodies=0;const store=memory();await importThread({store,mail:{thread:async()=>({messages:[message('new',NOW,'x','other@example.com',[])]}),message:async()=>{bodies++}},connection:{settings:{...m.DEFAULT_SETTINGS,emails:['approved@example.com']}},thread:{thread_id:'thread1'},now:()=>NOW});assert.equal(bodies,0);
});
test('expired history starts bounded initial discovery and captures a fresh anchor first',async()=>{
 const {discover}=await import(base+'sync.mjs'),m=await import(base+'mail.mjs');const store=memory({cos_gmail_connection:[{id:'owner'}]});const calls=[];await discover({store,connection:{settings:{...m.DEFAULT_SETTINGS,label_ids:['Label_work']},cursor:{mode:'history',history_id:'expired'}},mail:{profile:async()=>{calls.push('profile');return {historyId:'fresh'}},get:async(path,params)=>{calls.push([path,params]);if(path==='history')throw {status:404};return {threads:[{id:'thread1'}]}}},now:()=>NOW});assert.equal(calls[1],'profile');assert.deepEqual(store.db.cos_gmail_connection[0].cursor,{mode:'history',history_id:'fresh'});assert.equal(store.db.cos_gmail_threads[0].pending,true);
});
test('history first persists IDs; unrelated mail never takes a pilot slot',async()=>{
 const {discover}=await import(base+'sync.mjs'),m=await import(base+'mail.mjs');const store=memory({cos_gmail_connection:[{id:'owner'}]});let connection={settings:{...m.DEFAULT_SETTINGS,label_ids:['Label_work']},cursor:{mode:'history',history_id:'1'}};const mail={get:async()=>({historyId:'2',history:[{messagesAdded:[{message:{threadId:'unrelated'}}]}]}),thread:async()=>({messages:[message('id',NOW,'x','stranger@example.com',[])]})};await discover({store,connection,mail,now:()=>NOW});assert.equal(store.db.cos_gmail_connection[0].cursor.mode,'candidates');connection.cursor=store.db.cos_gmail_connection[0].cursor;await discover({store,connection,mail,now:()=>NOW});assert.equal(store.db.cos_gmail_threads,undefined);assert.equal(store.db.cos_gmail_connection[0].cursor.history_id,'2');
});
test('mail evidence is dated by its own message and cannot be forged or repeated',async()=>{
 const m=await import(base+'mail.mjs'),{mailEvidence}=await import('../../supabase/functions/cos-notes/communication-mail.mjs');const rows=[message('a','2026-10-01T12:00:00Z')],s=m.snapshot(rows,{threadId:'thread1',selection:{total:1,omitted:0},ownerEmail:'owner@example.com'}),item={source_text:s.source,source_meta:s.meta};const value={source_message_id:'a',trigger_message_id:'a',evidence:'Пришлю образец завтра.',trigger_evidence:'Пришлю образец завтра.',participant_email:'anton@example.com'};assert.equal(mailEvidence(value,item,{participants:[]}).date,'2026-10-01T12:00:00.000Z');assert.throws(()=>mailEvidence({...value,evidence:'invented'},item,{}),/invalid_mail_evidence/);item.source_meta.new_message_ids=[];assert.throws(()=>mailEvidence(value,item,{}),/invalid_mail_evidence/);
});
test('normalizer resolves tomorrow from source email, not the import day',async()=>{
 const m=await import(base+'mail.mjs'),{normalizeInboxProposal}=await import('../../supabase/functions/cos-notes/communication-inbox.mjs');const rows=[message('a','2026-10-01T12:00:00Z')],s=m.snapshot(rows,{threadId:'thread1',selection:{total:1,omitted:0},ownerEmail:'owner@example.com'});const proposal=normalizeInboxProposal({summary:'',questions:[],changes:[{kind:'task_create',text:'Получить образец',evidence:'Пришлю образец завтра.',source_message_id:'a',trigger_message_id:'a',trigger_evidence:'Пришлю образец завтра.',participant_email:'anton@example.com',participant_name:'Антон',date_text:'завтра',date_status:'explicit',direction:'to_me',agreement:'agreed'}]},{item:{source_text:s.source,source_meta:s.meta,created_at:NOW.toISOString()},context:{projects:[],participants:[],tasks:[],briefs:[]},timeZone:'Europe/Moscow'});assert.equal(proposal.changes[0].deadline,'2026-10-02');assert.equal(proposal.changes[0].participant_suggestion.email,'anton@example.com');
});
test('Gmail handler denies reads and CSRF writes without owner session',async()=>{
 const {createGmailHandler}=await import(base+'handler.mjs');const store=memory({cos_gmail_connection:[{id:'owner',google_sub:'owner'}]});const h=createGmailHandler({store,config:{cronSecret:'cron'},google:{},now:()=>NOW});const status=await h(new Request('https://app.test/gmail/status'));assert.deepEqual(await status.json(),{authenticated:false,configured:true});assert.equal((await h(new Request('https://app.test/gmail/settings',{method:'POST',headers:{Origin:'https://evil.invalid'},body:'{}'}))).status,403);assert.equal((await h(new Request('https://app.test/gmail/tick',{method:'POST'}))).status,401);assert.equal(store.calls.some(c=>c[1]==='cos_gmail_threads'),false);
});
test('Gmail settings UI escapes labels and keeps AI opt-in unchecked by default',()=>{
 const ui=require('../gmail.js');const html=ui.render({authenticated:true,connection:{email:'owner@example.com',status:'connected'},settings:{label_ids:[],emails:[],enabled:false,ai_consent:false}},[{id:'Label_1',name:'<script>alert(1)</script>'}]);assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/name="ai" checked/);assert.match(html,/OpenRouter/);assert.match(html,/90 дней/);
});
test('mail schema keeps tokens and source bodies private and uses invoker RPCs',()=>{
 const sql=fs.readFileSync(path.join(__dirname,'../../supabase/gmail-schema.sql'),'utf8');assert.doesNotMatch(sql,/security definer/i);for(const t of ['connection','oauth_states','lock','threads','people'])assert.ok(sql.includes(`alter table public.cos_gmail_${t} enable row level security`));assert.match(sql,/from public,anon,authenticated/);
});
test('analysis consent is checked before model or state mutation; superseded mail is blocked',async()=>{
 const {createCommunicationInbox}=await import('../../supabase/functions/cos-notes/communication-inbox.mjs');const id='11111111-1111-4111-8111-111111111111';let called=false;
 const store=memory({cos_communication_inbox:[{id,revision:1,status:'captured',source_meta:{type:'gmail'}}],cos_gmail_connection:[{id:'owner',settings:{ai_consent:false}}]});const inbox=createCommunicationInbox({store,model:()=>{called=true}});
 await assert.rejects(inbox.analyze(id,{revision:1}),e=>e.code==='analysis_consent_required');assert.equal(called,false);assert.equal(store.calls.some(c=>c[0]==='rpc'),false);
 store.db.cos_communication_inbox[0].source_meta.superseded=true;
 await assert.rejects(inbox.analyze(id,{revision:1}),e=>e.code==='source_superseded');
 await assert.rejects(inbox.apply(id,{revision:1,request_id:'22222222-2222-4222-8222-222222222222',proposal:{}}),e=>e.code==='source_superseded');
});
test('proposed reschedule cannot replace an agreed task deadline',async()=>{
 const m=await import(base+'mail.mjs'),{normalizeInboxProposal}=await import('../../supabase/functions/cos-notes/communication-inbox.mjs');const rows=[message('a','2026-10-01T12:00:00Z','Предлагаю прислать образец завтра.')],s=m.snapshot(rows,{threadId:'thread1',selection:{total:1,omitted:0},ownerEmail:'owner@example.com'});const task='33333333-3333-4333-8333-333333333333';const p=normalizeInboxProposal({summary:'Предложен перенос',questions:[],changes:[{kind:'task_update',task_id:task,text:'Получить образец',evidence:'Предлагаю прислать образец завтра.',source_message_id:'a',trigger_evidence:'Предлагаю прислать образец завтра.',date_text:'завтра',date_status:'explicit',agreement:'proposed',status:'open'}]},{item:{source_text:s.source,source_meta:s.meta,created_at:NOW.toISOString()},context:{projects:[],participants:[],tasks:[{id:task,description:'Получить образец',status:'open',deadline:'2026-10-05',cos_version:1}],briefs:[]},timeZone:'Europe/Moscow'});assert.equal(p.changes[0].deadline,'2026-10-05');assert.equal(p.changes[0].date_intent,false);
});
test('real REST store uses thread_id ordering for Gmail tables without id columns',async()=>{
 const {createStore}=await import('../../supabase/functions/cos-google-calendar/store.mjs');let url;
 const store=createStore({url:'https://db.example.com',serviceKey:'synthetic-service-key',fetchImpl:async(u)=>{url=new URL(u);return new Response('[]',{headers:{'content-type':'application/json'}})}});
 await store.page('cos_gmail_threads','thread_id=eq.thread1&limit=1');assert.equal(url.searchParams.get('order'),'thread_id.asc');
});

test('failed sign-in returns to Gmail settings instead of displaying raw JSON; logs omit secrets',async()=>{
 const {createGmailHandler}=await import(base+'handler.mjs'),{APP_ORIGIN}=await import('../../supabase/functions/cos-google-calendar/google.mjs');
 const logs=[],store=memory();store.insert=async()=>{throw Object.assign(Error('private-token-and-email'),{code:'STORE_TIMEOUT',status:0})};
 const h=createGmailHandler({store,google:{},config:{},now:()=>NOW,logger:{error:v=>logs.push(v)}});
 const r=await h(new Request(APP_ORIGIN+'/api/gmail/start',{method:'POST',headers:{Origin:APP_ORIGIN}}));
 assert.equal(r.status,303);const target=new URL(r.headers.get('Location'));assert.equal(target.origin,APP_ORIGIN);assert.equal(target.searchParams.get('gmail'),'error');assert.equal(target.searchParams.get('reason'),'gmail_temporarily_unavailable');assert.equal(target.hash,'#/inbox');assert.match(r.headers.get('Set-Cookie'),/Max-Age=0/);
 assert.deepEqual(JSON.parse(logs[0]),{component:'gmail',stage:'start',code:'STORE_TIMEOUT',status:0});assert.doesNotMatch(logs.join(''),/private-token-and-email/);
});

test('callback state-store failure is awaited and safely returns to the app',async()=>{
 const {createGmailHandler}=await import(base+'handler.mjs');const store=memory();store.remove=async()=>{throw Object.assign(Error('private database detail'),{code:'42P01',status:404})};const logs=[];
 const h=createGmailHandler({store,google:{},config:{},logger:{error:v=>logs.push(v)}});
 const r=await h(new Request('https://app.test/gmail/callback?state=gmail.synthetic&code=secret-code',{headers:{Cookie:'__Host-cos-gmail-flow=synthetic-browser'}}));
 assert.equal(r.status,303);assert.equal(new URL(r.headers.get('Location')).searchParams.get('reason'),'gmail_request_failed');assert.equal(JSON.parse(logs[0]).stage,'callback');assert.equal(JSON.parse(logs[0]).code,'42P01');assert.doesNotMatch(logs.join(''),/secret-code|synthetic-browser|private database detail/);
});

test('async labels failure is caught inside Gmail, retaining the actionable Google reason',async()=>{
 const {createGmailHandler}=await import(base+'handler.mjs'),{APP_ORIGIN,sha256,encryptSecret}=await import('../../supabase/functions/cos-google-calendar/google.mjs');
 const key=Buffer.alloc(32,7).toString('base64');const store=memory({cos_gmail_connection:[{id:'owner',google_sub:'owner',status:'connected',refresh_token_cipher:await encryptSecret('synthetic-refresh',key)}],cos_calendar_sessions:[{token_hash:await sha256('synthetic-session'),google_sub:'owner',expires_at:'2026-10-21T18:00:00Z'}]});
 const logs=[],h=createGmailHandler({store,config:{tokenKey:key},google:{refresh:async()=>{throw {reason:'invalid_client',status:401}}},now:()=>NOW,logger:{error:v=>logs.push(v)}});
 const r=await h(new Request(APP_ORIGIN+'/api/gmail/labels',{method:'POST',headers:{Origin:APP_ORIGIN,Cookie:'__Host-cos-calendar-session=synthetic-session'},body:'{}'}));
 assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:'invalid_client'});assert.equal(JSON.parse(logs[0]).stage,'labels');assert.ok(store.calls.some(c=>c[1]==='cos_gmail_release_lock'));
});

test('Gmail start and callback preserve browser binding and create an owner session',async()=>{
 const {createGmailHandler}=await import(base+'handler.mjs'),{APP_ORIGIN}=await import('../../supabase/functions/cos-google-calendar/google.mjs');const store=memory();let auth;
 const google={authorizationUrl:async args=>{auth=args;return 'https://accounts.google.com/synthetic'},exchangeCode:async args=>{assert.equal(args.verifier,auth.verifier);return {access_token:'synthetic-access',refresh_token:'synthetic-refresh'}},userInfo:async()=>({sub:'owner',email:'owner@example.com',email_verified:true})};
 const h=createGmailHandler({store,google,config:{allowedEmail:'owner@example.com',tokenKey:Buffer.alloc(32,7).toString('base64')},now:()=>NOW});
 const start=await h(new Request(APP_ORIGIN+'/api/gmail/start',{method:'POST',headers:{Origin:APP_ORIGIN}}));assert.equal(start.status,303);const browser=start.headers.get('Set-Cookie').split(';')[0];
 const callback=await h(new Request(APP_ORIGIN+'/api/google-calendar/callback?state='+auth.state+'&code=synthetic-code',{headers:{Cookie:browser}}));assert.equal(callback.status,303);assert.equal(new URL(callback.headers.get('Location')).searchParams.get('gmail'),'connected');assert.match(callback.headers.get('Set-Cookie'),/__Host-cos-calendar-session=/);assert.equal(store.db.cos_gmail_connection[0].status,'connected');assert.equal(store.db.cos_calendar_sessions.length,1);assert.equal(store.db.cos_gmail_oauth_states.length,0);
 const replay=await h(new Request(APP_ORIGIN+'/api/google-calendar/callback?state='+auth.state+'&code=synthetic-code',{headers:{Cookie:browser}}));assert.equal(new URL(replay.headers.get('Location')).searchParams.get('reason'),'invalid_state');
});

async function workMailboxLogin({identity={sub:'work-sub',email:'work@example.com',email_verified:true},existingMail}={}){
 const {createGmailHandler}=await import(base+'handler.mjs'),{APP_ORIGIN,sha256}=await import('../../supabase/functions/cos-google-calendar/google.mjs');
 const personal={id:'owner',google_sub:'personal-sub',email:'personal@example.com',status:'needs_reconnect',refresh_token_cipher:'unchanged-personal-cipher',calendar_id:'personal-calendar'};
 const store=memory({cos_calendar_connection:[personal],cos_calendar_sessions:[{token_hash:await sha256('previous-personal-session'),google_sub:'personal-sub',expires_at:'2026-10-21T18:00:00Z'}],...(existingMail?{cos_gmail_connection:[existingMail]}:{})});let auth;
 const google={authorizationUrl:async args=>{auth=args;return 'https://accounts.google.com/synthetic'},exchangeCode:async()=>({access_token:'synthetic-access',refresh_token:'synthetic-refresh'}),userInfo:async()=>identity};
 const h=createGmailHandler({store,google,config:{allowedEmail:'work@example.com',tokenKey:Buffer.alloc(32,7).toString('base64')},now:()=>NOW});
 const start=await h(new Request(APP_ORIGIN+'/api/gmail/start',{method:'POST',headers:{Origin:APP_ORIGIN}}));
 assert.equal(new URL(start.headers.get('Location')).searchParams.get('login_hint'),'work@example.com');
 const r=await h(new Request(APP_ORIGIN+'/api/google-calendar/callback?state='+auth.state+'&code=synthetic-code',{headers:{Cookie:start.headers.get('Set-Cookie').split(';')[0]}}));
 return {store,h,r,personal,APP_ORIGIN};
}

test('work Gmail creates a shared app session without changing the personal calendar',async()=>{
 const {store,h,r,personal,APP_ORIGIN}=await workMailboxLogin();
 assert.equal(new URL(r.headers.get('Location')).searchParams.get('gmail'),'connected');
 assert.equal(store.db.cos_gmail_connection[0].google_sub,'work-sub');assert.equal(store.db.cos_gmail_connection[0].email,'work@example.com');
 assert.equal(store.db.cos_calendar_sessions.at(-1).google_sub,'personal-sub');assert.deepEqual(store.db.cos_calendar_connection,[personal]);
 const Cookie=r.headers.getSetCookie().find(c=>c.startsWith('__Host-cos-calendar-session=')).split(';')[0];
 const status=await h(new Request(APP_ORIGIN+'/api/gmail/status',{headers:{Cookie}}));assert.equal((await status.json()).authenticated,true);
 const previous=await h(new Request(APP_ORIGIN+'/api/gmail/status',{headers:{Cookie:'__Host-cos-calendar-session=previous-personal-session'}}));assert.equal((await previous.json()).authenticated,true);
 const {createNotesHandler}=await import('../../supabase/functions/cos-notes/handler.mjs');
 const notes=createNotesHandler({store,now:()=>NOW});assert.equal((await notes(new Request(APP_ORIGIN+'/api/notes',{headers:{Cookie}}))).status,200);
 const {createHandler}=await import('../../supabase/functions/cos-google-calendar/handler.mjs');
 const calendar=createHandler({store,google:{},config:{},now:()=>NOW});const calendarStatus=await calendar(new Request(APP_ORIGIN+'/api/google-calendar/status',{headers:{Cookie}}));
 const data=await calendarStatus.json();assert.equal(data.authenticated,true);assert.equal(data.connection.email,'personal@example.com');
 await h(new Request(APP_ORIGIN+'/api/gmail/disconnect',{method:'POST',headers:{Cookie,Origin:APP_ORIGIN},body:'{}'}));
 assert.deepEqual(store.db.cos_calendar_connection,[personal]);assert.equal(store.db.cos_gmail_connection[0].refresh_token_cipher,null);assert.equal((await notes(new Request(APP_ORIGIN+'/api/notes',{headers:{Cookie}}))).status,200);
});

test('separate mailbox support still denies unapproved, unverified or replaced identities',async()=>{
 for(const [identity,existingMail] of [
  [{sub:'personal-sub',email:'personal@example.com',email_verified:true}],
  [{sub:'coworker',email:'colleague@example.com',email_verified:true}],
  [{sub:'work-sub',email:'work@example.com',email_verified:false}],
  [{sub:'replacement-sub',email:'work@example.com',email_verified:true},{id:'owner',google_sub:'work-sub',email:'work@example.com'}]
 ]){
  const {store,r,personal}=await workMailboxLogin({identity,existingMail});
  assert.equal(new URL(r.headers.get('Location')).searchParams.get('reason'),'wrong_account');assert.equal(store.db.cos_calendar_sessions.length,1);assert.deepEqual(store.db.cos_calendar_connection,[personal]);assert.equal(store.db.cos_gmail_connection?.length||0,existingMail?1:0);
 }
});

test('mailbox subject alone is not a valid shared owner session when a calendar owner exists',async()=>{
 const {store,h,APP_ORIGIN}=await workMailboxLogin();const {sha256}=await import('../../supabase/functions/cos-google-calendar/google.mjs');
 store.db.cos_calendar_sessions.push({token_hash:await sha256('wrong-sub-session'),google_sub:'work-sub',expires_at:'2026-10-21T18:00:00Z'});
 const result=await h(new Request(APP_ORIGIN+'/api/gmail/status',{headers:{Cookie:'__Host-cos-calendar-session=wrong-sub-session'}}));assert.equal((await result.json()).authenticated,false);
});

test('mail quotes restore exact whitespace without accepting changed words or cross-message joins',async()=>{
 const {exactMailQuote,restoreMailEvidence,mailEvidence}=await import('../../supabase/functions/cos-notes/communication-mail.mjs');
 const source='📦 Заказ\u00a0нужно\r\nсобрать.\nСрок:\tчетверг.';
 assert.equal(exactMailQuote(source,'Заказ нужно собрать.'),'Заказ\u00a0нужно\r\nсобрать.');
 assert.equal(exactMailQuote(source,'📦 Заказ нужно собрать.'),'📦 Заказ\u00a0нужно\r\nсобрать.');
 assert.equal(exactMailQuote(source,'Заказ можно собрать.'),null);
 assert.equal(exactMailQuote(source,'Заказ нужно собрать. Срок: пятница.'),null);
 const item={source_text:source,source_meta:{type:'gmail',messages:[{id:'a',start:0,end:source.length,date:NOW.toISOString()}],new_message_ids:['a']}};
 const value=restoreMailEvidence({source_message_id:'a',evidence:'Заказ нужно собрать.',trigger_evidence:'Срок: четверг.'},item);
 assert.equal(mailEvidence(value,item,{}).message_id,'a');
 const other={source_text:'Собрать заказ. Прислать образец.',source_meta:{type:'gmail',messages:[{id:'a',start:0,end:14},{id:'b',start:14,end:31}],new_message_ids:['b']}};
 const joined=restoreMailEvidence({source_message_id:'a',trigger_message_id:'b',evidence:'Собрать заказ. Прислать образец.',trigger_evidence:'Прислать образец.'},other);
 assert.throws(()=>mailEvidence(joined,other,{}),/invalid_mail_evidence/);
});

test('normalizer retains all supported changes from HTML email whitespace',async()=>{
 const m=await import(base+'mail.mjs'),{normalizeInboxProposal}=await import('../../supabase/functions/cos-notes/communication-inbox.mjs');
 const s=m.snapshot([message('a',NOW,'Пришлю\u00a0образец\r\nзавтра.')],{threadId:'thread1',selection:{total:1,omitted:0},ownerEmail:'owner@example.com'});
 const p=normalizeInboxProposal({summary:'Образец',changes:[{kind:'task_create',text:'Получить образец',source_message_id:'a',evidence:'Пришлю образец завтра.',trigger_evidence:'Пришлю образец завтра.',date_text:'завтра',date_status:'explicit'}]},{item:{source_text:s.source,source_meta:s.meta,created_at:NOW.toISOString()},context:{projects:[],participants:[],tasks:[],briefs:[]}});
 assert.equal(p.changes.length,1);assert.equal(p.changes[0].deadline,'2026-10-21');assert.ok(s.source.includes(p.changes[0].evidence));
});

test('recover cached Gmail analysis without another model request and respect consent and revision',async()=>{
 const {createCommunicationInbox}=await import('../../supabase/functions/cos-notes/communication-inbox.mjs');
 const id='11111111-1111-4111-8111-111111111111',source='Пришлю\u00a0образец завтра.';
 const original={id,revision:5,status:'error',error_code:'invalid_analysis',source_text:source,created_at:NOW.toISOString(),source_meta:{type:'gmail',messages:[{id:'a',start:0,end:source.length,date:NOW.toISOString()}],new_message_ids:['a']},proposal:{corrections:[],analysis:{usage:{cost:0.02},result:{summary:'Образец',changes:[{kind:'task_create',text:'Получить образец',source_message_id:'a',evidence:'Пришлю образец завтра.',trigger_evidence:'Пришлю образец завтра.'}]}}}};
 const store=memory({cos_communication_inbox:[original],cos_gmail_connection:[{id:'owner',settings:{ai_consent:true}}]});
 store.rpc=async(name,args)=>{assert.equal(name,'cos_inbox_update');const row=store.db.cos_communication_inbox[0];assert.equal(args.p_revision,row.revision);Object.assign(row,args.p_patch);row.revision++;return {item:clone(row)}};
 let modelCalls=0;const inbox=createCommunicationInbox({store,model:async()=>{modelCalls++;throw Error('unexpected')},timeZone:'Europe/Moscow'});
 const result=await inbox.recover(id);assert.equal(result.item.status,'ready');assert.equal(result.item.proposal.changes.length,1);assert.equal(result.item.proposal.analysis.recovered,true);assert.equal(modelCalls,0);
 assert.equal(await inbox.recover(id),null);
 store.db.cos_communication_inbox=[clone(original)];store.db.cos_gmail_connection[0].settings.ai_consent=false;
 assert.equal(await inbox.recover(id),null);assert.equal(store.db.cos_communication_inbox[0].revision,5);
});

test('sync captures five queued threads despite one analysis error, and drains saved sources separately',async()=>{
 const {syncMail}=await import(base+'sync.mjs'),m=await import(base+'mail.mjs');
 const connection={id:'owner',status:'connected',email:'owner@example.com',settings:{...m.DEFAULT_SETTINGS,label_ids:['Label_work'],enabled:true,ai_consent:true},cursor:{mode:'history',history_id:'1'}};
 const threads=Array.from({length:7},(_,i)=>({thread_id:'thread'+i,pending:true,context_days:90,message_limit:10}));
 const store=memory({cos_gmail_connection:[connection],cos_gmail_threads:threads,cos_communication_inbox:[]});
 const originalPage=store.page.bind(store);store.page=async(t,q)=>originalPage(t,q.replace('&source_meta->>type=eq.gmail',''));
 store.rpc=async(name,args)=>{assert.equal(name,'cos_gmail_capture');const item={id:args.p_thread_id,revision:1,status:'captured'};store.db.cos_communication_inbox.push(item);Object.assign(store.db.cos_gmail_threads.find(t=>t.thread_id===args.p_thread_id),{pending:false,inbox_id:item.id,message_ids:args.p_message_ids});return {item,duplicate:false}};
 const mail={get:async()=>({historyId:'2',history:[]}),thread:async id=>({messages:[{...message(id,NOW),threadId:id}]}),message:async id=>({...message(id,NOW),threadId:id})};
 let calls=0;const first=await syncMail({store,mail,connection,now:()=>NOW,analyze:async item=>{calls++;const row=store.db.cos_communication_inbox.find(i=>i.id===item.id);row.status=calls===1?'error':'ready';return {item:row}}});
 assert.equal(first.imported,5);assert.equal(first.analyzed,4);assert.equal(first.analysis_errors,1);assert.equal(store.db.cos_gmail_threads.filter(t=>t.pending).length,2);assert.equal(calls,5);
 const second=await syncMail({store,mail,connection,now:()=>NOW,analyze:async item=>{store.db.cos_communication_inbox.find(i=>i.id===item.id).status='ready';return {item:{status:'ready'}}}});
 assert.equal(second.imported,2);assert.equal(second.analyzed,2);assert.equal(store.db.cos_gmail_threads.filter(t=>t.pending).length,0);
});

test('Gmail progress distinguishes discovery, import and analysis; truncated text does not offer older messages',()=>{
 const ui=require('../gmail.js'),inbox=require('../inbox.js');
 assert.match(ui.progressText({progress:{found:40,imported:5,ready:3,queued:35,analyzing:1,errors:1,discovering:true}}),/Найдено цепочек: 40.*Загружено: 5.*Ошибок разбора: 1/);
 const item={id:'11111111-1111-4111-8111-111111111111',revision:1,status:'captured',source_text:'Исходник',source_meta:{type:'gmail',subject:'Заказ',messages:[{id:'a'}],total_messages:1,partial:true,omitted_messages:0,context_days:90,message_limit:10}};
 const html=inbox.renderDetail(inbox.createSession(item));assert.match(html,/Длинный текст письма сокращён/);assert.doesNotMatch(html,/Добавить 10 писем/);
});

test('automatic retry is bounded to two slots and skips second failures, preserving capacity for new mail',async()=>{
 const {syncMail}=await import(base+'sync.mjs'),m=await import(base+'mail.mjs');
 const connection={id:'owner',status:'connected',settings:{...m.DEFAULT_SETTINGS,enabled:true,ai_consent:true,label_ids:['Label_work']},cursor:{mode:'history',history_id:'1'}};
 const rows=[{id:'old-error',status:'error',error_code:'invalid_analysis'},...Array.from({length:4},(_,i)=>({id:'error'+i,status:'error',error_code:'invalid_analysis',proposal:{analysis:{attempts:i===0?2:1}}})),...Array.from({length:4},(_,i)=>({id:'new'+i,status:'captured'}))].map(r=>({...r,revision:1,source_meta:{type:'gmail'}}));
 const store=memory({cos_gmail_connection:[connection],cos_communication_inbox:rows});const calls=[];
 const analyze=async item=>{calls.push(item.id);const row=store.db.cos_communication_inbox.find(r=>r.id===item.id);row.status='error';row.error_code='invalid_analysis';row.proposal={analysis:{attempts:2}};return {item:row}};
 await syncMail({store,mail:{get:async()=>({historyId:'2',history:[]})},connection,analyze,now:()=>NOW});
 assert.deepEqual(calls,['old-error','error1','new0','new1','new2']);
 assert.equal(calls.includes('error0'),false);
 calls.length=0;await syncMail({store,mail:{get:async()=>({historyId:'2',history:[]})},connection,analyze,now:()=>NOW});
 assert.deepEqual(calls,['error2','error3','new3']);
});

test('omitted sentences are restored verbatim but force explicit review and no inferred task date',async()=>{
 const m=await import(base+'mail.mjs'),{completeMailQuote}=await import('../../supabase/functions/cos-notes/communication-mail.mjs'),{normalizeInboxProposal}=await import('../../supabase/functions/cos-notes/communication-inbox.mjs');
 const body='Пришлю образец завтра.\nПока это не согласовано.\nПодготовьте размеры оборудования.';
 const quote='Пришлю образец завтра.\nПодготовьте размеры оборудования.';
 assert.equal(completeMailQuote(body,quote),body);
 assert.equal(completeMailQuote(body,'Пришлю образец сегодня.\nПодготовьте размеры оборудования.'),null);
 assert.equal(completeMailQuote(body,'Подготовьте размеры оборудования.\nПришлю образец завтра.'),null);
 const snap=m.snapshot([message('a',NOW,body)],{threadId:'thread1',selection:{total:1,omitted:0},ownerEmail:'owner@example.com'});
 const proposal=normalizeInboxProposal({summary:'',changes:[{kind:'task_create',text:'Получить образец',evidence:quote,source_message_id:'a',trigger_evidence:'Пришлю образец завтра.',date_text:'завтра',date_status:'explicit'}]},{item:{source_text:snap.source,source_meta:snap.meta,created_at:NOW.toISOString()},context:{projects:[],participants:[],tasks:[],briefs:[]}});
 const change=proposal.changes[0];assert.equal(change.evidence,body);assert.equal(change.selected,false);assert.equal(change.evidence_restored,true);assert.equal(change.deadline,null);
 const inbox=require('../inbox.js');const html=inbox.renderDetail(inbox.createSession({id:'11111111-1111-4111-8111-111111111111',status:'ready',revision:1,proposal}));assert.match(html,/В цитату возвращены пропущенные фразы/);
});

test('explicit ellipses restore the omitted original passage under the same review limits',async()=>{
 const {completeMailQuote}=await import('../../supabase/functions/cos-notes/communication-mail.mjs');
 const body='Товар в наличии\r\nк оплате 838 руб\r\nАдрес получения указан в заказе.\r\nСрок хранения заказов - 3 рабочих дня.';
 assert.equal(completeMailQuote(body,'Товар в наличии\nк оплате 838 руб\n…Срок хранения заказов - 3 рабочих дня.'),body);
 assert.equal(completeMailQuote(body,'Товар в наличии ... Срок хранения заказов - 3 рабочих дня.'),body);
 assert.equal(completeMailQuote(body,'Товар в наличии ... Срок хранения заказов - 5 рабочих дней.'),null);
 assert.equal(completeMailQuote('Товар в наличии '+'.'.repeat(2001)+' Срок хранения заказов - 3 рабочих дня.','Товар в наличии ... Срок хранения заказов - 3 рабочих дня.'),null);
});

test('quote markers and omissions are restored in evidence and trigger only as unchecked full source passages',async()=>{
 const {restoreMailEvidence,mailEvidence}=await import('../../supabase/functions/cos-notes/communication-mail.mjs');
 const source='> Андрей, оплаты от вас не было.\n> Мы не успеем сегодня переместить заказ.';
 const item={source_text:source,source_meta:{type:'gmail',messages:[{id:'a',start:0,end:source.length}],new_message_ids:['a']}};
 const quote='Андрей, оплаты от вас не было. Мы не успеем сегодня переместить заказ.';
 const result=restoreMailEvidence({source_message_id:'a',evidence:quote,trigger_evidence:quote},item);
 assert.equal(result.evidence,source.slice(2));assert.equal(result.trigger_evidence,source.slice(2));assert.equal(mailEvidence(result,item,{}).expanded,true);
});
