import {GROQ_TRANSCRIPTION_MODEL} from '../telegram-webhook/voice.mjs';
const MAX_BYTES=3*1024*1024,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=(code,status=503)=>{throw Object.assign(Error(code),{safeCode:code,status,code})};
export async function readMobileAudio(request){
  if((request.headers.get('Content-Type')||'').split(';')[0]!=='audio/mp4')fail('voice_format',415);
  if(Number(request.headers.get('Content-Length')||0)>MAX_BYTES)fail('voice_too_large',413);
  const reader=request.body?.getReader();if(!reader)fail('voice_empty',400);
  let size=0,timer;const parts=[];
  try{await Promise.race([(async()=>{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_BYTES)fail('voice_too_large',413);parts.push(value)}})(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('voice_upload_timeout'),{safeCode:'voice_upload_timeout',status:408,code:'voice_upload_timeout'})),20000)})]);}
  finally{clearTimeout(timer);void reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  if(bytes.length<32||String.fromCharCode(...bytes.subarray(4,8))!=='ftyp')fail('voice_format',400);
  return bytes;
}
export function createMobileVoice({url,serviceKey,groqApiKey,fetchImpl=fetch}){
  const base=String(url).replace(/\/$/,''),bucket='cos-communication-audio';
  const path=id=>{if(!UUID.test(id||''))fail('voice_invalid_target',400);return 'android/'+id.toLowerCase()+'/voice.m4a';};
  const headers=()=>({apikey:serviceKey,Authorization:'Bearer '+serviceKey});
  async function request(url,init,stage){
    let response;try{response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(35000),...init});}catch(error){fail(stage+(['TimeoutError','AbortError'].includes(error?.name)?'_timeout':'_network_error'));}
    if(!response.ok)fail(stage+'_'+({401:'unauthorized',403:'forbidden',404:'not_found',429:'rate_limited',413:'too_large'}[response.status]||'failed'));
    return response;
  }
  return {
    model:'groq/'+GROQ_TRANSCRIPTION_MODEL,
    async saveBytes(id,bytes){
      const response=await fetchImpl(base+'/storage/v1/object/'+bucket+'/'+path(id),{method:'POST',headers:{...headers(),'Content-Type':'audio/mp4','x-upsert':'false'},body:bytes,redirect:'error',signal:AbortSignal.timeout(20000)});
      // Uploads are immutable. The capture RPC already checked the retry hash.
      if(!response.ok){let code='';try{code=String((await response.json()).statusCode||'');}catch{}if(response.status!==409&&code!=='409')fail('voice_storage_write_failed');}
    },
    async read({communicationId}){
      const response=await request(base+'/storage/v1/object/authenticated/'+bucket+'/'+path(communicationId),{headers:headers()},'voice_storage_read');
      return new Response(response.body,{headers:{'Content-Type':'audio/mp4','Content-Disposition':'inline; filename="voice.m4a"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
    },
    async transcribe({communicationId}){
      if(!groqApiKey)fail('voice_transcription_unavailable');
      const response=await this.read({communicationId}),bytes=await readMobileAudio(response);
      const body=new FormData();body.set('file',new Blob([bytes],{type:'audio/mp4'}),'voice.m4a');body.set('model',GROQ_TRANSCRIPTION_MODEL);body.set('language','ru');body.set('temperature','0');body.set('response_format','json');
      const reply=await request('https://api.groq.com/openai/v1/audio/transcriptions',{method:'POST',headers:{Authorization:'Bearer '+groqApiKey},body},'voice_transcription');
      let data;try{data=await reply.json();}catch{fail('voice_transcription_invalid_response');}
      const text=typeof data?.text==='string'?data.text.trim():'';
      if(!text)fail('voice_no_speech');if(text.length>20000)fail('voice_transcript_too_long');return text;
    }
  };
}
export function createMobileCapture({store,inbox,voice,now=()=>new Date()}){
  return async request=>{
    const id=request.headers.get('X-Capture-ID'),duration=request.headers.get('X-Audio-Seconds'),recorded=request.headers.get('X-Recorded-At');
    if(!UUID.test(id||'')||!/^\d{1,3}$/.test(duration||'')||+duration<1||+duration>600||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(recorded||'')||!Number.isFinite(Date.parse(recorded))||Date.parse(recorded)>+now()+300000)fail('invalid_mobile_audio',400);
    const bytes=await readMobileAudio(request),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
    let saved;try{saved=await store.rpc('cos_inbox_capture_android',{p_id:id.toLowerCase(),p_audio_hash:hash,p_bytes:bytes.length,p_seconds:+duration,p_recorded_at:recorded});}catch(error){if(['PT400','PT409','PT410'].includes(error?.code))fail('mobile_capture_conflict',Number(error.code.slice(2)));throw error;}
    if(['ready','applied','deferred','processing'].includes(saved.item.status))return inbox.get(saved.item.id);
    await voice.saveBytes(saved.item.id,bytes);
    try{return await inbox.analyze(saved.item.id,{revision:saved.item.revision});}catch(error){if(error?.status===409)return inbox.get(saved.item.id);throw error;}
  };
}
