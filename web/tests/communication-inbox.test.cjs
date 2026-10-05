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

test('reported spoken appointment survives split day/time and applies as a calendar meeting',async()=>{
 const {createCommunicationInbox}=await import(modulePath);
 const {projectCalendarRecord}=await import('../calendar/projector.mjs');
 const source='Завтра с факелом обсудить припак, убрать боковины, чтобы было видно топпер и продукт в 9:15.';
 const raw={summary:'Запланирована встреча',questions:[],changes:[{kind:'task_create',text:'Завтра в 9:15 обсудить с Факелом припак',evidence:source,date_status:'none',date_text:null}]};
 const fixture=setup({source,raw});fixture.setRow({source_meta:{message_date:'2026-09-30T16:45:03Z'}});
 fixture.context.cos_calendar_connection=[{time_zone:'Europe/Moscow'}];
 const service=createCommunicationInbox(fixture),{item}=await service.analyze(id,{revision:1});
 const change=item.proposal.changes[0];
 assert.equal(item.proposal.time_zone,'Europe/Moscow');assert.equal(change.kind,'meeting_create');
 assert.equal(change.meeting_date,'2026-10-01');assert.equal(change.meeting_time,'09:15');
 assert.equal(change.deadline,null);assert.equal(change.duration_minutes,30);assert.equal(change.duration_estimated,true);
 assert.equal(item.proposal.questions.some(q=>q.includes('Уточните срок')),false);
 await service.apply(id,{revision:item.revision,request_id:uuid(),proposal:{version:1,changes:[change]}});
 const actions=fixture.calls.find(c=>c[0]==='cos_inbox_apply')[1].p_actions;
 assert.equal(actions.length,1);assert.equal(actions[0].kind,'meeting_create');
 assert.equal(actions[0].meeting.starts_at,'2026-10-01T06:15:00.000Z');
 assert.equal(actions[0].meeting.ends_at,'2026-10-01T06:45:00.000Z');
 const google=projectCalendarRecord('meeting',{...actions[0].meeting,id:change.id,status:'scheduled'},{timeZone:'Europe/Moscow'});
 assert.equal(google.kind,'event');assert.equal(google.event.start.dateTime,'2026-10-01T06:15:00.000Z');
 assert.equal(google.event.summary.startsWith('Срок:'),false);
});

test('meeting time and duration can be edited and cannot be forged into invalid intervals',async()=>{
 const {createCommunicationInbox}=await import(modulePath);const source='Завтра в 9:15 обсудить припак с Факелом.';
 const fixture=setup({source,raw:{summary:'',changes:[{kind:'meeting_create',text:'Обсудить припак',evidence:source}]}});
 fixture.context.cos_calendar_connection=[{time_zone:'Europe/Moscow'}];
 const service=createCommunicationInbox(fixture),{item}=await service.analyze(id,{revision:1});
 const proposal={version:1,changes:clone(item.proposal.changes)};proposal.changes[0].duration_minutes=0;
 await assert.rejects(service.apply(id,{revision:item.revision,request_id:uuid(),proposal}),e=>e.code==='invalid_meeting_time');
 proposal.changes[0].duration_minutes=45;proposal.changes[0].meeting_time='10:30';
 await service.apply(id,{revision:item.revision,request_id:uuid(),proposal});
 const m=fixture.calls.find(c=>c[0]==='cos_inbox_apply')[1].p_actions[0].meeting;
 assert.equal(m.starts_at,'2026-10-01T07:30:00.000Z');assert.equal(m.ends_at,'2026-10-01T08:15:00.000Z');
 assert.doesNotMatch(m.agenda,/по умолчанию/);
});

test('a meeting without reliable time remains unselected and needs explicit correction',async()=>{
 const {createCommunicationInbox}=await import(modulePath);const source='Возможно, встреча с Анной завтра в 9:15.';
 const fixture=setup({source,raw:{summary:'',changes:[{kind:'meeting_create',text:'Встреча с Анной',evidence:source}]}});
 const service=createCommunicationInbox(fixture),{item}=await service.analyze(id,{revision:1});
 assert.equal(item.proposal.changes[0].selected,false);assert.equal(item.proposal.changes[0].meeting_date,null);
 const proposal={version:1,changes:clone(item.proposal.changes)};proposal.changes[0].selected=true;
 await assert.rejects(service.apply(id,{revision:item.revision,request_id:uuid(),proposal}),e=>e.code==='invalid_meeting_time');
});

test('reported Anton preparation survives zero model actions, creates one owner task, no optional questions',async()=>{
 const {createCommunicationInbox}=await import(modulePath);
 const source='Подобрать задачи для Антона на завтра.';
 const f=setup({source,raw:{summary:'Нужны уточнения',questions:['Создать участника?','К какому проекту относится Антон?','Какие конкретно задачи?'],changes:[]}});
 f.setRow({created_at:'2026-10-05T17:50:55Z',source_meta:{message_date:'2026-10-05T17:50:54Z'},proposal:{corrections:[{text:'Антон - новый участник. Дизайнер Ему надо дать задачи на завтра',created_at:'2026-10-05T17:52:18Z'},{text:'Антон дизайнер. Ему нужно подобрать задачи, завтра в 9:30',created_at:'2026-10-05T17:54:40Z'}]}});
 f.context.cos_calendar_connection=[{status:'needs_reconnect',time_zone:'Europe/Moscow'}];
 const service=createCommunicationInbox(f),{item}=await service.analyze(id,{revision:1});
 assert.equal(item.status,'ready');assert.equal(item.proposal.time_zone,'Europe/Moscow');assert.deepEqual(item.proposal.questions,[]);
 assert.equal(item.proposal.changes.length,1);const c=item.proposal.changes[0];
 assert.equal(c.text,'Подобрать задачи для Антона');assert.equal(c.kind,'task_create');assert.equal(c.direction,'internal');assert.equal(c.project_id,null);
 assert.equal(c.participant_id,null);assert.equal(c.participant_suggestion.name,'Антон');
 assert.equal(c.planned_on,'2026-10-06');assert.equal(c.planned_time,'09:30');assert.equal(c.deadline,null);
 // Creating a task remains possible without creating an optional participant first.
 await service.apply(id,{revision:item.revision,request_id:uuid(),proposal:{version:1,changes:item.proposal.changes}});
 const task=f.calls.find(c=>c[0]==='cos_inbox_apply')[1].p_actions[0].task;
 assert.equal(task.planned_on,'2026-10-06');assert.equal(task.planned_start_at,'2026-10-06T06:30:00.000Z');assert.equal(task.deadline_at,null);
 assert.equal(f.calls.filter(c=>c[0]==='cos_inbox_apply').length,1);
});

test('unknown participant is suggested, existing inflected names resolve without invented identities',async()=>{
 const {normalizeInboxProposal}=await import(modulePath);
 const source='Подобрать задачи для Антона завтра в 9:30.';
 const f=setup({source}),context={projects:[],participants:[],tasks:[],briefs:[]};
 const value={kind:'task_create',text:'Подобрать задачи для Антона',evidence:source,participant_name:'Антон',participant_mention:'Антона',date_text:'завтра в 9:30',date_status:'explicit',date_kind:'work'};
 const norm=ctx=>normalizeInboxProposal({summary:'',questions:['К какому проекту относится Антон?','Антон — новый участник, добавить его?'],changes:[value]},{item:f.row(),context:ctx,uuid});
 const proposed=norm(context);assert.equal(proposed.changes[0].participant_suggestion.name,'Антон');assert.deepEqual(proposed.questions,[]);
 context.participants=[{id:person,name:'Антон'}];const existing=norm(context).changes[0];assert.equal(existing.participant_id,person);assert.equal(existing.participant_suggestion,undefined);
 value.participant_name='Борис';value.participant_mention='Борис';value.participant_id=person;const forged=norm(context).changes[0];assert.equal(forged.participant_id,null);assert.equal(forged.participant_suggestion,undefined);
});

test('same first names offer a choice instead of creating or merging people',async()=>{
 const {participantFor}=await import('../../supabase/functions/cos-notes/communication-intent.mjs');
 const context={participants:[{id:person,name:'Антон Петров'},{id:project,name:'Антон Сидоров'}]};
 const result=participantFor({participant_name:'Антон',participant_mention:'Антону'},context,'Поставить Антону задачи');
 assert.equal(result.id,null);assert.deepEqual(result.suggestion.existing_ids,[person,project]);
 assert.equal(participantFor({participant_name:'Анна',participant_mention:'Анна'}, {participants:[{id:person,name:'Аннализа'}]},'Анна пришлёт чертёж').id,null);
});

test('recovery never overrides cancellation, questions, tentative text or an existing result',async()=>{
 const {recoverPreparationTask}=await import('../../supabase/functions/cos-notes/communication-intent.mjs');
 const empty={changes:[],questions:[]};
 for(const source of ['Не нужно ставить Антону задачи завтра.','Подобрать задачи для Антона завтра?','Возможно, подобрать задачи Антону.','Вчера подобрал задачи Антону.','Дизайнер Антон прислал материалы.'])assert.equal(recoverPreparationTask(empty,{source}),empty,source);
 assert.equal(recoverPreparationTask(empty,{source:'Подобрать задачи Антону завтра.',corrections:[{text:'Не нужно, отменить.'}]}),empty);
 const found={changes:[{kind:'task_create',text:'Подобрать задачи'}]};assert.equal(recoverPreparationTask(found,{source:'Подобрать задачи Антону завтра.'}),found);
});

test('work dates survive editing and defer; invalid time is rejected and existing work intervals stay intact',async()=>{
 const {createCommunicationInbox}=await import(modulePath);
 const source='Подобрать задачи для Антона завтра в 9:30.';
 const f=setup({source,raw:{summary:'',changes:[{kind:'task_create',text:'Подобрать задачи',evidence:source,date_text:'завтра в 9:30',date_status:'explicit',date_kind:'work'}]}}),service=createCommunicationInbox(f);
 const {item}=await service.analyze(id,{revision:1});const proposal={version:1,changes:clone(item.proposal.changes)};
 proposal.changes[0].planned_time='99:00';await assert.rejects(service.apply(id,{revision:item.revision,request_id:uuid(),proposal}),e=>e.code==='invalid_work_time');
 proposal.changes[0].planned_time='10:15';const deferred=await service.defer(id,{revision:item.revision,request_id:uuid(),proposal});
 await service.apply(id,{revision:deferred.item.revision,request_id:uuid(),proposal:{version:1,changes:deferred.item.proposal.changes}});
 const task=f.calls.find(c=>c[0]==='cos_inbox_apply')[1].p_actions[0].task;assert.equal(task.planned_start_at,'2026-10-01T08:15:00.000Z');
});

test('updating task text preserves an existing work interval and deadline timestamp',async()=>{
 const {createCommunicationInbox}=await import(modulePath);const taskId=uuid(),source='Colryut: Анна прислала образец.';
 const f=setup({source,raw:{summary:'',changes:[{kind:'task_update',task_id:taskId,text:'Получить образец',evidence:source,project_id:project,participant_id:person,status:'completed',date_status:'none'}]}});
 f.context.commitments.push({id:taskId,description:'Получить образец',project_id:project,participant_id:person,direction:'to_me',status:'open',deadline:'2026-10-05',deadline_at:'2026-10-05T10:00:00Z',next_check_on:null,planned_on:'2026-10-02',planned_start_at:'2026-10-02T07:00:00Z',planned_end_at:'2026-10-02T08:00:00Z',cos_version:2});
 const service=createCommunicationInbox(f),{item}=await service.analyze(id,{revision:1});
 await service.apply(id,{revision:item.revision,request_id:uuid(),proposal:{version:1,changes:item.proposal.changes}});
 const patch=f.calls.find(c=>c[0]==='cos_inbox_apply')[1].p_actions[0].patch;
 assert.equal(patch.status,'completed');for(const field of ['planned_on','planned_start_at','planned_end_at','deadline','deadline_at'])assert.equal(Object.hasOwn(patch,field),false,field);
});
