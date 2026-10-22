// Per-action policy for the owner's mixed mail mode. No confidence percentages:
// ownership, a new message and a literal, unquoted responsibility are required.
const addressList=s=>(String(s||'').match(/[a-zA-Z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,63}/g)||[]).map(x=>x.toLowerCase());
export function mailBody(item,id){
  const m=item.source_meta?.messages?.find(x=>x.id===id);if(!m)return null;
  const text=item.source_text.slice(m.start,m.end),headerEnd=text.indexOf('\n',text.indexOf('\nТема: ')+1);
  if(headerEnd<0)return null;
  const body=text.slice(headerEnd+1);
  const quote=body.search(/^(?:\s*>|\s*(?:On .+wrote:|.*(?:писал|писала|написал|написала)\s*:\s*$|От:\s|From:\s|[-_]{3,}|Начало переадресованного))/imu);
  return {message:m,text,body,unquoted:quote<0?body:body.slice(0,quote),to:m.to_emails||addressList(text.match(/^Кому: (.*)$/m)?.[1]),from:m.email?.toLowerCase()};
}
export function mailActionDecision(change,item){
  const review=reason=>({mode:'review',reason});
  if(change.mail_relation==='third_party'&&change.mail_intent==='information')return {mode:'information'};
  if(change.kind!=='task_create')return review(change.kind==='task_update'?'Нужно подтвердить изменение существующей задачи.':'Нужно подтвердить встречу или изменение проекта.');
  if(change.selected===false||change.evidence_restored)return review('Проверьте точность смысла по исходной цитате.');
  if(change.mail_relation==='unclear'||!change.mail_relation)return review(change.mail_review_reason||'Неясно, кому поручено действие и относится ли оно к вам.');
  const source=mailBody(item,change.source_message_id),trigger=mailBody(item,change.trigger_message_id);
  if(!source||!trigger||!item.source_meta?.new_message_ids?.includes(change.trigger_message_id))return review('Не удалось подтвердить новое поручение.');
  const evidence=change.mail_responsibility_evidence,triggerEvidence=change.mail_trigger_evidence;
  if(!evidence||!source.unquoted.includes(evidence)||!source.unquoted.includes(change.evidence)||!triggerEvidence||!trigger.unquoted.includes(triggerEvidence))return review('Действие может относиться к цитируемой старой переписке.');
  const owner=item.source_meta.owner_email?.toLowerCase(),incoming=source.from!==owner&&source.to.includes(owner),outgoing=source.from===owner;
  const intent=change.mail_intent,relation=change.mail_relation;
  const clear=(relation==='owner_request'&&intent==='request'&&incoming)||(relation==='owner_promise'&&intent==='promise'&&outgoing)||
    (relation==='waiting_for_other'&&((intent==='promise'&&incoming)||(intent==='request'&&outgoing)));
  if(!clear)return review(change.mail_review_reason||'Проверьте, чьё это обязательство.');
  if(change.status!=='open')return review('Изменение статуса требует подтверждения.');
  if(change.mail_review_reason&&!change.mail_proposed_date)return review(change.mail_review_reason);
  return {mode:'automatic',direction:relation==='waiting_for_other'?'to_me':'from_me'};
}
export function splitMailProposal(item){
  const automatic=[],reviews=[],information=[];
  for(const change of item.proposal?.changes||[]){
    const decision=mailActionDecision(change,item);
    if(decision.mode==='automatic')automatic.push({...change,direction:decision.direction,selected:true});
    else if(decision.mode==='information')information.push(change.id);
    else reviews.push({...change,selected:true,mail_review_reason:decision.reason});
  }
  return {automatic,reviews,information};
}

export function automaticReviewChanges(item){
 if(item.source_meta?.delivery!=='review'||item.status!=='ready'||item.proposal?.changes?.length!==1)return [];
 const change=item.proposal.changes[0];
 return splitMailProposal({...item,proposal:{...item.proposal,changes:[{...change,mail_review_reason:change.mail_review_reason==='Предложение по письму — подтвердите действие.'?null:change.mail_review_reason}]}}).automatic;
}
