import {header} from './mail.mjs';
const addresses=s=>(String(s||'').match(/[a-zA-Z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,63}/g)||[]).map(x=>x.toLowerCase());
export function followupFor(change,item){
 if(change.kind!=='task_create'||change.mail_intent!=='request'||change.mail_relation!=='waiting_for_other')return null;
 const meta=item.source_meta,source=meta?.messages?.find(m=>m.id===change.source_message_id);
 if(!source||source.email?.toLowerCase()!==meta.owner_email?.toLowerCase()||!meta.new_message_ids?.includes(source.id)||!Number.isFinite(Date.parse(source.date)))return null;
 const recipients=(source.to_emails||[]).filter(e=>e!==meta.owner_email?.toLowerCase());if(!recipients.length)return null;
 const answered=meta.messages.some(m=>Date.parse(m.date)>Date.parse(source.date)&&recipients.includes(m.email?.toLowerCase())&&!m.automatic_reply);
 if(answered)return null;
 return {sent_at:source.date,check_at:new Date(Date.parse(source.date)+3*3600000).toISOString(),recipients};
}
export function replyMetadata(messages){return messages.filter(m=>!(m.labelIds||[]).some(l=>['SPAM','TRASH','DRAFT','SENT'].includes(l))).map(m=>({id:m.id,from:addresses(header(m,'from'))[0]||'',at:Number.isFinite(Number(m.internalDate))?new Date(Number(m.internalDate)).toISOString():null,automatic:!!header(m,'auto-submitted')&&!/^no$/i.test(header(m,'auto-submitted'))||/auto_reply|auto-reply|bulk|list/i.test(header(m,'precedence'))||!!header(m,'x-autoreply')||!!header(m,'x-autorespond')})).filter(m=>m.at&&m.from).slice(-1000);}
