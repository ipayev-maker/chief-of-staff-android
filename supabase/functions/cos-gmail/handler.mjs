import {PUBLIC_ORIGIN,allowedOrigin,validChallenge,beginTransfer,issueTransfer} from '../cos-google-calendar/domain-bridge.mjs';
import {APP_ORIGIN,randomToken,sha256,encryptSecret,decryptSecret,safeEqual} from '../cos-google-calendar/google.mjs';
import {DEFAULT_SETTINGS,settings,validId} from './mail.mjs';
import {createMailClient} from './client.mjs';
import {syncMail} from './sync.mjs';
const C='cos_gmail_connection',STATES='cos_gmail_oauth_states',FLOW='__Host-cos-gmail-flow',SESSION='__Host-cos-calendar-session';
const eq=(k,v)=>k+'=eq.'+encodeURIComponent(v);
const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{...headers,'Content-Type':'application/json; charset=utf-8'}});
const cookie=(name,value,age)=>`${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
const readCookie=(r,name)=>(r.headers.get('Cookie')||'').split(';').map(v=>v.trim().split('=')).find(v=>v[0]===name)?.[1]||'';
function redirect(result,reason,cookies=[]){const h=new Headers({...headers,Location:`${APP_ORIGIN}/?gmail=${result}${reason?'&reason='+encodeURIComponent(reason):''}#/inbox`});for(const c of cookies)h.append('Set-Cookie',c);return new Response(null,{status:303,headers:h})}
const knownErrors=new Set(['invalid_grant','invalid_client','unauthorized_client','missing_required_scopes','accessNotConfigured','insufficientPermissions','rateLimitExceeded','userRateLimitExceeded','invalid_settings','scope_required','invalid_depth','thread_review_pending','gmail_network_error','mail_too_large','import_paused','analysis_consent_required','mail_delivery_failed']);
const reason=e=>knownErrors.has(e?.reason||e?.message)?e.reason||e.message:['STORE_TIMEOUT','STORE_NETWORK'].includes(e?.code)?'gmail_temporarily_unavailable':'gmail_request_failed';
export function createGmailHandler({store,google,config,now=()=>new Date(),mailFactory=createMailClient,analyze,recover,deliver,health,logger=console}){
  // Allowlisted metadata only: never log request URLs, cookies, tokens,
  // exception messages/stacks or provider/database response bodies.
  function report(error,stage){
    const code=typeof error?.code==='string'&&/^(?:[0-9A-Z]{5}|PGRST\d{3}|STORE_[A-Z_]+)$/.test(error.code)?error.code:reason(error);
    try{logger.error(JSON.stringify({component:'gmail',stage,code,status:Number.isInteger(error?.status)?error.status:0}))}catch{}
  }
  const stamp=()=>now().toISOString();
  const current=async()=> (await store.page(C,'id=eq.owner&limit=1'))[0]||null;
  async function authorized(request,connection){
    const token=readCookie(request,SESSION);if(!token||token.length>200)return false;
    // Match the shared app-session identity used by Calendar and Notes.
    // The connected mailbox is a source, not necessarily the calendar account.
    const owner=(await store.page('cos_calendar_connection','select=google_sub&id=eq.owner&limit=1'))[0]||connection;
    if(!owner)return false;
    const session=(await store.page('cos_calendar_sessions',eq('token_hash',await sha256(token))+'&expires_at=gt.'+encodeURIComponent(stamp())+'&limit=1'))[0];
    return !!session&&session.google_sub===owner.google_sub;
  }
  async function locked(fn){const holder=randomToken();if(await store.rpc('cos_gmail_claim_lock',{p_holder:holder,p_seconds:180})!==true)return json({error:'connection_busy'},409);try{return await fn()}finally{await store.rpc('cos_gmail_release_lock',{p_holder:holder}).catch(()=>{})}}
  async function mail(connection){
    if(!connection?.refresh_token_cipher||connection.status!=='connected')throw Error('invalid_grant');
    const tokens=await google.refresh(await decryptSecret(connection.refresh_token_cipher,config.tokenKey));
    if(tokens.refresh_token)await store.patch(C,'id=eq.owner',{refresh_token_cipher:await encryptSecret(tokens.refresh_token,config.tokenKey)});
    return mailFactory(tokens.access_token);
  }
  async function sync(connection){
    if(!connection?.settings?.enabled)return json({ok:false,reason:'import_paused'});
    try{
      // Owner-requested reload runs with the backend's real service identity,
      // preserving the note-deletion guard and atomic processed-ID receipts.
      if(connection.settings.reset_week===true){await store.rpc('cos_gmail_reset_week',{});connection=await current();}
      const result=await syncMail({store,mail:await mail(connection),connection,now,analyze,recover,deliver});
      await store.patch(C,'id=eq.owner',{last_sync_at:stamp(),last_error:null});return json(result);
    }catch(error){report(error,'sync');const code=reason(error);await store.patch(C,'id=eq.owner',{last_error:code,...(error.status===401||code==='invalid_grant'?{status:'needs_reconnect'}:{})});return json({ok:false,reason:code});}
  }
  async function callback(request,url){
    const cleared=cookie(FLOW,'',0),state=url.searchParams.get('state'),browser=readCookie(request,FLOW);
    if(!state?.startsWith('gmail.')||state.length>200||!browser||browser.length>200)return redirect('error','invalid_state',[cleared]);
    const states=await store.remove(STATES,eq('state_hash',await sha256(state))+'&'+eq('browser_hash',await sha256(browser))+'&expires_at=gt.'+encodeURIComponent(stamp()));
    if(states.length!==1)return redirect('error','invalid_state',[cleared]);
    if(url.searchParams.has('error'))return redirect('error','denied',[cleared]);
    const code=url.searchParams.get('code');if(!code||code.length>4096)return redirect('error','oauth_failed',[cleared]);
    const result=await locked(async()=>{
      let stage='exchange_code';
      try{
        const tokens=await google.exchangeCode({code,verifier:states[0].verifier});stage='verify_identity';
        const identity=await google.userInfo(tokens.access_token);stage='read_owner';
        const existing=await current(),calendar=(await store.page('cos_calendar_connection','select=google_sub&id=eq.owner&limit=1'))[0];
        if(!identity.email_verified||identity.email.toLowerCase()!==config.allowedEmail.trim().toLowerCase()||existing&&existing.google_sub!==identity.sub)return redirect('error','wrong_account',[cleared]);
        const cipher=tokens.refresh_token?await encryptSecret(tokens.refresh_token,config.tokenKey):existing?.refresh_token_cipher;
        if(!cipher)return redirect('error','refresh_token_missing',[cleared]);
        stage='save_connection';
        await store.upsert(C,{id:'owner',google_sub:identity.sub,email:identity.email,refresh_token_cipher:cipher,status:'connected',settings:existing?.settings||DEFAULT_SETTINGS,cursor:existing?.cursor||{},last_error:null},'id');
        stage='create_session';
        // Exact verified mailbox ownership grants the same single-owner app
        // access. Preserve the existing app identity and Calendar credentials;
        // never accept an arbitrary Google account or a domain-wide match.
        const session=randomToken();await store.insert('cos_calendar_sessions',{token_hash:await sha256(session),google_sub:calendar?.google_sub||identity.sub,expires_at:new Date(+now()+30*86400000).toISOString()});
        if(states[0].return_challenge){
          const destination=await issueTransfer({store,config,now,session,challenge:states[0].return_challenge,service:'gmail',returnTo:'/#/inbox'});
          const h=new Headers({...headers,Location:destination});h.append('Set-Cookie',cleared);h.append('Set-Cookie',cookie(SESSION,session,30*86400));return new Response(null,{status:303,headers:h});
        }
        return redirect('connected',null,[cleared,cookie(SESSION,session,30*86400)]);
      }catch(error){report(error,stage);return redirect('error',error.reason==='google_owner_mismatch'?'wrong_account':reason(error),[cleared]);}
    });
    return result.status===409?redirect('error','connection_busy',[cleared]):result;
  }
  async function start(request,challenge=null){
        if(!challenge&&request.headers.get('Origin')===PUBLIC_ORIGIN)return beginTransfer('gmail');
        const state='gmail.'+randomToken(),browser=randomToken(),verifier=randomToken(48);
        await store.remove(STATES,'expires_at=lt.'+encodeURIComponent(stamp()));
        await store.insert(STATES,{state_hash:await sha256(state),browser_hash:await sha256(browser),verifier,...(challenge?{return_challenge:challenge}:{}),expires_at:new Date(+now()+600000).toISOString()});
        const target=new URL(await google.authorizationUrl({state,verifier}));
        target.searchParams.set('login_hint',config.allowedEmail.trim().toLowerCase());
        const h=new Headers({...headers,Location:target.href,'Set-Cookie':cookie(FLOW,browser,600)});
        return new Response(null,{status:303,headers:h});
      }
  return async request=>{
    const url=new URL(request.url),route=url.pathname.split('/').filter(Boolean).at(-1);
    try{
      if(request.method==='GET'&&route==='bridge-start'){
        const challenge=url.searchParams.get('challenge');if(!validChallenge(challenge))return json({error:'invalid_state'},400);return await start(request,challenge);
      }
      if(request.method==='GET'&&route==='callback')return await callback(request,url);
      if(['tick','health'].includes(route)&&request.method==='POST'){
        if(!config.cronSecret||!safeEqual(request.headers.get('Authorization')||'','Bearer '+config.cronSecret))return json({error:'unauthorized'},401);
        if(route==='health')return health?json({analysis:await health()}):json({error:'not_found'},404);
        return await locked(async()=>sync(await current()));
      }
      const connection=await current();
      if(route==='status'&&request.method==='GET'){
        if(!await authorized(request,connection))return json({authenticated:false,configured:true});
        const threads=await store.list('cos_gmail_threads','select=thread_id,subject,inbox_id,pending,last_error,updated_at,context_days,message_limit,project_id&order=updated_at.desc');
        const ids=threads.map(t=>t.inbox_id).filter(Boolean);
        const inbox=ids.length?await store.list('cos_communication_inbox','select=id,status&id=in.('+ids.join(',')+')'):[];
        const progress={found:threads.length,imported:ids.length,queued:threads.filter(t=>t.pending).length,
          ready:inbox.filter(i=>['ready','deferred','applied'].includes(i.status)).length,
          analyzing:inbox.filter(i=>['captured','processing'].includes(i.status)).length,
          errors:inbox.filter(i=>i.status==='error').length,discovering:!!connection?.settings?.enabled&&connection?.cursor?.mode!=='history'};
        return json({authenticated:true,progress,connection:connection?{email:connection.email,status:connection.status,last_sync_at:connection.last_sync_at,last_error:connection.last_error}:null,settings:connection?.settings||DEFAULT_SETTINGS,threads:threads.slice(0,50),pilot_full:false});
      }
      if(!['start','settings','labels','sync','disconnect','expand','project'].includes(route))return json({error:'not_found'},404);
      if(request.method!=='POST')return json({error:'method_not_allowed'},405);
      if(!allowedOrigin(request.headers.get('Origin')))return json({error:'invalid_origin'},403);
      if(Number(request.headers.get('Content-Length')||0)>16384)return json({error:'request_too_large'},413);
      if(route==='start')return await start(request);
      if(!await authorized(request,connection))return json({error:'unauthorized'},401);
      const raw=await request.text();if(raw.length>16384)return json({error:'request_too_large'},413);
      let data;try{data=raw?JSON.parse(raw):{}}catch{return json({error:'invalid_json'},400)}
      if(!connection)return json({error:'not_connected'},409);
      return await locked(async()=>{
        const latest=await current();
        if(!await authorized(request,latest))return json({error:'unauthorized'},401);
        if(route==='settings'){
          const old=latest.settings||DEFAULT_SETTINGS,next=settings({...old,...data});
          const scopeChanged=JSON.stringify([next.label_ids,next.emails,next.initial_days])!==JSON.stringify([old.label_ids,old.emails,old.initial_days]);
          await store.patch(C,'id=eq.owner',{settings:next,...(scopeChanged?{cursor:{}}:{})});return json({ok:true,settings:next});
        }
        if(route==='disconnect'){
          // Do not revoke this OAuth client's entire grant: that could also
          // revoke Calendar. Dropping the Gmail token stops all Gmail access.
          await store.patch(C,'id=eq.owner',{status:'disconnected',refresh_token_cipher:null,settings:{...latest.settings,enabled:false}});return json({ok:true});
        }
        if(route==='labels'){
          const result=await (await mail(latest)).labels();return json({labels:(result.labels||[]).filter(l=>validId(l.id)&&!['SPAM','TRASH','DRAFT'].includes(l.id)).map(l=>({id:l.id,name:String(l.name).slice(0,200)}))});
        }
        if(route==='sync')return sync(latest);
        if(!validId(data.thread_id))return json({error:'invalid_thread'},400);
        const thread=(await store.page('cos_gmail_threads',eq('thread_id',data.thread_id)+'&limit=1'))[0];if(!thread)return json({error:'not_found'},404);
        if(route==='project'){
          if(data.project_id!==null){const project=(await store.page('projects',eq('id',data.project_id)+'&status=eq.active&limit=1'))[0];if(!project)return json({error:'invalid_project'},400);}
          await store.patch('cos_gmail_threads',eq('thread_id',thread.thread_id),{project_id:data.project_id});return json({ok:true});
        }
        if(![90,180].includes(data.context_days)||![20,30,40,50].includes(data.message_limit))return json({error:'invalid_depth'},400);
        // Expansion is an explicit owner action; it invalidates only this
        // review with revision checks, never the mailbox-wide depth setting.
        await store.rpc('cos_gmail_expand',{p_thread_id:thread.thread_id,p_revision:data.revision,p_days:data.context_days,p_limit:data.message_limit});return json({ok:true});
      });
    }catch(error){
      report(error,['start','callback','status','tick','settings','labels','sync','disconnect','expand','project'].includes(route)?route:'unknown_route');
      if(route==='start'&&request.method==='POST'||route==='callback'&&request.method==='GET')return redirect('error',reason(error),[cookie(FLOW,'',0)]);
      return json({error:reason(error)},error?.code==='PT409'?409:knownErrors.has(error?.message)?400:503);
    }
  };
}
