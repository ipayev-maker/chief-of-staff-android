// No mailbox-wide body fetch: select eligible message IDs from metadata first.
export const GMAIL_SCOPES = Object.freeze(['openid','email','https://www.googleapis.com/auth/gmail.readonly']);
export const DEFAULT_SETTINGS = Object.freeze({label_ids:[],emails:[],enabled:false,ai_consent:false,initial_days:30,context_days:90,message_limit:10,pilot_limit:50});
export const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
export const email = value => typeof value === 'string' && /^[a-zA-Z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,63}$/.test(value) ? value.toLowerCase() : null;
export function settings(value) {
  if (!value || !Array.isArray(value.label_ids) || !Array.isArray(value.emails) || value.label_ids.length>20 || value.emails.length>50 ||
      value.label_ids.some(id=>!validId(id)||['SPAM','TRASH','DRAFT'].includes(id)) || value.emails.some(v=>!email(v)) ||
      typeof value.enabled!=='boolean' || typeof value.ai_consent!=='boolean') throw Error('invalid_settings');
  const result={...DEFAULT_SETTINGS,label_ids:[...new Set(value.label_ids)],emails:[...new Set(value.emails.map(email))],enabled:value.enabled,ai_consent:value.ai_consent};
  if(result.enabled&&!result.label_ids.length&&!result.emails.length)throw Error('scope_required');
  return result;
}
export function header(message,name){return String(message.payload?.headers?.find(h=>h.name?.toLowerCase()===name.toLowerCase())?.value||'').replaceAll('\0','').slice(0,2000)}
export function addresses(value){return [...new Set((String(value).match(/[a-zA-Z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,63}/g)||[]).map(v=>v.toLowerCase()))]}
export function inScope(messages,config){
  return messages.some(m=>!(m.labelIds||[]).some(l=>['SPAM','TRASH','DRAFT'].includes(l))&&
    ((m.labelIds||[]).some(l=>config.label_ids.includes(l))||['from','to','cc'].some(h=>addresses(header(m,h)).some(a=>config.emails.includes(a)))));
}
export function searchQuery(config,now=new Date()){
  if(!config.label_ids.length&&!config.emails.length)throw Error('scope_required');
  // Label IDs are resolved separately with threads.list labelIds; this query is
  // only for approved email addresses. Values are validated before interpolation.
  return `after:${Math.floor((+now-config.initial_days*86400000)/1000)} -in:spam -in:trash -in:drafts`;
}
export function selectMessages(messages,{now=new Date(),contextDays=90,limit=10}={}){
  if(![90,180].includes(contextDays)||!Number.isInteger(limit)||limit<10||limit>50)throw Error('invalid_depth');
  const eligible=messages.filter(m=>validId(m.id)&&Number.isFinite(Number(m.internalDate))&&Number(m.internalDate)>=+now-contextDays*86400000&&Number(m.internalDate)<=+now+300000&&!(m.labelIds||[]).some(l=>['SPAM','TRASH','DRAFT'].includes(l)))
    .sort((a,b)=>Number(a.internalDate)-Number(b.internalDate)||a.id.localeCompare(b.id));
  return {selected:eligible.slice(-limit),eligible:eligible.length,total:messages.length,omitted:messages.length-Math.min(limit,eligible.length)};
}
function decode(data){try{const binary=atob(String(data||'').replace(/-/g,'+').replace(/_/g,'/'));return new TextDecoder().decode(Uint8Array.from(binary,c=>c.charCodeAt(0))).replaceAll('\0','')}catch{throw Error('invalid_mail_encoding')}}
export function htmlText(html){
  // Never render email HTML, load images, follow links or execute scripts.
  return html.replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<(br|\/p|\/div|\/tr|\/li)\b[^>]*>/gi,'\n').replace(/<[^>]*>/g,' ').replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>{const code=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return code>0&&code<=0x10ffff?String.fromCodePoint(code):''}).replace(/&(amp|lt|gt|quot|apos|nbsp);/g,(_,n)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '})[n]).replace(/[ \t]+/g,' ').replace(/\n\s*\n\s*\n/g,'\n\n').trim();
}
export function messageText(message){
  const attachments=[],plain=[],html=[];let external=false;
  function walk(part){
    if(!part)return;
    const disposition=(part.headers||[]).find(h=>h.name?.toLowerCase()==='content-disposition')?.value||'';
    if(part.filename||/^attachment\b/i.test(disposition)||part.mimeType==='message/rfc822'){
      if(part.filename)attachments.push(String(part.filename).slice(0,200));return;
    }
    if(part.mimeType==='multipart/alternative'){
      const choice=(part.parts||[]).find(p=>p.mimeType==='text/plain')||(part.parts||[]).find(p=>p.mimeType==='text/html');
      if(choice){walk(choice);return;}
    }
    if(['text/plain','text/html'].includes(part.mimeType)){
      if(part.body?.data)(part.mimeType==='text/plain'?plain:html).push(decode(part.body.data));
      else if(part.body?.attachmentId)external=true;
    }
    for(const child of part.parts||[])walk(child);
  }
  walk(message.payload);
  const raw=plain.length?plain.join('\n'):html.map(htmlText).join('\n');
  // Preserve inline answers. Do not silently cut everything after an On…wrote
  // marker: quoted text remains explicitly untrusted historical context.
  return {text:raw.trim(),attachments:[...new Set(attachments)],external,truncated:raw.length>10000};
}
export function snapshot(messages,{threadId,selection,ownerEmail,processedIds=[],contextDays=90,limit=10,projectId=null}){
  const meta={type:'gmail',subject:header(messages.at(-1)||{},'subject').slice(0,200)||'Переписка Gmail',thread_id:threadId,owner_email:ownerEmail,project_id:projectId,context_days:contextDays,message_limit:limit,total_messages:selection.total,omitted_messages:selection.omitted,messages:[],new_message_ids:[],partial:false};
  let source='';const retained=[];
  // At most 58k UTF-16 units in a single review, prioritise the newest messages.
  let budget=58000;
  for(const message of [...messages].reverse()){
    const body=messageText(message),date=new Date(Number(message.internalDate)).toISOString();
    const prefix=`Письмо ${message.id} · ${date}\nОт: ${header(message,'from')}\nКому: ${header(message,'to')}\nТема: ${header(message,'subject')}\n`;
    const allowance=Math.min(10000,Math.max(0,budget-prefix.length-250));
    if(allowance<100){meta.partial=true;continue;}
    const text=body.text.slice(0,allowance)||'[Текст недоступен: содержимое не загружено]';
    const suffix=body.attachments.length?'\nВложения (не прочитаны): '+body.attachments.slice(0,10).join(', '):'';
    const truncated=body.text.length>allowance||body.external||!body.text;
    const rendered=prefix+text+suffix+'\n\n';budget-=rendered.length;
    retained.unshift({message,date,rendered,body,truncated});
    if(truncated)meta.partial=true;
  }
  for(const {message,date,rendered,truncated} of retained){
    const start=source.length;source+=rendered;
    meta.messages.push({id:message.id,date,from:header(message,'from').slice(0,300),email:addresses(header(message,'from'))[0]||null,start,end:source.length,truncated});
    if(!processedIds.includes(message.id))meta.new_message_ids.push(message.id);
  }
  meta.partial ||= meta.omitted_messages>0;
  meta.message_date=meta.messages.at(-1)?.date;
  return {source:source.trimEnd(),meta,subject:header(messages.at(-1)||{},'subject').slice(0,200)||'Переписка Gmail'};
}
