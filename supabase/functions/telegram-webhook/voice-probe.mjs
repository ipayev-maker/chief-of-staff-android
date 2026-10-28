// Fixed synthetic speech only. No owner audio, business data or writes.
import {createVoiceAdapter,voiceConfiguration} from './voice.mjs';
import {audioBase64} from './voice-probe-fixture.mjs';
const ID='11111111-1111-4111-8111-111111111111';
const STORAGE='https://voice-probe.invalid/storage/v1/object/authenticated/cos-communication-audio/1/'+ID+'/voice.ogg';
const GROQ='https://api.groq.com/openai/v1/audio/transcriptions';
export async function probeVoice({groqApiKey,openRouterKey,transcriptionProvider,fetchImpl=fetch}={}){
  const started=Date.now();let model=null;
  try{
    const config=voiceConfiguration({groqApiKey,openRouterKey,transcriptionProvider});model=config.model;
    if(config.provider!=='groq'||!config.configured)return {status:'not_run',model,reason:'groq_required'};
    const adapter=createVoiceAdapter({url:'https://voice-probe.invalid',serviceKey:'synthetic-storage',groqApiKey,transcriptionProvider:'groq',fetchImpl:async(url,init)=>{
      if(url===STORAGE)return new Response(Uint8Array.from(atob(audioBase64),char=>char.charCodeAt(0)),{headers:{'Content-Type':'audio/ogg'}});
      if(url!==GROQ)throw Error('probe_unexpected_destination');
      return fetchImpl(url,init);
    }});
    const text=await adapter.transcribe({ownerId:1,communicationId:ID});
    const checks={meeting:/встреча/iu.test(text),person:/антон/iu.test(text),day:/завтра/iu.test(text),time:/двенадцать|12/u.test(text)};
    return {status:Object.values(checks).every(Boolean)?'passed':'failed',model,duration_ms:Date.now()-started,checks};
  }catch(error){
    // Never echo provider bodies, exception messages, audio or credentials.
    const code=error?.safeCode;
    return {status:'unavailable',model,duration_ms:Date.now()-started,error:typeof code==='string'&&/^voice_[a-z_]{1,60}$/.test(code)?code:'voice_probe_failed'};
  }
}
