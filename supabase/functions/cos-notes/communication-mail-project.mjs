const normalize=s=>String(s||'').normalize('NFC').toLocaleLowerCase('ru').replaceAll('ё','е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
function uniqueMatch(text,projects){
  const haystack=' '+normalize(text)+' ';
  let matches=projects.map(p=>({id:p.id,title:normalize(p.title)})).filter(p=>p.title.length>=4&&haystack.includes(' '+p.title+' '));
  // A full, more specific name beats its own prefix (Интершарм ТО / Интершарм).
  matches=matches.filter(p=>{
    const longer=matches.filter(other=>p.id!==other.id&&other.title!==p.title&&(' '+other.title+' ').includes(' '+p.title+' '));
    const remaining=longer.reduce((text,other)=>text.replaceAll(' '+other.title+' ',' '),haystack);
    return remaining.includes(' '+p.title+' ');
  });
  return matches.length===1?matches[0].id:null;
}
export function mailProject(value,item,projects){
  const active=projects.filter(p=>!p.status||p.status==='active');
  const explicit=item.proposal?.owner_context?.project_id||item.source_meta?.project_id;
  if(active.some(p=>p.id===explicit))return explicit;
  const work=active.filter(p=>!p.area_key||p.area_key==='work');
  const message=item.source_meta?.messages?.find(m=>m.id===value.source_message_id);
  const text=message?String(item.source_text||'').slice(message.start,message.end):String(item.source_text||'');
  const subject=text.match(/^Тема: (.*)$/m)?.[1]||item.source_meta?.subject||'';
  return uniqueMatch(value.evidence,work)||uniqueMatch(subject,work)||uniqueMatch(text,work);
}
