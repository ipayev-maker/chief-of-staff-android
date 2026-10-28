// Bind only explicitly named, active-context projects. Russian case endings
// do not change identity, but abbreviations and similar spelling are not proof.
import {nameMatches} from './communication-intent.mjs';
const tokens=value=>String(value||'').normalize('NFC').toLocaleLowerCase('ru').replaceAll('ё','е').replace(/[^\p{L}\p{N}]+/gu,' ').trim().split(' ').filter(Boolean);
function mentions(title,evidence){
  const name=tokens(title),words=tokens(evidence);
  if(!name.length)return [];
  const found=[];
  for(let i=0;i<=words.length-name.length;i++){
    const phrase=words.slice(i,i+name.length).join(' ');
    if(nameMatches(name.join(' '),phrase))found.push({phrase,start:i,end:i+name.length});
  }
  return found;
}
export function projectFor(raw,context,evidence){
  const matches=context.projects.filter(p=>p.status===undefined||p.status==='active').map(project=>({project,mentions:mentions(project.title,evidence)})).filter(row=>row.mentions.length);
  if(matches.length===1)return matches[0].project.id;
  const selected=matches.find(row=>row.project.id===raw.project_id);
  if(!selected)return null;
  // The model may choose between separately named projects in a sentence, but
  // never resolve colliding titles or a short title nested in a longer one.
  const ambiguous=matches.some(row=>row!==selected&&row.mentions.some(other=>selected.mentions.some(own=>own.start<other.end&&other.start<own.end)));
  return ambiguous?null:selected.project.id;
}
