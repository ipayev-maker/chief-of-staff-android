import { APP_ORIGIN, randomToken, sha256, encryptSecret, decryptSecret, safeEqual } from './google.mjs';
import { syncCalendar, projectionHash } from './sync.mjs';
import * as projector from '../../../web/calendar/projector.mjs';

const FLOW_COOKIE = '__Host-cos-calendar-flow';
const SESSION_COOKIE = '__Host-cos-calendar-session';
const SESSION_SECONDS = 30 * 86400;
const CONNECTION = 'cos_calendar_connection';
const STATES = 'cos_calendar_oauth_states';
const SESSIONS = 'cos_calendar_sessions';
const BINDINGS = 'cos_calendar_bindings';
const headers = { 'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer', 'X-Content-Type-Options':'nosniff' };
const queryValue = value => encodeURIComponent(String(value));
const eq = (key, value) => key + '=eq.' + queryValue(value);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers:{...headers,'Content-Type':'application/json; charset=utf-8'} });
function cookie(name, value, seconds) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
}
function readCookie(request, name) {
  const pairs = (request.headers.get('Cookie') || '').split(';').map(p => p.trim().split('='));
  return pairs.find(p => p[0] === name)?.[1] || '';
}
function redirect(location, cookies = []) {
  const h = new Headers({...headers, Location:location});
  for (const item of cookies) h.append('Set-Cookie', item);
  return new Response(null, {status:303, headers:h});
}
function validTimeZone(value) {
  if (typeof value !== 'string' || value.length > 100 || !value) throw Error('invalid_time_zone');
  new Intl.DateTimeFormat('en-US', {timeZone:value}).format(new Date(0));
  return value;
}
function safeReason(error) {
  const reason = error?.reason || error?.message;
  if (reason === 'missing_required_scopes') return 'missing_scope';
  if (['google_owner_mismatch','google_identity_unverified'].includes(reason)) return 'wrong_account';
  return typeof reason === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(reason) ? reason : 'calendar_request_failed';
}

/** Owner identity is verified by Google's userinfo endpoint after code exchange.
 * The browser-bound state is consumed atomically before that exchange. No JWT
 * payload, client-supplied email or source-table write is used for authorization.
 */
export function createHandler({store, google, config, now = () => new Date(), runSync = syncCalendar}) {
  const timestamp = () => now().toISOString();
  const connection = async () => (await store.list(CONNECTION, 'id=eq.owner'))[0] || null;
  async function ownerSession(request, current) {
    const token = readCookie(request, SESSION_COOKIE);
    if (!token || token.length > 200 || !current) return null;
    const rows = await store.list(SESSIONS, eq('token_hash', await sha256(token)) + '&expires_at=gt.' + queryValue(timestamp()));
    return rows[0]?.google_sub === current.google_sub ? rows[0] : null;
  }
  async function withLock(fn) {
    const holder = randomToken();
    const claimed = await store.rpc('cos_calendar_claim_lock', {p_holder:holder, p_seconds:180});
    if (claimed !== true) return json({error:'connection_busy'}, 409);
    try { return await fn(); }
    finally { await store.rpc('cos_calendar_release_lock', {p_holder:holder}).catch(() => {}); }
  }
  async function synchronized(current) {
    if (!current || current.status !== 'connected' || !current.calendar_id || !current.refresh_token_cipher) return {ok:false, reason:'not_connected'};
    try {
      const tokens = await google.refresh(await decryptSecret(current.refresh_token_cipher, config.tokenKey));
      if (tokens.refresh_token) {
        await store.patch(CONNECTION, 'id=eq.owner', {refresh_token_cipher:await encryptSecret(tokens.refresh_token, config.tokenKey), updated_at:timestamp()});
      }
      const result = await runSync({store,connection:current,google:google.calendar(tokens.access_token),projector,now,maxMutations:20,maxMillis:40000});
      await store.patch(CONNECTION, 'id=eq.owner', {last_sync_at:timestamp(),last_error:result.errors ? 'some_records_failed' : result.conflicts ? 'calendar_conflicts' : null,updated_at:timestamp()});
      return {ok:true,...result};
    } catch (error) {
      const reason = safeReason(error);
      const needsReconnect = ['invalid_grant','invalid_token','refresh_token_missing'].includes(reason) || error?.status === 401;
      await store.patch(CONNECTION, 'id=eq.owner', {last_error:reason, ...(needsReconnect ? {status:'needs_reconnect'} : {}),updated_at:timestamp()});
      return {ok:false,reason};
    }
  }
  async function status(request) {
    const current = await connection();
    if (!await ownerSession(request,current)) return json({authenticated:false,configured:true});
    const [bindings,tasks,meetings] = await Promise.all([
      store.list(BINDINGS,eq('connection_key',current.connection_key)),
      store.list('commitments','select=id,description,status,deadline,deadline_at&order=id'),
      store.list('meetings','select=id,title,status,starts_at,ends_at,location,meeting_url&order=id')
    ]);
    const bySource = new Map(bindings.map(row => [row.source_kind + ':' + row.source_id,row]));
    const counts = {synced:0,pending:0,errors:0,undatedTasks:0};
    const issues = [];
    for (const [kind,records] of [['task',tasks],['meeting',meetings]]) {
      for (const row of records) {
        const binding = bySource.get(kind + ':' + row.id);
        const projection = projector.projectCalendarRecord(kind,row,{timeZone:current.time_zone,generation:binding?.generation || 0});
        if (projection.kind === 'absent') {
          if (kind === 'task' && row.status !== 'cancelled' && row.status !== 'completed' && !row.deadline && !row.deadline_at) counts.undatedTasks++;
          if (binding && !['deleted'].includes(binding.state)) counts.pending++;
          continue;
        }
        if (projection.kind === 'error' || binding?.state === 'error' || binding?.state === 'conflict') {
          counts.errors++;
          issues.push({kind,id:row.id,title:kind === 'task' ? row.description : row.title,reason:projection.kind === 'error' ? projection.reason : binding.last_error || 'calendar_conflict'});
        } else if (binding?.state === 'active' && binding.source_hash === await projectionHash(projection,current.connection_key)) counts.synced++;
        else counts.pending++;
      }
    }
    return json({authenticated:true,connection:{email:current.email,calendarName:'Chief of Staff',timeZone:current.time_zone,status:current.status,lastSyncAt:current.last_sync_at,lastError:current.last_error},counts,issues});
  }
  async function start(request) {
    const form = await request.formData();
    const timeZone = validTimeZone(form.get('time_zone'));
    const state = randomToken();
    const browserSecret = randomToken();
    const verifier = randomToken(48);
    await store.remove(STATES,'expires_at=lt.' + queryValue(timestamp()));
    await store.insert(STATES,{state_hash:await sha256(state),browser_hash:await sha256(browserSecret),verifier,time_zone:timeZone,expires_at:new Date(now().getTime()+600000).toISOString()});
    return redirect(await google.authorizationUrl({state,verifier}),[cookie(FLOW_COOKIE,browserSecret,600)]);
  }
  async function callback(request,url) {
    const cleared = cookie(FLOW_COOKIE,'',0);
    const failed = reason => redirect(APP_ORIGIN + '/?calendar=error&reason=' + encodeURIComponent(reason),[cleared]);
    const state = url.searchParams.get('state');
    const browserSecret = readCookie(request,FLOW_COOKIE);
    if (!state || state.length > 200 || !browserSecret || browserSecret.length > 200) return failed('invalid_state');
    const states = await store.remove(STATES,eq('state_hash',await sha256(state)) + '&' + eq('browser_hash',await sha256(browserSecret)) + '&expires_at=gt.' + queryValue(timestamp()));
    if (states.length !== 1) return failed('invalid_state');
    if (url.searchParams.has('error')) return failed('denied');
    const code = url.searchParams.get('code');
    if (!code || code.length > 4096) return failed('oauth_failed');
    const result = await withLock(async () => {
      try {
        const tokens = await google.exchangeCode({code,verifier:states[0].verifier});
        const identity = await google.userInfo(tokens.access_token);
        if (identity.email.toLowerCase() !== config.allowedEmail.toLowerCase() || identity.email_verified !== true) return failed('wrong_account');
        let current = await connection();
        if (current && current.google_sub !== identity.sub) return failed('wrong_account');
        // Never blindly create another calendar after an uncertain provisioning outcome.
        if (current?.status === 'provisioning' && !current.calendar_id) return failed('calendar_setup_failed');
        const encrypted = tokens.refresh_token ? await encryptSecret(tokens.refresh_token,config.tokenKey) : current?.refresh_token_cipher;
        if (!encrypted) return failed('refresh_token_missing');
        current = {...(current || {}),id:'owner',connection_key:current?.connection_key || crypto.randomUUID(),google_sub:identity.sub,email:identity.email,time_zone:current?.time_zone || states[0].time_zone,refresh_token_cipher:encrypted,status:current?.calendar_id ? 'connected' : 'provisioning',last_error:null,updated_at:timestamp()};
        await store.upsert(CONNECTION,current,'id');
        if (!current.calendar_id) {
          let calendar;
          try {
            calendar = await google.calendar(tokens.access_token).request('/calendars',{method:'POST',body:{summary:'Chief of Staff',description:'Сроки задач и встречи из Chief of Staff',timeZone:current.time_zone}});
          } catch (error) {
            // An explicit rejection did not create a calendar. Permit a fresh
            // attempt after the owner enables the API or corrects permissions.
            if (error?.status >= 400 && error.status < 500 && error.status !== 408) {
              await store.patch(CONNECTION,'id=eq.owner',{status:'needs_reconnect',last_error:'calendar_setup_failed',updated_at:timestamp()});
            }
            throw Error('calendar_setup_failed');
          }
          if (!calendar?.id) throw Error('calendar_setup_failed');
          current.calendar_id = calendar.id;
          current.status = 'connected';
          await store.patch(CONNECTION,'id=eq.owner',{calendar_id:current.calendar_id,status:'connected',last_error:null,updated_at:timestamp()});
        }
        const sessionToken = randomToken();
        await store.remove(SESSIONS,'expires_at=lt.' + queryValue(timestamp()));
        await store.insert(SESSIONS,{token_hash:await sha256(sessionToken),google_sub:identity.sub,expires_at:new Date(now().getTime()+SESSION_SECONDS*1000).toISOString()});
        // Durable cron performs initial import; OAuth callback remains fast.
        return redirect(APP_ORIGIN + '/?calendar=connected',[cleared,cookie(SESSION_COOKIE,sessionToken,SESSION_SECONDS)]);
      } catch (error) {
        const reason = safeReason(error);
        const allowed = ['wrong_account','missing_scope','refresh_token_missing','calendar_setup_failed'];
        return failed(allowed.includes(reason) ? reason : 'oauth_failed');
      }
    });
    return result.status === 409 ? failed('connection_busy') : result;
  }
  return async function handle(request) {
    try {
      const url = new URL(request.url);
      const route = url.pathname.split('/').filter(Boolean).at(-1);
      if (request.method === 'POST' && route === 'tick') {
        const bearer = request.headers.get('Authorization') || '';
        if (!config.cronSecret || !safeEqual(bearer,'Bearer ' + config.cronSecret)) return json({error:'unauthorized'},401);
        return await withLock(async () => json(await synchronized(await connection())));
      }
      if (route === 'callback' && request.method === 'GET') return await callback(request,url);
      if (route === 'status' && request.method === 'GET') return await status(request);
      if (!['start','sync','disconnect'].includes(route)) return json({error:'not_found'},404);
      if (request.method !== 'POST') return json({error:'method_not_allowed'},405);
      if (request.headers.get('Origin') !== APP_ORIGIN) return json({error:'invalid_origin'},403);
      if (Number(request.headers.get('Content-Length') || 0) > 8192) return json({error:'request_too_large'},413);
      if (route === 'start') return await start(request);
      const current = await connection();
      if (!await ownerSession(request,current)) return json({error:'unauthorized'},401);
      return await withLock(async () => {
        const latest = await connection();
        if (!await ownerSession(request,latest)) return json({error:'unauthorized'},401);
        if (route === 'sync') return json(await synchronized(latest));
        await store.patch(CONNECTION,'id=eq.owner',{status:'disconnected',refresh_token_cipher:null,last_error:null,updated_at:timestamp()});
        await store.remove(SESSIONS,eq('google_sub',current.google_sub));
        const response = json({ok:true});
        response.headers.append('Set-Cookie',cookie(SESSION_COOKIE,'',0));
        return response;
      });
    } catch { return json({error:'calendar_request_failed'},500); }
  };
}
