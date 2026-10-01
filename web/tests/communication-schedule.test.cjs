const {test}=require('node:test');
const assert=require('node:assert/strict');
const mod=import('../../supabase/functions/cos-notes/communication-schedule.mjs');
const options={refDate:'2026-09-30T16:45:03Z',timeZone:'Europe/Moscow'};
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
