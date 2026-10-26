import {safeEqual} from '../cos-google-calendar/google.mjs';
import {createStore} from '../cos-google-calendar/store.mjs';
// Legacy endpoints are server-only. A public/anon JWT is never authorization.
export function serveProtected(handler: (request: Request)=>Response|Promise<Response>, options={allowCron:false}){
 const serviceKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
 const store=options.allowCron?createStore({url:Deno.env.get('SUPABASE_URL'),serviceKey}):null;
 let cron='',expires=0;
 Deno.serve(async request=>{
  const bearer=request.headers.get('Authorization')?.match(/^Bearer ([^\s]{32,2048})$/)?.[1]||'';
  let allowed=!!serviceKey&&!!bearer&&safeEqual(bearer,serviceKey);
  if(!allowed&&bearer&&store){try{if(Date.now()>=expires){cron=(await store.rpc('cos_calendar_get_config',{})).cronSecret||'';expires=Date.now()+60000}allowed=!!cron&&safeEqual(bearer,cron)}catch{}}
  if(!allowed)return new Response(JSON.stringify({error:'unauthorized'}),{status:401,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  return handler(request);
 });
}
