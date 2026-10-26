import {ownerSession,validBrowserRequest,PRIVATE_HEADERS,SESSION_COOKIE} from '../_shared/owner-session.mjs';
import {pinStatus,pinCookie,pinProof} from '../_shared/dashboard-pin.mjs';
import {randomToken,sha256} from '../cos-google-calendar/google.mjs';
const TABLES=new Set(['projects','commitments','participants','cos_areas','meetings','meeting_participants','meeting_minutes','project_notes','note_assets','commitment_assets','time_entries','commitment_links','project_task_layout']);
const FUNCTIONS=new Set(['cos-capture-chat','cos-meeting-minutes']);
const BUCKETS=new Set(['project-media','cos-note-media']);
const MEDIA_TYPES=new Set(['image/jpeg','image/png','image/webp','image/gif','application/pdf','audio/mpeg','audio/mp4','audio/wav','audio/ogg','audio/webm','video/mp4','video/webm','video/quicktime']);
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{...PRIVATE_HEADERS,'Content-Type':'application/json; charset=utf-8'}});
const failure=(status,code)=>{throw Object.assign(Error(code),{status,code})};
function resource(url){
 let path=url.pathname.replace(/^\/(?:functions\/v1\/cos-dashboard|cos-dashboard|api\/data)(?=\/|$)/,'');
 if(url.pathname==='/api/session')path='/session';
 if(url.pathname==='/api/session/logout')path='/logout';
 if(url.pathname.startsWith('/api/session/pin/'))path=url.pathname.slice('/api/session'.length);
 if(!path.startsWith('/')||/%|\\|[\x00-\x20]/.test(path)){
  try{path=decodeURIComponent(path)}catch{failure(400,'invalid_path')}
 }
 if(!path.startsWith('/')||path.includes('\\')||path.includes('%')||/[\x00-\x1f]/.test(path)||path.split('/').some(p=>p==='.'||p==='..'))failure(400,'invalid_path');
 return path;
}
async function boundedBody(request,maxBytes){
 const length=request.headers.get('Content-Length');if(length&&(!/^\d+$/.test(length)||+length>maxBytes))failure(413,'request_too_large');
 if(!request.body)return undefined;
 const reader=request.body.getReader(),parts=[];let size=0,timer;
 try{return await Promise.race([(async()=>{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes)failure(413,'request_too_large');parts.push(value)}const result=new Uint8Array(size);let pos=0;for(const p of parts){result.set(p,pos);pos+=p.length}return result})(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('request_timeout'),{status:408,code:'request_timeout'})),15000)})])}
 finally{clearTimeout(timer);void reader.cancel().catch(()=>{})}
}
export function createDashboardHandler({store,url,serviceKey,fetchImpl=fetch,now=()=>new Date()}){
 const base=new URL(url);if(base.protocol!=='https:'||base.username||base.password||!serviceKey)throw Error('invalid_dashboard_config');
 return async request=>{
  try{
   const input=new URL(request.url),path=resource(input);
   if(!validBrowserRequest(request))return json({error:'invalid_origin'},403);
   const session=await ownerSession(store,request,now);
   if(path==='/session'&&request.method==='GET'){
    if(!session)return json({authenticated:false});
    const state=await pinStatus(store,request);
    if(!state.authenticated)return json({authenticated:false});
    return json({authenticated:true,email:session.email,pinRequired:!state.unlocked,pinSetupRequired:state.setupRequired,retryAfter:state.retryAfter||0});
   }
   if(!session)return json({error:'unauthorized'},401);
   if(path==='/logout'&&request.method==='POST'){
    await store.remove('cos_calendar_sessions','token_hash=eq.'+session.tokenHash);
    const response=json({ok:true});response.headers.append('Set-Cookie',SESSION_COOKIE+'=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0');response.headers.append('Set-Cookie',pinCookie(''));return response;
   }
   if(path==='/pin/lock'&&request.method==='POST'){
    await store.remove('cos_dashboard_pin_sessions','session_hash=eq.'+session.tokenHash);
    const response=json({ok:true});response.headers.set('Set-Cookie',pinCookie(''));return response;
   }
   if(['/pin/setup','/pin/unlock'].includes(path)&&request.method==='POST'){
    if(input.search||(request.headers.get('Content-Type')||'').split(';')[0]!=='application/json')failure(400,'invalid_pin');
    let data;try{data=JSON.parse(new TextDecoder().decode(await boundedBody(request,256)))}catch(error){if(error.status)throw error;failure(400,'invalid_pin')}
    const setup=path==='/pin/setup';
    if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!['pin',...(setup?['confirmation']:[])].includes(k))||typeof data.pin!=='string'||!/^\d{4}$/.test(data.pin)||setup&&data.confirmation!==data.pin)failure(400,'invalid_pin');
    const config=await store.rpc('cos_calendar_get_config',{}),token=randomToken();
    const result=await store.rpc('cos_dashboard_pin_unlock',{p_session_hash:session.tokenHash,p_proof:await pinProof(data.pin,config?.tokenKey),p_unlock_hash:await sha256(token),p_setup:setup});
    if(result?.ok!==true){
     const status={unauthorized:401,pin_incorrect:400,pin_locked:429,pin_already_configured:409,pin_setup_required:409,invalid_pin:400}[result?.error];
     if(!status)failure(503,'pin_unavailable');
     const response=json({error:result.error,...(result.retryAfter?{retryAfter:result.retryAfter}:{})},status);
     if(result.retryAfter)response.headers.set('Retry-After',String(result.retryAfter));return response;
    }
    const response=json({ok:true});response.headers.set('Set-Cookie',pinCookie(token));return response;
   }
   const pin=await pinStatus(store,request);
   if(!pin.authenticated)return json({error:'unauthorized'},401);
   if(!pin.unlocked)return json({error:'pin_required',setupRequired:pin.setupRequired},423);
   let target,storage=false;
   const rest=/^\/rest\/v1\/([a-z_]+)$/.exec(path),fn=/^\/(?:ai|functions\/v1)\/([a-z-]+)$/.exec(path);
   if(rest&&TABLES.has(rest[1])&&['GET','HEAD','POST','PATCH','DELETE'].includes(request.method)){
    target=path+input.search;
   }else if(fn&&FUNCTIONS.has(fn[1])&&request.method==='POST'){
    if(input.search)failure(400,'invalid_request');target='/functions/v1/'+fn[1];
   }else{
    const file=/^\/storage\/v1\/object\/(sign\/|authenticated\/|upload\/sign\/)?([^/]+)\/(.+)$/.exec(path);
    if(!file||!BUCKETS.has(file[2]))return json({error:'not_found'},404);
    const [,operation='',bucket,name]=file;storage=true;
    if(!name||name.length>1500||name.split('/').some(p=>!p||p==='.'||p==='..'))failure(400,'invalid_path');
    const encoded=bucket+'/'+name.split('/').map(encodeURIComponent).join('/');
    // Keep media behind the owner session. Do not issue bearer download URLs.
    if(operation==='sign/'&&request.method==='POST')return json({signedURL:'/storage/v1/object/authenticated/'+encoded});
    if(['authenticated/','sign/'].includes(operation)&&['GET','HEAD'].includes(request.method))target='/storage/v1/object/authenticated/'+encoded;
    else if(!operation&&['POST','PUT'].includes(request.method))target='/storage/v1/object/'+encoded;
    else if(operation==='upload/sign/'&&request.method==='PUT')target='/storage/v1/object/'+encoded;
    else return json({error:'method_not_allowed'},405);
   }
   if(storage&&!['GET','HEAD'].includes(request.method)&&!MEDIA_TYPES.has((request.headers.get('Content-Type')||'').split(';')[0].trim()))failure(415,'unsupported_media_type');
   const headers=new Headers({apikey:serviceKey,Authorization:'Bearer '+serviceKey});
   for(const key of ['Content-Type','Prefer','Range','If-None-Match','If-Modified-Since','x-upsert'])if(request.headers.has(key))headers.set(key,request.headers.get(key));
   if(rest){headers.set('Accept-Profile','public');headers.set('Content-Profile','public')}
   const body=['GET','HEAD'].includes(request.method)?undefined:await boundedBody(request,storage?50*1024*1024:512*1024);
   const result=await fetchImpl(new URL(target,base),{method:request.method,headers,body,redirect:'error',signal:AbortSignal.timeout(90000)});
   const responseHeaders=new Headers(PRIVATE_HEADERS);
   for(const key of ['Content-Type','Content-Range','Accept-Ranges','Content-Disposition','ETag'])if(result.headers.has(key))responseHeaders.set(key,result.headers.get(key));
   if(storage&&result.ok&&!MEDIA_TYPES.has((responseHeaders.get('Content-Type')||'').split(';')[0].trim())){responseHeaders.set('Content-Type','application/octet-stream');responseHeaders.set('Content-Disposition','attachment')}
   return new Response(result.body,{status:result.status,headers:responseHeaders});
  }catch(error){return json({error:error.status&&error.code?error.code:'dashboard_unavailable'},error.status||503)}
 };
}
