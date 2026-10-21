const test=require('node:test'),assert=require('node:assert/strict');
const base='../../supabase/functions/cos-gmail/';
const id='11111111-1111-4111-8111-111111111111';
const encode=s=>Buffer.from(s).toString('base64url');
const message=()=>({id:'m1',threadId:'t1',internalDate:'1792576800000',labelIds:['work'],payload:{headers:[{name:'From',value:'Антон <anton@example.com>'},{name:'Subject',value:'Образец'}],mimeType:'text/html',body:{data:encode('<table><tr><td>Письмо целиком</td></tr></table>')}}});
test('reader preserves full MIME body beyond analysis snapshot limit and embedded images',async()=>{
 const {renderableMessage}=await import(base+'reader.mjs');const m=message(),long='Подробности '.repeat(2200);
 m.payload={...m.payload,mimeType:'multipart/mixed',parts:[{mimeType:'multipart/alternative',parts:[{mimeType:'text/plain',body:{data:encode(long)}},{mimeType:'text/html',body:{attachmentId:'body'}}]},{mimeType:'image/png',filename:'logo.png',headers:[{name:'Content-ID',value:'<logo>'}],body:{data:'aGVsbG8',size:5}},{mimeType:'application/pdf',filename:'estimate.pdf',body:{attachmentId:'private-file',size:100}}]};
 const calls=[],r=await renderableMessage(m,{attachment:async(mid,aid)=>{calls.push([mid,aid]);return {data:encode('<p>'+long+'</p><img src="cid:logo">')}}});
 assert.equal(r.text,long);assert.ok(r.html.length>20000);assert.match(r.html,/cid:logo/);assert.equal(r.inline[0].cid,'logo');assert.equal(r.attachments[0].name,'estimate.pdf');assert.deepEqual(calls,[['m1','body']]);
});
test('reader validates selected thread, current scope and message membership before body fetch',async()=>{
 const {createMailReader}=await import(base+'reader.mjs');let bodies=0;
 const store={page:async()=>[{thread_id:'t1',inbox_id:id}],list:async()=>[]};let meta={id:'t1',messages:[message()]};
 const reader=createMailReader({store,mail:async()=>({thread:async()=>meta,message:async()=>{bodies++;return message();}})}),connection={settings:{label_ids:['work'],emails:[]}};
 await assert.rejects(reader.message('t1','foreign',connection),e=>e.status===404);assert.equal(bodies,0);
 meta.messages[0].labelIds=['TRASH'];await assert.rejects(reader.message('t1','m1',connection),e=>e.status===404);assert.equal(bodies,0);
 meta={id:'t1',messages:[message()]};const result=await reader.message('t1','m1',connection);assert.match(result.html,/Письмо целиком/);assert.equal(bodies,1);
 await assert.rejects(reader.thread('../t1',connection),e=>e.status===400);
});
test('mail reading routes reject anonymous and foreign sessions before touching mail records',async()=>{
 const {createGmailHandler}=await import(base+'handler.mjs');let touched=false;
 const store={page:async(table)=>{if(table==='cos_gmail_connection')return [{id:'owner',google_sub:'owner'}];if(table==='cos_calendar_connection')return [{google_sub:'owner'}];if(table==='cos_calendar_sessions')return [{google_sub:'stranger'}];touched=true;return []}};
 const handler=createGmailHandler({store,config:{},google:{}});
 for(const path of ['letters','thread?id=t1','message?thread=t1&id=m1'])for(const cookie of ['', '__Host-cos-calendar-session=foreign']){
  const result=await handler(new Request('https://app.test/gmail/'+path,{headers:{Cookie:cookie}}));assert.equal(result.status,401);
 }
 assert.equal(touched,false);
});
test('manual mail mode delivers clear actions as review children without automatic tasks',async()=>{
 const {createCommunicationInbox}=await import('../../supabase/functions/cos-notes/communication-inbox.mjs');const body='Пришлите чертёж.';
 const text='Письмо m1 · 2026-10-21\nОт: anton@example.com\nКому: owner@example.com\nТема: Чертёж\n'+body;
 const row={id,revision:1,status:'ready',source_text:text,source_meta:{type:'gmail',delivery:'tasks',owner_email:'owner@example.com',messages:[{id:'m1',email:'anton@example.com',to_emails:['owner@example.com'],start:0,end:text.length}],new_message_ids:['m1']},proposal:{analysis:{id,status:'completed'},changes:[{id,kind:'task_create',text:'Прислать чертёж',selected:true,status:'open',evidence:body,source_message_id:'m1',trigger_message_id:'m1',mail_relation:'owner_request',mail_intent:'request',mail_responsibility_evidence:body,mail_trigger_evidence:body}]}};
 let args;const store={page:async t=>t==='cos_communication_inbox'?[row]:[{settings:{enabled:true,ai_consent:true,auto_tasks:true,review_before_create:true}}],rpc:async(name,value)=>{assert.equal(name,'cos_gmail_deliver_hybrid');args=value;return {item:{...row,status:'applied'}}}};
 await createCommunicationInbox({store,timeZone:'Europe/Moscow'}).deliverMail(id);assert.deepEqual(args.p_actions,[]);assert.equal(args.p_reviews.length,1);assert.equal(args.p_reviews[0].proposal.changes[0].text,'Прислать чертёж');
});
test('mail routes round trip and actionable suggestions stay tied to the selected message',()=>{
 const nav=require('../navigation.js'),reader=require('../mail-reader.js');const route=nav.readRoute({hash:'#/mail/thread_1'});assert.equal(route.mailId,'thread_1');assert.equal(nav.routeURL({pathname:'/',search:''},route),'/#/mail/thread_1');assert.equal(nav.readRoute({hash:'#/mail/..%2Fsecret'}),null);
 const records=[{id,source_meta:{delivery:'review',messages:[{id:'m1'},{id:'m2'}]},proposal:{changes:[{id:'a',source_message_id:'m1',trigger_message_id:'m1'},{id:'b',source_message_id:'m2',trigger_message_id:'m2'}]}}];
 assert.deepEqual(reader.proposalsForMessage(records,'m1').map(x=>x.change.id),['a']);assert.equal(reader.safeLink('javascript:alert(1)'),null);
});

test('thread link writes validate complete data and map optimistic conflicts without leaking DB errors',async()=>{
 const {saveThreadLinks}=await import(base+'links.mjs');const calls=[],person='22222222-2222-4222-8222-222222222222';
 const store={rpc:async(name,args)=>{calls.push({name,args});return {project_id:id,participant_ids:[person],revision:3}}};
 const data={thread_id:'t1',project_id:id,participant_ids:[person],revision:2};
 for(const bad of [{...data,project_id:'bad'},{...data,participant_ids:[person,person]},{...data,participant_ids:null},{...data,revision:-1},{...data,extra:true}])await assert.rejects(saveThreadLinks(store,bad),e=>e.status===400);
 assert.equal(calls.length,0);assert.equal((await saveThreadLinks(store,data)).revision,3);assert.equal(calls[0].name,'cos_gmail_set_links');assert.deepEqual(calls[0].args.p_participant_ids,[person]);
 await assert.rejects(saveThreadLinks({rpc:async()=>{throw {code:'PT409',message:'private details'}}},data),e=>e.reason==='links_conflict'&&!e.message.includes('private'));
});
test('mail list filters are applied before pagination and return all linked people',async()=>{
 const {createMailReader}=await import(base+'reader.mjs');let query;const person='22222222-2222-4222-8222-222222222222';
 const store={page:async(t,q)=>{query=q;return [{thread_id:'t1',inbox_id:id,project_id:id}]},list:async(t)=>t==='cos_gmail_thread_participants'?[{thread_id:'t1',participant_id:person}]:[]};
 const reader=createMailReader({store});const r=await reader.list(50,{projectId:id,participantId:person});assert.match(query,/offset=50/);assert.match(query,/!inner/);assert.ok(query.includes('project_id=eq.'+id));assert.ok(query.includes('mail_people.participant_id=eq.'+person));assert.deepEqual(r.items[0].participant_ids,[person]);
 await assert.rejects(reader.list(0,{projectId:'bad'}),e=>e.status===400);
});
test('links endpoint rejects CSRF and foreign sessions before any mutation',async()=>{
 const {createGmailHandler}=await import(base+'handler.mjs');let writes=0;
 const store={page:async t=>t==='cos_calendar_sessions'?[{google_sub:'other'}]:[{google_sub:'owner'}],rpc:async()=>{writes++}};
 const handler=createGmailHandler({store,google:{},config:{}});
 const wrong=await handler(new Request('https://app.test/gmail/links',{method:'POST',headers:{Origin:'https://evil.invalid'},body:'{}'}));assert.equal(wrong.status,403);
 const foreign=await handler(new Request('https://app.test/gmail/links',{method:'POST',headers:{Origin:'https://nikodim.vercel.app',Cookie:'__Host-cos-calendar-session=foreign'},body:'{}'}));assert.equal(foreign.status,401);assert.equal(writes,0);
});
test('explicit conversation project wins for new actions; ambiguous people and existing tasks are preserved',()=>{
 const {withMailLinks}=require('../mail-reader.js');const context={projects:[{id:'active',title:'Проект',status:'active'},{id:'old',status:'completed'}],participants:[{id:'a',name:'Антон'},{id:'b',name:'Мария'}]},base={kind:'task_create',project_id:null,participant_id:null};
 let c=withMailLinks(base,{project_id:'active',participant_ids:['a'],revision:1},context);assert.equal(c.project_id,'active');assert.equal(c.participant_id,'a');assert.equal(base.project_id,null);
 c=withMailLinks(base,{project_id:'old',participant_ids:['a','b'],revision:1},context);assert.equal(c.project_id,null);assert.equal(c.participant_id,null);
 c=withMailLinks({...base,participant_name:'Андрей'},{participant_ids:['a']},context);assert.equal(c.participant_id,null);
 c=withMailLinks({...base,project_id:'old'},{project_id:'active',revision:1},context);assert.equal(c.project_id,'active');
 c=withMailLinks({...base,kind:'task_update',project_id:'old'},{project_id:'active',revision:1},context);assert.equal(c.project_id,'old');
});
test('legacy captured mail is clipped to three messages before reanalysis, with corrected evidence offsets',async()=>{
 const {mailAnalysisWindow,DEFAULT_SETTINGS}=await import(base+'mail.mjs');assert.equal(DEFAULT_SETTINGS.message_limit,3);
 let source='';const messages=[];for(let i=0;i<5;i++){const start=source.length;source+='Message '+i+'\n';messages.push({id:'m'+i,start,end:source.length,date:'2026-10-2'+i});}
 const result=mailAnalysisWindow({source_text:source,source_meta:{type:'gmail',messages,new_message_ids:['m0','m4']}});
 assert.equal(result.source_meta.messages.length,3);assert.doesNotMatch(result.source_text,/Message [01]/);assert.deepEqual(result.source_meta.new_message_ids,['m4']);
 for(const m of result.source_meta.messages)assert.ok(result.source_text.slice(m.start,m.end).includes('Message '+m.id.slice(1)));
});
