import {createTelegramAdmin} from './handler.mjs';
Deno.serve(createTelegramAdmin({url:Deno.env.get('SUPABASE_URL'),serviceKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),botToken:Deno.env.get('TELEGRAM_BOT_TOKEN')}));
