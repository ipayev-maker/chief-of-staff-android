import {modelHealth} from '../cos-gmail/health.mjs';
import { createStore } from './store.mjs';
import { createGoogle } from './google.mjs';
import { createHandler } from './handler.mjs';
import {createGmailHandler} from '../cos-gmail/handler.mjs';
import {GMAIL_SCOPES} from '../cos-gmail/mail.mjs';
import {createCommunicationInbox,createInboxModel} from '../cos-notes/communication-inbox.mjs';

// Supabase provides these server-only credentials. Never serialize them to clients.
const store = createStore({url:Deno.env.get('SUPABASE_URL'),serviceKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')});
let cachedHandler: ((request: Request) => Promise<Response>) | null = null;
let cacheUntil = 0;
Deno.serve(async (request: Request) => {
  try {
    if (!cachedHandler || Date.now() >= cacheUntil) {
      const config = await store.rpc('cos_calendar_get_config',{});
      if (!config?.clientId || !config?.clientSecret || !config?.tokenKey || !config?.allowedEmail || !config?.cronSecret) throw Error('not_configured');
      const calendar=createHandler({store,google:createGoogle({config}),config});
      const inbox=createCommunicationInbox({store,model:createInboxModel({openRouterKey:Deno.env.get('OPENROUTER_KEY')})});
      // One app owner may use a work mailbox and a personal calendar.
      // Only the exact server-configured Gmail address can authorize mail.
      const gmailConfig={...config,allowedEmail:config.gmailAllowedEmail??config.allowedEmail};
      const gmail=createGmailHandler({store,google:createGoogle({config:gmailConfig,scopes:GMAIL_SCOPES}),config:gmailConfig,analyze:item=>inbox.process(item),recover:item=>inbox.recover(item.id),deliver:item=>inbox.deliverMail(item.id),health:()=>modelHealth({key:Deno.env.get('OPENROUTER_KEY')})});
      cachedHandler=request=>{const url=new URL(request.url);return url.pathname.includes('/gmail/')||url.pathname.endsWith('/callback')&&url.searchParams.get('state')?.startsWith('gmail.')?gmail(request):calendar(request)};
      cacheUntil = Date.now() + 60000;
    }
    return await cachedHandler(request);
  } catch {
    return new Response(JSON.stringify({error:'calendar_not_configured'}),{status:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  }
});
