import {serveProtected} from '../_shared/legacy-auth.ts';
const C={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'apikey, authorization, content-type, x-client-info','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'};
const R=(b:any,s=200)=>new Response(JSON.stringify({...b,server_version:'2.5.0'}),{status:s,headers:C});
const N=(s:any)=>String(s??'').normalize('NFKC').toLowerCase().replace(/ё/g,'е').replace(/\s+/g,' ').trim();
const add=(d:string,n:number)=>{const x=new Date(d+'T12:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10)};
function splitChat(text:string){
 const re=/^\[(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2})\][^\n]*$/gm; const hits=[...text.matchAll(re)];
 if(hits.length<2)return [text.trim()];
 const blocks:string[]=[]; for(let i=0;i<hits.length;i++){const a=hits[i].index??0,b=i+1<hits.length?(hits[i+1].index??text.length):text.length;const part=text.slice(a,b).trim();if(part)blocks.push(part)}
 return blocks.length?blocks:[text.trim()];
}
function normalizeDayparts(draft:any,today:string){
 if(!draft||!Array.isArray(draft.date_evidence))return draft;
 let review=false; const warnings:string[]=[];
 for(const ev of draft.date_evidence){
  const x=N(ev?.expression); const m=x.match(/^(сегодня|завтра|послезавтра)\s+(утром|днем|днём|вечером|ночью)$/);
  if(m && !ev.date){const off=m[1]==='сегодня'?0:m[1]==='завтра'?1:2; ev.date=add(today,off);ev.kind='date';ev.needs_confirmation=false;ev.warnings=[{code:'daypart_without_exact_time',message:`Дата распознана как ${ev.date}; «${m[2]}» не превращалось в выдуманное точное время.`}]; if(ev.field==='deadline')draft.deadline=ev.date; if(ev.field==='planned_on')draft.planned_on=ev.date; if(ev.field==='next_check_on')draft.next_check_on=ev.date; warnings.push(`Указано «${m[2]}»: дата определена, точное время не задано.`)}
  if(ev?.needs_confirmation)review=true;
 }
 draft.warnings=[...(draft.warnings||[]).filter((w:any)=>!String(w).includes('Не удалось однозначно вычислить дату.')),...warnings];
 draft.needs_date_review=review;
 return draft;
}
function dedupe(arr:any[]){const out:any[]=[];for(const d of arr){const k=N(d?.description);if(!k)continue;if(out.some(x=>N(x.description)===k))continue;out.push(d)}return out}
serveProtected(async(req)=>{
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers:C}); if(req.method!=='POST')return R({error:'method_not_allowed'},405);
 const apikey=req.headers.get('apikey'); if(!apikey)return R({error:'api_key_required'},401);
 let input:any; try{input=await req.json()}catch{return R({error:'invalid_json'},400)}
 if(typeof input?.text!=='string'||!input.text.trim())return R({error:'text_required'},400);
 if(input.mode && input.mode!=='preview')return R({error:'preview_only'},400);
 const base=Deno.env.get('SUPABASE_URL'); if(!base)return R({error:'server_not_configured'},502);
 const auth=req.headers.get('authorization'); const headers:any={'Content-Type':'application/json','apikey':apikey}; if(auth)headers.Authorization=auth;
 const parts=splitChat(input.text.trim());
 try{
  const parsed=await Promise.all(parts.map(async part=>{const q=await fetch(`${base}/functions/v1/cos-capture`,{method:'POST',headers,body:JSON.stringify({mode:'preview',text:part}),signal:AbortSignal.timeout(70000)});const j=await q.json().catch(()=>null);if(!q.ok)throw Error(j?.error||`capture_http_${q.status}`);return j}));
  const today=parsed.find(x=>x?.today)?.today || new Date().toISOString().slice(0,10); const tz=parsed.find(x=>x?.time_zone)?.time_zone || null;
  let drafts:any[]=dedupe(parsed.flatMap(x=>Array.isArray(x?.drafts)?x.drafts:[]).map(d=>normalizeDayparts(d,today)));
  const projects=[...new Set(drafts.map(d=>String(d?.project_title||'').trim()).filter(Boolean))]; if(projects.length===1){for(const d of drafts)if(!d.project_title)d.project_title=projects[0]}
  return R({drafts,today,time_zone:tz,preview:true,base_server_version:parsed[0]?.server_version||parsed[0]?.version||null,chat_blocks:parts.length,version:'2.5.0'});
 }catch(e){return R({error:String((e as any)?.message||e).slice(0,700)},502)}
});
