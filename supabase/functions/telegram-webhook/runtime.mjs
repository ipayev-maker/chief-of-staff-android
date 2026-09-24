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
  async function extract(text,{refDate=now().toISOString()}={}){
    if(!openRouterKey)fail();
    const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(refDate));
    const prompt=`You are an operational assistant. Today is ${today}. Timezone: Europe/Moscow.
Analyze the Russian message. Extract tasks, obligations, promises, reminders or payments as commitments. Do not turn ordinary factual information or thoughts into tasks. An ordinary note can have empty commitments and events.
- direction: "to_me" (мне обещали), "from_me" (я должен), "internal".
- deadline and event date: null, dates are calculated by a separate module.
- For EACH commitment and event, source_text is the shortest EXACT contiguous quote from the original message that describes this action and its date, if any. Never rewrite or invent this quote.
- date_text is an EXACT contiguous quote from source_text containing ONLY this action's explicitly stated date, including qualifiers such as "примерно", "не раньше", alternatives or ranges. Keep its original Russian wording; do not calculate a date.
- date_status is "explicit" for one clear date, "none" when no date is given, or "ambiguous" for uncertain dates, alternatives, negated dates or a range. Use date_text:null for none/ambiguous. Do not choose a date from a range or silently drop negation.
- Never copy a date from another action. Shared dates apply to multiple actions ONLY when the original wording explicitly links them: "Завтра подготовить чертежи и отправить образец" allows the same source_text and date_text for both; "чертежи завтра, образец в пятницу, запросить КП" requires tomorrow, Friday, and no date respectively.
- If one action has a preparation date and a final deadline, keep date_status:"ambiguous" unless the final deadline is unmistakably identified. Never treat a reminder time as the completion deadline.
- project only if a project name is explicitly mentioned.
- who: the OTHER named person, never the author or "я"/"мне"/"меня". Preserve the name as written; do not invent a surname. "Юрий обещал прислать" -> who "Юрий"; "ответить Максиму" -> who "Максиму"; "купить молоко" -> who null.
Return STRICT JSON: {"project":null or {"title":"...","description":"..."},"commitments":[{"description":"...","who":null or "...","deadline":null,"direction":"to_me|from_me|internal","source_text":"exact original quote","date_text":null or "exact date quote","date_status":"explicit|none|ambiguous"}],"events":[{"description":"...","date":null,"source_text":"exact original quote","date_text":null or "exact date quote","date_status":"explicit|none|ambiguous"}]}.`;
    const data=await request('https://openrouter.ai/api/v1/chat/completions',{headers:{Authorization:'Bearer '+openRouterKey,'HTTP-Referer':'https://supabase.com','X-Title':'Chief of Staff'},timeoutMs:25_000,body:{model:'anthropic/claude-sonnet-4.6',messages:[{role:'system',content:prompt},{role:'user',content:text}],temperature:0.1,max_tokens:4000}});
    const content=data?.choices?.[0]?.message?.content;if(typeof content!=='string')fail();const start=content.indexOf('{'),end=content.lastIndexOf('}');if(start<0||end<start)fail();try{return JSON.parse(content.slice(start,end+1))}catch{fail()}
  }
  return {
    store,now,loadConfig:()=>store.rpc('cos_notes_get_config'),extract,
    parseDates:(text,{refDate=now().toISOString()}={})=>{if(!anonKey)fail();return request(base+'/functions/v1/parse-dates',{headers:{Authorization:'Bearer '+anonKey,apikey:anonKey},body:{text,refDate}})},
    sendTelegram:async(method,body)=>{if(!botToken||!['sendMessage','answerCallbackQuery'].includes(method))fail();const reply=await request('https://api.telegram.org/bot'+botToken+'/'+method,{body});if(reply?.ok!==true)fail();return reply.result}
  };
}
