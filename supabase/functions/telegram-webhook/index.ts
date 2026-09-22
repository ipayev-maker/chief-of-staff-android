import {createTelegramWebhook} from './handler.mjs';
import {createTelegramRuntime} from './runtime.mjs';
Deno.serve(createTelegramWebhook(createTelegramRuntime({
  url:Deno.env.get('SUPABASE_URL'),serviceKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  anonKey:Deno.env.get('SUPABASE_ANON_KEY'),botToken:Deno.env.get('TELEGRAM_BOT_TOKEN'),openRouterKey:Deno.env.get('OPENROUTER_KEY')
})));
