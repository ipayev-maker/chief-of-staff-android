// Server-only native-fetch adapters. Existing OpenRouter model and date parser
// are retained. No API keys, user text, or upstream response bodies are logged.
const fail=()=>{throw Error('upstream_failed')};
export function createTelegramRuntime({url,serviceKey,anonKey,botToken,openRouterKey,fetchImpl=fetch,now=()=>new Date()}){
  const base=String(url||'').replace(/\/$/,'');
  async function request(target,{method='POST',headers={},body,timeoutMs=10_000}={}){
    let response,data;
    try{response=await fetchImpl(target,{method,headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(timeoutMs),redirect:'error'});data=await response.json();}catch{fail()}
    if(!response.ok)fail();return data;
  }
  const dbHeaders=()=>{if(!base||!serviceKey)fail();return {apikey:serviceKey,Authorization:'Bearer '+serviceKey}};
  const store={
    async list(table,query){if(!['cos_notes_telegram_receipts','inbox','commitments'].includes(table))fail();const rows=await request(base+'/rest/v1/'+table+'?'+query,{method:'GET',headers:dbHeaders()});if(!Array.isArray(rows))fail();return rows},
    rpc:(name,body={})=>request(base+'/rest/v1/rpc/'+name,{headers:dbHeaders(),body})
  };
  async function extract(text){
    if(!openRouterKey)fail();
    const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(now());
    const prompt=`You are an operational assistant. Today is ${today}. Timezone: Europe/Moscow.
Analyze the Russian message. Extract tasks, obligations, promises, reminders or payments as commitments. Do not turn ordinary factual information or thoughts into tasks. An ordinary note can have empty commitments and events.
- direction: "to_me" (мне обещали), "from_me" (я должен), "internal".
- deadline and event date: null, dates are calculated by a separate module.
- project only if a project name is explicitly mentioned.
- who: the OTHER named person, never the author or "я"/"мне"/"меня". Preserve the name as written; do not invent a surname. "Юрий обещал прислать" -> who "Юрий"; "ответить Максиму" -> who "Максиму"; "купить молоко" -> who null.
Return STRICT JSON: {"project":null or {"title":"...","description":"..."},"commitments":[{"description":"...","who":null or "...","deadline":null,"direction":"to_me|from_me|internal"}],"events":[{"description":"...","date":null}]}.`;
    const data=await request('https://openrouter.ai/api/v1/chat/completions',{headers:{Authorization:'Bearer '+openRouterKey,'HTTP-Referer':'https://supabase.com','X-Title':'Chief of Staff'},timeoutMs:25_000,body:{model:'anthropic/claude-sonnet-4.6',messages:[{role:'system',content:prompt},{role:'user',content:text}],temperature:0.1,max_tokens:2000}});
    const content=data?.choices?.[0]?.message?.content;if(typeof content!=='string')fail();const start=content.indexOf('{'),end=content.lastIndexOf('}');if(start<0||end<start)fail();try{return JSON.parse(content.slice(start,end+1))}catch{fail()}
  }
  return {
    store,loadConfig:()=>store.rpc('cos_notes_get_config'),extract,
    parseDates:text=>{if(!anonKey)fail();return request(base+'/functions/v1/parse-dates',{headers:{Authorization:'Bearer '+anonKey,apikey:anonKey},body:{text}})},
    sendTelegram:async(method,body)=>{if(!botToken||!['sendMessage','answerCallbackQuery'].includes(method))fail();const reply=await request('https://api.telegram.org/bot'+botToken+'/'+method,{body});if(reply?.ok!==true)fail();return reply.result}
  };
}
