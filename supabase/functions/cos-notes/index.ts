import {createNoteMedia} from './media.mjs';
import {createStore} from '../cos-google-calendar/store.mjs';
import {createNotesHandler} from './handler.mjs';
import {createCommunicationInbox, createInboxModel} from './communication-inbox.mjs';
import {createVoiceAdapter} from '../telegram-webhook/voice.mjs';
import {withPinGate} from '../_shared/dashboard-pin.mjs';
import {createMobileVoice,createMobileCapture} from './mobile-voice.mjs';

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
      const voiceAdapter = createVoiceAdapter({
        url: Deno.env.get('SUPABASE_URL'), serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
        botToken: Deno.env.get('TELEGRAM_BOT_TOKEN'), openRouterKey: Deno.env.get('OPENROUTER_KEY'),
        groqApiKey: Deno.env.get('GROQ_API_KEY'), transcriptionProvider: Deno.env.get('VOICE_TRANSCRIPTION_PROVIDER'),
      });
      const ownerVoice = async (method: 'save' | 'transcribe' | 'read', args: object) => {
        const config = await store.rpc('cos_notes_get_config');
        return voiceAdapter[method]({...args, ownerId: config.telegramOwnerUserId});
      };
      const mobileVoice=createMobileVoice({url:Deno.env.get('SUPABASE_URL'),serviceKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),groqApiKey:Deno.env.get('GROQ_API_KEY')});
      const telegramVoice={model:voiceAdapter.model,save:(args:object)=>ownerVoice('save',args),transcribe:(args:object)=>ownerVoice('transcribe',args),read:(args:object)=>ownerVoice('read',args)};
      const inbox = createCommunicationInbox({store,
        model: createInboxModel({openRouterKey: Deno.env.get('OPENROUTER_KEY'),telegramModel:Deno.env.get('TELEGRAM_OPENROUTER_MODEL'),mailModel:Deno.env.get('GMAIL_OPENROUTER_MODEL')}),
        voice: {forItem:(item:any)=>item.source_meta?.channel==='android'?mobileVoice:telegramVoice},
      });
      handler = withPinGate(createNotesHandler({store, inbox,mobileCapture:createMobileCapture({store,inbox,voice:mobileVoice}),media:createNoteMedia({store,url:Deno.env.get('SUPABASE_URL'),serviceKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')})}),{store});
    }
    return await handler(request);
  } catch {
    return new Response(JSON.stringify({error: 'notes_unavailable'}), {
      status: 503, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'},
    });
  }
});
