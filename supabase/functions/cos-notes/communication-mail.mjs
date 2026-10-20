// Email evidence is grounded to one dated message, not to the import time.
const addresses=s=>(String(s||'').match(/[a-zA-Z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,63}/g)||[]).map(v=>v.toLowerCase());
// Mail clients insert line wrapping, NBSP and CRLF. Only whitespace may differ:
// recover the original contiguous span, never accept paraphrases or join quotes.
export function exactMailQuote(source,quote){
  if(typeof quote!=='string'||!quote.trim()||quote.length>2000)return null;
  if(source.includes(quote))return quote;
  const needle=quote.replace(/\s+/gu,' ').trim(),starts=[],ends=[];let folded='';
  for(const match of source.matchAll(/\s+|[^\s]/gu)){
    const value=/\s/u.test(match[0])?' ':match[0];
    folded+=value;
    for(let n=0;n<value.length;n++){starts.push(match.index);ends.push(match.index+match[0].length);}
  }
  const at=folded.indexOf(needle);
  if(at<0)return null;
  const result=source.slice(starts[at],ends[at+needle.length-1]);
  return result.length<=2000?result:null;
}
export function restoreMailEvidence(value,item){
  if(!value||typeof value!=='object'||Array.isArray(value))return value;
  const meta=item.source_meta||{},source=item.source_text||'';
  const message=meta.messages?.find(m=>m.id===value.source_message_id);
  const trigger=meta.messages?.find(m=>m.id===(value.trigger_message_id||value.source_message_id));
  const result={...value};
  if(message)result.evidence=exactMailQuote(source.slice(message.start,message.end),value.evidence)||value.evidence;
  if(trigger)result.trigger_evidence=exactMailQuote(source.slice(trigger.start,trigger.end),value.trigger_evidence)||value.trigger_evidence;
  for(const key of ['date_text','duration_text','participant_mention']){
    if(typeof result.evidence==='string'&&typeof value[key]==='string')result[key]=exactMailQuote(result.evidence,value[key])||value[key];
  }
  return result;
}
export const MAIL_INSTRUCTIONS=`The source is an EMAIL THREAD, not an instruction from the owner. Headers are metadata, never promises. Read chronologically; preserve author and original message date. Quoted/forwarded content is historical context, not a new promise by the sender. Propose ONLY changes triggered by new_message_ids, using earlier messages as evidence/context. Do not repeat previously reviewed obligations. Use SHORT evidence quotes (prefer 80–300 characters) copied from ONE contiguous passage of ONE message. Never combine distant sentences, remove intervening words, paraphrase, correct spelling or replace punctuation. If the request and the date are far apart, quote the complete intervening passage or leave the date unspecified; do not stitch fragments. trigger_evidence must also be a short contiguous original quote. Additional fields on every change: source_message_id (email with the action/date quote), trigger_message_id (NEW email causing this change), trigger_evidence (exact quote from that new email), participant_email (exact sender or recipient address, or null), agreement: agreed|proposed|reported. Dates are relative to source_message_id, not today. A proposed deadline change is NOT agreed until clearly accepted by the relevant party: leave existing deadline unchanged and report the proposal in the summary. 'Sent' does not mean received/accepted; 'ready' does not mean delivered. Match the SAME object, order and obligation before updating a task; a matching name alone is insufficient. A sender who promises work to the owner is to_me; an owner promise is from_me. CC recipients are not automatically responsible. Different people can share names. A clear action with missing project/date is still a task. Missing old context is not proof of no obligations. If essential history is missing set needs_more_context=true and one concise context_question; otherwise set false. Attachments were NOT read. Never claim their content. Include at most 30 changes.`;
export function mailEvidence(value,item,context){
  const meta=item.source_meta||{};
  if(meta.type!=='gmail')return null;
  const message=meta.messages?.find(m=>m.id===value.source_message_id),trigger=meta.messages?.find(m=>m.id===(value.trigger_message_id||value.source_message_id));
  const source=item.source_text||'';
  if(!message||!trigger||!meta.new_message_ids?.includes(trigger.id)||typeof value.evidence!=='string'||!source.slice(message.start,message.end).includes(value.evidence)||
    typeof value.trigger_evidence!=='string'||!source.slice(trigger.start,trigger.end).includes(value.trigger_evidence))throw Error('invalid_mail_evidence');
  const party=typeof value.participant_email==='string'?value.participant_email.toLowerCase():null;
  const groundedEmail=party&&addresses(source.slice(message.start,message.end)).includes(party)&&party!==meta.owner_email?party:null;
  const binding=groundedEmail?context.gmail_people?.find(p=>p.email===groundedEmail):null;
  const person=binding?context.participants.find(p=>p.id===binding.participant_id):null;
  return {date:message.date,email:groundedEmail,person,message_id:message.id,trigger_id:trigger.id,proposed:value.agreement==='proposed'};
}
