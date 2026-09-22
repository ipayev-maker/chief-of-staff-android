import {APP_ORIGIN, sha256} from '../cos-google-calendar/google.mjs';

const SESSION_COOKIE = '__Host-cos-calendar-session';
const MAX_BODY_BYTES = 128 * 1024;
const BODY_TIMEOUT_MS = 10_000;
const NOTE_FIELDS = Object.freeze([
  'id', 'title', 'plain_text', 'project_id', 'source', 'source_message_id',
  'telegram_chat_id', 'telegram_message_id', 'telegram_update_id',
  'archived_at', 'created_at', 'updated_at', 'revision',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESPONSE_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  Vary: 'Cookie',
});

class NotesError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
function fail(status, code) { throw new NotesError(status, code); }
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {status, headers: RESPONSE_HEADERS});
}
const eq = (key, value) => `${key}=eq.${encodeURIComponent(String(value))}`;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function sessionToken(request) {
  const matches = (request.headers.get('Cookie') || '').split(';').map(part => part.trim())
    .filter(part => part.startsWith(SESSION_COOKIE + '='));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(SESSION_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{32,200}$/.test(token) ? token : null;
}

function noteView(row) {
  return Object.fromEntries(NOTE_FIELDS.filter(key => own(row, key)).map(key => [key, row[key]]));
}

function resourceId(url) {
  const match = /^\/(?:api\/notes|functions\/v1\/cos-notes|cos-notes)(?:\/([^/]+))?\/?$/.exec(url.pathname);
  if (!match) fail(404, 'not_found');
  if (match[1] && !UUID.test(match[1])) fail(400, 'invalid_id');
  return match[1]?.toLowerCase() || null;
}

async function readJson(request) {
  if ((request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    fail(415, 'json_required');
  }
  const declared = request.headers.get('Content-Length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    fail(413, 'request_too_large');
  }
  if (!request.body) fail(400, 'invalid_request');
  const reader = request.body.getReader();
  let timer;
  try {
    const text = await Promise.race([
      (async () => {
        const decoder = new TextDecoder('utf-8', {fatal: true});
        let text = '', bytes = 0;
        for (;;) {
          const {done, value} = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_BODY_BYTES) fail(413, 'request_too_large');
          text += decoder.decode(value, {stream: true});
        }
        return text + decoder.decode();
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new NotesError(408, 'request_timeout')), BODY_TIMEOUT_MS);
      }),
    ]);
    let data;
    try { data = JSON.parse(text); } catch { fail(400, 'invalid_request'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, 'invalid_request');
    return data;
  } catch (error) {
    if (error instanceof NotesError) throw error;
    fail(400, 'invalid_request');
  } finally {
    clearTimeout(timer);
    // Do not let a malicious/stalled request's cancel handler delay the reply.
    void reader.cancel().catch(() => {});
  }
}

function noteValues(data, creating, timestamp) {
  const allowed = creating ? ['title', 'plain_text', 'project_id'] : ['revision', 'title', 'plain_text', 'project_id', 'archived'];
  if (Object.keys(data).some(key => !allowed.includes(key))) fail(400, 'invalid_request');
  if (!creating && (!Number.isSafeInteger(data.revision) || data.revision < 1 || data.revision >= 2147483647)) {
    fail(400, 'invalid_revision');
  }
  if (!creating && !['title', 'plain_text', 'project_id', 'archived'].some(key => own(data, key))) {
    fail(400, 'invalid_request');
  }
  const values = {};
  if (creating || own(data, 'title')) {
    const title = creating && !own(data, 'title') ? '' : data.title;
    if (typeof title !== 'string' || title.length > 300 || title.includes('\0')) fail(400, 'invalid_note');
    values.title = title.trim();
  }
  if (creating || own(data, 'plain_text')) {
    if (typeof data.plain_text !== 'string' || !data.plain_text.trim() || data.plain_text.length > 64000 || data.plain_text.includes('\0')) {
      fail(400, 'invalid_note');
    }
    values.plain_text = data.plain_text;
  }
  if (creating || own(data, 'project_id')) {
    const projectId = creating && !own(data, 'project_id') ? null : data.project_id;
    if (projectId !== null && (typeof projectId !== 'string' || !UUID.test(projectId))) fail(400, 'invalid_project');
    values.project_id = projectId?.toLowerCase() || null;
  }
  if (own(data, 'archived')) {
    if (typeof data.archived !== 'boolean') fail(400, 'invalid_request');
    values.archived_at = data.archived ? timestamp : null;
  }
  if (creating) values.source = 'web';
  return values;
}

function pagination(url) {
  const allowed = new Set(['archived', 'limit', 'offset']);
  if ([...url.searchParams.keys()].some(key => !allowed.has(key) || url.searchParams.getAll(key).length !== 1)) {
    fail(400, 'invalid_request');
  }
  const archived = url.searchParams.get('archived') ?? 'false';
  const rawLimit = url.searchParams.get('limit') ?? '50';
  const rawOffset = url.searchParams.get('offset') ?? '0';
  if (!['false', 'true'].includes(archived) || !/^[1-9]\d*$/.test(rawLimit) || Number(rawLimit) > 100 ||
      !/^\d+$/.test(rawOffset) || !Number.isSafeInteger(Number(rawOffset)) || Number(rawOffset) > 1_000_000) {
    fail(400, 'invalid_pagination');
  }
  return {archived: archived === 'true', limit: Number(rawLimit), offset: Number(rawOffset)};
}

/** Single-owner notes: only a server-issued, unexpired Google-owner session
 * authorizes reads/writes. Calendar connection status is deliberately ignored.
 * No caller-controlled email, anonymous key or Google token is accepted here.
 */
export function createNotesHandler({store, now = () => new Date()}) {
  async function authenticate(request) {
    const token = sessionToken(request);
    if (!token) fail(401, 'unauthorized');
    const timestamp = now().toISOString();
    const [connections, sessions] = await Promise.all([
      store.list('cos_calendar_connection', 'select=google_sub&id=eq.owner'),
      store.list('cos_calendar_sessions', `select=google_sub,expires_at&${eq('token_hash', await sha256(token))}&expires_at=gt.${encodeURIComponent(timestamp)}`),
    ]);
    const owner = connections[0];
    if (connections.length !== 1 || sessions.length !== 1 || typeof owner?.google_sub !== 'string' || !owner.google_sub ||
        sessions[0].google_sub !== owner.google_sub || !(Date.parse(sessions[0].expires_at) > now().getTime())) {
      fail(401, 'unauthorized');
    }
  }

  return async function handleNotes(request) {
    try {
      const url = new URL(request.url);
      const id = resourceId(url);
      const method = request.method;
      if (!['GET', 'POST', 'PATCH'].includes(method) || (method === 'POST' && id) || (method === 'PATCH' && !id)) {
        return json({error: 'method_not_allowed'}, 405);
      }
      if (method !== 'GET' && request.headers.get('Origin') !== APP_ORIGIN) fail(403, 'invalid_origin');
      await authenticate(request);
      if (method === 'GET') {
        if (id) {
          if (url.search) fail(400, 'invalid_request');
          const rows = await store.page('quick_notes', `${eq('id', id)}&select=${NOTE_FIELDS.join(',')}&limit=1`, {timeoutMs: 8000});
          if (!rows.length) fail(404, 'note_not_found');
          return json({note: noteView(rows[0])});
        }
        const {archived, limit, offset} = pagination(url);
        const query = new URLSearchParams({
          select: NOTE_FIELDS.join(','), archived_at: archived ? 'not.is.null' : 'is.null',
          order: 'created_at.desc,id.desc', limit: String(limit + 1), offset: String(offset),
        });
        const rows = await store.page('quick_notes', query, {timeoutMs: 8000});
        return json({notes: rows.slice(0, limit).map(noteView), nextOffset: rows.length > limit ? offset + limit : null});
      }
      if (url.search) fail(400, 'invalid_request');
      const data = await readJson(request);
      const values = noteValues(data, method === 'POST', now().toISOString());
      if (method === 'POST') {
        const row = await store.insert('quick_notes', values, {timeoutMs: 8000});
        return json({note: noteView(row)}, 201);
      }
      const rows = await store.patch('quick_notes', `${eq('id', id)}&${eq('revision', data.revision)}`, values, {timeoutMs: 8000});
      if (rows.length === 1) return json({note: noteView(rows[0])});
      if (rows.length !== 0) fail(503, 'notes_unavailable');
      const current = await store.page('quick_notes', `${eq('id', id)}&select=${NOTE_FIELDS.join(',')}&limit=1`, {timeoutMs: 8000});
      if (!current.length) fail(404, 'note_not_found');
      return json({error: 'revision_conflict', note: noteView(current[0])}, 409);
    } catch (error) {
      if (error instanceof NotesError) return json({error: error.code}, error.status);
      if (error?.code === '23503') return json({error: 'invalid_project'}, 400);
      if (['23514', '22001', '22P02'].includes(error?.code)) return json({error: 'invalid_note'}, 400);
      return json({error: 'notes_unavailable'}, 503);
    }
  };
}
