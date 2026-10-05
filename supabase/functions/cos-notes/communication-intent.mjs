// Conservative, source-only recovery for an explicit task to prepare/delegate work.
// Does not invent the future subtasks, write people, or execute model instructions.
const key=value=>String(value||'').normalize('NFC').toLocaleLowerCase('ru').replaceAll('ё','е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const tokens=value=>key(value).split(' ').filter(Boolean);
function nameTokenMatches(name,mention){
  if(name===mention)return true;
  if(name.length<3||mention.length<3)return false;
  if(!/[аяйь]$/u.test(name))return ['а','у','ом','е'].some(end=>mention===name+end);
  const stem=name.slice(0,-1),ends={а:['ы','е','у','ой'],я:['и','е','ю','ей'],й:['я','ю','ем','е'],ь:['я','ю','ем','е','и','ью']};
  return ends[name.at(-1)]?.some(end=>mention===stem+end)||false;
}
export function nameMatches(name,mention){
  const a=tokens(name),b=tokens(mention);
  return a.length>0&&a.length===b.length&&a.every((word,i)=>nameTokenMatches(word,b[i]));
}
export function participantFor(raw,context,evidence){
  const mention=typeof raw.participant_mention==='string'?raw.participant_mention.trim():'';
  const source=' '+key(evidence)+' ';
  const grounded=mention&&source.includes(' '+key(mention)+' ');
  const byId=context.participants.find(p=>p.id===raw.participant_id);
  if(byId&&(source.includes(' '+key(byId.name)+' ')||grounded&&nameMatches(byId.name,mention)))return {id:byId.id,suggestion:null};
  if(!grounded)return {id:null,suggestion:null};
  const matches=context.participants.filter(p=>nameMatches(p.name,mention));
  if(matches.length===1)return {id:matches[0].id,suggestion:null};
  // A first name shared by several full names requires choosing, never merging.
  const candidates=context.participants.filter(p=>nameTokenMatches(tokens(p.name)[0]||'',tokens(mention)[0]||''));
  if(candidates.length)return {id:null,suggestion:{name:mention,mention,existing_ids:candidates.map(p=>p.id)}};
  const name=typeof raw.participant_name==='string'?raw.participant_name.trim():'';
  if(!name||name.length>200||!nameMatches(name,mention))return {id:null,suggestion:null};
  return {id:null,suggestion:{name,mention,existing_ids:[]}};
}
export function recoverPreparationTask(raw,{source,corrections=[]}){
  if(!Array.isArray(raw?.changes)||raw.changes.length)return raw;
  // Later clarification wins, but only if it itself contains a complete action.
  if(corrections.some(c=>/(?:^|[^\p{L}])(?:не|отмен\p{L}*|вместо|уже)(?:$|[^\p{L}])/iu.test(c.text)))return raw;
  const blocks=[...corrections.map(c=>c.text).reverse(),source];
  for(const block of blocks){
    if(typeof block!=='string'||block.length>1000||/[?!]/u.test(block)||/(?:^|[^\p{L}])(?:не|если|возможно|например|отмен\p{L}*|уже|вчера|сделал\p{L}*)(?:$|[^\p{L}])/iu.test(block))continue;
    const action=block.match(/(?:^|[.!]\s+)(?:(?:мне|ему|ей)\s+)?(?:(?:надо|нужно|необходимо)\s+)?((?:подобрать|поставить|дать|распределить|подготовить|составить|назначить)\s+[^.!?]+)/iu);
    if(!action||!/(?:^|[^\p{L}])(?:задачи|задания|план работы)(?:$|[^\p{L}])/iu.test(action[1]))continue;
    const phrase=action[1].trim();
    const identity=[...corrections.map(c=>c.text).reverse(),source].map(s=>s.match(/^([А-ЯЁ][а-яё-]{2,})\s*(?:[-—–]\s*)?(?:новый участник|дизайнер|менеджер|инженер|конструктор|технолог)(?:\s|[.,]|$)/u)).find(Boolean);
    const name=identity?.[1]||null;
    const explicitMention=phrase.match(/(?:для\s+)?([А-ЯЁ][а-яё-]{2,})(?=\s|[,.:]|$)/u)?.[1];
    const mention=explicitMention||(name&&block.includes(name)?name:null);
    const day=phrase.match(/(?<!\p{L})(?:послезавтра|завтра|сегодня)(?!\p{L})(?:\s+в\s+[0-2]?\d:[0-5]\d)?/iu)?.[0]||null;
    let title=phrase.replace(/[,\s]*(?:на\s+)?(?:послезавтра|завтра|сегодня)(?:\s+в\s+[0-2]?\d:[0-5]\d)?[.\s]*$/iu,'').trim();
    const original=source.match(/^((?:подобрать|поставить|дать|распределить|подготовить|составить|назначить)\s+[^.!?]+)/iu)?.[1];
    if(name&&!explicitMention&&original)title=original.replace(/[,\s]*(?:на\s+)?(?:послезавтра|завтра|сегодня)(?:\s+в\s+[0-2]?\d:[0-5]\d)?[.\s]*$/iu,'').trim();
    title=title.charAt(0).toLocaleUpperCase('ru')+title.slice(1);
    return {...raw,summary:title,questions:[],recovered_intent:true,changes:[{kind:'task_create',text:title,evidence:block,project_id:null,participant_id:null,participant_name:name||mention,participant_mention:mention,direction:'internal',status:'open',date_text:day,date_status:day?'explicit':'none',date_kind:'work'}]};
  }
  return raw;
}
