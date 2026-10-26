import {sessionToken,validBrowserRequest,PRIVATE_HEADERS} from './owner-session.mjs';
import {sha256} from '../cos-google-calendar/google.mjs';
export const PIN_COOKIE='__Host-cos-pin-session';
export const pinCookie=value=>`${PIN_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict${value?'':'; Max-Age=0'}`;
export function pinToken(request){
 const values=(request.headers.get('Cookie')||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(PIN_COOKIE+'='));
 const value=values.length===1?values[0].slice(PIN_COOKIE.length+1):'';
 return /^[A-Za-z0-9_-]{32,200}$/.test(value)?value:null;
}
export async function pinStatus(store,request){
 const session=sessionToken(request);if(!session)return {authenticated:false};
 const unlock=pinToken(request),result=await store.rpc('cos_dashboard_pin_status',{p_session_hash:await sha256(session),p_unlock_hash:unlock?await sha256(unlock):null});
 if(!result||typeof result.authenticated!=='boolean'||result.authenticated&&(typeof result.unlocked!=='boolean'||typeof result.setupRequired!=='boolean'))throw Error('pin_unavailable');
 return result;
}
export async function pinProof(pin,key){
 if(typeof key!=='string'||key.length<32)throw Error('pin_unavailable');
 const encoder=new TextEncoder(),hmac=await crypto.subtle.importKey('raw',encoder.encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',hmac,encoder.encode('cos-dashboard-pin-v1:'+pin))),b=>b.toString(16).padStart(2,'0')).join('');
}
const json=(data,status)=>new Response(JSON.stringify(data),{status,headers:{...PRIVATE_HEADERS,'Content-Type':'application/json; charset=utf-8'}});
function googleEntry(request){
 const url=new URL(request.url);let path=url.pathname.replace(/^\/(?:functions\/v1\/cos-google-calendar|cos-google-calendar|api\/google-calendar)(?=\/|$)/,'').replace(/^\/api\/gmail(?=\/|$)/,'/gmail');
 // These handlers retain their own OAuth state / cron-secret verification.
 return request.method==='GET'&&['/callback','/bridge-start','/bridge-finish','/gmail/callback','/gmail/bridge-start'].includes(path)||request.method==='POST'&&['/start','/gmail/start','/tick','/gmail/tick','/gmail/health'].includes(path);
}
export function withPinGate(handler,{store,google=false}){
 return async request=>{
  if(google&&googleEntry(request))return handler(request);
  try{
   if(!validBrowserRequest(request))return json({error:'invalid_origin'},403);
   const status=await pinStatus(store,request);
   if(!status.authenticated)return json({error:'unauthorized'},401);
   if(!status.unlocked)return json({error:'pin_required',setupRequired:status.setupRequired},423);
   return await handler(request);
  }catch{return json({error:'pin_unavailable'},503)}
 };
}
