// Conservative, source-only recovery for an explicit task to prepare/delegate work.
// Does not invent the future subtasks, write people, or execute model instructions.
import {dateEvidence,exactDay} from '../telegram-webhook/date-evidence.mjs';
const key=value=>String(value||'').normalize('NFC').toLocaleLowerCase('ru').replaceAll('ё','е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const tokens=value=>key(value).split(' ').filter(Boolean);

// A leading day + owner instruction is a work date even if the model omitted
// date_text or rewrote its spelling. Use only this action's literal evidence.
export function recoverTaskWorkDate(raw,{full,refDate,timeZone}){
  const source=raw.evidence;
  if(raw.kind!=='task_create'||raw.task_id||raw.direction==='to_me'||raw.status&&raw.status!=='open'||typeof source!=='string'||source.length>1000||!full.includes(source))return raw;
  if(/[;!?«»“”"\n]|\.\s+\p{L}/u.test(source)||/(?:^|[^\p{L}])(?:если|например|затем|потом|а|сказал\p{L}*|написал\p{L}*)(?:$|[^\p{L}])/iu.test(source))return raw;
  const match=source.match(/^(.{1,160}?)\s*,?\s+(?:(?:мне|нам)\s+)?(?:надо|нужно|необходимо)\s+(.+)$/iu);
  if(!match)return raw;
  const quote=match[1].trim().replace(/,$/u,'');
  if(/^(?:до|к)\s/iu.test(quote))return raw;
  const actions=[...match[2].matchAll(/(?<!\p{L})([а-яё-]{3,}(?:ть|ться|ти|чь))(?!\p{L})/giu)].map(m=>m[1].toLocaleLowerCase('ru'));
  if(!actions.some(verb=>tokens(raw.text).includes(verb)))return raw;
  const checked=dateEvidence({source_text:source,date_text:quote,date_status:'explicit'},full);
  if(!checked.quote||!exactDay(checked.quote,refDate,{timeZone}).day)return raw;
  return {...raw,date_text:checked.quote,date_status:'explicit',date_kind:'work'};
}
function nameTokenMatches(name,mention){
  if(name===mention)return true;
  if(name.length<3||mention.length<3)return false;
  // Adjectival surnames and project titles: Вяловая → Вяловой,
  // Тверской → Тверским. Keep complete stems; never fuzzy-match typos.
  if(/(?:ая|яя)$/u.test(name))return (name.endsWith('ая')?['ой','ую']:['ей','юю']).some(end=>mention===name.slice(0,-2)+end);
  if(/(?:ый|ий|ой)$/u.test(name)&&['ого','его','ому','ему','ым','им','ом','ем'].some(end=>mention===name.slice(0,-2)+end))return true;
  if(/(?:ов|ев|ин|ын)$/u.test(name)&&mention===name+'ым')return true;
  if(!/[аяйь]$/u.test(name))return ['а','у','ом','е'].some(end=>mention===name+end);
  const stem=name.slice(0,-1),ends={а:['ы','е','у','ой'],я:['и','е','ю','ей'],й:['я','ю','ем','е'],ь:['я','ю','ем','е','и','ью']};
  return ends[name.at(-1)]?.some(end=>mention===stem+end)||false;
}
export function nameMatches(name,mention){
  const a=tokens(name),b=tokens(mention);
  return a.length>0&&a.length===b.length&&a.every((word,i)=>nameTokenMatches(word,b[i]));
}
function partialNameMatches(name,mention){
  const full=tokens(name),part=tokens(mention);
  return part.length>0&&part.length<=full.length&&full.some((_,i)=>i+part.length<=full.length&&nameMatches(full.slice(i,i+part.length).join(' '),mention));
}
function partialParticipantFor(raw,context,evidence){
  const participants=context.participants;
  const source=' '+key(evidence)+' ';
  let mention=typeof raw.participant_mention==='string'?raw.participant_mention.trim():'';
  const byId=participants.find(p=>p.id===raw.participant_id);
  // An omitted mention can be recovered only from the selected person's name,
  // as literal tokens in this action's evidence. Prefer the longest match.
  if(!mention&&byId){
    const words=tokens(evidence),size=tokens(byId.name).length;
    outer:for(let length=size;length>=1;length--)for(let i=0;i<=words.length-length;i++){
      const part=words.slice(i,i+length).join(' ');
      if(partialNameMatches(byId.name,part)){mention=part;break outer;}
    }
  }
  if(!mention||!source.includes(' '+key(mention)+' '))return {id:null,suggestion:null};
  const matches=participants.filter(p=>partialNameMatches(p.name,mention));
  if(matches.length===1)return {id:matches[0].id,suggestion:null};
  // A model-supplied ID is not evidence that one of several Antons was meant.
  if(matches.length)return {id:null,suggestion:{name:mention,mention,existing_ids:matches.map(p=>p.id)}};
  const name=typeof raw.participant_name==='string'?raw.participant_name.trim():'';
  if(!name||name.length>200||!nameMatches(name,mention))return {id:null,suggestion:null};
  return {id:null,suggestion:{name,mention,existing_ids:[]}};
}
export function participantFor(raw,context,evidence,{allowPartial=false}={}){
  if(allowPartial)return partialParticipantFor(raw,context,evidence);
  let mention=typeof raw.participant_mention==='string'?raw.participant_mention.trim():'';
  const byId=context.participants.find(p=>p.id===raw.participant_id);
  // Some model responses provide only a known ID. Ground its full inflected
  // name in this action's evidence before accepting it.
  if(!mention&&byId){const words=tokens(evidence),size=tokens(byId.name).length;for(let i=0;i<=words.length-size;i++){const part=words.slice(i,i+size).join(' ');if(nameMatches(byId.name,part)){mention=part;break;}}}
  const source=' '+key(evidence)+' ';
  const grounded=mention&&source.includes(' '+key(mention)+' ');
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

// Short owner commands remain actionable even when the model returns no changes.
// Ambiguous fragments, quotations, conditions and completed actions stay notes.
export function recoverDirectTask(raw,{source,corrections=[]}){
  if(raw.changes?.length||corrections.length||typeof source!=='string'||source.length>1000||/[?!«»“”"\n]/u.test(source)||/(?:^|[^\p{L}])(?:не|если|возможно|например|уже|вчера|отмен\p{L}*)(?:$|[^\p{L}])/iu.test(source))return raw;
  const verbs={запроси:'Запросить',сделай:'Сделать',подготовь:'Подготовить',отправь:'Отправить',проверь:'Проверить',уточни:'Уточнить',согласуй:'Согласовать',напиши:'Написать',позвони:'Позвонить',свяжись:'Связаться'};
  const match=source.trim().match(/^(?:(?:мне\s+)?(?:надо|нужно|необходимо)\s+)?(запроси(?:ть)?|сделай|сделать|подготовь|подготовить|отправь|отправить|проверь|проверить|уточни(?:ть)?|согласуй|согласовать|напиши|написать|позвони(?:ть)?|свяжись|связаться)\s+(.+)$/iu);
  if(!match)return raw;
  const verb=match[1].toLocaleLowerCase('ru'),title=(verbs[verb]||verb[0].toUpperCase()+verb.slice(1))+' '+match[2];
  const date=source.match(/(?<!\p{L})(?:(?:до|к|на|в)\s+)?(?:сегодня|завтра|послезавтра|понедельник|вторник|сред[ау]|четверг|пятниц[ау]|суббот[ау]|воскресенье)(?!\p{L})(?:\s+(?:в\s+)?\d{1,2}[:.]\d{2})?/iu)?.[0]||null;
  return {...raw,questions:[],summary:title,changes:[{kind:'task_create',text:title,evidence:source,project_id:null,participant_id:null,direction:'internal',status:'open',date_text:date,date_status:date?'explicit':'none',date_kind:/^(?:до|к)\s/iu.test(date||'')?'deadline':'work'}]};
}
