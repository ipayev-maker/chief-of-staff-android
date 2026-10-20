// Literal Russian clock forms emitted by speech recognition. Node 24 / Deno 2.
// Keep offsets intact when hiding clocks from the numeric calendar-date parser.
export function clockEvidence(source){
  if(typeof source!=='string')return [];
  const pattern=/(?<![\p{L}\d])(?:в|на|к|до)\s+(\d{1,2})(?:([:.])(\d{2})|(\s+час(?:а|ов)?))?(?![\p{L}\d:/-]|\.\d)/giu;
  return [...source.matchAll(pattern)].map(m=>({text:m[0],index:m.index,hour:Number(m[1]),minute:Number(m[3]||0),
    time:Number(m[1])<24&&Number(m[3]||0)<60?m[1].padStart(2,'0')+':'+(m[3]||'00'):null,
    // "до 21.10" can mean a date: only в/на disambiguate a dotted clock.
    dottedDate:m[2]==='.'&&/^(?:до|к)\s/iu.test(m[0])&&Number(m[1])<=31&&Number(m[3])>=1&&Number(m[3])<=12
  })).filter(c=>!c.dottedDate);
}
export function withoutClocks(source){
  const chars=source.split('');
  for(const clock of clockEvidence(source))for(let i=clock.index;i<clock.index+clock.text.length;i++)chars[i]=' ';
  return chars.join('');
}
