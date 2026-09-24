// Telegram owner-only ingestion. Deno 2 / Node 24 Web APIs; injected I/O for tests.
import {assignEntityDates} from './date-evidence.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP='https://chief-of-staff-v3-live.vercel.app/';
const ok=()=>new Response('ok',{status:200,headers:{'Cache-Control':'no-store'}});
const json=(error,status)=>new Response(JSON.stringify({error}),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const fail=code=>{throw Object.assign(new Error(code),{safeCode:code})};
const telegramId=value=>Number.isSafeInteger(value)&&value>0?String(value):null;
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
export function normalizeExtraction(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||!Array.isArray(value.commitments)||!Array.isArray(value.events))fail('invalid_extraction');
  const commitments=value.commitments.map(row=>{
    if(!row||typeof row.description!=='string'||!row.description.trim()||!['to_me','from_me','internal'].includes(row.direction))fail('invalid_extraction');
    return {description:row.description.trim(),direction:row.direction,who:typeof row.who==='string'&&row.who.trim()?row.who.trim():null,deadline:null};
  });
  const events=value.events.map(row=>{if(!row||typeof row.description!=='string'||!row.description.trim())fail('invalid_extraction');return {description:row.description.trim(),date:null}});
  if(commitments.length>30||events.length>30)fail('invalid_extraction');
  let project=null;
  if(value.project!==null&&value.project!==undefined){if(typeof value.project!=='object'||typeof value.project.title!=='string'||!value.project.title.trim())fail('invalid_extraction');project={title:value.project.title.trim(),description:typeof value.project.description==='string'?value.project.description:null}}
  return {project,commitments,events};
}
function dayLabel(day){return new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',timeZone:'UTC'}).format(new Date(day+'T12:00:00Z'));}
function entityReply(extracted,saved,warningCount=0){
  const dir={to_me:'жду от другого',from_me:'мне сделать',internal:'моё действие'},lines=[];
  if(extracted.project?.title)lines.push('📁 Проект: '+extracted.project.title);
  for(const item of extracted.commitments)lines.push('📌 Задача: '+item.description+(item.deadline?' | 📅 '+dayLabel(item.deadline):'')+' | '+dir[item.direction]);
  for(const item of extracted.events)lines.push('📅 Событие: '+item.description+(item.date?' | 📅 '+dayLabel(item.date):''));
  const taskRows=(saved.commitment_ids||[]).filter(id=>UUID.test(id)).map(id=>[{text:'✅',callback_data:'done:'+id},{text:'⏸',callback_data:'pause:'+id},{text:'❌',callback_data:'cancel1:'+id}]);
  const warning=warningCount?`⚠️ Без даты: ${warningCount}. Срок не указан однозначно или не распознан. Уточните его в приложении.\n\n`:'';
  return {text:('✅ Сохранено:\n\n'+warning+lines.join('\n\n')).slice(0,3500),reply_markup:{inline_keyboard:[...taskRows,[{text:'✏️ Исправить всё',callback_data:'fix:'+saved.inbox_id},{text:'❌ Отменить всё',callback_data:'cancel:'+saved.inbox_id}]]}};
}
export function createTelegramWebhook({loadConfig,store,extract,sendTelegram,now=()=>new Date()}){
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
      if(!ownerMessage(callback.from,callback.message?.chat,config))return ok();
      const match=String(callback.data||'').match(/^(done|pause|cancel1|cancel|fix):([0-9a-f-]+)$/i);if(!match||!UUID.test(match[2])||typeof callback.id!=='string')return ok();
      const [,action,id]=match,isInbox=['cancel','fix'].includes(action);
      try{
        const rows=await store.list(isInbox?'inbox':'commitments','select=id&id=eq.'+id+'&telegram_user_id=eq.'+config.telegramOwnerUserId);
        if(rows.length!==1)return ok();
        let reply;
        if(action==='cancel'){await store.rpc('cancel_by_inbox',{p_inbox_id:id});reply='Все задачи из сообщения отменены'}
        else if(action==='fix'){await store.rpc('start_correction',{p_inbox_id:id});reply='Отправьте исправленный текст следующим сообщением'}
        else{await store.rpc('set_commitment_status',{p_commitment_id:id,p_status:{done:'completed',pause:'paused',cancel1:'cancelled'}[action]});reply={done:'Отмечено выполненным',pause:'Поставлено на паузу',cancel1:'Задача отменена'}[action]}
        // Reply acknowledgement can be retried by Telegram without creating chat messages.
        try{await sendTelegram('answerCallbackQuery',{callback_query_id:callback.id,text:reply})}catch{}
        return ok();
      }catch{return json('callback_not_saved',503)}
    }
    const message=update.message;
    if(!message||!ownerMessage(message.from,message.chat,config))return ok();
    if(!telegramId(message.message_id))return json('invalid_message',400);
    // The deployed predecessor accepted text only. Voice/file transcription is
    // not invented here; an actual text transcript follows this same path.
    if(typeof message.text!=='string'||!message.text.trim())return ok();
    const text=message.text.trim();if(text.length>20_000)return json('text_too_long',413);
    try{
      const receipts=await store.list('cos_notes_telegram_receipts','select=result_json&chat_id=eq.'+config.telegramOwnerChatId+'&message_id=eq.'+message.message_id);
      if(receipts.length)return ok(); // No second classification or outbound reply.
      // Telegram may deliver a message after midnight or retry a failed delivery.
      // Resolve relative dates from its original timestamp, never the retry day.
      const sentAt=Number.isSafeInteger(message.date)&&message.date>0?new Date(message.date*1000):null;
      const refDate=sentAt&&Number.isFinite(+sentAt)?sentAt.toISOString():now().toISOString();
      const raw=await extract(text,{refDate});
      const extracted=normalizeExtraction(raw);
      const kind=extracted.commitments.length||extracted.events.length?'entities':'note';
      const warningCount=kind==='entities'?assignEntityDates(extracted,raw,text,{refDate}):0;
      const saved=await store.rpc('cos_notes_ingest_telegram',{
        p_update_id:update.update_id,p_message_id:message.message_id,p_chat_id:message.chat.id,p_user_id:message.from.id,p_text:text,p_kind:kind,
        p_project:kind==='entities'?extracted.project:null,p_commitments:kind==='entities'?extracted.commitments:[],p_events:kind==='entities'?extracted.events:[],p_extracted:kind==='entities'?extracted:{}
      });
      if(saved?.duplicate)return ok(); // A concurrent first delivery won the SQL lock.
      if(saved?.kind!==kind||(kind==='note'?!UUID.test(saved.note_id||''):!UUID.test(saved.inbox_id||'')))fail('save_not_confirmed');
      const reply=kind==='note'?{text:'📝 Сохранил заметку.\n\n'+APP+'?section=notes&id='+saved.note_id}:entityReply(extracted,saved,warningCount);
      // Saving is durable before sending. A failed/uncertain reply is never
      // retried automatically, so it cannot duplicate tasks or owner messages.
      try{await sendTelegram('sendMessage',{chat_id:message.chat.id,...reply})}catch{}
      return ok();
    }catch{return json('message_not_saved',503)}
  };
}
