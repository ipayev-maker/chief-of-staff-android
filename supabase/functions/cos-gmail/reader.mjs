import {header,validId,inScope} from './mail.mjs';
import {threadLinks,UUID} from './links.mjs';
const eq=(key,value)=>key+'=eq.'+encodeURIComponent(value);
const fail=(status,reason)=>{throw Object.assign(Error(reason),{status,reason})};
const permitted=m=>validId(m?.id)&&!(m.labelIds||[]).some(l=>['SPAM','TRASH','DRAFT'].includes(l));
const cleanItem=row=>{
  const proposal={...(row.proposal||{})};
  delete proposal.context;
  if(proposal.analysis){proposal.analysis={...proposal.analysis};delete proposal.analysis.result;}
  return {...row,proposal};
};
export function createMailReader({store,mail}){
  async function known(id){
    if(!validId(id))fail(400,'invalid_thread');
    const row=(await store.page('cos_gmail_threads',eq('thread_id',id)+'&limit=1'))[0];
    if(!row?.inbox_id)fail(404,'thread_unavailable');
    return row;
  }
  async function list(offset=0,{projectId=null,participantId=null,review=false}={}){
    if(projectId&&!UUID.test(projectId)||participantId&&!UUID.test(participantId))fail(400,'invalid_links');
    if(!Number.isSafeInteger(offset)||offset<0||offset>100000)fail(400,'invalid_pagination');
    const rows=await store.page('cos_gmail_mailbox','select=thread_id,subject,inbox_id,updated_at,pending,project_id,last_message_at,review_count'+(participantId?',mail_people:cos_gmail_thread_participants!inner(participant_id)':'')+'&inbox_id=not.is.null'+(projectId?'&project_id=eq.'+projectId:'')+(participantId?'&mail_people.participant_id=eq.'+participantId:'')+(review?'&review_count=gt.0':'')+'&order=last_message_at.desc,thread_id.asc&limit=51&offset='+offset);
    const page=rows.slice(0,50),ids=page.map(r=>r.inbox_id);
    const people=page.length?await store.list('cos_gmail_thread_participants','select=thread_id,participant_id&thread_id=in.('+page.map(r=>r.thread_id).join(',')+')&order=position.asc'):[];
    const sources=ids.length?await store.list('cos_communication_inbox','select=id,status,source_meta,proposal&id=in.('+ids.join(',')+')'):[];
    const reviews=page.length?await store.list('cos_communication_inbox','select=source_meta&source_meta->>delivery=eq.review&status=eq.ready&source_meta->>thread_id=in.('+page.map(r=>r.thread_id).join(',')+')'):[];
    return {items:page.map(row=>{
      const source=sources.find(s=>s.id===row.inbox_id),meta=source?.source_meta||{},last=meta.messages?.at(-1);
      return {id:row.thread_id,project_id:row.project_id||null,participant_ids:people.filter(p=>p.thread_id===row.thread_id).map(p=>p.participant_id),subject:row.subject||meta.subject||'Без темы',from:last?.from||'',date:last?.date||meta.message_date||row.updated_at,summary:String(source?.proposal?.summary||'').slice(0,240),status:source?.status||'captured',pending:row.pending,needs_review:reviews.filter(r=>r.source_meta?.thread_id===row.thread_id&&!r.source_meta?.superseded).length};
    }).sort((a,b)=>String(b.date).localeCompare(String(a.date))),nextOffset:rows.length>50?offset+50:null};
  }
  async function thread(id,connection){
    const row=await known(id),client=await mail(connection),metadata=await client.thread(id);
    if(metadata.id!==id||!inScope(metadata.messages||[],connection.settings))fail(404,'thread_unavailable');
    const messages=(metadata.messages||[]).filter(permitted).map(m=>({id:m.id,from:header(m,'from'),to:header(m,'to'),date:new Date(Number(m.internalDate)).toISOString(),subject:header(m,'subject')})).sort((a,b)=>a.date.localeCompare(b.date));
    const records=await store.list('cos_communication_inbox','select=id,revision,status,source_meta,proposal,applied_result,created_at&source_meta->>type=eq.gmail&source_meta->>thread_id=eq.'+encodeURIComponent(id)+'&order=created_at.desc,id.desc');
    return {id,links:await threadLinks(store,row),subject:row.subject||messages.at(-1)?.subject||'Без темы',messages,records:records.filter(r=>!r.source_meta?.superseded&&r.source_meta?.delivery!=='retired').map(cleanItem),owner_email:connection.email};
  }
  async function message(threadId,messageId,connection){
    await known(threadId);if(!validId(messageId))fail(400,'invalid_message');
    const client=await mail(connection),metadata=await client.thread(threadId);
    if(metadata.id!==threadId||!inScope(metadata.messages||[],connection.settings)||!metadata.messages?.some(m=>m.id===messageId&&permitted(m)))fail(404,'thread_unavailable');
    const full=await client.message(messageId);
    if(full.id!==messageId||full.threadId!==threadId||!permitted(full))fail(404,'thread_unavailable');
    return renderableMessage(full,client);
  }
  return {list,thread,message};
}

export async function renderableMessage(message,client){
  const plain=[],html=[],attachments=[],inline=[];let bytes=0,omittedImages=false;
  const decode=(data,part)=>{
    const raw=atob(String(data||'').replace(/-/g,'+').replace(/_/g,'/'));
    bytes+=raw.length;if(bytes>2500000)fail(413,'mail_too_large');
    const charset=(part.headers||[]).find(h=>h.name?.toLowerCase()==='content-type')?.value?.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1]||'utf-8';
    const input=Uint8Array.from(raw,c=>c.charCodeAt(0));
    try{return new TextDecoder(charset).decode(input).replaceAll('\0','')}catch{return new TextDecoder().decode(input).replaceAll('\0','')}
  };
  async function walk(part){
    if(!part)return;
    const h=name=>(part.headers||[]).find(v=>v.name?.toLowerCase()===name)?.value||'';
    const cid=h('content-id').replace(/^<|>$/g,''),isAttachment=/^attachment\b/i.test(h('content-disposition'));
    if(cid&&!isAttachment&&/^image\/(png|jpeg|gif|webp)$/i.test(part.mimeType||'')){
      if(inline.length>=12||bytes+(part.body?.size||0)>1800000){omittedImages=true;return;}
      let data=part.body?.data;
      if(!data&&part.body?.attachmentId){try{data=(await client.attachment(message.id,part.body.attachmentId)).data}catch{omittedImages=true;return;}}
      if(data){bytes+=Math.ceil(data.length*3/4);inline.push({cid,src:'data:'+part.mimeType+';base64,'+data.replace(/-/g,'+').replace(/_/g,'/')});}return;
    }
    if(part.filename||isAttachment||part.mimeType==='message/rfc822'){
      attachments.push({name:String(part.filename||'Вложение').slice(0,250),size:part.body?.size||0});return;
    }
    if(['text/plain','text/html'].includes(part.mimeType)){
      let data=part.body?.data;
      if(!data&&part.body?.attachmentId)data=(await client.attachment(message.id,part.body.attachmentId)).data;
      if(data)(part.mimeType==='text/html'?html:plain).push(decode(data,part));
    }
    for(const child of part.parts||[])await walk(child);
  }
  await walk(message.payload);
  return {id:message.id,from:header(message,'from'),to:header(message,'to'),date:new Date(Number(message.internalDate)).toISOString(),subject:header(message,'subject'),html:html.join('\n'),text:plain.join('\n'),inline,attachments,omittedImages};
}
