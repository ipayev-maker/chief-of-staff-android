// Node 24; native fetch is replaced. Synthetic bytes only, no external traffic.
const {test}=require('node:test');const assert=require('node:assert/strict');
const implementation=import('../../supabase/functions/telegram-webhook/voice.mjs');
const ID='12345678-1234-4123-8123-123456789abc';
const voice={file_id:'synthetic-file',file_unique_id:'synthetic-unique',duration:30,file_size:64,mime_type:'audio/ogg'};
const bytes=()=>{const value=new Uint8Array(64);value.set([79,103,103,83]);return value};
async function fixture(options={}){
  const {createVoiceAdapter}=await implementation,calls=[],env={badFilePath:null,downloadBytes:null,failUpload:false,overrides:{},transcript:'После звонка: отправить чертёж завтра.'};
  env.adapter=createVoiceAdapter({url:'https://project.supabase.co',serviceKey:'service-test',botToken:'bot-test',openRouterKey:'ai-test',...options,fetchImpl:async(url,init={})=>{
    calls.push({url,init});
    const stage=url.includes('/getFile')?'telegram_file':url.includes('/file/bot')?'telegram_download':url.includes('/storage/')?(init.method==='POST'?'storage_write':'storage_read'):url.includes('/audio/transcriptions')?'transcription':null;
    if(env.overrides[stage])return env.overrides[stage]();
    if(stage==='telegram_file')return new Response(JSON.stringify({ok:true,result:{file_path:env.badFilePath??'voice/file_123.oga',file_size:64}}));
    if(stage==='telegram_download')return new Response(env.downloadBytes||bytes());
    if(stage==='storage_write')return new Response('{}',{status:env.failUpload?503:200});
    if(stage==='storage_read')return new Response(bytes());
    if(stage==='transcription')return new Response(JSON.stringify({text:env.transcript}));
    throw Error('unexpected URL');
  }});
  env.calls=calls;env.save=()=>env.adapter.save({ownerId:'123456789',communicationId:ID,voice});env.transcribe=()=>env.adapter.transcribe({ownerId:'123456789',communicationId:ID});return env;
}
test('voice source is stored privately with deterministic bounded owner path',async()=>{const env=await fixture();const saved=await env.save();assert.equal(saved.path,'123456789/'+ID+'/voice.ogg');assert.equal(saved.bucket,'cos-communication-audio');assert.equal(saved.size_bytes,64);assert.equal(env.calls.length,3);assert.match(env.calls[2].url,/storage\/v1\/object\/cos-communication-audio/);assert.equal(env.calls[2].init.headers.Authorization,'Bearer service-test');assert.equal(env.calls[2].init.headers['Content-Type'],'audio/ogg');assert.equal(env.calls[2].init.redirect,'error');assert.equal(env.calls.some(r=>r.url.includes('openrouter')),false);assert.equal(JSON.stringify(saved).includes('bot-test'),false)});
test('speech recognition reads the stored original and uses existing OpenRouter account',async()=>{const env=await fixture();assert.equal(await env.transcribe(),env.transcript);assert.match(env.calls[0].url,/storage\/v1\/object\/authenticated/);const call=env.calls[1];assert.equal(call.url,'https://openrouter.ai/api/v1/audio/transcriptions');assert.equal(call.init.headers.Authorization,'Bearer ai-test');const body=JSON.parse(call.init.body);assert.equal(body.model,'openai/gpt-4o-transcribe');assert.equal(env.adapter.model,body.model);assert.equal(body.language,'ru');assert.equal(body.input_audio.format,'ogg');assert.deepEqual(Buffer.from(body.input_audio.data,'base64'),Buffer.from(bytes()))});
test('voice metadata bounds reject oversized or long audio before any external call',async()=>{const {validateVoice,VOICE_MAX_BYTES}=await implementation;for(const extra of [{duration:601},{duration:-1},{file_size:VOICE_MAX_BYTES+1},{file_id:'../secret'},{mime_type:'text/html'}])assert.throws(()=>validateVoice({...voice,...extra}));assert.equal(validateVoice(voice).duration,30)});
test('Telegram getFile may use a safe directory other than voice',async()=>{for(const path of ['audio/file_123.oga','documents/2026/file-123.ogg','file_123.oga']){const env=await fixture();env.badFilePath=path;await env.save();assert.equal(env.calls[1].url,'https://api.telegram.org/file/botbot-test/'+path);assert.equal(env.calls[1].init.redirect,'error')}});
test('invalid Telegram file paths cannot produce cross-origin or traversal downloads',async()=>{for(const path of ['', 'https://example.com/file.ogg','//example.com/file.ogg','/voice/file.ogg','voice/../secret','voice/./file.ogg','voice//file.ogg','voice/file.ogg?token=x','voice/file.ogg#fragment','voice/%2e%2e/secret','voice\\file.ogg','voice/'+ 'x'.repeat(1024)]){const env=await fixture();env.badFilePath=path;await assert.rejects(env.save(),{message:'voice_telegram_file_invalid_path'});assert.equal(env.calls.length,1)}});
test('HTML or arbitrary media is never uploaded as OGG audio',async()=>{const env=await fixture();env.downloadBytes=new TextEncoder().encode('<html>not an audio source</html>');await assert.rejects(env.save(),{message:'voice_format'});assert.equal(env.calls.length,2)});
test('actual download length is bounded independently of Telegram metadata',async()=>{const {VOICE_MAX_BYTES}=await implementation;const env=await fixture();env.downloadBytes=new Uint8Array(VOICE_MAX_BYTES+1);await assert.rejects(env.save(),{message:'voice_too_large'});assert.equal(env.calls.length,2)});
test('failed private storage does not claim successful upload',async()=>{const env=await fixture();env.failUpload=true;await assert.rejects(env.save(),{message:'voice_storage_write_server_error'});assert.equal(env.calls.some(r=>r.url.includes('openrouter')),false)});
test('empty or excessively large transcript is an explicit retryable failure',async()=>{for(const transcript of ['', 'x'.repeat(20001)]){const env=await fixture();env.transcript=transcript;await assert.rejects(env.transcribe());}});
test('invalid owner and source identities cannot access private audio',async()=>{const env=await fixture();await assert.rejects(env.adapter.transcribe({ownerId:'../',communicationId:ID}),{message:'voice_invalid_target'});await assert.rejects(env.adapter.save({ownerId:'123456789',communicationId:'../id',voice}),{message:'voice_invalid_target'});assert.equal(env.calls.length,0)});
test('private playback returns audio bytes without storage or Telegram credentials in response',async()=>{const env=await fixture();const response=await env.adapter.read({ownerId:'123456789',communicationId:ID});assert.equal(response.headers.get('Content-Type'),'audio/ogg');assert.equal(response.headers.get('Cache-Control'),'private, no-store');assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');assert.equal(response.headers.get('Location'),null);assert.deepEqual(Buffer.from(await response.arrayBuffer()),Buffer.from(bytes()));assert.equal(env.calls.length,1)});
test('provider HTTP failures retain only bounded status categories, never response bodies',async()=>{
  const statuses={400:'bad_request',401:'unauthorized',402:'payment_required',403:'forbidden',404:'not_found',408:'timeout',413:'too_large',415:'unsupported_media',422:'invalid_input',429:'rate_limited',500:'server_error',503:'server_error',418:'http_error'};
  for(const [status,suffix] of Object.entries(statuses)){
    const env=await fixture();env.overrides.transcription=()=>({ok:false,status:Number(status),json(){throw Error('Response body must not be read')}});
    await assert.rejects(env.transcribe(),error=>{assert.equal(error.message,'voice_transcription_'+suffix);assert.equal(error.safeCode,error.message);assert.match(error.safeCode,/^voice_[a-z_]+$/);assert.equal(error.cause,undefined);return true});
  }
});
test('Telegram lookup, media download, and storage failures identify their separate stage',async()=>{
  for(const stage of ['telegram_file','telegram_download','storage_write','storage_read']){
    const env=await fixture();env.overrides[stage]=()=>new Response('private upstream body',{status:403});
    await assert.rejects(stage==='storage_read'?env.transcribe():env.save(),{message:'voice_'+stage+'_forbidden'});
  }
});
test('fetch timeouts and network errors never propagate secret-bearing exception messages',async()=>{
  for(const stage of ['telegram_file','telegram_download','storage_write','storage_read','transcription'])for(const name of ['TimeoutError','AbortError','TypeError']){
    const env=await fixture();env.overrides[stage]=()=>{throw Object.assign(new Error('SECRET_TOKEN private URL and message'),{name})};
    await assert.rejects(['storage_read','transcription'].includes(stage)?env.transcribe():env.save(),{message:'voice_'+stage+'_'+(name==='TypeError'?'network_error':'timeout')});
  }
});
test('Telegram API errors and malformed JSON are diagnosed without persisting descriptions',async()=>{
  const env=await fixture();env.overrides.telegram_file=()=>new Response(JSON.stringify({ok:false,error_code:429,description:'private body'}));
  await assert.rejects(env.save(),{message:'voice_telegram_file_rate_limited'});
  for(const stage of ['telegram_file','transcription']){
    const invalid=await fixture();invalid.overrides[stage]=()=>new Response('private non-JSON upstream response');
    await assert.rejects(stage==='transcription'?invalid.transcribe():invalid.save(),{message:'voice_'+stage+'_invalid_response'});
  }
});
test('audio stream failures preserve the download stage and timeout classification',async()=>{
  const env=await fixture();env.overrides.telegram_download=()=>new Response(new ReadableStream({start(controller){controller.error(new DOMException('private file URL','TimeoutError'))}}));
  await assert.rejects(env.save(),{message:'voice_telegram_download_timeout'});assert.equal(env.calls.length,2);
});


test('Groq uploads original private OGG bytes as multipart with a separate credential',async()=>{
  const env=await fixture({groqApiKey:'groq-synthetic'});
  assert.equal(await env.transcribe(),env.transcript);
  assert.equal(env.adapter.provider,'groq');assert.equal(env.adapter.model,'groq/whisper-large-v3');
  assert.equal(env.calls.length,2);
  const call=env.calls[1];assert.equal(call.url,'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.deepEqual(call.init.headers,{Authorization:'Bearer groq-synthetic'});
  assert.equal(call.init.redirect,'error');assert.ok(call.init.signal instanceof AbortSignal);
  const body=call.init.body;assert.ok(body instanceof FormData);
  assert.deepEqual([...body.keys()].sort(),['file','language','model','response_format','temperature']);
  assert.equal(body.get('model'),'whisper-large-v3');assert.equal(body.get('language'),'ru');assert.equal(body.get('temperature'),'0');assert.equal(body.get('response_format'),'json');
  const file=body.get('file');assert.equal(file.name,'voice.ogg');assert.equal(file.type,'audio/ogg');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()),Buffer.from(bytes()));
  assert.equal(env.calls.some(c=>c.url.includes('openrouter')),false);
});
test('Groq errors preserve the source and never call the paid provider',async()=>{
 for(const status of [401,429,500]){
  const env=await fixture({groqApiKey:'groq-synthetic'});
  env.overrides.transcription=()=>new Response('PRIVATE_PROVIDER_BODY',{status});
  await assert.rejects(env.transcribe(),e=>e.safeCode==='voice_transcription_'+({401:'unauthorized',429:'rate_limited',500:'server_error'}[status]));
  assert.equal(env.calls.length,2);assert.equal(env.calls.some(c=>c.url.includes('openrouter')),false);
 }
});
test('forcing Groq without a key does not read audio or silently use OpenRouter',async()=>{
 const env=await fixture({transcriptionProvider:'groq'});
 await assert.rejects(env.transcribe(),{message:'voice_transcription_unavailable'});assert.equal(env.calls.length,0);
});
test('Groq network and invalid transcript failures remain bounded and redacted',async()=>{
 for(const override of [()=>{throw new DOMException('private','TimeoutError')},()=>new Response('not json'),()=>Response.json({text:''}),()=>Response.json({text:'x'.repeat(20001)})]){
  const env=await fixture({groqApiKey:'groq-synthetic'});env.overrides.transcription=override;
  await assert.rejects(env.transcribe(),e=>/^voice_[a-z_]+$/.test(e.safeCode)&&!e.message.includes('private'));
  assert.equal(env.calls.length,2);
 }
});
test('voice configuration exposes only provider identity and key presence',async()=>{
 const {voiceConfiguration}=await implementation;
 assert.deepEqual(voiceConfiguration({groqApiKey:'g-private',openRouterKey:'o-private'}),{provider:'groq',model:'groq/whisper-large-v3',configured:true,groq_configured:true});
 assert.equal(voiceConfiguration({openRouterKey:'o-private'}).provider,'openrouter');
 assert.equal(voiceConfiguration({groqApiKey:'g-private',openRouterKey:'o-private',transcriptionProvider:'openrouter'}).provider,'openrouter');
 assert.throws(()=>voiceConfiguration({transcriptionProvider:'https://other.invalid'}),{message:'voice_invalid_provider'});
});
