import {createStore} from '../cos-google-calendar/store.mjs';
import {createDashboardHandler} from './handler.mjs';
const url=Deno.env.get('SUPABASE_URL'),serviceKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const store=createStore({url,serviceKey});
Deno.serve(createDashboardHandler({store,url,serviceKey}));
