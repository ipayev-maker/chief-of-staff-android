import {sha256} from '../cos-google-calendar/google.mjs';
export const SESSION_COOKIE='__Host-cos-calendar-session';
export const TRUSTED_ORIGINS=new Set(['https://nikodim.vercel.app','https://chief-of-staff-v3-live.vercel.app']);
export const PRIVATE_HEADERS={'Cache-Control':'private, no-store, max-age=0','Pragma':'no-cache','Vary':'Cookie','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
export function sessionToken(request){
 const parts=(request.headers.get('Cookie')||'').split(';').map(p=>p.trim()).filter(p=>p.startsWith(SESSION_COOKIE+'='));
 const token=parts.length===1?parts[0].slice(SESSION_COOKIE.length+1):'';
 return /^[A-Za-z0-9_-]{32,200}$/.test(token)?token:null;
}
export async function ownerSession(store,request,now=()=>new Date()){
 const token=sessionToken(request);if(!token)return null;
 const tokenHash=await sha256(token);
 const [owners,sessions]=await Promise.all([
  store.list('cos_calendar_connection','select=google_sub,email&id=eq.owner'),
  store.list('cos_calendar_sessions','select=google_sub,expires_at&token_hash=eq.'+tokenHash+'&expires_at=gt.'+encodeURIComponent(now().toISOString()))
 ]);
 if(!owners.length)owners.push(...await store.page('cos_gmail_connection','select=google_sub,email&id=eq.owner&limit=1'));
 if(owners.length!==1||sessions.length!==1||!owners[0]?.google_sub||sessions[0].google_sub!==owners[0].google_sub||!(Date.parse(sessions[0].expires_at)>now().getTime()))return null;
 return {tokenHash,email:owners[0].email||null};
}
export function validBrowserRequest(request){
 const origin=request.headers.get('Origin');
 if(origin&&!TRUSTED_ORIGINS.has(origin))return false;
 if(request.headers.get('Sec-Fetch-Site')==='cross-site')return false;
 return ['GET','HEAD'].includes(request.method)||!!origin&&TRUSTED_ORIGINS.has(origin);
}
