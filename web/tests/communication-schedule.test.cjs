const {test}=require('node:test');
const assert=require('node:assert/strict');
const mod=import('../../supabase/functions/cos-notes/communication-schedule.mjs');
const options={refDate:'2026-09-30T16:45:03Z',timeZone:'Europe/Moscow'};
test('speech clock formats do not count as a second calendar date',async()=>{
 for(const clock of ['15.00','15:00','15 часов','15']){
  const result=await parse('Сегодня в '+clock+' встреча с Сергеем Соколовым.');
  assert.equal(result?.meeting_date,'2026-09-30',clock);assert.equal(result?.meeting_time,'15:00',clock);
 }
 const numeric=await parse('01.10.2026 в 15.00 встреча с Сергеем.');assert.equal(numeric.meeting_date,'2026-10-01');
});
async function parse(source,extra={}){const {sourceAppointment}=await mod;return sourceAppointment({kind:'task_create',text:source,evidence:source,...extra},{...options,full:source});}
test('clock order and literal duration are independent of rewritten model wording',async()=>{
 const a=await parse('Завтра обсудить припак с Факелом в 9:15, 45 минут.',{duration_text:'45 минут'});
 assert.deepEqual(a,{meeting_date:'2026-10-01',meeting_time:'09:15',duration_minutes:45,duration_estimated:false});
 const b=await parse('В 9:15 завтра созвониться с Анной.');assert.equal(b.meeting_time,'09:15');assert.equal(b.meeting_date,'2026-10-01');
});
test('never schedule cancelled, uncertain, deadline-only, reminder or multiclause actions',async()=>{
 for(const source of ['Возможно, завтра в 9:15 обсудить припак.','Завтра в 9:15 встреча отменена.','До 9:15 завтра обсудить припак.','Напомни завтра в 9:15 обсудить припак.','Завтра в 9:15 или в 10:00 обсудить припак.','Завтра обсудить припак; отправить смету в 9:15.','Завтра в 9:15 отправить смету.','Завтра в 29:15 обсудить припак.','Постараемся завтра в 9:15 обсудить припак.'])assert.equal(await parse(source),null,source);
});
test('untrusted model duration and date outside evidence cannot become a meeting',async()=>{
 const result=await parse('Завтра в 9:15 обсудить припак.',{duration_text:'90 минут'});assert.equal(result.duration_minutes,30);
 const {sourceAppointment}=await mod;
 assert.equal(sourceAppointment({kind:'meeting_create',text:'Встреча',evidence:'Завтра в 9:15 встреча'},{...options,full:'Обсудить припак'}),null);
 assert.equal(sourceAppointment({kind:'meeting_create',text:'Встреча',evidence:'Завтра в 9:15 встреча'},{...options,full:'Завтра в 9:15 встреча',forwardedUnknown:true}),null);
});
test('meeting review renders start time and editable duration as a meeting, not a deadline',()=>{
 const inbox=require('../inbox.js');
 const change={id:'00000000-0000-4000-8000-000000000001',kind:'meeting_create',text:'Обсудить припак',evidence:'Завтра в 9:15 обсудить припак',selected:true,project_id:null,participant_id:null,meeting_date:'2026-10-01',meeting_time:'09:15',duration_minutes:30,duration_estimated:true};
 const session=inbox.createSession({id:'00000000-0000-4000-8000-000000000002',status:'ready',revision:2,proposal:{version:1,time_zone:'Europe/Moscow',changes:[change]}});
 let html=inbox.renderDetail(session);assert.match(html,/Встреча в календаре/);assert.match(html,/09:15/);assert.match(html,/по умолчанию/);assert.match(html,/Москва/);
 session.editing=true;html=inbox.renderDetail(session);assert.match(html,/data-ci-field="meeting_date"/);assert.match(html,/data-ci-field="meeting_time"/);assert.match(html,/data-ci-field="duration_minutes"/);
 assert.equal(inbox.validateProposal(session.proposal), '');session.proposal.changes[0].duration_minutes=0;assert.match(inbox.validateProposal(session.proposal),/длительность/);
});

test('spoken clock hours retain exact time and reject unsupported number sequences',async()=>{
  for(const [clock,time]of [['двенадцать','12:00'],['двенадцать часов','12:00'],['двадцать один','21:00'],['три часа дня','15:00'],['семь вечера','19:00'],['12 ночи','00:00']])assert.equal((await parse('Сегодня в '+clock+' встреча с Соколовой.'))?.meeting_time,time,clock);
  for(const clock of ['двенадцать три часа','12 03','двенадцать тридцать','12 минут','двадцать пять'])assert.equal(await parse('Сегодня в '+clock+' встреча с Соколовой.'),null,clock);
});

test('terse weekday appointments with bare clocks are recovered separately and SKU quantities are not clocks',async()=>{
 const {normalizeInboxProposal}=await import('../../supabase/functions/cos-notes/communication-inbox.mjs');
 const {clockEvidence}=await import('../../supabase/functions/telegram-webhook/time-evidence.mjs');
 const context={projects:[],participants:[],tasks:[],briefs:[]},base={source_meta:{message_date:'2026-10-26T13:45:00Z'},created_at:'2026-10-26T13:45:00Z',proposal:{}};
 const p=normalizeInboxProposal({summary:'',questions:[],changes:[]},{item:{...base,source_text:'Встреча агентство Eva среда 12.00\nЗум Инсталл Групп завтра 13.00'},context,timeZone:'Europe/Moscow'});
 assert.deepEqual(p.changes.map(c=>[c.kind,c.meeting_date,c.meeting_time]),[['meeting_create','2026-10-28','12:00'],['meeting_create','2026-10-27','13:00']]);assert.deepEqual(p.questions,[]);
 for(const source of ['Сделать кассету под пудры на 6 sku','Подставка на 12 штук','Подсветка в 2 ряда','Накладка акрил 2 мм'])assert.deepEqual(clockEvidence(source),[],source);
 const task=normalizeInboxProposal({summary:'',questions:[],changes:[]},{item:{...base,source_text:'Сделать кассету под пудры на 6 sku'},context,timeZone:'Europe/Moscow'});assert.equal(task.changes[0].kind,'task_create');assert.equal(task.changes[0].deadline,null);assert.deepEqual(task.questions,[]);
 const imperative=normalizeInboxProposal({summary:'',questions:['Что делать?'],changes:[]},{item:{...base,source_text:'Запроси нашу грамоту повторно'},context});assert.equal(imperative.changes[0].text,'Запросить нашу грамоту повторно');assert.deepEqual(imperative.questions,[]);
});
test('literal relative dates and same-day clock ranges retain exact meeting duration',async()=>{
 for(const [source,date,time,duration] of [
  ['Через неделю в 12 встреча с Антоном','2026-10-07','12:00',30],
  ['Через 3 дня в 12 встреча с Антоном','2026-10-03','12:00',30],
  ['Сегодня с 13:00 до 14:00 встреча с Антоном по Интершарму','2026-09-30','13:00',60],
  ['Сегодня с 9.30 до 10.45 встреча с Антоном','2026-09-30','09:30',75],
 ]){const result=await parse(source);assert.deepEqual([result?.meeting_date,result?.meeting_time,result?.duration_minutes],[date,time,duration],source);}
 for(const source of ['Через месяц в 12 встреча с Антоном','Через 0 дней в 12 встреча','Сегодня с 23:00 до 01:00 встреча','Сегодня с 13:00 до 13:00 встреча','Сегодня с 13:00 до 25:00 встреча','Сегодня с 13:00 до 14:00 или в 15:00 встреча','Сегодня встреча обсудить рост с 13 до 14 рублей','Встреча с 3 по 5 октября в 12','Встреча с 3 до 5 ноября','Сегодня встреча обсудить сокращение срока с 3 до 5 дней'])assert.equal(await parse(source),null,source);
});
test('a separate date/time header produces one meeting even when model quotes lose the header',async()=>{
 const {normalizeInboxProposal}=await import('../../supabase/functions/cos-notes/communication-inbox.mjs');
 const {recoverAppointment}=await mod;
 const header='29.10 – с 13:00 до 14:00',title='Встреча с Open Group по проекту Технический мерчандайзинг',source=header+'\n'+title;
 const context={projects:[],participants:[],tasks:[],briefs:[]},item={source_text:source,source_meta:{message_date:'2026-10-28T10:00:00Z'},created_at:'2026-10-28T10:00:00Z'};
 for(const changes of [[],[{kind:'meeting_create',text:title,evidence:source,date_text:'29.10',date_status:'explicit'}],[{kind:'meeting_create',text:title,evidence:title},{kind:'meeting_create',text:'Встреча',evidence:header}]]){
  const result=normalizeInboxProposal({summary:'',questions:['Уточните дату и время встречи'],changes},{item,context});
  assert.equal(result.changes.length,1);const meeting=result.changes[0];
  assert.deepEqual([meeting.kind,meeting.meeting_date,meeting.meeting_time,meeting.duration_minutes,meeting.duration_estimated,meeting.selected],['meeting_create','2026-10-29','13:00',60,false,true]);
  assert.equal(meeting.evidence,source);assert.deepEqual(result.questions,[]);
 }
 const task={kind:'task_create',text:'Отправить смету',evidence:'Отправить смету'};
 const mixed=header+'\n'+title+'\nОтправить смету';
 const raw={changes:[{kind:'meeting_create',text:title,evidence:header+'\n'+title},task],questions:[]};
 assert.equal(recoverAppointment(raw,{source:mixed,refDate:item.created_at,timeZone:'Europe/Moscow'}),raw,'never collapse a task and meeting');
 const update={changes:[{kind:'task_update',text:title,evidence:source,task_id:'00000000-0000-4000-8000-000000000001'}],questions:[]};
 assert.equal(recoverAppointment(update,{source,refDate:item.created_at,timeZone:'Europe/Moscow'}),update,'never replace an existing-task update');
});
