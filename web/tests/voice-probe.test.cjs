const {test}=require('node:test');
const assert=require('node:assert/strict');
const implementation=import('../../supabase/functions/telegram-webhook/voice-probe.mjs');
test('voice probe uploads only fixed Russian OGG through the production adapter',async()=>{
 const {probeVoice}=await implementation;let calls=0;
 const result=await probeVoice({groqApiKey:'synthetic-groq',openRouterKey:'never-use',fetchImpl:async(url,init)=>{
  calls++;assert.equal(url,'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.deepEqual(init.headers,{Authorization:'Bearer synthetic-groq'});assert.equal(init.method,'POST');
  assert.equal(init.body.get('model'),'whisper-large-v3');assert.equal(init.body.get('language'),'ru');
  const bytes=Buffer.from(await init.body.get('file').arrayBuffer());assert.equal(bytes.subarray(0,4).toString(),'OggS');assert.ok(bytes.length>1000);
  return Response.json({text:'Завтра в 12 встреча с Антоном.'});
 }});
 assert.equal(calls,1);assert.equal(result.status,'passed');assert.equal(result.model,'groq/whisper-large-v3');
 assert.deepEqual(result.checks,{meeting:true,person:true,day:true,time:true});assert.equal('text' in result,false);
});
test('voice probe never calls paid inference or any provider before Groq is selected',async()=>{
 const {probeVoice}=await implementation;
 for(const config of [{},{openRouterKey:'x'},{groqApiKey:'g',openRouterKey:'x',transcriptionProvider:'openrouter'}]){
  const result=await probeVoice({...config,fetchImpl:()=>assert.fail('no network call allowed')});assert.equal(result.status,'not_run');
 }
});
test('voice probe distinguishes API errors and incorrect speech without exposing upstream content',async()=>{
 const {probeVoice}=await implementation;
 for(const status of [401,429,500]){
  let calls=0;const result=await probeVoice({groqApiKey:'synthetic-groq',fetchImpl:async()=>{calls++;return new Response('SECRET_ERROR_BODY',{status});}});
  assert.equal(calls,1);assert.equal(result.status,'unavailable');assert.doesNotMatch(JSON.stringify(result),/SECRET|synthetic-groq/);
 }
 const result=await probeVoice({groqApiKey:'g',fetchImpl:async()=>Response.json({text:'Погода хорошая.'})});
 assert.equal(result.status,'failed');assert.ok(Object.values(result.checks).every(value=>value===false));
});
