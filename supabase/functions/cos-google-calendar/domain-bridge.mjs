// One-time browser-bound login handoff. Google's registered callback stays on
// the original domain; neither session tokens nor credentials enter URLs.
import {APP_ORIGIN,randomToken,sha256,encryptSecret,decryptSecret} from './google.mjs';
export const PUBLIC_ORIGIN='https://nikodim.vercel.app';
export const ANDROID_RETURN='/android';
export const allowedOrigin=origin=>[APP_ORIGIN,PUBLIC_ORIGIN].includes(origin);
const TABLE='cos_auth_transfers',COOKIE='__Host-cos-auth-transfer';
const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
const cookie=(name,value,age)=>`${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
const eq=(key,value)=>key+'=eq.'+encodeURIComponent(value);
export const validChallenge=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function redirect(url,cookies=[]){const h=new Headers({...headers,Location:url});for(const c of cookies)h.append('Set-Cookie',c);return new Response(null,{status:303,headers:h})}
export async function beginTransfer(service,params={}){
  const verifier=randomToken(),url=new URL(APP_ORIGIN+'/api/'+(service==='gmail'?'gmail':'google-calendar')+'/bridge-start');
  url.searchParams.set('challenge',await sha256(verifier));
  for(const [key,value]of Object.entries(params))if(value)url.searchParams.set(key,value);
  return redirect(url.href,[cookie(COOKIE,verifier,600)]);
}
export async function issueTransfer({store,config,now,session,challenge,service,returnTo}){
  if(!validChallenge(challenge))throw Error('invalid_transfer');
  const code=randomToken();
  await store.remove(TABLE,'expires_at=lt.'+encodeURIComponent(now().toISOString()));
  await store.insert(TABLE,{code_hash:await sha256(code),browser_hash:challenge,session_cipher:await encryptSecret(session,config.tokenKey),service,return_to:returnTo||null,expires_at:new Date(+now()+120000).toISOString()});
  // Only an opaque, one-use, PKCE-bound code enters the Android deep link.
  // The session remains encrypted until the initiating app proves its verifier.
  return (service==='calendar'&&returnTo===ANDROID_RETURN?'ru.ipayev.chiefofstaff://auth':'https://nikodim.vercel.app/api/google-calendar/bridge-finish')+'?code='+encodeURIComponent(code);
}
export async function finishTransfer({request,store,config,now}){
  const code=new URL(request.url).searchParams.get('code'),verifier=(request.headers.get('Cookie')||'').split(';').map(v=>v.trim().split('=')).find(v=>v[0]===COOKIE)?.[1];
  const cleared=cookie(COOKIE,'',0),failure=()=>redirect(PUBLIC_ORIGIN+'/?calendar=error&reason=invalid_state',[cleared]);
  if(!code||code.length>200||!verifier||verifier.length>200)return failure();
  const rows=await store.remove(TABLE,eq('code_hash',await sha256(code))+'&'+eq('browser_hash',await sha256(verifier))+'&expires_at=gt.'+encodeURIComponent(now().toISOString()));
  if(rows.length!==1)return failure();
  const row=rows[0],session=await decryptSecret(row.session_cipher,config.tokenKey);
  const url=new URL(PUBLIC_ORIGIN+'/');url.searchParams.set(row.service==='gmail'?'gmail':'calendar','connected');
  if(/^\/#\/inbox(?:\/[a-f0-9-]{36})?$/.test(row.return_to||''))url.hash=row.return_to.slice(1);
  return redirect(url.href,[cleared,cookie('__Host-cos-calendar-session',session,30*86400)]);
}
