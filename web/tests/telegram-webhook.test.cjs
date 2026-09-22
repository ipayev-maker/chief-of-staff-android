// Node 24; synthetic Telegram updates and injected adapters only. No network.
const {test}=require('node:test');const assert=require('node:assert/strict');
const implementation=Promise.all([import('../../supabase/functions/telegram-webhook/handler.mjs'),import('../../supabase/functions/telegram-webhook/runtime.mjs')]);
const ID='12345678-1234-4123-8123-123456789abc';
const config={webhookSecret:'a'.repeat(64),telegramOwnerUserId:'123456789',telegramOwnerChatId:'123456789'};
const update=(extra={})=>({update_id:100,message:{message_id:200,from:{id:123456789,is_bot:false},chat:{id:123456789,type:'private'},text:'Обычная мысль',...extra}});
async function fixture(){
  const [{createTelegramWebhook}]=await implementation;const calls=[],sent=[],receipts=new Map();
  const env={extractResult:{project:null,commitments:[],events:[]},extractionError:false,dateResult:{dates:[]},saveError:false,replyError:false,raceDuplicate:false,ownerTarget:true,config:{...config}};
  const store={async list(table,query){calls.push({type:'list',table,query});if(table==='cos_notes_telegram_receipts'){const p=new URLSearchParams(query);const key=p.get('chat_id')+':'+p.get('message_id');return receipts.has(key)?[{result_json:receipts.get(key)}]:[]}return env.ownerTarget?[{id:ID}]:[]},async rpc(name,body){calls.push({type:'rpc',name,body:structuredClone(body)});if(env.saveError)throw Error('private database body');if(name==='cos_notes_ingest_telegram'){const result={kind:body.p_kind,note_id:body.p_kind==='note'?ID:null,inbox_id:body.p_kind==='entities'?ID:null,commitment_ids:body.p_kind==='entities'?[ID]:[],duplicate:env.raceDuplicate};receipts.set('eq.'+body.p_chat_id+':eq.'+body.p_message_id,result);return result}return {success:true}}};
  const handler=createTelegramWebhook({
    loadConfig:async()=>{calls.push({type:'config'});return env.config},store,
    extract:async text=>{calls.push({type:'extract',text});if(env.extractionError)throw Error('private model response');return structuredClone(env.extractResult)},
    parseDates:async text=>{calls.push({type:'dates',text});return structuredClone(env.dateResult)},
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
test('entity extraction preserves task directions/date and passes required Telegram IDs to atomic RPC',async()=>{
  const env=await fixture();env.extractResult={project:null,commitments:[{description:'Ответить Юрию',who:'Юрий',direction:'from_me',deadline:null}],events:[{description:'Обсуждение проекта',date:null}]};env.dateResult={dates:[{date:'2026-10-01'}]};
  assert.equal((await env.run()).status,200);const body=env.rpc()[0].body;assert.equal(body.p_kind,'entities');assert.equal(body.p_message_id,200);assert.equal(body.p_commitments[0].deadline,'2026-10-01');assert.equal(body.p_commitments[0].direction,'from_me');assert.equal(body.p_events[0].date,'2026-10-01');
  assert.match(env.sent[0].body.text,/Ответить Юрию/);assert.equal(env.sent[0].body.reply_markup.inline_keyboard[0][0].callback_data,'done:'+ID);
});
test('date parser failure prevents partial task storage',async()=>{
  const env=await fixture();env.extractResult={project:null,commitments:[{description:'Action',direction:'internal'}],events:[]};env.dateResult={dates:[{date:'2026-02-30'}]};
  assert.equal((await env.run()).status,503);assert.equal(env.rpc().length,0);assert.equal(env.sent.length,0);
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
  await runtime.parseDates('Tomorrow');assert.equal(requests[1].init.headers.Authorization,'Bearer anon-test');
  const broken=createTelegramRuntime({...env,fetchImpl:async()=>new Response('private upstream error',{status:500})});await assert.rejects(broken.extract('text'),{message:'upstream_failed'});
});
