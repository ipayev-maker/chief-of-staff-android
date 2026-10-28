// Date-only deadlines from exact quotes, never from a rewritten task title.
// Node 24 / Deno 2; no dependencies or I/O. Legacy callers default to Moscow;
// inbox callers pass the configured business timezone and original source time.
import {clockEvidence,withoutClocks} from './time-evidence.mjs';
const DAY=86_400_000;
const months=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const weekdays=new Map([['понедельник',1],['вторник',2],['среду',3],['среда',3],['четверг',4],['пятницу',5],['пятница',5],['субботу',6],['суббота',6],['воскресенье',0],['понедельника',1],['вторника',2],['среды',3],['четверга',4],['пятницы',5],['субботы',6],['воскресенья',0]]);
const word=(terms,text)=>new RegExp('(?:^|[^\\p{L}])(?:'+terms+')(?:$|[^\\p{L}])','iu').test(text);
export function validDay(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const date=new Date(value+'T12:00:00Z');return Number.isFinite(+date)&&date.toISOString().slice(0,10)===value;}
const stamp=day=>Date.parse(day+'T12:00:00Z');
const move=(day,days)=>new Date(stamp(day)+days*DAY).toISOString().slice(0,10);
const dayString=(year,month,day)=>`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
function baseDay(refDate,timeZone){return new Intl.DateTimeFormat('sv-SE',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(refDate));}
function clean(value){return value.trim().toLowerCase().replaceAll('ё','е').replace(/[.,!?:;]+$/,'').replace(/^(?:(?:до|к|на|в|во)\s+)+/,'').trim();}
export function hasDateHint(text){return /\d{1,4}[./-]\d{1,2}|\d{1,2}\s+(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)/iu.test(text)||word('сегодня|завтра|послезавтра|вчера|позавчера|понедельник\\p{L}*|вторник\\p{L}*|сред[ау]|четверг\\p{L}*|пятниц\\p{L}*|суббот\\p{L}*|воскресень\\p{L}*|недел\\p{L}*|месяц\\p{L}*|срок\\p{L}*|через|назад',text);}
// A person and project ("с Антоном по Интершарму") are not a date range.
// Require temporal-looking endpoints, including abbreviated "с 3 по 5 ноября".
const rangeBoundary='(?:\\d{1,4}(?![\\p{L}\\d])|(?:(?:эт[а-яё]*|следующ[а-яё]*|прошл[а-яё]*)\\s+)?(?:сегодня|завтра|послезавтра|вчера|позавчера|понедельник[а-яё]*|вторник[а-яё]*|сред[ауы]|четверг[а-яё]*|пятниц[а-яё]*|суббот[а-яё]*|воскресень[а-яё]*|утр[а-яё]*|вечер[а-яё]*|ноч[а-яё]*|начал[а-яё]*|кон[еца][а-яё]*)(?!\\p{L}))';
const dateRange=new RegExp('(?:^|\\s)с\\s+'+rangeBoundary+'.*?\\s+(?:по|до)\\s+'+rangeBoundary,'iu');
function uncertain(text){return word('или|либо|примерно|ориентировочно|возможно|наверное|предположительно|между|раньше|позже|пока|когда-нибудь',text)||/\d\s*[-–—]\s*\d/u.test(text.replace(/\d{4}-\d{2}-\d{2}/g,''))||dateRange.test(text);}
// Explicit same-day clock intervals carry a start and duration, not two dates.
// Keep the literal span so callers can mask it without altering quote offsets.
export function clockRangeEvidence(source){
  if(typeof source!=='string')return [];
  const pattern=/(?<![\p{L}\d])с\s+(\d{1,2})(?:[:.](\d{2}))?(?:\s+час(?:а|ов)?)?\s+до\s+(\d{1,2})(?:[:.](\d{2}))?(?:\s+час(?:а|ов)?)?(?![\p{L}\d:/-]|\.\d)/giu;
  return [...source.matchAll(pattern)].map(m=>{
    const start=Number(m[1])*60+Number(m[2]||0),end=Number(m[3])*60+Number(m[4]||0);
    const unit=/^\s*(?:sku|скю|детал\p{L}*|штук\p{L}*|шт\.?|позиц\p{L}*|мм|см|кг|руб\p{L}*|дн(?:я|ей)|день|недел\p{L}*|месяц\p{L}*|процент\p{L}*|%|января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?=$|[^\p{L}])/iu.test(source.slice(m.index+m[0].length));
    const valid=!unit&&Number(m[1])<24&&Number(m[3])<24&&Number(m[2]||0)<60&&Number(m[4]||0)<60&&end>start;
    return {text:m[0],index:m.index,time:valid?m[1].padStart(2,'0')+':'+(m[2]||'00'):null,duration_minutes:valid?end-start:null};
  });
}
function withoutClockRanges(source){
  const chars=source.split('');
  for(const range of clockRangeEvidence(source))if(range.time)for(let i=range.index;i<range.index+range.text.length;i++)chars[i]=' ';
  return chars.join('');
}
// A date-bearing clause with a negation needs clarification. "Не забудь" is
// an instruction, not a negated deadline; keep that common idiom usable.
function countDateMentions(text){return [...text.matchAll(/\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}(?:[./]\d{4})?|\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)|(?<!\p{L})(?:сегодня|послезавтра|завтра|позавчера|вчера|понедельник\p{L}*|вторник\p{L}*|сред[ауы]|четверг\p{L}*|пятниц\p{L}*|суббот\p{L}*|воскресень\p{L}*)(?!\p{L})/giu)].length;}
function sourceUncertain(source){const text=source.replace(/(?:^|\s)не\s+(?:забудь|забыть|забывайте|забывай)\s+/giu,' '),calendar=withoutClockRanges(text);return uncertain(calendar)||countDateMentions(withoutClocks(calendar))>1||word('не',text);}
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
// the date has not passed the reference calendar year; otherwise ask for a year.
// Explicit past years and relative past dates are deliberately preserved.
export function exactDay(quote,refDate,{timeZone='Europe/Moscow'}={}){
  const text=clean(quote),today=baseDay(refDate,timeZone),year=Number(today.slice(0,4));let match,day;
  const clocks=clockEvidence(text);
  if(clocks.length===1&&clocks[0].index>0&&clocks[0].index+clocks[0].text.length===text.length){
    return clocks[0].time?exactDay(text.slice(0,clocks[0].index).trim(),refDate,{timeZone}):{known:true,day:null};
  }
  // Preserve the date portion of an explicit date + clock time. Times are not
  // invented as deadlines: the current ingestion schema stores a date only.
  if((match=text.match(/^(.+?)\s+(?:в|к|до)\s+([0-2]?\d)(?:[:.]([0-5]\d))?(?:\s*час(?:а|ов)?)?$/))){return Number(match[2])<=23?exactDay(match[1],refDate,{timeZone}):{known:true,day:null};}
  if(/^\d{1,2}:\d{2}$/.test(text))return {known:true,day:null};
  if((match=text.match(/^(?:следующей\s+неделе\s+в\s+(.+)|(.+?)\s+(?:на\s+)?следующей\s+недел(?:е|и))$/))){return exactDay('следующий '+(match[1]||match[2]),refDate,{timeZone});}
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
