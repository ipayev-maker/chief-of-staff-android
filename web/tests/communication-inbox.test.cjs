const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const modulePath=pathToFileURL(path.resolve(__dirname,'../../supabase/functions/cos-notes/communication-inbox.mjs')).href;
const id='00000000-0000-4000-8000-000000000001',project='00000000-0000-4000-8000-000000000002',person='00000000-0000-4000-8000-000000000003';
let serial=20;const uuid=()=>`00000000-0000-4000-8000-${String(serial++).padStart(12,'0')}`;
const clone=v=>JSON.parse(JSON.stringify(v));
function setup({source='Проект Colryut: Анна пришлёт образец завтра в 14:30.',raw,voice,meta={}}={}){
  let row={id,note_id:uuid(),source_text:source,source_meta:{message_date:'2026-09-29T23:30:00Z',...meta},transcript:null,status:'captured',revision:1,proposal:{},created_at:'2026-09-29T23:30:00Z',updated_at:'2026-09-29T23:30:00Z'};
  const calls=[],context={projects:[{id:project,title:'Colryut',status:'active'}],participants:[{id:person,name:'Анна'}],commitments:[],cos_project_briefs:[]};
  const receipts=new Map();
  const store={async page(table){if(table==='cos_communication_inbox')return [clone(row)];if(table==='cos_settings')return [{time_zone:'Europe/Berlin'}];return context[table]||[]},async list(table){calls.push(['list',table]);return clone(context[table]||[])},async rpc(name,args){calls.push([name,clone(args)]);if(name==='cos_inbox_update'){assert.equal(args.p_revision,row.revision);row={...row,...clone(args.p_patch),source_meta:{...row.source_meta,...args.p_patch.source_meta},revision:row.revision+1};return {item:clone(row),replayed:false}}
    if(name==='cos_inbox_apply'){const prior=receipts.get(args.p_request_id);if(prior){if(JSON.stringify(prior.confirmation)!==JSON.stringify(args.p_confirmation))throw {code:'PT409'};return {...clone(prior.result),replayed:true}}assert.equal(args.p_revision,row.revision);row={...row,status:'applied',revision:row.revision+1};const result={item:clone(row),result:{tasks:[],briefs:[],changes:args.p_actions},replayed:false};receipts.set(args.p_request_id,{confirmation:clone(args.p_confirmation),result});return result}throw Error(name)}};
  const model=async()=>{calls.push(['model',clone(row)]);return {data:raw||{summary:'Ожидается образец',questions:[],changes:[{kind:'task_create',text:'Получить образец',evidence:source,project_id:project,participant_id:person,direction:'to_me',status:'open',date_text:'завтра в 14:30',date_status:'explicit'}]},model:'test-model',usage:{total_tokens:100,cost:0.01}}};
  return {store,model,voice,calls,context,row:()=>clone(row),setRow:v=>{row={...row,...clone(v)}},uuid,now:()=>new Date('2026-10-01T10:00:00Z')};
}
test('source precedes model, result persisted, analysis does not mutate tasks',async()=>{
  const {createCommunicationInbox}=await import(modulePath);const fixture=setup(),service=createCommunicationInbox(fixture);
  const {item}=await service.analyze(id,{revision:1});assert.equal(item.status,'ready');assert.equal(item.proposal.changes[0].deadline,'2026-10-01');assert.equal(item.proposal.changes[0].deadline_time,'14:30');assert.equal(item.proposal.time_zone,'Europe/Berlin');assert.equal(item.proposal.analysis.model,'test-model');
  const atModel=fixture.calls.find(c=>c[0]==='model')[1];assert.equal(atModel.status,'processing');assert.ok(atModel.proposal.analysis.id);assert.equal(fixture.calls.some(c=>c[0]==='cos_inbox_apply'),false);
});
test('voice bytes recorded before transcription and retained on transcription failure',async()=>{
  const {createCommunicationInbox}=await import(modulePath);const fixture=setup({source:'[Голосовое сообщение]',meta:{type:'voice',voice:{file_id:'file'}}});let saved=false;
  fixture.voice={async save(){saved=true;return {path:'owner/id/voice.ogg',bucket:'private',mime_type:'audio/ogg',size_bytes:12,duration_seconds:3}},async transcribe(){assert.equal(saved,true);assert.equal(fixture.row().source_meta.audio_path,'owner/id/voice.ogg');throw {safeCode:'voice_transcription_unavailable'}}};
  const {item}=await createCommunicationInbox(fixture).analyze(id,{revision:1});assert.equal(item.status,'error');assert.equal(item.source_text,'[Голосовое сообщение]');assert.equal(item.error_code,'voice_transcription_unavailable');assert.equal(fixture.calls.some(c=>c[0]==='model'),false);
});
test('invalid model evidence fails safely and preserves charged generation metadata',async()=>{
  const {createCommunicationInbox}=await import(modulePath);const fixture=setup({raw:{summary:'x',questions:[],changes:[{kind:'task_create',text:'fake',evidence:'invented'}]}});
  const {item}=await createCommunicationInbox(fixture).analyze(id,{revision:1});assert.equal(item.status,'error');assert.equal(item.error_code,'invalid_analysis');assert.equal(item.proposal.analysis.usage.total_tokens,100);assert.equal(item.proposal.analysis.result.changes[0].evidence,'invented');
});
test('apply binds saved evidence and target; edited text accepted, forged evidence rejected',async()=>{
  const {createCommunicationInbox}=await import(modulePath);const fixture=setup(),service=createCommunicationInbox(fixture);const {item}=await service.analyze(id,{revision:1});const proposal={version:1,changes:clone(item.proposal.changes)};
  proposal.changes[0].evidence='forged';await assert.rejects(service.apply(id,{revision:item.revision,request_id:uuid(),proposal}),e=>e.code==='invalid_proposal');proposal.changes[0].evidence=item.source_text;proposal.changes[0].text='Получить и проверить образец';
  await service.apply(id,{revision:item.revision,request_id:uuid(),proposal});const apply=fixture.calls.find(c=>c[0]==='cos_inbox_apply')[1];assert.equal(apply.p_actions[0].task.description,'Получить и проверить образец');assert.equal(apply.p_actions[0].task.deadline_at,'2026-10-01T12:30:00.000Z');
});
test('lost apply response replay bypasses changed project context; changed payload conflicts',async()=>{
  const {createCommunicationInbox}=await import(modulePath);const fixture=setup(),service=createCommunicationInbox(fixture);const {item}=await service.analyze(id,{revision:1});const body={revision:item.revision,request_id:uuid(),proposal:{version:1,changes:item.proposal.changes}};
  await service.apply(id,body);fixture.context.projects=[];const replay=await service.apply(id,body);assert.equal(replay.replayed,true);assert.deepEqual(fixture.calls.at(-1)[1].p_actions,[]);body.proposal.changes[0].text='different';await assert.rejects(service.apply(id,body),e=>e.code==='inbox_conflict');
});
test('defer keeps edited proposal and creates no tasks',async()=>{
  const {createCommunicationInbox}=await import(modulePath);const fixture=setup(),service=createCommunicationInbox(fixture);const {item}=await service.analyze(id,{revision:1});const proposal={version:1,changes:clone(item.proposal.changes)};proposal.changes[0].text='Проверить образец';const deferred=await service.defer(id,{revision:item.revision,request_id:uuid(),proposal});assert.equal(deferred.item.status,'deferred');assert.equal(deferred.item.proposal.changes[0].text,'Проверить образец');assert.equal(fixture.calls.some(c=>c[0]==='cos_inbox_apply'),false);
});
test('grounding uses action clause and full name tokens, not another clause or name substring',async()=>{
  const {normalizeInboxProposal}=await import(modulePath);const fixture=setup({source:'Colryut: Анна пришлёт образец. Другой проект: Аннализа ответит.'});const context={projects:fixture.context.projects,participants:fixture.context.participants,tasks:[],briefs:[]};const result=normalizeInboxProposal({summary:'',questions:[],changes:[{kind:'task_create',text:'Получить ответ',evidence:'Другой проект: Аннализа ответит.',project_id:project,participant_id:person,date_status:'none'}]},{item:fixture.row(),context,uuid});assert.equal(result.changes[0].project_id,null);assert.equal(result.changes[0].participant_id,null);
});
test('unknown forward date leaves relative date unset and asks for clarification',async()=>{
  const {createCommunicationInbox}=await import(modulePath);const fixture=setup({meta:{forwarded:true,original_date:null}});const {item}=await createCommunicationInbox(fixture).analyze(id,{revision:1});assert.equal(item.proposal.changes[0].deadline,null);assert.ok(item.proposal.questions.length);
});
test('list omits heavy history/baselines while detail preserves them',async()=>{
  const {createCommunicationInbox}=await import(modulePath);const fixture=setup();fixture.setRow({proposal:{version:1,changes:[],context:{briefs:[{document:{}}]}},applied_result:{changes:[{}]}});const service=createCommunicationInbox(fixture);const list=await service.list();assert.equal(list.items[0].proposal.context,undefined);assert.equal(list.items[0].applied_result,undefined);const detail=await service.get(id);assert.ok(detail.item.proposal.context);assert.ok(detail.item.applied_result);
});
test('manual date edits survive deferred review and later confirmation',async()=>{
 const {createCommunicationInbox}=await import(modulePath);const taskId=uuid(),source='Colryut: Анна прислала образец.';
 const fixture=setup({source,raw:{summary:'',questions:[],changes:[{kind:'task_update',task_id:taskId,text:'Получить образец',evidence:source,project_id:project,participant_id:person,direction:'to_me',status:'completed',date_status:'none'}]}});
 fixture.context.commitments.push({id:taskId,description:'Получить образец',project_id:project,participant_id:person,direction:'to_me',status:'open',deadline:'2026-10-05',deadline_at:null,next_check_on:null,cos_version:1});
 const service=createCommunicationInbox(fixture),{item}=await service.analyze(id,{revision:1});assert.equal(item.proposal.changes[0].date_intent,false);const proposal={version:1,changes:clone(item.proposal.changes)};proposal.changes[0].deadline='2026-10-08';
 const deferred=await service.defer(id,{revision:item.revision,request_id:uuid(),proposal});assert.equal(deferred.item.proposal.changes[0].date_intent,true);await service.apply(id,{revision:deferred.item.revision,request_id:uuid(),proposal:{version:1,changes:deferred.item.proposal.changes}});
 const action=fixture.calls.find(c=>c[0]==='cos_inbox_apply')[1].p_actions[0];assert.equal(action.patch.deadline,'2026-10-08');
});
test('tentative plural promise stays undated even if a model calls the date explicit',async()=>{
 const {createCommunicationInbox}=await import(modulePath);const source='Colryut: постараемся прислать образец завтра.';
 const fixture=setup({source,raw:{summary:'',questions:[],changes:[{kind:'task_create',text:'Получить образец',evidence:source,project_id:project,participant_id:null,direction:'to_me',status:'open',date_status:'explicit',date_text:'завтра'}]}});
 const {item}=await createCommunicationInbox(fixture).analyze(id,{revision:1});assert.equal(item.status,'ready');assert.equal(item.proposal.changes[0].deadline,null);assert.ok(item.proposal.questions.some(q=>q.includes('Уточните срок')));
});
