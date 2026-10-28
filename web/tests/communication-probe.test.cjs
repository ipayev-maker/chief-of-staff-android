const {test}=require('node:test');
const assert=require('node:assert/strict');
const root='../../supabase/functions/';
const modulePromise=import(root+'cos-notes/communication-probe.mjs');
const MODEL='google/gemma-4-31b-it:free';
function fakeModel({fail=false,paid=false}={}){
 const calls=[];
 const model=async args=>{
  calls.push(args);if(fail)throw Object.assign(Error('secret upstream body'),{code:'analysis_unavailable',provider_status:429});
  const mail=!!args.mail,body=mail?args.text.split('\n').at(-1):args.text;
  return {model:MODEL,usage:{prompt_tokens:5,completion_tokens:6,total_tokens:11,cost:0,secret:'private'},data:{summary:'Проверка',questions:[],changes:[{kind:mail?'task_create':'meeting_create',text:mail?'Прислать чертёж':'Встреча с Антоном',evidence:body,project_id:args.context.projects[0].id,participant_id:args.context.participants[0].id,participant_name:'Антон',participant_mention:mail?null:'Антоном',date_kind:mail?'deadline':null,date_text:mail?'до 30.10.2026':'Сегодня',date_status:'explicit',direction:'internal',status:'open',...(mail?{source_message_id:'synthetic-message',trigger_message_id:'synthetic-message',trigger_evidence:body,participant_email:'anton@example.invalid',agreement:'agreed',owner_relation:'owner_request',action_intent:'request',responsibility_evidence:'прошу прислать чертёж',deadline_agreement:'confirmed',review_reason:null}:{})}]}};
 };
 model.modelFor=()=>paid?'anthropic/claude-sonnet-4.6':MODEL;
 return {model,calls};
}
test('fixed Telegram and Gmail probes use the real normalizer, source metadata and sequential models',async()=>{
 const {probeCommunicationModel}=await modulePromise,fixture=fakeModel();
 const result=await probeCommunicationModel(fixture.model);
 assert.equal(result.status,'passed');assert.equal(fixture.calls.length,2);
 assert.equal(fixture.calls[0].channel,'telegram');assert.equal(fixture.calls[0].mail,undefined);
 const mail=fixture.calls[1];assert.equal(mail.mail.messages[0].start,0);assert.equal(mail.mail.messages[0].end,mail.text.length);
 for(const row of result.cases){assert.equal(row.status,'passed');assert.equal(row.requested_model,MODEL);assert.equal(row.actual_model,MODEL);assert.equal(row.usage.cost,0);assert.equal(Object.values(row.checks).every(Boolean),true);}
 assert.doesNotMatch(JSON.stringify(result),/Антон|Альфа|example\.invalid|private|secret|source_text/);
});
test('paid or missing model selectors never perform inference',async()=>{
 const {probeCommunicationModel}=await modulePromise,{model,calls}=fakeModel({paid:true});
 assert.equal((await probeCommunicationModel(model)).status,'not_run');assert.equal(calls.length,0);
 delete model.modelFor;assert.equal((await probeCommunicationModel(model)).status,'not_run');assert.equal(calls.length,0);
});
test('provider quota failures are unavailable, never successful and never leak raw errors',async()=>{
 const {probeCommunicationModel}=await modulePromise,{model}=fakeModel({fail:true});
 const result=await probeCommunicationModel(model);assert.equal(result.status,'unavailable');
 for(const row of result.cases){assert.equal(row.provider_status,429);assert.equal(row.error,'analysis_unavailable');}
 assert.doesNotMatch(JSON.stringify(result),/secret upstream body/);
});
test('normalization recovery alone cannot make an empty model response pass',async()=>{
 const {probeCommunicationModel}=await modulePromise;
 const model=async()=>({model:MODEL,data:{summary:'',questions:[],changes:[]}});model.modelFor=()=>MODEL;
 const result=await probeCommunicationModel(model);assert.notEqual(result.status,'passed');assert.equal(result.cases[0].checks.model_action,false);
});
test('health authenticates before reading the probe body and preserves empty-body checks',async()=>{
 const {createGmailHandler}=await import(root+'cos-gmail/handler.mjs');
 const calls=[];const handler=createGmailHandler({config:{cronSecret:'test-cron'},health:async options=>{calls.push(options);return {configured:true};}});
 const unauth={method:'POST',url:'https://app.test/gmail/health',headers:new Headers(),get body(){throw Error('body must not be read')}};
 assert.equal((await handler(unauth)).status,401);assert.equal(calls.length,0);
 assert.equal((await handler(new Request('https://app.test/gmail/health',{method:'POST',headers:{Authorization:'Bearer test-cron'}}))).status,200);assert.deepEqual(calls,[{}]);
 const request=new Request('https://app.test/gmail/health',{method:'POST',headers:{Authorization:'Bearer test-cron','Content-Type':'application/json'},body:'{"probe":true}'});
 assert.equal((await handler(request)).status,200);assert.deepEqual(calls.at(-1),{probe:true});
});
test('health rejects arbitrary probe inputs, non-JSON bodies and oversized streams',async()=>{
 const {createGmailHandler}=await import(root+'cos-gmail/handler.mjs');let calls=0;
 const handler=createGmailHandler({config:{cronSecret:'test-cron'},health:async()=>{calls++;return {};}});
 for(const body of ['{}','null','[]','{"probe":false}','{"probe":true,"text":"private"}','{"model":"x"}','{',' '.repeat(129)]){
  const request=new Request('https://app.test/gmail/health',{method:'POST',headers:{Authorization:'Bearer test-cron','Content-Type':'application/json'},body});
  assert.equal((await handler(request)).status,400,body);
 }
 assert.equal((await handler(new Request('https://app.test/gmail/health',{method:'POST',headers:{Authorization:'Bearer test-cron'},body:'{"probe":true}'}))).status,400);
 assert.equal(calls,0);
});
