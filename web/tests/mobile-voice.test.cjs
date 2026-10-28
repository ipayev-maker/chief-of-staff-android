const {test}=require('node:test');const assert=require('node:assert/strict');
const modulePath='../../supabase/functions/cos-notes/mobile-voice.mjs';
const ID='00000000-0000-4000-8000-000000000001',DATE='2026-10-28T18:00:00Z';
const mp4=()=>{const bytes=new Uint8Array(64);bytes.set([102,116,121,112],4);return bytes;};
const req=(headers={},bytes=mp4())=>new Request('https://nikodim.vercel.app/api/notes/mobile/voice',{method:'POST',headers:{'Content-Type':'audio/mp4','X-Capture-ID':ID,'X-Audio-Seconds':'3','X-Recorded-At':DATE,...headers},body:bytes});
test('mobile upload accepts bounded M4A and rejects malformed, oversized and non-audio data',async()=>{
 const {readMobileAudio}=await import(modulePath);assert.deepEqual(await readMobileAudio(req()),mp4());
 for(const request of [req({'Content-Type':'application/json'}),req({'Content-Length':'3145729'}),req({},new Uint8Array(64)),req({},new Uint8Array(3145729))])await assert.rejects(readMobileAudio(request),e=>[400,413,415].includes(e.status));
});
test('Android uses Groq Whisper with a private immutable object and never sends server credentials to the provider',async()=>{
 const {createMobileVoice}=await import(modulePath),calls=[];
 const voice=createMobileVoice({url:'https://storage.invalid',serviceKey:'private-storage-key',groqApiKey:'private-groq-key',fetchImpl:async(url,init)=>{
  calls.push({url,init});if(url.includes('groq.com')){assert.equal(init.body.get('model'),'whisper-large-v3');assert.equal(init.body.get('language'),'ru');assert.equal(init.body.get('file').type,'audio/mp4');assert.equal(init.body.get('file').name,'voice.m4a');assert.equal(init.headers.Authorization,'Bearer private-groq-key');assert.equal(init.headers.apikey,undefined);return Response.json({text:'Завтра в 12 встреча с Антоном.'});}
  assert.equal(init.headers.Authorization,'Bearer private-storage-key');return new Response(init.method==='POST'?'{}':mp4());
 }});
 await voice.saveBytes(ID,mp4());assert.equal(calls[0].init.headers['x-upsert'],'false');
 assert.equal(await voice.transcribe({communicationId:ID}),'Завтра в 12 встреча с Антоном.');assert.equal(calls.length,3);assert.equal(voice.model,'groq/whisper-large-v3');
 await assert.rejects(voice.read({communicationId:'../other'}));assert.equal(calls.length,3);
});
test('missing key, unavailable Groq or quota errors never invoke a paid fallback',async()=>{
 const {createMobileVoice}=await import(modulePath);let calls=[];
 const missing=createMobileVoice({url:'https://storage.invalid',serviceKey:'storage',fetchImpl:async()=>{throw Error('must not fetch')}});
 await assert.rejects(missing.transcribe({communicationId:ID}),e=>e.safeCode==='voice_transcription_unavailable');
 for(const status of [401,429,500]){
  calls=[];const voice=createMobileVoice({url:'https://storage.invalid',serviceKey:'storage',groqApiKey:'groq',fetchImpl:async(url)=>{calls.push(url);return url.includes('groq.com')?new Response('secret provider failure',{status}):new Response(mp4());}});
  await assert.rejects(voice.transcribe({communicationId:ID}),e=>e.safeCode.startsWith('voice_transcription_')&&!e.message.includes('secret'));assert.equal(calls.length,2);assert.equal(calls.some(url=>url.includes('openrouter')),false);
 }
});
test('capture persists identity before upload or inference; repeats retrieve ready/processing/applied work',async()=>{
 const {createMobileCapture}=await import(modulePath);const calls=[];let status='captured';
 const store={rpc:async(name,args)=>{calls.push(['rpc',name,args]);return {item:{id:ID,revision:1,status}};}};
 const voice={saveBytes:async(id,bytes)=>{calls.push(['save',id,bytes.length]);}};
 const inbox={analyze:async(id,args)=>{calls.push(['analyze',id,args]);return {item:{id,status:'ready'}};},get:async id=>{calls.push(['get',id]);return {item:{id,status}};}};
 const capture=createMobileCapture({store,voice,inbox,now:()=>new Date(DATE)});
 assert.equal((await capture(req())).item.status,'ready');assert.deepEqual(calls.map(c=>c[0]),['rpc','save','analyze']);
 assert.equal(calls[0][2].p_bytes,64);assert.match(calls[0][2].p_audio_hash,/^[a-f0-9]{64}$/);assert.equal(calls[0][2].p_recorded_at,DATE);
 for(status of ['ready','processing','applied','deferred']){calls.length=0;await capture(req());assert.deepEqual(calls.map(c=>c[0]),['rpc','get']);}
});
test('changed retry identity is rejected before overwriting audio; failed upload never starts inference',async()=>{
 const {createMobileCapture}=await import(modulePath);let stored=0,analyzed=0;
 const inbox={analyze:async()=>{analyzed++;}},voice={saveBytes:async()=>{stored++;throw Error('storage unavailable');}};
 let capture=createMobileCapture({store:{rpc:async()=>{throw {code:'PT409'}}},voice,inbox,now:()=>new Date(DATE)});
 await assert.rejects(capture(req()),e=>e.safeCode==='mobile_capture_conflict');assert.equal(stored,0);assert.equal(analyzed,0);
 capture=createMobileCapture({store:{rpc:async()=>({item:{id:ID,revision:1,status:'captured'}})},voice,inbox,now:()=>new Date(DATE)});
 await assert.rejects(capture(req()));assert.equal(stored,1);assert.equal(analyzed,0);
 for(const headers of [{'X-Capture-ID':'../bad'},{'X-Audio-Seconds':'601'},{'X-Recorded-At':'2030-01-01T00:00:00Z'}])await assert.rejects(capture(req(headers)),e=>e.status===400);
});
test('mobile audio endpoint checks Google owner, PIN and origin before reading upload bytes',async()=>{
 const {createNotesHandler}=await import('../../supabase/functions/cos-notes/handler.mjs');
 const {withPinGate}=await import('../../supabase/functions/_shared/dashboard-pin.mjs');let captures=0,unlocked=false;
 const TOKEN='synthetic-cookie-0123456789012345678901234567';
 const store={rpc:async()=>({authenticated:true,unlocked,setupRequired:false}),list:async table=>table==='cos_calendar_connection'?[{google_sub:'owner'}]:[{google_sub:'owner',expires_at:'2027-01-01T00:00:00Z'}]};
 const handler=withPinGate(createNotesHandler({store,mobileCapture:async()=>{captures++;return {item:{id:ID}}},now:()=>new Date(DATE)}),{store});
 function request(owner=true,origin='https://nikodim.vercel.app'){return req({Origin:origin,...(owner?{Cookie:'__Host-cos-calendar-session='+TOKEN}:{})});}
 assert.equal((await handler(request(false))).status,401);assert.equal((await handler(request())).status,423);unlocked=true;
 assert.equal((await handler(request(true,'https://evil.invalid'))).status,403);assert.equal(captures,0);
 const result=await handler(request());assert.equal(result.status,200);assert.equal(captures,1);assert.deepEqual(await result.json(),{item:{id:ID}});
});
