// Opt-in at the trusted Telegram ingestion boundary; never applies Gmail,
// forwards, historical messages or edits to existing business records.
const word=(terms,value)=>new RegExp('(?:^|[^\\p{L}])(?:'+terms+')(?:$|[^\\p{L}])','iu').test(value);
export function automaticCreation(item,now=new Date()){
  const meta=item.source_meta||{},proposal=item.proposal||{},changes=proposal.changes;
  if(meta.channel!=='telegram'||meta.auto_create!==true||!['text','voice'].includes(meta.type)||meta.forwarded||meta.superseded)return false;
  if(item.status!=='ready'||proposal.corrections?.length||proposal.questions?.length||!Array.isArray(changes)||!changes.length)return false;
  const age=+now-Date.parse(meta.message_date);
  if(!Number.isFinite(age)||age < -300000||age>86400000)return false;
  const source=item.transcript?[meta.caption||((item.source_text||'')!=='[Голосовое сообщение]'?item.source_text:''),item.transcript].filter(Boolean).join('\n\n'):item.source_text||'';
  const cleaned=source.replace(/(?:^|\s)не\s+(?:забудь|забыть|забывайте|забывай)\s+/giu,' ');
  // Do not execute quoted examples, alternative plans, past reports or negation
  // even if an imperfect model extracts an affirmative fragment from them.
  if(/[?«»“”"]/u.test(cleaned)||word('не|если|возможно|примерно|ориентировочно|наверное|либо|или|например|постара\\p{L}*|попробу\\p{L}*|отмен\\p{L}*|перенес\\p{L}*|вчера|позавчера|состоял\\p{L}*|обсудили|завершили|сказал\\p{L}*|написал\\p{L}*',cleaned))return false;
  return changes.every(c=>{
    if(c.selected===false||!['task_create','meeting_create'].includes(c.kind)||!c.evidence||!source.includes(c.evidence)||c.evidence_restored)return false;
    if(c.kind==='meeting_create')return !!(c.meeting_date&&c.meeting_time);
    if(c.status!=='open'||c.direction==='to_me')return false;
    // A concrete infinitive action or explicit create-task command is required.
    // The grounding is the original source, never the rewritten model title.
    return word('создай|создать|добавь|добавить|запиши|записать|поставь|поставить|напомни|напомнить',c.evidence)||
      /(?:^|[\s,:;])(?:[а-яё-]{3,}(?:ть|ться|ти|чь))(?=$|[\s,.;:])/iu.test(c.evidence);
  });
}
