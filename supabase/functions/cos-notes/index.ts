import {createStore} from '../cos-google-calendar/store.mjs';
import {createNotesHandler} from './handler.mjs';

// Deploy with verify_jwt=false: the handler authenticates the existing private
// owner session cookie, not a public Supabase key or a caller-supplied email.
let handler: ((request: Request) => Promise<Response>) | null = null;
Deno.serve(async (request: Request) => {
  try {
    if (!handler) {
      const store = createStore({
        url: Deno.env.get('SUPABASE_URL'),
        serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
      });
      handler = createNotesHandler({store});
    }
    return await handler(request);
  } catch {
    return new Response(JSON.stringify({error: 'notes_unavailable'}), {
      status: 503, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'},
    });
  }
});
