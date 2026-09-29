// Real webhook/runtime/store/voice/inbox composition; all remote I/O is synthetic.
// Receipts, settings and project briefs do not have an `id` column. The fixture
// rejects invalid PostgREST columns instead of returning a permissive empty set.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const runtimeModule=import('../../supabase/functions/telegram-webhook/runtime.mjs');
const handlerModule=import('../../supabase/functions/telegram-webhook/handler.mjs');
const ID='12345678-1234-4123-8123-123456789abc';
const OWNER=123456789;
// Match cos_notes_get_config: timezone is loaded separately from cos_settings.
const CONFIG={webhookSecret:'a'.repeat(64),telegramOwnerUserId:String(OWNER),telegramOwnerChatId:String(OWNER)};
const TRANSCRIPT='После звонка: образец будет готов завтра.';
const NON_ID_COLUMNS={
  cos_notes_telegram_receipts:new Set(['chat_id','message_id','update_id','user_id','kind','result_json','created_at']),
  cos_settings:new Set(['singleton','time_zone']),
  cos_project_briefs:new Set(['project_id','revision','document','updated_at']),
};
const json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json',...headers}});
const ogg=()=>{const value=new Uint8Array(64);value.set([79,103,103,83]);return value};

async function fixture({existingReceipt=false}={}){
  const [{createTelegramRuntime},{createTelegramWebhook}]=await Promise.all([runtimeModule,handlerModule]);
  const calls=[],sent=[];
  let receipt=existingReceipt,item=null,storedAudio=null;
  const fetchImpl=async(target,init={})=>{
    const url=new URL(target),path=url.pathname;
    const body=typeof init.body==='string'?JSON.parse(init.body):init.body;
    calls.push({path,params:new URLSearchParams(url.search),body,method:init.method||'GET'});
    if(path==='/rest/v1/rpc/cos_notes_get_config')return json(CONFIG);
    const table=path.replace('/rest/v1/',''),allowedColumns=NON_ID_COLUMNS[table];
    if(allowedColumns){
      const columns=[...(url.searchParams.get('select')||'').split(','),...(url.searchParams.get('order')||'').split(',').map(order=>order.split('.')[0])];
      if(columns.some(column=>column&&!allowedColumns.has(column)))return json({code:'42703',message:'column '+table+'.id does not exist'},400);
    }
    if(path==='/rest/v1/cos_notes_telegram_receipts'){
      assert.equal(url.searchParams.get('chat_id'),'eq.'+OWNER);
      assert.equal(url.searchParams.get('message_id'),'eq.200');
      return receipt?json([{result_json:{note_id:ID}}],200,{'Content-Range':'0-0/1'}):json([]);
    }
    if(path==='/rest/v1/cos_settings'){
      assert.equal(url.searchParams.get('order'),'singleton.asc');
      return json([{time_zone:'Europe/Berlin'}],200,{'Content-Range':'0-0/1'});
    }
    if(path==='/rest/v1/cos_project_briefs'){
      assert.equal(url.searchParams.get('order'),'project_id.asc');
      return json([]);
    }
    if(path==='/rest/v1/rpc/cos_inbox_capture_telegram'){
      assert.equal(receipt,false);
      receipt=true;
      item={id:ID,note_id:ID,source_text:body.p_text,source_meta:body.p_source_meta,transcript:null,status:'captured',revision:1,proposal:{},created_at:'2026-09-29T20:00:00.000Z',updated_at:'2026-09-29T20:00:00.000Z'};
      return json({item,duplicate:false});
    }
    if(path==='/rest/v1/cos_communication_inbox')return json(item?[item]:[]);
    if(path==='/rest/v1/rpc/cos_inbox_update'){
      assert.equal(body.p_id,ID);
      assert.equal(body.p_revision,item.revision);
      const patch=body.p_patch;
      item={...item,...patch,source_meta:{...item.source_meta,...patch.source_meta},revision:item.revision+1};
      return json({item});
    }
    if(['/rest/v1/projects','/rest/v1/participants','/rest/v1/commitments'].includes(path))return json([]);
    if(path==='/botsynthetic-bot/getFile')return json({ok:true,result:{file_path:'voice/file_123.oga',file_size:64}});
    if(path==='/file/botsynthetic-bot/voice/file_123.oga')return new Response(ogg());
    if(path==='/storage/v1/object/cos-communication-audio/'+OWNER+'/'+ID+'/voice.ogg'){
      assert.equal(init.method,'POST');storedAudio=new Uint8Array(body);return json({});
    }
    if(path==='/storage/v1/object/authenticated/cos-communication-audio/'+OWNER+'/'+ID+'/voice.ogg'){
      assert.ok(storedAudio,'recognition must read the original after private storage succeeds');return new Response(storedAudio);
    }
    if(path==='/api/v1/audio/transcriptions'){
      assert.deepEqual(Buffer.from(body.input_audio.data,'base64'),Buffer.from(storedAudio));
      return json({text:TRANSCRIPT});
    }
    if(path==='/api/v1/chat/completions')return json({choices:[{message:{content:JSON.stringify({summary:'Сохранён итог звонка.',questions:[],changes:[]})}}],usage:{prompt_tokens:10,completion_tokens:10}});
    if(path==='/rest/v1/rpc/cos_inbox_claim_reply')return json(true);
    if(path==='/botsynthetic-bot/sendMessage'){sent.push(body);return json({ok:true,result:{message_id:201}})}
    throw Error('Unexpected synthetic network path: '+path);
  };
  const runtime=createTelegramRuntime({url:'https://synthetic.supabase.co',serviceKey:'synthetic-service',botToken:'synthetic-bot',openRouterKey:'synthetic-ai',fetchImpl,now:()=>new Date('2026-09-29T20:00:00Z')});
  const handler=createTelegramWebhook(runtime);
  const run=kind=>handler(new Request('https://synthetic.supabase.co/functions/v1/telegram-webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':CONFIG.webhookSecret},body:JSON.stringify({update_id:100,message:{message_id:200,date:1790712000,from:{id:OWNER,is_bot:false},chat:{id:OWNER,type:'private'},...(kind==='voice'?{voice:{file_id:'synthetic-file',duration:10,file_size:64,mime_type:'audio/ogg'}}:{text:TRANSCRIPT})}})}));
  return {calls,sent,runtime,run,get item(){return item}};
}

test('strict non-id schema fixtures reject explicit invalid id ordering',async()=>{
  const env=await fixture();
  for(const [table,select] of [['cos_notes_telegram_receipts','result_json'],['cos_settings','time_zone'],['cos_project_briefs','project_id,revision,document']]){
    await assert.rejects(env.runtime.store.page(table,'select='+select+'&order=id.asc'),{code:'42703',status:400});
  }
  assert.equal(env.item,null);
});

test('real store defaults use receipt composite key, settings singleton and private project brief project key',async()=>{
  const env=await fixture();
  assert.deepEqual(await env.runtime.store.list('cos_notes_telegram_receipts','select=result_json&chat_id=eq.'+OWNER+'&message_id=eq.200'),[]);
  assert.equal(env.calls.at(-1).params.get('order'),'chat_id.asc,message_id.asc');
  assert.deepEqual(await env.runtime.store.page('cos_settings','select=time_zone&limit=1'),[{time_zone:'Europe/Berlin'}]);
  assert.equal(env.calls.at(-1).params.get('order'),'singleton.asc');
  assert.deepEqual(await env.runtime.store.page('cos_project_briefs','select=project_id,revision,document&project_id=eq.'+ID+'&limit=1'),[]);
  assert.equal(env.calls.at(-1).params.get('order'),'project_id.asc');
});

for(const kind of ['voice','text'])test('real Telegram '+kind+' pipeline captures and analyzes with composite receipt key; retry does not repeat work',async()=>{
  const env=await fixture();
  const response=await env.run(kind);
  assert.equal(response.status,200,await response.text());
  assert.equal(env.item?.status,'ready');
  assert.equal(env.item.source_meta.type,kind);
  assert.equal(env.item.source_text,kind==='voice'?'[Голосовое сообщение]':TRANSCRIPT);
  if(kind==='voice')assert.equal(env.item.transcript,TRANSCRIPT);
  const paths=env.calls.map(call=>call.path);
  const captureIndex=paths.indexOf('/rest/v1/rpc/cos_inbox_capture_telegram');
  const modelIndex=paths.indexOf('/api/v1/chat/completions');
  assert.ok(captureIndex>=0&&modelIndex>captureIndex);
  assert.ok(paths.indexOf('/rest/v1/cos_settings')>captureIndex);
  assert.ok(paths.indexOf('/rest/v1/cos_settings')<modelIndex);
  assert.equal(env.item.proposal.time_zone,'Europe/Berlin');
  if(kind==='voice')assert.ok(paths.indexOf('/api/v1/audio/transcriptions')>captureIndex);
  assert.equal(env.sent.length,1);
  assert.match(env.sent[0].text,/Сохранил во «Входящие»/);
  assert.equal(paths.includes('/rest/v1/rpc/cos_inbox_apply'),false);
  const boundary=env.calls.length;
  assert.equal((await env.run(kind)).status,200);
  assert.deepEqual(env.calls.slice(boundary).map(call=>call.path),['/rest/v1/rpc/cos_notes_get_config','/rest/v1/cos_notes_telegram_receipts']);
  assert.equal(env.sent.length,1);
});

test('legacy receipt skips capture, transcription, analysis and reply through real store',async()=>{
  const env=await fixture({existingReceipt:true});
  assert.equal((await env.run('voice')).status,200);
  assert.deepEqual(env.calls.map(call=>call.path),['/rest/v1/rpc/cos_notes_get_config','/rest/v1/cos_notes_telegram_receipts']);
  assert.equal(env.item,null);
  assert.equal(env.sent.length,0);
});
