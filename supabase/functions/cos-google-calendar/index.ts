import { createStore } from './store.mjs';
import { createGoogle } from './google.mjs';
import { createHandler } from './handler.mjs';

// Supabase provides these server-only credentials. Never serialize them to clients.
const store = createStore({url:Deno.env.get('SUPABASE_URL'),serviceKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')});
let cachedHandler: ((request: Request) => Promise<Response>) | null = null;
let cacheUntil = 0;
Deno.serve(async (request: Request) => {
  try {
    if (!cachedHandler || Date.now() >= cacheUntil) {
      const config = await store.rpc('cos_calendar_get_config',{});
      if (!config?.clientId || !config?.clientSecret || !config?.tokenKey || !config?.allowedEmail || !config?.cronSecret) throw Error('not_configured');
      cachedHandler = createHandler({store,google:createGoogle({config}),config});
      cacheUntil = Date.now() + 60000;
    }
    return await cachedHandler(request);
  } catch {
    return new Response(JSON.stringify({error:'calendar_not_configured'}),{status:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  }
});
