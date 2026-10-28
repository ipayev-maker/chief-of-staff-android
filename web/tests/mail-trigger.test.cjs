const test=require('node:test'),assert=require('node:assert/strict');
const modulePath='../../supabase/functions/cos-notes/communication-mail.mjs';
const owner='owner@example.com',vendor='oksana@vendor-a.example',other='dima@vendor-b.example';
function fixture({triggerFrom=other,triggerTo=[owner],triggerBody='Ожидаем список документов.',party=vendor}={}){
 const oldBody='Встречу назначу на 29.10 в 13:00. Ссылку направлю отдельным письмом.';
 const message=(id,from,to,body)=>`Письмо ${id} · 2026-10-28T10:00:00Z\nОт: ${from}\nКому: ${to.join(', ')}\nТема: Запрос КП\n${body}\n\n`;
 const before=message('old',vendor,[owner],oldBody),after=message('new',triggerFrom,triggerTo,triggerBody);
 const item={source_text:before+after,source_meta:{type:'gmail',owner_email:owner,new_message_ids:['new'],messages:[
  {id:'old',email:vendor,to_emails:[owner],date:'2026-10-28T10:00:00Z',start:0,end:before.length},
  {id:'new',email:triggerFrom,to_emails:triggerTo,date:'2026-10-28T17:00:00Z',start:before.length,end:before.length+after.length}]}};
 return {item,value:{kind:'task_update',source_message_id:'old',trigger_message_id:'new',evidence:oldBody,trigger_evidence:triggerBody,participant_email:party}};
}
test('another vendor in the same Gmail thread cannot trigger an old obligation',async()=>{
 const {mailEvidence}=await import(modulePath),{item,value}=fixture();
 assert.throws(()=>mailEvidence(value,item,{participants:[]}),/invalid_mail_evidence/);
 assert.throws(()=>mailEvidence({...value,participant_email:null},item,{participants:[]}),/invalid_mail_evidence/);
});
test('owner replies and replies from the original correspondent retain historical evidence',async()=>{
 const {mailEvidence}=await import(modulePath);
 for(const f of [fixture({triggerFrom:vendor}),fixture({triggerFrom:owner,triggerTo:[vendor],triggerBody:'Ссылку получил, спасибо.'})])
  assert.equal(mailEvidence(f.value,f.item,{participants:[]}).trigger_id,'new');
});
test('an explicit email reference in the new action quote can link different correspondents',async()=>{
 const {mailEvidence}=await import(modulePath),f=fixture({triggerBody:`Ссылку от ${vendor} получил, встреча подтверждена.`});
 assert.equal(mailEvidence(f.value,f.item,{participants:[]}).trigger_id,'new');
});
test('quoted email history and a shared owner are not evidence of a new cross-vendor action',async()=>{
 const {mailEvidence}=await import(modulePath),f=fixture({triggerBody:`Ожидаем список документов.\n\nFrom: ${vendor}\nСсылку направлю отдельным письмом.`});
 f.value.trigger_evidence='Ожидаем список документов.';
 assert.throws(()=>mailEvidence(f.value,f.item,{participants:[]}),/invalid_mail_evidence/);
 f.value.trigger_evidence=`From: ${vendor}\nСсылку направлю отдельным письмом.`;
 assert.throws(()=>mailEvidence(f.value,f.item,{participants:[]}),/invalid_mail_evidence/);
});
test('an empty trigger quote cannot validate an action',async()=>{
 const {mailEvidence}=await import(modulePath),f=fixture({triggerFrom:vendor});f.value.trigger_evidence='';
 assert.throws(()=>mailEvidence(f.value,f.item,{participants:[]}),/invalid_mail_evidence/);
});
test('mixed-supplier analysis keeps the new supplier request and drops the unrelated update',async()=>{
 const {normalizeInboxProposal}=await import('../../supabase/functions/cos-notes/communication-inbox.mjs'),f=fixture();
 const taskId='11111111-1111-4111-8111-111111111111';
 const context={projects:[],participants:[],briefs:[],tasks:[{id:taskId,description:'Получить ссылку на встречу',status:'open',cos_version:1}]};
 const p=normalizeInboxProposal({summary:'Документы',changes:[
  {...f.value,task_id:taskId,text:'Получить ссылку на встречу',status:'open'},
  {kind:'task_create',text:'Прислать список документов',evidence:'Ожидаем список документов.',source_message_id:'new',trigger_evidence:'Ожидаем список документов.',participant_email:other}]},{item:f.item,context});
 assert.equal(p.changes.length,1);assert.equal(p.changes[0].text,'Прислать список документов');assert.equal(p.changes[0].source_message_id,'new');
});
test('previously persisted cross-supplier proposals cannot be applied, but can be rejected',async()=>{
 const {createCommunicationInbox}=await import('../../supabase/functions/cos-notes/communication-inbox.mjs'),f=fixture();
 const id='11111111-1111-4111-8111-111111111111',task='22222222-2222-4222-8222-222222222222',request='33333333-3333-4333-8333-333333333333';
 const change={...f.value,id,kind:'task_update',task_id:task,task_version:1,text:'Получить ссылку',selected:true,project_id:null,participant_id:null,direction:'to_me',deadline:null,deadline_time:null,next_check_on:null,status:'open',entry_kind:null,brief_revision:null,mail_trigger_evidence:f.value.trigger_evidence};
 const row={...f.item,id,status:'ready',revision:1,proposal:{version:1,changes:[change],context:{tasks:[]}}};
 const writes=[];const store={async page(table){return table==='cos_communication_inbox'?[row]:[]},async list(){return []},async rpc(name,args){writes.push({name,args});return {item:{...row,status:'applied',revision:2},result:{}}}};
 const service=createCommunicationInbox({store,timeZone:'Europe/Moscow'});
 await assert.rejects(service.apply(id,{revision:1,request_id:request,proposal:row.proposal}),e=>e.code==='invalid_mail_evidence');assert.equal(writes.length,0);
 await service.apply(id,{revision:1,request_id:request,proposal:{version:1,changes:[{...change,selected:false}]}});
 assert.equal(writes.length,1);assert.deepEqual(writes[0].args.p_actions,[]);
});
