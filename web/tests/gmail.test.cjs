const test=require('node:test');const assert=require('node:assert/strict');
const path=require('node:path');const fs=require('node:fs');
const base='../../supabase/functions/cos-gmail/';
const NOW=new Date('2026-10-20T18:00:00Z');
const encode=text=>Buffer.from(text).toString('base64url');
function message(id,date,text='Пришлю образец завтра.',from='Антон <anton@example.com>',labels=['Label_work']){return{id,threadId:'thread1',internalDate:String(+new Date(date)),labelIds:labels,payload:{mimeType:'text/plain',headers:[{name:'From',value:from},{name:'To',value:'Owner <owner@example.com>'},{name:'Subject',value:'Образец'}],body:{data:encode(text)}}};}
const clone=v=>JSON.parse(JSON.stringify(v));
function memory(initial={}){
 const db=clone(initial),calls=[];
 const matching=(table,q)=>{const params=new URLSearchParams(q);let rows=[...(db[table]||[])];for(const [k,v]of params){if(['select','limit','order','offset'].includes(k))continue;if(v.startsWith('eq.'))rows=rows.filter(r=>String(r[k])===v.slice(3));if(v.startsWith('gt.'))rows=rows.filter(r=>r[k]>v.slice(3));}return rows.slice(0,Number(params.get('limit')||1000));};
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
