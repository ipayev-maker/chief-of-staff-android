// Node 24; synthetic Telegram updates and injected adapters only. No network.
const {test}=require('node:test');const assert=require('node:assert/strict');
const implementation=Promise.all([import('../../supabase/functions/telegram-webhook/handler.mjs'),import('../../supabase/functions/telegram-webhook/runtime.mjs')]);
const ID='12345678-1234-4123-8123-123456789abc';
const config={webhookSecret:'a'.repeat(64),telegramOwnerUserId:'123456789',telegramOwnerChatId:'123456789'};
const update=(extra={})=>({update_id:100,message:{message_id:200,from:{id:123456789,is_bot:false},chat:{id:123456789,type:'private'},text:'Обычная мысль',...extra}});
async function fixture(){
  const [{createTelegramWebhook}]=await implementation;const calls=[],sent=[],receipts=new Map();
  const env={extractResult:{project:null,commitments:[],events:[]},extractionError:false,dateResult:{dates:[]},saveError:false,replyError:false,raceDuplicate:false,ownerTarget:true,config:{...config},refDate:'2026-09-24T18:00:00.000Z',dateResults:{},dateHandler:null};
  const store={async list(table,query){calls.push({type:'list',table,query});if(table==='cos_notes_telegram_receipts'){const p=new URLSearchParams(query);const key=p.get('chat_id')+':'+p.get('message_id');return receipts.has(key)?[{result_json:receipts.get(key)}]:[]}return env.ownerTarget?[{id:ID}]:[]},async rpc(name,body){calls.push({type:'rpc',name,body:structuredClone(body)});if(env.saveError)throw Error('private database body');if(name==='cos_notes_ingest_telegram'){const result={kind:body.p_kind,note_id:body.p_kind==='note'?ID:null,inbox_id:body.p_kind==='entities'?ID:null,commitment_ids:body.p_kind==='entities'?[ID]:[],duplicate:env.raceDuplicate};receipts.set('eq.'+body.p_chat_id+':eq.'+body.p_message_id,result);return result}return {success:true}}};
  const handler=createTelegramWebhook({
    loadConfig:async()=>{calls.push({type:'config'});return env.config},store,now:()=>new Date(env.refDate),
    extract:async(text,options)=>{calls.push({type:'extract',text,options});if(env.extractionError)throw Error('private model response');if(env.refAfterExtract)env.refDate=env.refAfterExtract;return structuredClone(env.extractResult)},
    parseDates:async(text,options)=>{calls.push({type:'dates',text,options});return env.dateHandler?env.dateHandler(text,options):structuredClone(env.dateResults[text]||env.dateResult)},
    sendTelegram:async(method,body)=>{sent.push({method,body});if(env.replyError)throw Error('private Telegram body');return {message_id:1}}
  });
  env.calls=calls;env.sent=sent;env.receipts=receipts;env.rpc=()=>calls.filter(call=>call.type==='rpc');
  env.run=(value=update(),headers={'X-Telegram-Bot-Api-Secret-Token':config.webhookSecret})=>handler(new Request('https://example.invalid/telegram-webhook',{method:'POST',headers,body:JSON.stringify(value)}));
  env.handler=handler;return env;
}
test('missing or incorrect webhook secret blocks all data processing',async()=>{
  const env=await fixture();assert.equal((await env.run(update(),{})).status,401);assert.equal(env.calls.length,0);
  assert.equal((await env.run(update(),{'X-Telegram-Bot-Api-Secret-Token':'wrong'})).status,401);assert.equal(env.calls.filter(call=>call.type!=='config').length,0);assert.equal(env.sent.length,0);
});
test('owner, private chat and sender checks reject other recipients even with valid secret',async()=>{
  const env=await fixture();
  for(const extra of [{from:{id:987654321}},{chat:{id:987654321,type:'private'}},{chat:{id:123456789,type:'group'}},{from:{id:123456789,is_bot:true}}])assert.equal((await env.run(update(extra))).status,200);
  assert.equal(env.calls.filter(call=>call.type!=='config').length,0);assert.equal(env.sent.length,0);
});
test('incomplete owner configuration fails closed',async()=>{
  const env=await fixture();env.config.telegramOwnerChatId='987654321';assert.equal((await env.run()).status,503);assert.equal(env.rpc().length,0);
});
test('plain text without tasks/events creates one private note without legacy writes or date parsing',async()=>{
  const env=await fixture();const response=await env.run(update({text:'  Исследовательская мысль  '}));assert.equal(response.status,200);
  assert.equal(env.rpc().length,1);const call=env.rpc()[0];assert.equal(call.name,'cos_notes_ingest_telegram');
  assert.deepEqual(call.body,{p_update_id:100,p_message_id:200,p_chat_id:123456789,p_user_id:123456789,p_text:'Исследовательская мысль',p_kind:'note',p_project:null,p_commitments:[],p_events:[],p_extracted:{}});
  assert.equal(env.calls.some(call=>call.type==='dates'),false);assert.equal(env.sent.length,1);assert.equal(env.sent[0].method,'sendMessage');assert.match(env.sent[0].body.text,/Сохранил заметку/);assert.match(env.sent[0].body.text,new RegExp('section=notes&id='+ID));
});
test('a project-only interpretation is still a note rather than an empty legacy journal entry',async()=>{
  const env=await fixture();env.extractResult.project={title:'Existing project',description:'Context'};await env.run();assert.equal(env.rpc()[0].body.p_kind,'note');assert.equal(env.rpc()[0].body.p_project,null);
});
test('text transcript follows the note path; unsupported raw voice is not falsely transcribed',async()=>{
  const env=await fixture();await env.run(update({text:'Транскрипция: идея для обсуждения'}));assert.equal(env.rpc()[0].body.p_kind,'note');
  const voice=await fixture();await voice.run(update({text:undefined,voice:{file_id:'synthetic'}}));assert.equal(voice.rpc().length,0);assert.equal(voice.sent.length,0);
});
test('malformed or failed extraction never silently becomes a saved note',async()=>{
  for(const value of [{},{project:null,commitments:[{description:'Action'}],events:[]}]){
    const env=await fixture();env.extractResult=value;const response=await env.run();assert.equal(response.status,503);assert.equal(env.rpc().length,0);assert.equal(env.sent.length,0);assert.equal((await response.text()).includes('private'),false);
  }
  const env=await fixture();env.extractionError=true;assert.equal((await env.run()).status,503);assert.equal(env.rpc().length,0);
});
test('existing receipt is checked before AI and produces no duplicate outbound reply',async()=>{
  const env=await fixture();await env.run();await env.run(update({text:'Changed duplicate must not overwrite'}));
  assert.equal(env.calls.filter(call=>call.type==='extract').length,1);assert.equal(env.rpc().length,1);assert.equal(env.sent.length,1);assert.equal(env.rpc()[0].body.p_text,'Обычная мысль');
});
test('concurrent duplicate determined by atomic RPC is acknowledged without a second reply',async()=>{
  const env=await fixture();env.raceDuplicate=true;assert.equal((await env.run()).status,200);assert.equal(env.rpc().length,1);assert.equal(env.sent.length,0);
});
test('entity extraction preserves independent dates and required Telegram IDs in the atomic RPC',async()=>{
  const env=await fixture();env.extractResult={project:null,commitments:[{description:'Ответить Юрию',who:'Юрий',direction:'from_me',source_text:'Ответить Юрию завтра',date_text:'завтра',date_status:'explicit'}],events:[{description:'Обсуждение проекта',source_text:'Обсуждение проекта 1 октября',date_text:'1 октября',date_status:'explicit'}]};
  assert.equal((await env.run(update({text:'Ответить Юрию завтра. Обсуждение проекта 1 октября.'}))).status,200);const body=env.rpc()[0].body;assert.equal(body.p_kind,'entities');assert.equal(body.p_message_id,200);assert.equal(body.p_commitments[0].deadline,'2026-09-25');assert.equal(body.p_commitments[0].direction,'from_me');assert.equal(body.p_events[0].date,'2026-10-01');
  assert.match(env.sent[0].body.text,/Ответить Юрию/);assert.equal(env.sent[0].body.reply_markup.inline_keyboard[0][0].callback_data,'done:'+ID);
  assert.equal(env.calls.filter(call=>call.type==='dates').length,0); // Known dates avoid the legacy parser's week rollover.
});
test('an impossible deadline is saved without a fabricated date and clearly reported',async()=>{
  const env=await fixture();env.extractResult={project:null,commitments:[{description:'Отправить образец',direction:'internal',source_text:'Отправить образец 30 февраля 2026',date_text:'30 февраля 2026',date_status:'explicit'}],events:[]};
  assert.equal((await env.run(update({text:'Отправить образец 30 февраля 2026'}))).status,200);assert.equal(env.rpc()[0].body.p_commitments[0].deadline,null);assert.match(env.sent[0].body.text,/Без даты: 1/);
});
test('database failure cannot claim the message was saved',async()=>{
  const env=await fixture();env.saveError=true;assert.equal((await env.run()).status,503);assert.equal(env.sent.length,0);
});
test('uncertain reply is not retried after durable storage',async()=>{
  const env=await fixture();env.replyError=true;assert.equal((await env.run()).status,200);assert.equal((await env.run()).status,200);assert.equal(env.rpc().length,1);assert.equal(env.sent.length,1);
});
test('callback target requires owner-matching database row before old task RPC',async()=>{
  const callback={update_id:101,callback_query:{id:'synthetic-query',from:{id:123456789},message:{chat:{id:123456789,type:'private'}},data:'done:'+ID}};
  const denied=await fixture();denied.ownerTarget=false;await denied.run(callback);assert.equal(denied.rpc().length,0);assert.equal(denied.sent.length,0);
  const env=await fixture();await env.run(callback);assert.match(env.calls.find(call=>call.type==='list').query,/telegram_user_id=eq.123456789/);assert.equal(env.rpc()[0].name,'set_commitment_status');assert.equal(env.rpc()[0].body.p_status,'completed');assert.equal(env.sent[0].method,'answerCallbackQuery');
});
test('invalid or oversized updates never reach classifier',async()=>{
  const env=await fixture();assert.equal((await env.run({update_id:-1,message:update().message})).status,400);
  assert.equal((await env.run(update({text:'x'.repeat(132000)}))).status,413);assert.equal(env.calls.some(call=>call.type==='extract'),false);
});
test('native adapters retain existing model/date parser and never turn HTTP errors into empty extraction',async()=>{
  const [, {createTelegramRuntime}]=await implementation;const requests=[];
  const env={url:'https://example.supabase.co',serviceKey:'service-test',anonKey:'anon-test',botToken:'bot-test',openRouterKey:'model-test'};
  const runtime=createTelegramRuntime({...env,fetchImpl:async(url,init)=>{requests.push({url,init});if(url.includes('openrouter.ai'))return new Response(JSON.stringify({choices:[{message:{content:'{"project":null,"commitments":[],"events":[]}'}}]}),{status:200});return new Response(JSON.stringify(url.includes('parse-dates')?{dates:[]}:{}),{status:200})}});
  assert.deepEqual(await runtime.extract('Synthetic text'),{project:null,commitments:[],events:[]});assert.equal(JSON.parse(requests[0].init.body).model,'anthropic/claude-sonnet-4.6');assert.equal(JSON.parse(requests[0].init.body).messages[1].content,'Synthetic text');
  const refDate='2026-09-24T21:01:00.000Z';await runtime.parseDates('Tomorrow',{refDate});assert.equal(requests[1].init.headers.Authorization,'Bearer anon-test');assert.deepEqual(JSON.parse(requests[1].init.body),{text:'Tomorrow',refDate});
  await runtime.extract('Контроль',{refDate});assert.match(JSON.parse(requests[2].init.body).messages[0].content,/Today is 2026-09-25/);assert.match(JSON.parse(requests[2].init.body).messages[0].content,/source_text/);
  const broken=createTelegramRuntime({...env,fetchImpl:async()=>new Response('private upstream error',{status:500})});await assert.rejects(broken.extract('text'),{message:'upstream_failed'});
});

const task=(description,source_text,date_text=null,extra={})=>({description,source_text,date_text,date_status:date_text?'explicit':'none',direction:'internal',...extra});
test('several deadlines, an undated task and an event keep their own dates',async()=>{
  const env=await fixture();const text='Чертежи завтра; образец в понедельник; запросить КП; встреча 1 октября.';
  env.extractResult={project:null,commitments:[task('Подготовить чертежи','Чертежи завтра','завтра'),task('Отправить образец','образец в понедельник','в понедельник'),task('Запросить КП','запросить КП')],events:[{description:'Встреча',source_text:'встреча 1 октября',date_text:'1 октября',date_status:'explicit'}]};
  assert.equal((await env.run(update({text}))).status,200);const saved=env.rpc()[0].body;
  assert.deepEqual(saved.p_commitments.map(row=>row.deadline),['2026-09-25','2026-09-28',null]);assert.equal(saved.p_events[0].date,'2026-10-01');assert.doesNotMatch(env.sent[0].body.text,/Без даты/);
  await env.run(update({text}));assert.equal(env.calls.filter(call=>call.type==='extract').length,1);assert.equal(env.rpc().length,1);assert.equal(env.sent.length,1);
});
test('one explicitly shared date applies to both actions',async()=>{
  const env=await fixture();const text='Завтра подготовить чертежи и отправить образец';env.extractResult={project:null,commitments:[task('Подготовить чертежи',text,'Завтра'),task('Отправить образец',text,'Завтра')],events:[]};
  await env.run(update({text}));assert.deepEqual(env.rpc()[0].body.p_commitments.map(row=>row.deadline),['2026-09-25','2026-09-25']);
});
test('fabricated quotes and model-supplied normalized deadlines are never trusted',async()=>{
  const env=await fixture();const text='Запросить КП; подготовить чертежи завтра';env.extractResult={project:null,commitments:[task('Запросить КП','Запросить КП','в пятницу',{deadline:'2026-10-02'}),task('Подготовить чертежи','Подготовить чертежи 1 октября','1 октября')],events:[]};
  assert.equal((await env.run(update({text}))).status,200);assert.deepEqual(env.rpc()[0].body.p_commitments.map(row=>row.deadline),[null,null]);assert.match(env.sent[0].body.text,/Без даты: 2/);assert.equal(env.calls.filter(call=>call.type==='dates').length,0);
});
test('a missing date in evidence does not inherit another action date',async()=>{
  const env=await fixture();const text='Чертежи завтра; запросить КП';env.extractResult={project:null,commitments:[task('Чертежи','Чертежи завтра','завтра'),task('Запросить КП','запросить КП')],events:[]};
  await env.run(update({text}));assert.deepEqual(env.rpc()[0].body.p_commitments.map(row=>row.deadline),['2026-09-25',null]);
});
test('uncertain, negated and ranged dates remain unassigned even when the model picks one part',async()=>{
  for(const [source,date] of [['Отправить образец не завтра','завтра'],['Чертежи завтра или в пятницу','завтра'],['Образец с 25 по 27 сентября','27 сентября'],['Образец 25 сентября — 27 сентября','25 сентября'],['Образец примерно в пятницу','в пятницу'],['Образец на следующей неделе','на следующей неделе']]){
    const env=await fixture();env.extractResult={project:null,commitments:[task('Отправить образец',source,date)],events:[]};await env.run(update({text:source}));assert.equal(env.rpc()[0].body.p_commitments[0].deadline,null,source);assert.match(env.sent[0].body.text,/Без даты: 1/);assert.equal(env.calls.filter(call=>call.type==='dates').length,0);
  }
});
test('one Moscow reference instant governs extraction and dates even if extraction crosses midnight',async()=>{
  const env=await fixture();env.refDate='2026-09-24T20:59:59.000Z';env.refAfterExtract='2026-09-24T21:00:01.000Z';const text='Подготовить чертежи завтра; отправить образец послезавтра';
  env.extractResult={project:null,commitments:[task('Подготовить чертежи','Подготовить чертежи завтра','завтра'),task('Отправить образец','отправить образец послезавтра','послезавтра')],events:[]};
  await env.run(update({text}));const extraction=env.calls.find(call=>call.type==='extract');assert.equal(extraction.options.refDate,'2026-09-24T20:59:59.000Z');assert.deepEqual(env.rpc()[0].body.p_commitments.map(row=>row.deadline),['2026-09-25','2026-09-26']);assert.equal(env.calls.filter(call=>call.type==='dates').length,0);
});
test('unknown phrasing never calls the faulty legacy parser or silently assigns a date',async()=>{
  for(const date of ['на Рождество','неделю назад','через месяц']){
    const env=await fixture();const text='Отправить образец '+date;env.extractResult={project:null,commitments:[task('Отправить образец',text,date)],events:[]};env.dateHandler=async()=>{throw Error('must not be called')};
    assert.equal((await env.run(update({text}))).status,200);assert.equal(env.rpc()[0].body.p_commitments[0].deadline,null);assert.match(env.sent[0].body.text,/Без даты: 1/);assert.equal(env.calls.filter(call=>call.type==='dates').length,0);
  }
});
test('contradictory date status and negation after the date require clarification',async()=>{
  for(const extra of [{date_status:'none'},{date_status:'unexpected'},{date_status:undefined}]){
    const env=await fixture();const text='Чертежи завтра';env.extractResult={project:null,commitments:[task('Чертежи',text,'завтра',extra)],events:[]};await env.run(update({text}));assert.equal(env.rpc()[0].body.p_commitments[0].deadline,null);assert.match(env.sent[0].body.text,/Без даты: 1/);
  }
  const env=await fixture();const text='Встреча завтра не состоится';env.extractResult={project:null,commitments:[],events:[{description:'Встреча',source_text:text,date_text:'завтра',date_status:'explicit'}]};await env.run(update({text}));assert.equal(env.rpc()[0].body.p_events[0].date,null);assert.match(env.sent[0].body.text,/Без даты: 1/);
});

test('delayed Telegram delivery uses the original message day for relative deadlines',async()=>{
  const env=await fixture();env.refDate='2026-09-26T09:00:00.000Z';const text='Отправить образец завтра';env.extractResult={project:null,commitments:[task('Отправить образец',text,'завтра')],events:[]};
  const sent='2026-09-24T18:00:00.000Z';await env.run(update({text,date:Date.parse(sent)/1000}));assert.equal(env.calls.find(call=>call.type==='extract').options.refDate,sent);assert.equal(env.rpc()[0].body.p_commitments[0].deadline,'2026-09-25');
});
