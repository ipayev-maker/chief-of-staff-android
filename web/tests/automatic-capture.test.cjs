// Node 24: real webhook + inbox service, synthetic speech/model/storage/Telegram.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const clone=structuredClone;
const ID='00000000-0000-4000-8000-000000000001',PERSON='00000000-0000-4000-8000-000000000002';
const OWNER=123456789,NOW='2026-10-21T06:02:30Z';
async function fixture(source,raw,{voice=false,meta={},people=[],lostReply=false}={}){
  const [{createCommunicationInbox},{createTelegramWebhook}]=await Promise.all([
    import('../../supabase/functions/cos-notes/communication-inbox.mjs'),import('../../supabase/functions/telegram-webhook/handler.mjs')]);
  let item,receipt=false,serial=100,claimed=false;
  const uuid=()=>`00000000-0000-4000-8000-${String(serial++).padStart(12,'0')}`;
  const records=[],calls=[],sent=[],receipts=new Map(),config={webhookSecret:'s'.repeat(64),telegramOwnerUserId:String(OWNER),telegramOwnerChatId:String(OWNER)};
  const store={
    async page(table){if(table==='cos_communication_inbox')return [clone(item)];if(table==='cos_calendar_connection')return [{time_zone:'Europe/Moscow'}];return []},
    async list(table){if(table==='cos_notes_telegram_receipts')return receipt?[{}]:[];if(table==='participants')return people;return []},
    async rpc(name,args){calls.push({name,args:clone(args)});
      if(name==='cos_inbox_capture_telegram'){receipt=true;item={id:ID,note_id:uuid(),status:'captured',revision:1,source_text:args.p_text,source_meta:{...args.p_source_meta,...meta},created_at:NOW,proposal:{}};return {item:clone(item),duplicate:false};}
      if(name==='cos_inbox_update'){if(args.p_revision!==item.revision)throw {code:'PT409'};item={...item,...args.p_patch,source_meta:{...item.source_meta,...args.p_patch.source_meta},revision:item.revision+1};return {item:clone(item)};}
      if(name==='cos_inbox_apply'){
        if(receipts.has(args.p_request_id))return receipts.get(args.p_request_id);
        if(args.p_revision!==item.revision||item.status!=='ready')throw {code:'PT409'};
        const changes=args.p_actions.map(action=>({id:action.id,kind:action.kind,before:null,after:{...(action.task||action.meeting),id:action.id,cos_version:1}}));
        records.push(...changes);item={...item,status:'applied',revision:item.revision+1,applied_result:{changes},applied_at:NOW};
        const result={item:clone(item),result:item.applied_result};receipts.set(args.p_request_id,result);if(lostReply){lostReply=false;throw Error('lost response');}return result;
      }
      if(name==='cos_inbox_claim_reply'){if(claimed)return false;claimed=true;return true;}
      throw Error(name);
    }
  };
  const service=createCommunicationInbox({store,timeZone:'Europe/Moscow',uuid,now:()=>new Date(NOW),
    voice:{async save(){return {path:'private/synthetic.ogg'}},async transcribe(){assert.equal(records.length,0);return source}},
    model:async()=>{assert.equal(records.length,0);return {data:raw,model:'synthetic',usage:{}}}});
  const handler=createTelegramWebhook({store,createInbox:()=>service,loadConfig:async()=>config,now:()=>new Date(NOW),sendTelegram:async(method,body)=>{sent.push({method,body});return {message_id:1}}});
  const update={update_id:1,message:{message_id:1,from:{id:OWNER},chat:{id:OWNER,type:'private'},date:Date.parse(NOW)/1000,...(voice?{voice:{file_id:'synthetic',duration:10}}:{text:source})}};
  const run=()=>handler(new Request('https://example.invalid/telegram-webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':config.webhookSecret},body:JSON.stringify(update)}));
  return {run,service,records,calls,sent,item:()=>clone(item),update};
}
const task=(evidence,extra={})=>({summary:'',questions:[],changes:[{kind:'task_create',text:'Подготовить смету',evidence,status:'open',direction:'internal',date_status:'none',...extra}]});
test('voice appointment with dotted clock and inflected full name creates a meeting immediately',async()=>{
  const source='Сегодня в 15.00 встреча с Сергеем Соколовым.';
  const f=await fixture(source,{summary:'Встреча',questions:[],changes:[{kind:'meeting_create',text:'Встреча с Сергеем Соколовым',evidence:source,participant_id:PERSON}]},{voice:true,people:[{id:PERSON,name:'Сергей Соколов'}]});
  assert.equal((await f.run()).status,200);assert.equal(f.item().status,'applied');assert.equal(f.records.length,1);
  assert.equal(f.records[0].kind,'meeting_create');assert.equal(f.records[0].after.starts_at,'2026-10-21T12:00:00.000Z');
  assert.match(f.records[0].after.agenda,/Участник: Сергей Соколов/);assert.deepEqual(f.item().proposal.questions,[]);
  assert.match(f.sent[0].body.text,/Встреча создана/);assert.match(f.sent[0].body.text,/2026-10-21 в 15:00/);
  assert.match(f.sent[0].body.reply_markup.inline_keyboard[0][0].url,/#\/inbox\//);
  assert.equal(f.sent[0].body.reply_markup.inline_keyboard[1][0].callback_data,'ic:'+ID+':0');
  await f.run();assert.equal(f.records.length,1);assert.equal(f.sent.length,1);
});
test('voice task preserves work time and unknown participant without making a meeting or demanding a project',async()=>{
  const source='Завтра в 9.30 подготовить смету для Антона.';
  const f=await fixture(source,task(source,{participant_name:'Антон',participant_mention:'Антона',date_kind:'work',date_status:'explicit',date_text:'Завтра'}),{voice:true});
  await f.run();assert.equal(f.item().status,'applied');assert.equal(f.records.length,1);
  const record=f.records[0];assert.equal(record.kind,'task_create');assert.equal(record.after.planned_on,'2026-10-22');
  assert.equal(record.after.planned_start_at,'2026-10-22T06:30:00.000Z');assert.equal(record.after.deadline,null);
  assert.equal(record.after.project_id,null);assert.equal(record.after.participant_id,null);assert.match(record.after.details,/Антон/);
  assert.match(f.sent[0].body.text,/Задача создана/);assert.match(f.sent[0].body.text,/Работа: 2026-10-22 в 09:30/);
});
test('task without optional dates or people is created; an explicit due date stays a deadline',async()=>{
  for(const [source,extra,deadline]of [['Подготовить смету.',{},null],['Подготовить смету до пятницы.',{date_text:'до пятницы',date_status:'explicit',date_kind:'deadline'},'2026-10-23']]){
    const f=await fixture(source,task(source,extra));await f.run();assert.equal(f.records.length,1);assert.equal(f.records[0].after.deadline,deadline);assert.equal(f.records[0].after.planned_on,null);
  }
});
test('uncertain apply response is recovered from durable result without recreating records',async()=>{
  const f=await fixture('Подготовить смету.',task('Подготовить смету.'),{lostReply:true});await f.run();
  assert.equal(f.item().status,'applied');assert.equal(f.records.length,1);assert.match(f.sent[0].body.text,/Задача создана/);
  await f.service.autoApply(ID);assert.equal(f.records.length,1);assert.equal(f.calls.filter(c=>c.name==='cos_inbox_apply').length,1);
});
test('forwards, Gmail, historical messages and uncertainty remain reviewable without automatic writes',async()=>{
  const cases=[{meta:{forwarded:true}},{meta:{channel:'email',type:'text'}},{meta:{auto_create:false}},{meta:{message_date:'2026-10-17T06:02:30Z'}}];
  for(const opt of cases){const f=await fixture('Подготовить смету.',task('Подготовить смету.'),opt);await f.run();assert.equal(f.item().status,'ready');assert.equal(f.records.length,0);}
  for(const source of ['Возможно, завтра подготовить смету.','Не надо подготовить смету.','Например, подготовить смету.']){
    const f=await fixture(source,task(source));await f.run();assert.equal(f.records.length,0);
  }
  const {automaticCreation}=await import('../../supabase/functions/cos-notes/communication-auto.mjs');
  const f=await fixture('Подготовить смету.',task('Подготовить смету.'));await f.run();const row=f.item();row.status='ready';row.source_meta.type='gmail';assert.equal(automaticCreation(row,new Date(NOW)),false);
});
test('unresolved meeting time and invalid task clock do not silently lose the requested schedule',async()=>{
  for(const [source,raw]of [
    ['Завтра встреча с Сергеем.',{summary:'',changes:[{kind:'meeting_create',text:'Встреча',evidence:'Завтра встреча с Сергеем.'}]}],
    ['Завтра в 15.99 подготовить смету.',task('Завтра в 15.99 подготовить смету.',{date_text:'Завтра',date_status:'explicit',date_kind:'work'})]
    ,['В 15:00 подготовить смету.',task('В 15:00 подготовить смету.')]
  ]){const f=await fixture(source,raw);await f.run();assert.equal(f.item().status,'ready');assert.equal(f.records.length,0);assert.ok(f.item().proposal.questions.length);}
});
test('voice caption negation prevents executing an affirmative transcript fragment',async()=>{
 const source='Подготовить смету.';const f=await fixture(source,task(source),{voice:true,meta:{caption:'Не создавай задачу, это пример.'}});
 await f.run();assert.equal(f.records.length,0);
});
test('one direct message can atomically create both a task and a meeting',async()=>{
  const one='Завтра в 10.00 встреча с Марией.',two='Подготовить смету.';
  const f=await fixture(one+' '+two,{summary:'',questions:[],changes:[{kind:'meeting_create',text:'Встреча с Марией',evidence:one},...task(two).changes]});
  await f.run();assert.deepEqual(f.records.map(r=>r.kind),['meeting_create','task_create']);assert.equal(f.calls.filter(c=>c.name==='cos_inbox_apply').length,1);
});
