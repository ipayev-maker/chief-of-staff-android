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
