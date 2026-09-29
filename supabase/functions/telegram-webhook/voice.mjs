// Telegram voice notes are stored privately before transcription. Native Web APIs
// only: Deno 2 / Node 24. Never return Telegram file URLs or log upstream bodies.
export const VOICE_MAX_BYTES=10*1024*1024;
export const VOICE_MAX_SECONDS=600;
const bad=code=>{throw Object.assign(new Error(code),{safeCode:code})};
const FILE_ID=/^[A-Za-z0-9_-]{1,512}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateVoice(voice){
  if(!voice||!FILE_ID.test(voice.file_id||''))bad('voice_invalid');
  if(!Number.isInteger(voice.duration)||voice.duration<0||voice.duration>VOICE_MAX_SECONDS)bad('voice_too_long');
  if(voice.file_size!==undefined&&(!Number.isSafeInteger(voice.file_size)||voice.file_size<=0||voice.file_size>VOICE_MAX_BYTES))bad('voice_too_large');
  if(voice.mime_type&&voice.mime_type!=='audio/ogg'&&voice.mime_type!=='audio/opus')bad('voice_format');
  return {file_id:voice.file_id,file_unique_id:typeof voice.file_unique_id==='string'?voice.file_unique_id.slice(0,256):null,duration:voice.duration,file_size:voice.file_size||null,mime_type:'audio/ogg'};
}
async function readBounded(response,max=VOICE_MAX_BYTES){
  if(!response.ok||!response.body)bad('voice_download_failed');
  if(Number(response.headers.get('content-length')||0)>max)bad('voice_too_large');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max){await reader.cancel();bad('voice_too_large')}chunks.push(value)}}finally{reader.releaseLock()}
  if(!size)bad('voice_empty');const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}return bytes;
}
function base64(bytes){let result='';for(let i=0;i<bytes.length;i+=32768)result+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(result)}
function validOgg(bytes){return bytes.length>=32&&bytes[0]===79&&bytes[1]===103&&bytes[2]===103&&bytes[3]===83}
export function createVoiceAdapter({url,serviceKey,botToken,openRouterKey,fetchImpl=fetch,bucket='cos-communication-audio'}){
  const base=String(url||'').replace(/\/$/,'');
  const privatePath=(owner,id)=>{if(!/^[1-9]\d*$/.test(String(owner))||!UUID.test(id||''))bad('voice_invalid_target');return String(owner)+'/'+id+'/voice.ogg'};
  const storageHeaders=()=>{if(!base||!serviceKey)bad('voice_storage_unavailable');return {apikey:serviceKey,Authorization:'Bearer '+serviceKey}};
  async function jsonRequest(target,body,headers,timeoutMs=10000){
    let response,data;try{response=await fetchImpl(target,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});data=await response.json()}catch{bad('voice_upstream_failed')}
    if(!response.ok)bad('voice_upstream_failed');return data;
  }
  return {
    async read({ownerId,communicationId}){
      const path=privatePath(ownerId,communicationId);let response;
      try{response=await fetchImpl(base+'/storage/v1/object/authenticated/'+bucket+'/'+path,{headers:storageHeaders(),redirect:'error',signal:AbortSignal.timeout(12000)})}catch{bad('voice_download_failed')}
      const bytes=await readBounded(response);if(!validOgg(bytes))bad('voice_format');
      return new Response(bytes,{headers:{'Content-Type':'audio/ogg','Content-Disposition':'inline; filename="voice.ogg"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
    },
    async save({ownerId,communicationId,voice}){
      const normalized=validateVoice(voice),path=privatePath(ownerId,communicationId);if(!botToken)bad('voice_unavailable');
      const file=await jsonRequest('https://api.telegram.org/bot'+botToken+'/getFile',{file_id:normalized.file_id},{});
      if(file?.ok!==true||!/^voice\/[A-Za-z0-9_\-./]+$/.test(file.result?.file_path||'')||file.result.file_path.includes('..')||file.result.file_path.includes('//'))bad('voice_download_failed');
      if(file.result.file_size>VOICE_MAX_BYTES)bad('voice_too_large');
      let response;try{response=await fetchImpl('https://api.telegram.org/file/bot'+botToken+'/'+file.result.file_path,{redirect:'error',signal:AbortSignal.timeout(12000)})}catch{bad('voice_download_failed')}
      const bytes=await readBounded(response);if(!validOgg(bytes))bad('voice_format');
      let saved;try{saved=await fetchImpl(base+'/storage/v1/object/'+bucket+'/'+path,{method:'POST',headers:{...storageHeaders(),'Content-Type':'audio/ogg','x-upsert':'true'},body:bytes,redirect:'error',signal:AbortSignal.timeout(12000)})}catch{bad('voice_storage_failed')}
      if(!saved.ok)bad('voice_storage_failed');
      return {bucket,path,mime_type:'audio/ogg',size_bytes:bytes.byteLength,duration_seconds:normalized.duration};
    },
    async transcribe({ownerId,communicationId}){
      if(!openRouterKey)bad('voice_transcription_unavailable');
      const path=privatePath(ownerId,communicationId);let response;
      try{response=await fetchImpl(base+'/storage/v1/object/authenticated/'+bucket+'/'+path,{headers:storageHeaders(),redirect:'error',signal:AbortSignal.timeout(12000)})}catch{bad('voice_download_failed')}
      const bytes=await readBounded(response);if(!validOgg(bytes))bad('voice_format');
      // Existing OpenRouter account; dedicated STT endpoint, no new SDK or key.
      // https://openrouter.ai/docs/api/api-reference/stt/create-transcription
      const data=await jsonRequest('https://openrouter.ai/api/v1/audio/transcriptions',{model:'openai/gpt-4o-mini-transcribe',input_audio:{data:base64(bytes),format:'ogg'},language:'ru',response_format:'json'},{Authorization:'Bearer '+openRouterKey},35000);
      const text=typeof data?.text==='string'?data.text.trim():'';if(!text)bad('voice_no_speech');if(text.length>20000)bad('voice_transcript_too_long');return text;
    }
  };
}
