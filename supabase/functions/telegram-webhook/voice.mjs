// Telegram voice notes are stored privately before transcription. Native Web APIs
// only: Deno 2 / Node 24. Never return Telegram file URLs or log upstream bodies.
export const VOICE_MAX_BYTES=10*1024*1024;
export const VOICE_MAX_SECONDS=600;
const bad=code=>{throw Object.assign(new Error(code),{safeCode:code})};
const FILE_ID=/^[A-Za-z0-9_-]{1,512}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Only bounded, locally defined diagnostics are persisted. Upstream response
// bodies and exception messages can contain private text or credential URLs.
const HTTP_FAILURE={400:'bad_request',401:'unauthorized',402:'payment_required',403:'forbidden',404:'not_found',408:'timeout',413:'too_large',415:'unsupported_media',422:'invalid_input',429:'rate_limited'};
const httpFailure=(stage,status)=>bad(stage+'_'+(HTTP_FAILURE[status]||(status>=500&&status<=599?'server_error':'http_error')));
const transportFailure=(stage,error)=>bad(stage+'_'+(['TimeoutError','AbortError'].includes(error?.name)?'timeout':'network_error'));
function validTelegramPath(path){
  // getFile promises a relative file_path, not a particular directory name.
  return typeof path==='string'&&path.length<=1024&&/^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/.test(path)&&!path.includes('..');
}
export function validateVoice(voice){
  if(!voice||!FILE_ID.test(voice.file_id||''))bad('voice_invalid');
  if(!Number.isInteger(voice.duration)||voice.duration<0||voice.duration>VOICE_MAX_SECONDS)bad('voice_too_long');
  if(voice.file_size!==undefined&&(!Number.isSafeInteger(voice.file_size)||voice.file_size<=0||voice.file_size>VOICE_MAX_BYTES))bad('voice_too_large');
  if(voice.mime_type&&voice.mime_type!=='audio/ogg'&&voice.mime_type!=='audio/opus')bad('voice_format');
  return {file_id:voice.file_id,file_unique_id:typeof voice.file_unique_id==='string'?voice.file_unique_id.slice(0,256):null,duration:voice.duration,file_size:voice.file_size||null,mime_type:'audio/ogg'};
}
async function readBounded(response,stage,max=VOICE_MAX_BYTES){
  if(!response.ok)httpFailure(stage,response.status);
  if(!response.body)bad(stage+'_empty_response');
  if(Number(response.headers.get('content-length')||0)>max)bad('voice_too_large');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max){await reader.cancel();bad('voice_too_large')}chunks.push(value)}}catch(error){if(error?.safeCode)throw error;transportFailure(stage,error)}finally{reader.releaseLock()}
  if(!size)bad('voice_empty');const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}return bytes;
}
function base64(bytes){let result='';for(let i=0;i<bytes.length;i+=32768)result+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(result)}
function validOgg(bytes){return bytes.length>=32&&bytes[0]===79&&bytes[1]===103&&bytes[2]===103&&bytes[3]===83}
export function createVoiceAdapter({url,serviceKey,botToken,openRouterKey,fetchImpl=fetch,bucket='cos-communication-audio'}){
  const base=String(url||'').replace(/\/$/,'');
  const privatePath=(owner,id)=>{if(!/^[1-9]\d*$/.test(String(owner))||!UUID.test(id||''))bad('voice_invalid_target');return String(owner)+'/'+id+'/voice.ogg'};
  const storageHeaders=()=>{if(!base||!serviceKey)bad('voice_storage_unavailable');return {apikey:serviceKey,Authorization:'Bearer '+serviceKey}};
  async function request(target,init,stage){
    let response;try{response=await fetchImpl(target,init)}catch(error){transportFailure(stage,error)}
    if(!response.ok)httpFailure(stage,response.status);return response;
  }
  async function jsonRequest(target,body,headers,stage,timeoutMs=10000){
    const response=await request(target,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)},stage);
    try{return await response.json()}catch(error){if(['TimeoutError','AbortError'].includes(error?.name))transportFailure(stage,error);bad(stage+'_invalid_response')}
  }
  return {
    async read({ownerId,communicationId}){
      const path=privatePath(ownerId,communicationId);
      const response=await request(base+'/storage/v1/object/authenticated/'+bucket+'/'+path,{headers:storageHeaders(),redirect:'error',signal:AbortSignal.timeout(12000)},'voice_storage_read');
      const bytes=await readBounded(response,'voice_storage_read');if(!validOgg(bytes))bad('voice_format');
      return new Response(bytes,{headers:{'Content-Type':'audio/ogg','Content-Disposition':'inline; filename="voice.ogg"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
    },
    async save({ownerId,communicationId,voice}){
      const normalized=validateVoice(voice),path=privatePath(ownerId,communicationId);if(!botToken)bad('voice_unavailable');
      const file=await jsonRequest('https://api.telegram.org/bot'+botToken+'/getFile',{file_id:normalized.file_id},{},'voice_telegram_file');
      if(file?.ok!==true){if(Number.isInteger(file?.error_code)&&file.error_code>=400&&file.error_code<=599)httpFailure('voice_telegram_file',file.error_code);bad('voice_telegram_file_invalid_response')}
      if(!validTelegramPath(file.result?.file_path))bad('voice_telegram_file_invalid_path');
      if(file.result.file_size>VOICE_MAX_BYTES)bad('voice_too_large');
      const response=await request('https://api.telegram.org/file/bot'+botToken+'/'+file.result.file_path,{redirect:'error',signal:AbortSignal.timeout(12000)},'voice_telegram_download');
      const bytes=await readBounded(response,'voice_telegram_download');if(!validOgg(bytes))bad('voice_format');
      await request(base+'/storage/v1/object/'+bucket+'/'+path,{method:'POST',headers:{...storageHeaders(),'Content-Type':'audio/ogg','x-upsert':'true'},body:bytes,redirect:'error',signal:AbortSignal.timeout(12000)},'voice_storage_write');
      return {bucket,path,mime_type:'audio/ogg',size_bytes:bytes.byteLength,duration_seconds:normalized.duration};
    },
    async transcribe({ownerId,communicationId}){
      if(!openRouterKey)bad('voice_transcription_unavailable');
      const path=privatePath(ownerId,communicationId);
      const response=await request(base+'/storage/v1/object/authenticated/'+bucket+'/'+path,{headers:storageHeaders(),redirect:'error',signal:AbortSignal.timeout(12000)},'voice_storage_read');
      const bytes=await readBounded(response,'voice_storage_read');if(!validOgg(bytes))bad('voice_format');
      // Existing OpenRouter account; dedicated STT endpoint, no new SDK or key.
      // https://openrouter.ai/docs/api/api-reference/stt/create-transcription
      const data=await jsonRequest('https://openrouter.ai/api/v1/audio/transcriptions',{model:'openai/gpt-4o-mini-transcribe',input_audio:{data:base64(bytes),format:'ogg'},language:'ru',response_format:'json'},{Authorization:'Bearer '+openRouterKey},'voice_transcription',35000);
      const text=typeof data?.text==='string'?data.text.trim():'';if(!text)bad('voice_no_speech');if(text.length>20000)bad('voice_transcript_too_long');return text;
    }
  };
}
