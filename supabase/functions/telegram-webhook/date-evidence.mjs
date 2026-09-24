// Date-only deadlines from exact quotes, never from a rewritten task title.
// Node 24 / Deno 2; no dependencies or I/O. The owner's business timezone is Moscow.
const DAY=86_400_000;
const months=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const weekdays=new Map([['понедельник',1],['вторник',2],['среду',3],['среда',3],['четверг',4],['пятницу',5],['пятница',5],['субботу',6],['суббота',6],['воскресенье',0],['понедельника',1],['вторника',2],['среды',3],['четверга',4],['пятницы',5],['субботы',6],['воскресенья',0]]);
const word=(terms,text)=>new RegExp('(?:^|[^\\p{L}])(?:'+terms+')(?:$|[^\\p{L}])','iu').test(text);
export function validDay(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const date=new Date(value+'T12:00:00Z');return Number.isFinite(+date)&&date.toISOString().slice(0,10)===value;}
const stamp=day=>Date.parse(day+'T12:00:00Z');
const move=(day,days)=>new Date(stamp(day)+days*DAY).toISOString().slice(0,10);
const dayString=(year,month,day)=>`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
function baseDay(refDate){return new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(refDate));}
function clean(value){return value.trim().toLowerCase().replaceAll('ё','е').replace(/[.,!?:;]+$/,'').replace(/^(?:(?:до|к|на|в|во)\s+)+/,'').trim();}
export function hasDateHint(text){return /\d{1,4}[./-]\d{1,2}|\d{1,2}\s+(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)/iu.test(text)||word('сегодня|завтра|послезавтра|вчера|позавчера|понедельник\\p{L}*|вторник\\p{L}*|сред[ау]|четверг\\p{L}*|пятниц\\p{L}*|суббот\\p{L}*|воскресень\\p{L}*|недел\\p{L}*|месяц\\p{L}*|срок\\p{L}*|через|назад',text);}
function uncertain(text){return word('или|либо|примерно|ориентировочно|возможно|наверное|предположительно|между|раньше|позже|пока|когда-нибудь',text)||/\d\s*[-–—]\s*\d/u.test(text.replace(/\d{4}-\d{2}-\d{2}/g,''))||/(?:^|\s)с\s+.+\s+по\s+/iu.test(text);}
// A date-bearing clause with a negation needs clarification. "Не забудь" is
// an instruction, not a negated deadline; keep that common idiom usable.
function countDateMentions(text){return [...text.matchAll(/\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}(?:[./]\d{4})?|\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)|(?<!\p{L})(?:сегодня|послезавтра|завтра|позавчера|вчера|понедельник\p{L}*|вторник\p{L}*|сред[ауы]|четверг\p{L}*|пятниц\p{L}*|суббот\p{L}*|воскресень\p{L}*)(?!\p{L})/giu)].length;}
function sourceUncertain(source){const text=source.replace(/(?:^|\s)не\s+(?:забудь|забыть|забывайте|забывай)\s+/giu,' ');return uncertain(text)||countDateMentions(text)>1||word('не',text);}
export function dateEvidence(row,text){
  const source=typeof row?.source_text==='string'?row.source_text.trim():'';
  const date=typeof row?.date_text==='string'?row.date_text.trim():'';
  if(!source||source.length>2000||!text.includes(source))return {warning:true};
  if(row?.date_status==='ambiguous')return {warning:true};
  if(!date)return {warning:hasDateHint(source)};
  if(row?.date_status!=='explicit'||date.length>160||!source.includes(date)||sourceUncertain(source)||word('начале|конце|середине|рабочих|рабочие',date)||/^(?:(?:на|до|к|в)\s+)?(?:следующ(?:ая|ей|ую)|эт(?:а|ой|у))\s+(?:недел\p{L}*|месяц\p{L}*)$/iu.test(date))return {warning:true};
  return {quote:date,warning:false};
}
// Resolve supported syntax locally. An omitted year is accepted only when
// the date has not passed this Moscow calendar year; otherwise ask for a year.
// Explicit past years and relative past dates are deliberately preserved.
export function exactDay(quote,refDate){
  const text=clean(quote),today=baseDay(refDate),year=Number(today.slice(0,4));let match,day;
  // Preserve the date portion of an explicit date + clock time. Times are not
  // invented as deadlines: the current ingestion schema stores a date only.
  if((match=text.match(/^(.+?)\s+в\s+([0-2]?\d)(?::([0-5]\d))?(?:\s*час(?:а|ов)?)?$/))){return Number(match[2])<=23?exactDay(match[1],refDate):{known:true,day:null};}
  if(/^\d{1,2}:\d{2}$/.test(text))return {known:true,day:null};
  if((match=text.match(/^(?:следующей\s+неделе\s+в\s+(.+)|(.+?)\s+(?:на\s+)?следующей\s+недел(?:е|и))$/))){return exactDay('следующий '+(match[1]||match[2]),refDate);}
  const relative={сегодня:0,завтра:1,послезавтра:2,вчера:-1,позавчера:-2};
  if(Object.hasOwn(relative,text))return {known:true,day:move(today,relative[text])};
  if(/^\d{4}-\d{2}-\d{2}$/.test(text))return {known:true,day:validDay(text)?text:null};
  if((match=text.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{4}))?$/))){day=dayString(match[3]||year,match[2],match[1]);return {known:true,day:validDay(day)&&(match[3]||day>=today)?day:null};}
  if((match=text.match(/^(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s+(\d{4})(?:\s*(?:года|г))?)?$/))){day=dayString(match[3]||year,months.indexOf(match[2])+1,match[1]);return {known:true,day:validDay(day)&&(match[3]||day>=today)?day:null};}
  if((match=text.match(/^через\s+(\d{1,3})\s+(день|дня|дней|неделю|недели|недель)$/))){const count=Number(match[1]);return {known:true,day:count>0?move(today,count*(match[2].startsWith('недел')?7:1)):null};}
  if(text==='через неделю')return {known:true,day:move(today,7)};
  if((match=text.match(/^(?:(эту|этот|это|этой|этого|следующую|следующий|следующее|следующей|следующего|прошлую|прошлый|прошлое|прошлой|прошлого)\s+)?(понедельник|понедельника|вторник|вторника|среду|среда|среды|четверг|четверга|пятницу|пятница|пятницы|субботу|суббота|субботы|воскресенье|воскресенья)$/))){
    const target=weekdays.get(match[2]),current=new Date(stamp(today)).getUTCDay(),modifier=match[1];
    const offset=modifier?(target+6)%7-(current+6)%7+(modifier.startsWith('следующ')?7:modifier.startsWith('прошл')?-7:0):(target-current+7)%7;
    return {known:true,day:move(today,offset)};
  }
  return {known:false,day:null};
}
// The shared legacy parser rolls past dates forward by a week and uses UTC.
// Unknown syntax must stay unset until that service has a reliable contract.
// This resolver intentionally performs no network calls.
export function assignEntityDates(extracted,raw,text,{refDate}){
  const entries=[...extracted.commitments.map((item,index)=>({item,row:raw.commitments[index],field:'deadline'})),...extracted.events.map((item,index)=>({item,row:raw.events[index],field:'date'}))];
  const dates=new Map();let warningCount=0;
  for(const {item,row,field} of entries){
    const evidence=dateEvidence(row,text);
    if(evidence.quote&&!dates.has(evidence.quote))dates.set(evidence.quote,exactDay(evidence.quote,refDate).day);
    const day=evidence.quote?dates.get(evidence.quote):null;item[field]=day||null;
    if(evidence.warning||evidence.quote&&!day)warningCount++;
  }
  return warningCount;
}
