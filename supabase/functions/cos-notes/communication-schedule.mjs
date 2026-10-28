// Source-grounded appointment extraction. Node 24 / Deno 2; no I/O.
import {dateEvidence,exactDay,clockRangeEvidence} from '../telegram-webhook/date-evidence.mjs';
import {clockEvidence,withoutClocks} from '../telegram-webhook/time-evidence.mjs';
const communication=/(?:^|[^\p{L}])(?:встреч[ауи]|встретиться|встретимся|созвон(?:иться|имся)?|позвонить|позвоним|звонок|зум|zoom|обсудить|обсудим)(?:$|[^\p{L}])/iu;
const reminders=/(?:^|[^\p{L}])(?:напомни\p{L}*|напоминание)(?:$|[^\p{L}])/iu;
const dates=/\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}(?:[./]\d{4})?|\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s+\d{4})?|(?<!\p{L})(?:через\s+(?:\d{1,3}\s+(?:день|дня|дней|неделю|недели|недель)|неделю)|послезавтра|завтра|сегодня|(?:следующ(?:ий|ую|ее)\s+)?(?:понедельник|вторник|сред[ау]|четверг|пятниц[ау]|суббот[ау]|воскресенье))(?!\p{L})/giu;
function calendarText(source){
  const chars=withoutClocks(source).split('');
  for(const range of clockRangeEvidence(source))for(let i=range.index;i<range.index+range.text.length;i++)chars[i]=' ';
  return chars.join('');
}
function appointmentClock(source){
  const ranges=clockRangeEvidence(source);
  if(ranges.length){
    if(ranges.length!==1||!ranges[0].time)return null;
    const range=ranges[0],outside=source.slice(0,range.index)+' '.repeat(range.text.length)+source.slice(range.index+range.text.length);
    return clockEvidence(outside).length?null:range;
  }
  const clocks=clockEvidence(source);
  return clocks.length===1&&clocks[0].time&&(clocks[0].bare||/^(?:в|на)\s/iu.test(clocks[0].text))?clocks[0]:null;
}
// Telegram commonly places a complete schedule above a single meeting title.
// Recover only this narrow envelope; do not borrow a header across several actions.
function recoverScheduleHeader(raw,{source,corrections,refDate,timeZone}){
  if(corrections.length||typeof source!=='string'||source.length>1000||/[;!?«»“”"]/u.test(source))return null;
  if((raw.changes||[]).some(change=>!['task_create','meeting_create'].includes(change?.kind)||change.task_id))return null;
  const lines=source.split(/\n+/).map(line=>line.trim()).filter(Boolean);
  if(lines.length!==2)return null;
  const [header,title]=lines;
  if(!/^(?:встреч[ау]|созвон|звонок|зум|zoom)(?:\s+.+)?[.]?$/iu.test(title)||/[.]\s+\p{L}|(?:^|\s)(?:и|затем|потом)\s+\p{L}*(?:ть|ться|ти|чь)(?:$|[^\p{L}])/iu.test(title))return null;
  if([...title.matchAll(new RegExp(communication.source,'giu'))].length!==1||[...calendarText(title).matchAll(dates)].length||clockEvidence(title).length)return null;
  const day=[...calendarText(header).matchAll(dates)];
  if(day.length!==1||calendarText(header).replace(dates,' ').replace(/[\s,.:–—-]/gu,''))return null;
  const timing=sourceAppointment({kind:'meeting_create',text:title,evidence:source},{full:source,refDate,timeZone});
  if(!timing)return null;
  const candidates=(raw.changes||[]).filter(change=>typeof change?.evidence==='string'&&source.includes(change.evidence)&&change.evidence.includes(title));
  const original=candidates.find(change=>change.kind==='meeting_create')||candidates[0]||{};
  return {...raw,summary:title,questions:[],changes:[{...original,kind:'meeting_create',text:title,evidence:source,date_text:day[0][0],date_status:'explicit'}]};
}
// An unknown surname is optional metadata, not an ambiguous scheduling intent.
// Recover only a complete, single, literal appointment; never repair ASR words.
export function recoverAppointment(raw,{source,corrections=[],refDate,timeZone}){
  const header=recoverScheduleHeader(raw,{source,corrections,refDate,timeZone});
  if(header)return header;
  if(!raw.changes?.length&&!corrections.length&&typeof source==='string'&&source.includes('\n')){
    const lines=source.split(/\n+/).map(s=>s.trim()).filter(Boolean);
    if(lines.length<=10){const changes=lines.flatMap(line=>recoverAppointment({changes:[],questions:[]},{source:line,refDate,timeZone}).changes||[]);if(changes.length)return {...raw,questions:[],changes};}
  }
  if(raw.changes?.length||corrections.length||typeof source!=='string'||source.length>300||/[;!?«»“”"\n]/u.test(source))return raw;
  if(/(?:^|[^\p{L}])(?:не|если|возможно|примерно|ориентировочно|наверное|либо|или|например|постара\p{L}*|попробу\p{L}*|планиру\p{L}*|отмен\p{L}*|перен\p{L}*|вчера|позавчера|была|прошла|состоял\p{L}*|сказал\p{L}*|написал\p{L}*)(?:$|[^\p{L}])/iu.test(source))return raw;
  const day=[...calendarText(source).matchAll(dates)],clock=appointmentClock(source);
  if(day.length!==1||!clock)return raw;
  const phrase=calendarText(source).replace(dates,' ').replace(/^[\s,]+|[\s,.]+$/gu,'').replace(/\s+/g,' ');
  const match=phrase.match(/^(?:(?:создай|создать|добавь|добавить|запиши|записать|назначь|назначить)\s+)?(встреч[ау]|созвон|звонок|зум|zoom)(?:\s+(?:с\s+)?([\p{L}\d-]+(?:\s+[\p{L}\d-]+){0,4}))?$/iu);
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
  const found=[...calendarText(evidence).matchAll(dates)];
  const clock=appointmentClock(evidence);
  if(found.length!==1||!clock)return null;
  const quote=found[0][0];
  if(forwardedUnknown&&!/\d{4}/u.test(quote))return null;
  if(/(?:^|[^\p{L}])(?:постара\p{L}*|попробу\p{L}*|планиру\p{L}*)(?:$|[^\p{L}])/iu.test(evidence))return null;
  const grounded=dateEvidence({source_text:evidence,date_text:quote,date_status:'explicit'},full);
  if(!grounded.quote)return null;
  const day=exactDay(quote,refDate,{timeZone}).day;
  if(!day)return null;
  let duration=clock.duration_minutes||30,estimated=!clock.duration_minutes;
  if(!clock.duration_minutes&&typeof raw.duration_text==='string'&&evidence.includes(raw.duration_text)){
    const match=raw.duration_text.match(/^(\d{1,3})\s*(минут(?:а|ы)?|час(?:а|ов)?)$/iu);
    const value=match?Number(match[1])*(match[2].toLowerCase().startsWith('час')?60:1):0;
    if(value>=1&&value<=1440){duration=value;estimated=false;}
  }
  return {meeting_date:day,meeting_time:clock.time,duration_minutes:duration,duration_estimated:estimated};
}
