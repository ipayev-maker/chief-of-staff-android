// Owner-only, minimal provenance. No mail body or credentials leave this endpoint.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function taskOrigin(task,item,receipts=[]){
  if(!item?.applied_result?.changes?.some(c=>c.kind==='task_create'&&c.after?.id===task.id))return null;
  const receipt=receipts.find(r=>r.inbox_id===item.id&&r.kind==='apply');
  const automatic=!!receipt&&(receipt.input_json?.confirmation?.mode==='gmail_hybrid'||receipt.request_id===item.proposal?.analysis?.id||item.source_meta?.type==='gmail'&&item.source_meta?.delivery==='review'&&receipt.request_id===item.id);
  const source=item.source_meta?.type==='gmail'?'gmail':['text','voice','media','photo','document','video','audio'].includes(item.source_meta?.type)?'telegram':'note';
  return {task_id:task.id,source,automatic};
}
export async function taskOrigins(store,raw){
  const ids=String(raw||'').split(',');
  if(!ids.length||ids.length>50||ids.some(id=>!UUID.test(id)))throw Object.assign(new Error('invalid_request'),{status:400,code:'invalid_request'});
  const tasks=await store.list('commitments','select=id,details&deleted_at=is.null&id=in.('+[...new Set(ids)].join(',')+')');
  const references=tasks.map(t=>({task:t,id:String(t.details||'').match(/(?:^|\n)Источник: https:\/\/(?:nikodim|chief-of-staff-v3-live)\.vercel\.app\/#\/inbox\/([0-9a-f-]{36})\s*$/i)?.[1]})).filter(r=>UUID.test(r.id||''));
  if(!references.length)return {origins:[]};
  const inboxIds=[...new Set(references.map(r=>r.id))].join(',');
  const [items,receipts]=await Promise.all([
    store.list('cos_communication_inbox','select=id,source_meta,proposal,applied_result&id=in.('+inboxIds+')&status=eq.applied'),
    store.list('cos_communication_requests','select=request_id,inbox_id,kind,input_json&kind=eq.apply&inbox_id=in.('+inboxIds+')'),
  ]);
  return {origins:references.map(r=>taskOrigin(r.task,items.find(i=>i.id===r.id),receipts)).filter(Boolean)};
}
