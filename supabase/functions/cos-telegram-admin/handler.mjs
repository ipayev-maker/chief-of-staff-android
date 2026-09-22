// Temporary server-only webhook administration. No message-sending operations.
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const fail=code=>{throw Object.assign(new Error(code),{safeCode:code})};
async function equalSecret(a,b){
  if(typeof a!=='string'||typeof b!=='string'||!a||!b||a.length>1024||b.length>1024)return false;
  const hashes=await Promise.all([a,b].map(value=>crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))));
  const x=new Uint8Array(hashes[0]),y=new Uint8Array(hashes[1]);let diff=0;for(let i=0;i<x.length;i++)diff|=x[i]^y[i];return diff===0;
}
export function createTelegramAdmin({url,serviceKey,botToken,fetchImpl=fetch}){
  const expectedUrl=String(url||'').replace(/\/$/,'')+'/functions/v1/telegram-webhook';
  async function request(target,headers,body){
    let response,data;
    try{response=await fetchImpl(target,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(10_000),redirect:'error'});data=await response.json();}catch{fail('upstream_unavailable')}
    if(!response.ok)fail('upstream_rejected');return data;
  }
  const rpc=name=>request(String(url).replace(/\/$/,'')+'/rest/v1/rpc/'+name,{apikey:serviceKey,Authorization:'Bearer '+serviceKey},{});
  async function telegram(method,body={}){const reply=await request('https://api.telegram.org/bot'+botToken+'/'+method,{},body);if(reply?.ok!==true)fail('telegram_rejected');return reply.result;}
  function publicInfo(info){
    let safeUrl='';try{const target=new URL(info.url);safeUrl=target.origin+target.pathname;}catch{}
    return {url:safeUrl,matches_expected:info.url===expectedUrl,has_query:!!String(info.url||'').includes('?'),has_custom_certificate:!!info.has_custom_certificate,
      pending_update_count:Number(info.pending_update_count)||0,max_connections:Number(info.max_connections)||null,allowed_updates:Array.isArray(info.allowed_updates)?info.allowed_updates:[],last_error_date:Number(info.last_error_date)||null};
  }
  return async req=>{
    if(req.method!=='POST')return json({error:'method_not_allowed'},405);
    if(!url||!serviceKey||!botToken)return json({error:'admin_not_configured'},503);
    const bearer=req.headers.get('Authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];if(!bearer)return json({error:'unauthorized'},401);
    try{
      const calendarConfig=await rpc('cos_calendar_get_config');
      if(!await equalSecret(bearer,calendarConfig?.cronSecret))return json({error:'unauthorized'},401);
      let input;try{input=await req.json()}catch{return json({error:'invalid_json'},400)}
      if(!['getInfo','configure'].includes(input?.action))return json({error:'invalid_action'},400);
      const before=await telegram('getWebhookInfo');
      if(input.action==='getInfo')return json({ok:true,...publicInfo(before)});
      // Never redirect another integration or discard pending owner messages.
      if(before.url!==expectedUrl)return json({error:'unexpected_webhook_url',...publicInfo(before)},409);
      const config=await rpc('cos_notes_get_config');
      if(!/^[A-Za-z0-9_-]{32,256}$/.test(config?.webhookSecret||'')||!/^\d+$/.test(config?.telegramOwnerUserId||'')||config.telegramOwnerChatId!==config.telegramOwnerUserId)fail('notes_not_configured');
      await telegram('setWebhook',{url:before.url,secret_token:config.webhookSecret,drop_pending_updates:false,
        ...(Number.isInteger(before.max_connections)&&before.max_connections>=1&&before.max_connections<=100?{max_connections:before.max_connections}:{}),
        ...(Array.isArray(before.allowed_updates)&&before.allowed_updates.length?{allowed_updates:before.allowed_updates}:{})});
      return json({ok:true,configured:true,...publicInfo(await telegram('getWebhookInfo'))});
    }catch(error){return json({error:error?.safeCode||'admin_failed'},502)}
  };
}
