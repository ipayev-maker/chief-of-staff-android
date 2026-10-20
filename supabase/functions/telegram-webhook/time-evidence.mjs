// Literal Russian clock forms emitted by speech recognition. Node 24 / Deno 2.
// Keep offsets intact when hiding clocks from the numeric calendar-date parser.
const numbers=['ноль','один','два','три','четыре','пять','шесть','семь','восемь','девять','десять','одиннадцать','двенадцать','тринадцать','четырнадцать','пятнадцать','шестнадцать','семнадцать','восемнадцать','девятнадцать','двадцать','двадцать один','двадцать два','двадцать три'];
const spoken=numbers.slice().sort((a,b)=>b.length-a.length).join('|');
const extraNumber=/^\s+(?:\d|ноль|один|одна|дв[ае]|три|четыре|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать|тринадцать|четырнадцать|пятнадцать|шестнадцать|семнадцать|восемнадцать|девятнадцать|двадцать|тридцать|сорок|пятьдесят|минут)[\p{L}\d]*(?=$|[^\p{L}\d])/iu;
export function clockEvidence(source){
  if(typeof source!=='string')return [];
  const pattern=/(?<![\p{L}\d])(?:в|на|к|до)\s+(\d{1,2})(?:([:.])(\d{2})|(\s+час(?:а|ов)?))?(?![\p{L}\d:/-]|\.\d)/giu;
  const numeric=[...source.matchAll(pattern)].map(m=>({text:m[0],index:m.index,hour:Number(m[1]),minute:Number(m[3]||0),
    time:Number(m[1])<24&&Number(m[3]||0)<60?m[1].padStart(2,'0')+':'+(m[3]||'00'):null,
    // "до 21.10" can mean a date: only в/на disambiguate a dotted clock.
    dottedDate:m[2]==='.'&&/^(?:до|к)\s/iu.test(m[0])&&Number(m[1])<=31&&Number(m[3])>=1&&Number(m[3])<=12
  })).filter(c=>!c.dottedDate);
  const words=[...source.matchAll(new RegExp('(?<![\\p{L}\\d])(?:в|на|к|до)\\s+('+spoken+')(?![\\p{L}\\d])(?:\\s+час(?:а|ов)?(?!\\p{L}))?','giu'))].map(m=>{
    const hour=numbers.indexOf(m[1].toLocaleLowerCase('ru').replace(/\s+/g,' '));
    return {text:m[0],index:m.index,hour,minute:0,time:String(hour).padStart(2,'0')+':00'};
  });
  return [...numeric,...words].sort((a,b)=>a.index-b.index).map(clock=>{
    const tail=source.slice(clock.index+clock.text.length);
    // Unsupported/malformed spoken minutes must not become a confident hour.
    // "двенадцать три часа" is neither 12:00 nor 12:03.
    if(extraNumber.test(tail))return {...clock,time:null};
    const period=tail.match(/^\s+(утра|дня|вечера|ночи)(?!\p{L})/iu);
    if(!period||!clock.time)return clock;
    const p=period[1].toLowerCase();let hour=clock.hour;
    if(hour<1||hour>12)return {...clock,time:null};
    if(p==='дня'||p==='вечера')hour=hour%12+12;
    else if(p==='ночи'&&hour===12)hour=0;
    else if(p==='утра'&&hour===12)return {...clock,time:null};
    return {...clock,text:clock.text+period[0],hour,time:String(hour).padStart(2,'0')+clock.time.slice(2)};
  });
}
export function withoutClocks(source){
  const chars=source.split('');
  for(const clock of clockEvidence(source))for(let i=clock.index;i<clock.index+clock.text.length;i++)chars[i]=' ';
  return chars.join('');
}
