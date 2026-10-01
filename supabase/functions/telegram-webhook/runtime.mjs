// Server-only native-fetch adapters; the shared service powers both Telegram
// confirmation and dashboard review. No API keys or source text are logged.
import {createStore} from '../cos-google-calendar/store.mjs';
import {createCommunicationInbox,createInboxModel} from '../cos-notes/communication-inbox.mjs';
import {createVoiceAdapter} from './voice.mjs';
const fail=()=>{throw Error('upstream_failed')};
export function createTelegramRuntime({url,serviceKey,botToken,openRouterKey,fetchImpl=fetch,now=()=>new Date()}){
  const store=createStore({url,serviceKey,fetchImpl});
  const voice=createVoiceAdapter({url,serviceKey,botToken,openRouterKey,fetchImpl});
  const model=createInboxModel({openRouterKey,fetchImpl});
  return {
    store,now,loadConfig:()=>store.rpc('cos_notes_get_config'),
    createInbox:config=>createCommunicationInbox({store,model,now,voice:{
      save:args=>voice.save({...args,ownerId:config.telegramOwnerUserId}),
      transcribe:args=>voice.transcribe({...args,ownerId:config.telegramOwnerUserId}),
      read:args=>voice.read({...args,ownerId:config.telegramOwnerUserId})
    }}),
    sendTelegram:async(method,body)=>{
      if(!botToken||!['sendMessage','answerCallbackQuery'].includes(method))fail();
      let response,reply;try{response=await fetchImpl('https://api.telegram.org/bot'+botToken+'/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000),redirect:'error'});reply=await response.json()}catch{fail()}
      if(!response.ok||reply?.ok!==true)fail();return reply.result;
    }
  };
}
