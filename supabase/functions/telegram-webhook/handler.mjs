// Telegram owner-only ingestion. Deno 2 / Node 24 Web APIs; injected I/O for tests.
// Every eligible communication is durable before speech/AI processing. Applying
// proposals is a separate, explicit owner action shared with the dashboard.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP='https://chief-of-staff-v3-live.vercel.app/';
const ok=()=>new Response('ok',{status:200,headers:{'Cache-Control':'no-store'}});
const json=(error,status)=>new Response(JSON.stringify({error}),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const fail=code=>{throw Object.assign(new Error(code),{safeCode:code})};
const telegramId=value=>Number.isSafeInteger(value)&&value>0?String(value):null;
const itemOf=value=>value?.item||value;
async function equalSecret(a,b){
  if(typeof a!=='string'||typeof b!=='string'||a.length<1||b.length<32||a.length>256||b.length>256)return false;
  const hashes=await Promise.all([a,b].map(value=>crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))));
  const x=new Uint8Array(hashes[0]),y=new Uint8Array(hashes[1]);let diff=0;for(let i=0;i<x.length;i++)diff|=x[i]^y[i];return diff===0;
}
async function readUpdate(req){
  if(Number(req.headers.get('content-length')||0)>131072)fail('payload_too_large');
  if(!req.body)fail('invalid_json');const reader=req.body.getReader(),chunks=[];let size=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>131072){await reader.cancel();fail('payload_too_large')}chunks.push(value)}}finally{reader.releaseLock()}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
  try{return JSON.parse(new TextDecoder().decode(bytes))}catch{fail('invalid_json')}
}
function configValid(config){return /^[A-Za-z0-9_-]{32,256}$/.test(config?.webhookSecret||'')&&/^[1-9]\d*$/.test(config?.telegramOwnerUserId||'')&&config.telegramOwnerChatId===config.telegramOwnerUserId;}
function ownerMessage(from,chat,config){return telegramId(from?.id)===config.telegramOwnerUserId&&telegramId(chat?.id)===config.telegramOwnerChatId&&chat?.type==='private'&&from?.is_bot!==true;}
async function callbackRequestId(callback){
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('cos-inbox:'+callback.id+':'+callback.data))).slice(0,16);
  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const s=Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');return s.slice(0,8)+'-'+s.slice(8,12)+'-'+s.slice(12,16)+'-'+s.slice(16,20)+'-'+s.slice(20);
}
export function inboxReply(item){
  const url=APP+'#/inbox/'+item.id,actions=Array.isArray(item.proposal?.changes)?item.proposal.changes.filter(change=>change.selected!==false):[];
  const lines=[];
  if(item.status==='ready'){
    lines.push('📝 Сохранил во «Входящие».');
    if(actions.length)lines.push('Предлагаю изменения — проверьте и подтвердите:');
    else lines.push('Новых действий не выделено. Исходное сообщение сохранено как заметка.');
    for(const action of actions.slice(0,6)){
      const label=String(action.description||action.title||action.text||'').trim(),kind={task_create:action.direction==='to_me'?'Ждём':'Задача',task_update:'Изменение задачи',project_state:'Состояние проекта',project_entry:'Договорённость'}[action.kind]||'Изменение';
      const details=[action.project_title&&'Проект: '+action.project_title,action.participant_name&&'Участник: '+action.participant_name,action.deadline&&'Срок: '+action.deadline+(action.deadline_time?' '+action.deadline_time+(item.proposal?.time_zone?' ('+item.proposal.time_zone+')':''):'')].filter(Boolean);
      if(label)lines.push('• '+kind+': '+label.slice(0,260)+(details.length?'\n'+details.join(' · '):''));
    }
    if(actions.length>6)lines.push('И ещё '+(actions.length-6)+' — в карточке.');
    if(item.proposal?.summary&&typeof item.proposal.summary==='string')lines.push(item.proposal.summary.slice(0,600));
    if(item.proposal?.questions?.length)lines.push('Есть вопросы для уточнения — откройте карточку.');
  }else{lines.push('📝 Сообщение сохранено во «Входящие».','Разбор пока не завершён. В карточке можно повторить обработку и проверить исходное сообщение.');}
  const buttons=[];
  if(item.status==='ready'&&lines.join('\n\n').length<=3500&&actions.length&&actions.length<=6&&!item.proposal?.questions?.length&&actions.every(action=>action.kind==='task_create'&&String(action.text||'').length<=260&&(!action.project_id||action.project_title)&&(!action.participant_id||action.participant_name))&&Number.isSafeInteger(item.revision))buttons.push([{text:'Применить всё',callback_data:'ia:'+item.id+':'+item.revision}]);
  buttons.push([{text:'Исправить / открыть',url},{text:'Разобрать позже',callback_data:'il:'+item.id+':'+item.revision}]);
  return {text:lines.join('\n\n').slice(0,3500),reply_markup:{inline_keyboard:buttons}};
}
export function createTelegramWebhook({loadConfig,store,createInbox,sendTelegram,now=()=>new Date()}){
  return async req=>{
    if(req.method!=='POST')return json('method_not_allowed',405);
    const secret=req.headers.get('X-Telegram-Bot-Api-Secret-Token');if(!secret)return json('unauthorized',401);
    let config;try{config=await loadConfig()}catch{return json('server_not_configured',503)}
    if(!configValid(config))return json('server_not_configured',503);
    if(!await equalSecret(secret,config.webhookSecret))return json('unauthorized',401);
    let update;try{update=await readUpdate(req)}catch(error){return json(error?.safeCode||'invalid_json',error?.safeCode==='payload_too_large'?413:400)}
    if(!Number.isSafeInteger(update?.update_id)||update.update_id<0)return json('invalid_update',400);
    const callback=update.callback_query;
    if(callback){
      if(!ownerMessage(callback.from,callback.message?.chat,config)||typeof callback.id!=='string'||callback.id.length>256)return ok();
      const modern=String(callback.data||'').match(/^(ia|il):([0-9a-f-]+):(\d{1,12})$/i);
      if(modern&&UUID.test(modern[2])&&Number(modern[3])<=2147483646){
        const [,action,id,revision]=modern;let reply;
        try{const inbox=createInbox(config),options={revision:Number(revision),request_id:await callbackRequestId(callback)};if(action==='ia'){await inbox.apply(id,options);reply='Изменения применены'}else{await inbox.defer(id,options);reply='Оставлено для разбора позже'}}catch{reply='Карточка изменилась или пока недоступна. Откройте её в приложении.'}
        try{await sendTelegram('answerCallbackQuery',{callback_query_id:callback.id,text:reply})}catch{}return ok();
      }
      // Old bot messages remain operable; every target is checked against owner.
      const match=String(callback.data||'').match(/^(done|pause|cancel1|cancel|fix):([0-9a-f-]+)$/i);if(!match||!UUID.test(match[2]))return ok();
      const [,action,id]=match,isInbox=['cancel','fix'].includes(action);
      try{
        const rows=await store.list(isInbox?'inbox':'commitments','select=id&id=eq.'+id+'&telegram_user_id=eq.'+config.telegramOwnerUserId);
        if(rows.length!==1)return ok();let reply;
        if(action==='cancel'){await store.rpc('cancel_by_inbox',{p_inbox_id:id});reply='Все задачи из сообщения отменены'}
        else if(action==='fix'){reply='Откройте приложение и исправьте нужные задачи. Новые сообщения сохраняются во «Входящие».'}
        else{await store.rpc('set_commitment_status',{p_commitment_id:id,p_status:{done:'completed',pause:'paused',cancel1:'cancelled'}[action]});reply={done:'Отмечено выполненным',pause:'Поставлено на паузу',cancel1:'Задача отменена'}[action]}
        try{await sendTelegram('answerCallbackQuery',{callback_query_id:callback.id,text:reply})}catch{}return ok();
      }catch{return json('callback_not_saved',503)}
    }
    const message=update.message;
    if(!message||!ownerMessage(message.from,message.chat,config))return ok();
    if(!telegramId(message.message_id))return json('invalid_message',400);
    const voice=message.voice&&typeof message.voice==='object'?message.voice:null;
    const text=typeof message.text==='string'?message.text.trim():voice?(typeof message.caption==='string'?message.caption.trim():''):'',sourceText=text||(voice?'[Голосовое сообщение]':'');
    if(!sourceText)return ok();if(sourceText.length>20000)return json('text_too_long',413);
    try{
      // Preserve already acknowledged messages from older releases as well.
      const receipts=await store.list('cos_notes_telegram_receipts','select=result_json&chat_id=eq.'+config.telegramOwnerChatId+'&message_id=eq.'+message.message_id);
      if(receipts.length)return ok();
      const sentAt=Number.isSafeInteger(message.date)&&message.date>0?new Date(message.date*1000):null;
      const refDate=sentAt&&Number.isFinite(+sentAt)?sentAt.toISOString():now().toISOString();
      const forwarded=!!message.forward_origin||message.forward_date!==undefined;
      const originalTimestamp=message.forward_origin?.date??message.forward_date,originalDate=Number.isSafeInteger(originalTimestamp)&&originalTimestamp>0?new Date(originalTimestamp*1000):null;
      const sourceMeta={channel:'telegram',type:voice?'voice':'text',owner_id:message.from.id,message_date:refDate,...(voice?{voice:{file_id:voice.file_id,file_unique_id:voice.file_unique_id,duration:voice.duration,file_size:voice.file_size,mime_type:voice.mime_type},caption:text}:{}),...(forwarded?{forwarded:true,original_date:originalDate&&Number.isFinite(+originalDate)?originalDate.toISOString():null}:{})};
      const saved=await store.rpc('cos_inbox_capture_telegram',{p_update_id:update.update_id,p_message_id:message.message_id,p_chat_id:message.chat.id,p_user_id:message.from.id,p_text:sourceText,p_source_meta:sourceMeta});
      if(saved?.duplicate)return ok();let item=itemOf(saved);if(!UUID.test(item?.id||''))fail('save_not_confirmed');
      let inbox;
      try{inbox=createInbox(config);item=itemOf(await inbox.analyze(item.id,{revision:item.revision}))}catch{if(inbox)try{item=itemOf(await inbox.get(item.id))}catch{} }
      // Claim is committed before sending. An uncertain send is never repeated;
      // the saved card is always available in the dashboard for manual review.
      const claimed=await store.rpc('cos_inbox_claim_reply',{p_id:item.id,p_channel:'telegram'});
      if(claimed===true)try{await sendTelegram('sendMessage',{chat_id:message.chat.id,...inboxReply(item)})}catch{}
      return ok();
    }catch{return json('message_not_saved',503)}
  };
}
