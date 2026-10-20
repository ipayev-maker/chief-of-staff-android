// Source-grounded appointment extraction. Node 24 / Deno 2; no I/O.
import {dateEvidence,exactDay} from '../telegram-webhook/date-evidence.mjs';
import {clockEvidence,withoutClocks} from '../telegram-webhook/time-evidence.mjs';
const communication=/(?:^|[^\p{L}])(?:встреч[ауи]|встретиться|встретимся|созвон(?:иться|имся)?|позвонить|позвоним|звонок|обсудить|обсудим)(?:$|[^\p{L}])/iu;
const reminders=/(?:^|[^\p{L}])(?:напомни\p{L}*|напоминание)(?:$|[^\p{L}])/iu;
const dates=/\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}(?:[./]\d{4})?|\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s+\d{4})?|(?<!\p{L})(?:послезавтра|завтра|сегодня|(?:следующ(?:ий|ую|ее)\s+)?(?:понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье))(?!\p{L})/giu;
// An unknown surname is optional metadata, not an ambiguous scheduling intent.
// Recover only a complete, single, literal appointment; never repair ASR words.
export function recoverAppointment(raw,{source,corrections=[],refDate,timeZone}){
  if(raw.changes?.length||corrections.length||typeof source!=='string'||source.length>300||/[;!?«»“”"\n]/u.test(source))return raw;
  if(/(?:^|[^\p{L}])(?:не|если|возможно|примерно|ориентировочно|наверное|либо|или|например|постара\p{L}*|попробу\p{L}*|планиру\p{L}*|отмен\p{L}*|перен\p{L}*|вчера|позавчера|была|прошла|состоял\p{L}*|сказал\p{L}*|написал\p{L}*)(?:$|[^\p{L}])/iu.test(source))return raw;
  const day=[...withoutClocks(source).matchAll(dates)],clocks=clockEvidence(source);
  if(day.length!==1||clocks.length!==1||!clocks[0].time)return raw;
  const phrase=withoutClocks(source).replace(dates,' ').replace(/^[\s,]+|[\s,.]+$/gu,'').replace(/\s+/g,' ');
  const match=phrase.match(/^(?:(?:создай|создать|добавь|добавить|запиши|записать|назначь|назначить)\s+)?(встреч[ау]|созвон|звонок)(?:\s+с\s+([\p{L}-]+(?:\s+[\p{L}-]+){0,2}))?$/iu);
  if(!match)return raw;
  const title=(match[1].toLowerCase()==='встречу'?'Встреча':match[1][0].toUpperCase()+match[1].slice(1))+(match[2]?' с '+match[2]:'');
  const change={kind:'meeting_create',text:title,evidence:source,participant_id:null,participant_name:match[2]||null,participant_mention:match[2]||null};
  if(!sourceAppointment(change,{full:source,refDate,timeZone}))return raw;
  return {...raw,summary:title,questions:[],changes:[change]};
}
export function sourceAppointment(raw,{full,refDate,timeZone,forwardedUnknown=false}){
  const evidence=raw.evidence;
  if(typeof evidence!=='string'||!full.includes(evidence)||reminders.test(evidence)||/[;!?]|\.\s+\p{L}|\sа\s/iu.test(evidence)||/(?:отмен\p{L}*|состоял\p{L}*|обсудили|прошла|перенос\p{L}*)/iu.test(evidence))return null;
  const intent=raw.kind==='meeting_create'||(raw.kind==='task_create'&&communication.test(evidence)&&communication.test(raw.text));
  if(!intent)return null;
  // Exactly one day and one wall-clock value in the action's own evidence.
  // Separate literal quotes handle speech such as "Завтра ... в 9:15".
  const found=[...withoutClocks(evidence).matchAll(dates)];
  const clocks=clockEvidence(evidence);
  if(found.length!==1||clocks.length!==1||!clocks[0].time||!/^(?:в|на)\s/iu.test(clocks[0].text))return null;
  const quote=found[0][0];
  if(forwardedUnknown&&!/\d{4}/u.test(quote))return null;
  if(/(?:^|[^\p{L}])(?:постара\p{L}*|попробу\p{L}*|планиру\p{L}*)(?:$|[^\p{L}])/iu.test(evidence))return null;
  const grounded=dateEvidence({source_text:evidence,date_text:quote,date_status:'explicit'},full);
  if(!grounded.quote)return null;
  const day=exactDay(quote,refDate,{timeZone}).day;
  if(!day)return null;
  let duration=30,estimated=true;
  if(typeof raw.duration_text==='string'&&evidence.includes(raw.duration_text)){
    const match=raw.duration_text.match(/^(\d{1,3})\s*(минут(?:а|ы)?|час(?:а|ов)?)$/iu);
    const value=match?Number(match[1])*(match[2].toLowerCase().startsWith('час')?60:1):0;
    if(value>=1&&value<=1440){duration=value;estimated=false;}
  }
  return {meeting_date:day,meeting_time:clocks[0].time,duration_minutes:duration,duration_estimated:estimated};
}
