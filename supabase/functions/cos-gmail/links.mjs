import {validId} from './mail.mjs';
export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=(status,reason)=>{throw Object.assign(Error(reason),{status,reason})};
export async function threadLinks(store,row){
  const people=await store.list('cos_gmail_thread_participants','select=participant_id&thread_id=eq.'+encodeURIComponent(row.thread_id)+'&order=position.asc');
  return {project_id:row.project_id||null,participant_ids:people.map(p=>p.participant_id),revision:row.links_revision||0};
}
export async function saveThreadLinks(store,data){
  if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).length!==4||Object.keys(data).some(k=>!['thread_id','project_id','participant_ids','revision'].includes(k))||!validId(data.thread_id)||
    data.project_id!==null&&!UUID.test(data.project_id||'')||!Array.isArray(data.participant_ids)||data.participant_ids.length>30||data.participant_ids.some(id=>!UUID.test(id||''))||
    new Set(data.participant_ids.map(id=>id.toLowerCase())).size!==data.participant_ids.length||!Number.isSafeInteger(data.revision)||data.revision<0||data.revision>2147483647)fail(400,'invalid_links');
  try{return await store.rpc('cos_gmail_set_links',{p_thread_id:data.thread_id,p_project_id:data.project_id,p_participant_ids:data.participant_ids,p_revision:data.revision});}
  catch(e){const errors={PT400:[400,'invalid_links'],PT404:[404,'thread_unavailable'],PT409:[409,'links_conflict'],PT422:[422,'invalid_link_target'],23503:[422,'invalid_link_target']};if(errors[e.code])fail(...errors[e.code]);throw e;}
}
