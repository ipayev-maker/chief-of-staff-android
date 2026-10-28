const {test}=require('node:test');
const assert=require('node:assert/strict');
const modulePath='../../supabase/functions/cos-notes/communication-inbox.mjs';
const args={text:'Сегодня в 12 встреча с Вяловой',context:{projects:[],participants:[],tasks:[],briefs:[]},refDate:'2026-10-28T07:00:00Z',timeZone:'Europe/Moscow'};
const answer={summary:'Встреча',questions:[],changes:[]};
async function fixture({status=200,finish='stop',content=JSON.stringify(answer),actualModel}={}){
  const {createInboxModel,TELEGRAM_MODEL}=await import(modulePath),calls=[];
  const model=createInboxModel({openRouterKey:'synthetic-test-key',fetchImpl:async(url,init)=>{
    calls.push({url,body:JSON.parse(init.body)});
    return new Response(JSON.stringify(status===200?{model:actualModel,choices:[{finish_reason:finish,message:{content}}],usage:{total_tokens:100,cost:0}}:{error:{message:'provider limited'}}),{status});
  }});
  return {model,calls,TELEGRAM_MODEL};
}
test('Telegram text and voice transcripts use the pinned free model and enforce JSON',async()=>{
  const {model,calls,TELEGRAM_MODEL}=await fixture();
  const result=await model({...args,channel:'telegram'});
  assert.equal(calls[0].body.model,TELEGRAM_MODEL);
  assert.equal(calls[0].body.model,'dots-studio/dots-3-note-preview:free');
  assert.deepEqual(calls[0].body.response_format,{type:'json_object'});
  assert.equal(calls[0].body.provider.require_parameters,true);
  assert.equal(calls[0].body.provider.data_collection,'deny');
  assert.equal(calls[0].body.reasoning.enabled,false);
  assert.equal(result.model,TELEGRAM_MODEL);
  assert.equal(result.usage.cost,0);
});
test('Gmail uses the free model for initial and repeated analysis while other capture paths stay unchanged',async()=>{
  const {model,calls}=await fixture();
  await model({...args,channel:'telegram',mail:{type:'gmail'}});
  await model(args);
  assert.equal(calls[0].body.model,'dots-studio/dots-3-note-preview:free');
  assert.deepEqual(calls[0].body.response_format,{type:'json_object'});
  assert.equal(calls[1].body.model,'anthropic/claude-sonnet-4.6');
  assert.equal(calls[1].body.response_format,undefined);
});
test('a free-model outage never silently spends credits on paid fallback',async()=>{
  const {model,calls}=await fixture({status:429});
  await assert.rejects(model({...args,channel:'telegram'}),e=>e.code==='analysis_unavailable'&&e.provider_status===429);
  assert.equal(calls.length,1);
  assert.equal(calls[0].body.model,'dots-studio/dots-3-note-preview:free');
});
test('truncated or malformed generations are rejected before normalization',async()=>{
  for(const options of [{finish:'length'},{finish:'error'},{content:'not json'}]){
    const {model}=await fixture(options);
    await assert.rejects(model({...args,channel:'telegram'}),e=>e.code==='invalid_analysis');
  }
});
test('analysis records the returned provider model and exposes the requested model before inference',async()=>{
  const {model,TELEGRAM_MODEL}=await fixture({actualModel:'dots-studio/dots-3-note-preview:free'});
  assert.equal(model.modelFor({channel:'telegram'}),TELEGRAM_MODEL);
  assert.equal(model.modelFor({channel:'telegram',mail:true}),TELEGRAM_MODEL);
  assert.equal((await model({...args,channel:'telegram'})).model,'dots-studio/dots-3-note-preview:free');
});
test('source channel survives analyze and re-analysis, including failed generation metadata',async()=>{
  const {createCommunicationInbox}=await import(modulePath);
  const {model,TELEGRAM_MODEL}=await fixture({status:429});
  const id='00000000-0000-4000-8000-000000000001';let sequence=10;
  let row={id,revision:1,source_text:args.text,source_meta:{channel:'telegram',type:'text',message_date:args.refDate},status:'captured',proposal:{},created_at:args.refDate};
  const store={page:async table=>table==='cos_communication_inbox'?[row]:[],list:async()=>[],rpc:async(name,input)=>{
    assert.equal(name,'cos_inbox_update');row={...row,...input.p_patch,revision:row.revision+1};return {item:row};
  }};
  const inbox=createCommunicationInbox({store,model,timeZone:args.timeZone,uuid:()=>`00000000-0000-4000-8000-${String(sequence++).padStart(12,'0')}`});
  const first=await inbox.analyze(id);
  assert.equal(first.item.proposal.analysis.model,TELEGRAM_MODEL);
  assert.equal(first.item.proposal.analysis.provider_status,429);
  const second=await inbox.analyze(id,{revision:row.revision,correction:'Сегодня в 12 встреча с Вяловой'});
  assert.equal(second.item.proposal.analysis.model,TELEGRAM_MODEL);
  assert.equal(second.item.proposal.analysis.attempts,2);
});

test('provider health exposes only safe numeric daily free quota fields',async()=>{
 const {modelHealth}=await import('../../supabase/functions/cos-gmail/health.mjs');
 const result=await modelHealth({key:'test',fetchImpl:async url=>Response.json({data:url.endsWith('/key')?{free_model_daily_requests:{used:2,limit:1000,remaining:998,label:'private'}}:{total_credits:10,total_usage:3}})});
 assert.deepEqual(result.free_model_daily_requests,{used:2,limit:1000,remaining:998});
 assert.equal(JSON.stringify(result).includes('private'),false);
});
