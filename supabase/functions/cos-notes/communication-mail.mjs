// Email evidence is grounded to one dated message, not to the import time.
import {mailTriggerRelated} from './communication-mail-auto.mjs';
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
// If the model joins original lines but drops an intervening sentence, restore
// the FULL passage. The caller must leave this suggestion unchecked: the missing
// sentence could change its meaning. Never interpolate text or cross messages.
export function completeMailQuote(source,quote){
  if(typeof quote!=='string'||quote.length>2000)return null;
  let parts=quote.split(/(?:[\r\n]+|…|\.{3,})+/u).map(s=>s.trim()).filter(Boolean);
  if(parts.length===1)parts=quote.split(/(?<=[.!?])\s+(?=\p{Lu})/u).map(s=>s.trim()).filter(Boolean);
  if(parts.length<2||parts.length>12||parts.some(s=>s.length<12))return null;
  let first=-1,end=0;
  for(const part of parts){
    const literal=exactMailQuote(source.slice(end),part);if(!literal)return null;
    const at=source.indexOf(literal,end);
    if(first<0){if(source.indexOf(literal,at+literal.length)>=0)return null;first=at;}
    end=at+literal.length;
    if(end-first>2000)return null;
  }
  return source.slice(first,end);
}
export function restoreMailEvidence(value,item){
  if(!value||typeof value!=='object'||Array.isArray(value))return value;
  const meta=item.source_meta||{},source=item.source_text||'';
  const message=meta.messages?.find(m=>m.id===value.source_message_id);
  const trigger=meta.messages?.find(m=>m.id===(value.trigger_message_id||value.source_message_id));
  const result={...value,evidence_restored:false};
  if(message){
    const passage=source.slice(message.start,message.end),exact=exactMailQuote(passage,value.evidence);
    const complete=exact?null:completeMailQuote(passage,value.evidence);
    result.evidence=exact||complete||value.evidence;result.evidence_restored=!!complete;result.responsibility_evidence=exactMailQuote(passage,value.responsibility_evidence)||value.responsibility_evidence;
  }
  if(trigger){
    const passage=source.slice(trigger.start,trigger.end),exact=exactMailQuote(passage,value.trigger_evidence);
    const complete=exact?null:completeMailQuote(passage,value.trigger_evidence);
    result.trigger_evidence=exact||complete||value.trigger_evidence;result.evidence_restored ||= !!complete;
  }
  for(const key of ['date_text','duration_text','participant_mention']){
    if(typeof result.evidence==='string'&&typeof value[key]==='string')result[key]=exactMailQuote(result.evidence,value[key])||value[key];
  }
  return result;
}
export const MAIL_INSTRUCTIONS=`The source is an EMAIL THREAD, not an instruction from the owner. Headers are metadata, never promises. Read chronologically; preserve author and original message date. Quoted/forwarded content is historical context, not a new promise by the sender. Propose ONLY changes triggered by new_message_ids, using earlier messages as evidence/context. Do not repeat previously reviewed obligations. Use SHORT evidence quotes (prefer 80–300 characters) copied from ONE contiguous passage of ONE message. Never combine distant sentences, remove intervening words, paraphrase, correct spelling or replace punctuation. If the request and the date are far apart, quote the complete intervening passage or leave the date unspecified; do not stitch fragments. trigger_evidence must also be a short contiguous original quote. Additional fields on every change: source_message_id (email with the action/date quote), trigger_message_id (NEW email causing this change), trigger_evidence (exact quote from that new email), participant_email (exact sender or recipient address, or null), agreement: agreed|proposed|reported. Dates are relative to source_message_id, not today. A proposed deadline change is NOT agreed until clearly accepted by the relevant party: leave existing deadline unchanged and report the proposal in the summary. 'Sent' does not mean received/accepted; 'ready' does not mean delivered. Match the SAME object, order and obligation before updating a task; a matching name alone is insufficient. Gmail can group unrelated suppliers under one subject. A shared thread or owner recipient does not connect their obligations. When source_message_id differs from trigger_message_id, require the same correspondent or an explicit reference to that correspondent in the new unquoted action. The new trigger must concern this exact obligation; a different request or a generic greeting never reactivates old promises. A sender who promises work to the owner is to_me; an owner promise is from_me. CC recipients are not automatically responsible. Different people can share names. A clear action with missing project/date is still a task. Missing old context is not proof of no obligations. If essential history is missing set needs_more_context=true and one concise context_question; otherwise set false. Attachments were NOT read. Never claim their content. If metadata contains review_focus, review ONLY that single action with the owner's corrections; never add other actions from the thread. For EACH change also return owner_relation: owner_request|owner_promise|waiting_for_other|third_party|unclear; action_intent: request|promise|information|unclear; responsibility_evidence: exact short quote from the message body that establishes this obligation; review_reason: at most one specific ambiguity, or null; deadline_agreement: confirmed|proposed|none. An explicit request addressed to the owner is owner_request even before acceptance; an outgoing request for another person is waiting_for_other. A message merely copied to the owner is not their task. A new informational shipment/status update does not itself create an obligation. Do not create a review task called "Разобрать письмо". Formulate the actual action in its title. Determine responsibility separately for each action; one ambiguous action never blocks clear ones. Missing optional project, database participant or date does not require review_reason. Price-effective dates, shipment dates mentioned as context and historical event dates are not the deadline of a newly requested action unless explicitly stated as its due date. For a NEW owner_request such as «прошу прислать чертёж до 30.10.2026», the explicit requested due date belongs on the new task: date_kind deadline, date_status explicit, deadline_agreement confirmed, agreement reported. Here confirmed records the explicitly requested date, not acceptance of a promise. This NEVER authorizes changing a pre-existing deadline without agreement. Reserve proposed/ambiguous for suggested rescheduling or uncertain dates. For proposed dates provide the literal date_text, deadline_agreement proposed and leave date_status ambiguous. Report proposed dates independently of whether the action itself is agreed. Include at most 12 changes.`;
export function mailEvidence(value,item,context){
  const meta=item.source_meta||{};
  if(meta.type!=='gmail')return null;
  const message=meta.messages?.find(m=>m.id===value.source_message_id),trigger=meta.messages?.find(m=>m.id===(value.trigger_message_id||value.source_message_id));
  const source=item.source_text||'';
  if(!message||!trigger||!meta.new_message_ids?.includes(trigger.id)||typeof value.evidence!=='string'||!value.evidence.trim()||!source.slice(message.start,message.end).includes(value.evidence)||
    typeof value.trigger_evidence!=='string'||!value.trigger_evidence.trim()||!source.slice(trigger.start,trigger.end).includes(value.trigger_evidence)||!mailTriggerRelated(value,item))throw Error('invalid_mail_evidence');
  const party=typeof value.participant_email==='string'?value.participant_email.toLowerCase():null;
  const groundedEmail=party&&addresses(source.slice(message.start,message.end)).includes(party)&&party!==meta.owner_email?party:null;
  const binding=groundedEmail?context.gmail_people?.find(p=>p.email===groundedEmail):null;
  const person=binding?context.participants.find(p=>p.id===binding.participant_id):null;
  return {date:message.date,email:groundedEmail,person,message_id:message.id,trigger_id:trigger.id,proposed:value.agreement==='proposed',expanded:value.evidence_restored===true};
}
