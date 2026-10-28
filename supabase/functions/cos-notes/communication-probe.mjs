// Opt-in provider smoke test. These constants are synthetic: no store, real
// messages, business mutations, Telegram API or Gmail API are used here.
import {normalizeInboxProposal} from './communication-inbox.mjs';
const PROJECT='11111111-1111-4111-8111-111111111111';
const PERSON='22222222-2222-4222-8222-222222222222';
const ITEM='33333333-3333-4333-8333-333333333333';
const CHANGE='44444444-4444-4444-8444-444444444444';
const REF='2026-10-28T06:00:00.000Z',ZONE='Europe/Moscow';
const project={id:PROJECT,title:'Тестовый проект Альфа',status:'active',area_key:'work'};
const person={id:PERSON,name:'Антон Иванов'};
const telegramText='Сегодня в 12 встреча с Антоном по Тестовому проекту Альфа.';
const mailBody='По проекту «Тестовый проект Альфа» прошу прислать чертёж до 30.10.2026.';
const mailText=`Письмо synthetic-message · ${REF}\nОт: Антон Иванов <anton@example.invalid>\nКому: Владелец <owner@example.invalid>\nТема: Тестовый проект Альфа\n${mailBody}`;
const mailMeta={type:'gmail',subject:'Тестовый проект Альфа',thread_id:'synthetic-thread',owner_email:'owner@example.invalid',project_id:null,context_days:7,message_limit:3,total_messages:1,omitted_messages:0,partial:false,message_date:REF,new_message_ids:['synthetic-message'],messages:[{id:'synthetic-message',date:REF,from:'Антон Иванов <anton@example.invalid>',email:'anton@example.invalid',to_emails:['owner@example.invalid'],start:0,end:mailText.length,truncated:false,automatic_reply:false}]};
const cases=[
 {name:'telegram',kind:'meeting_create',text:telegramText,meta:{type:'text',channel:'telegram',message_date:REF},date:'2026-10-28',time:'12:00'},
 {name:'gmail',kind:'task_create',text:mailText,meta:mailMeta,date:'2026-10-30'}
];
const modelName=value=>typeof value==='string'&&value.length<=200&&/^[a-z0-9_.:-]+\/[a-z0-9_.:-]+$/i.test(value)?value:null;
function usage(value){return Object.fromEntries(['prompt_tokens','completion_tokens','total_tokens','cost'].filter(key=>typeof value?.[key]==='number'&&Number.isFinite(value[key])&&value[key]>=0).map(key=>[key,value[key]]));}
export async function probeCommunicationModel(model){
  const results=[];
  for(const sample of cases){
    const started=Date.now(),args={channel:sample.meta.channel,...(sample.name==='gmail'?{mail:structuredClone(mailMeta)}:{})};
    let requested=null,actual=null,safeUsage={};
    try{
      requested=modelName(model?.modelFor?.(args));
      if(!requested?.endsWith(':free')){results.push({case:sample.name,status:'not_run',requested_model:requested,reason:'free_model_required'});continue;}
      const context={projects:[{...project}],participants:[{...person}],tasks:[],briefs:[],gmail_people:[{email:'anton@example.invalid',participant_id:PERSON}]};
      const generated=await model({...args,text:sample.text,context:{projects:context.projects,participants:context.participants,tasks:[],briefs:[]},refDate:REF,timeZone:ZONE});
      actual=modelName(generated?.model);safeUsage=usage(generated?.usage);
      const item={id:ITEM,source_text:sample.text,source_meta:structuredClone(sample.meta),transcript:null,created_at:REF,proposal:{}};
      const proposal=normalizeInboxProposal(generated?.data,{item,context,timeZone:ZONE,uuid:()=>CHANGE});
      const change=proposal.changes.length===1?proposal.changes[0]:null;
      const checks={model_action:generated.data.changes?.length===1&&generated.data.changes[0].kind===sample.kind,action:change?.kind===sample.kind,project:change?.project_id===PROJECT,participant:change?.participant_id===PERSON,date:(sample.name==='telegram'?change?.meeting_date:change?.deadline)===sample.date,...(sample.time?{time:change?.meeting_time===sample.time}:{}),selected:change?.selected===true,no_questions:proposal.questions.length===0,...(sample.name==='gmail'?{responsibility:change?.mail_relation==='owner_request',intent:change?.mail_intent==='request'}:{})};
      results.push({case:sample.name,status:Object.values(checks).every(Boolean)?'passed':'failed',requested_model:requested,actual_model:actual,usage:safeUsage,duration_ms:Date.now()-started,checks});
    }catch(error){
      results.push({case:sample.name,status:'unavailable',requested_model:requested,actual_model:actual,usage:safeUsage,duration_ms:Date.now()-started,error:['analysis_unavailable','invalid_analysis'].includes(error?.code)?error.code:'probe_failed',...(Number.isInteger(error?.provider_status)&&error.provider_status>=100&&error.provider_status<=599?{provider_status:error.provider_status}:{})});
    }
  }
  return {status:results.every(result=>result.status==='passed')?'passed':results.every(result=>result.status==='not_run')?'not_run':results.some(result=>result.status==='unavailable')?'unavailable':'failed',cases:results};
}
