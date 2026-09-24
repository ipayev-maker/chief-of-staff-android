import {APP_ORIGIN, sha256} from '../cos-google-calendar/google.mjs';

const SESSION_COOKIE = '__Host-cos-calendar-session';
const MAX_BODY_BYTES = 128 * 1024;
const BODY_TIMEOUT_MS = 10_000;
const NOTE_FIELDS = Object.freeze([
  'id', 'title', 'plain_text', 'project_id', 'source', 'source_message_id',
  'telegram_chat_id', 'telegram_message_id', 'telegram_update_id',
  'archived_at', 'created_at', 'updated_at', 'revision',
]);
const TASK_FIELDS = Object.freeze([
  'description', 'details', 'status', 'direction', 'project_id', 'area_key', 'participant_id',
  'deadline', 'planned_on', 'next_check_on', 'planned_start_at', 'planned_end_at',
  'deadline_at', 'next_check_at', 'estimate_minutes',
]);
const TASK_RESPONSE_FIELDS = Object.freeze(['id', ...TASK_FIELDS, 'created_at', 'updated_at', 'cos_version', 'deleted_at']);
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

function resource(url) {
  const match = /^\/(?:api\/notes|functions\/v1\/cos-notes|cos-notes)(?:\/(.*?))?\/?$/.exec(url.pathname);
  if (!match) fail(404, 'not_found');
  const path = match[1] || '';
  if (!path) return {kind: 'notes', methods: ['GET', 'POST']};
  let parts = /^tasks\/([^/]+)\/source$/.exec(path);
  if (parts) return {kind: 'taskSource', id: resourceUuid(parts[1]), methods: ['GET']};
  parts = /^tasks\/([^/]+)$/.exec(path);
  if (parts) return {kind: 'deleteTask', id: resourceUuid(parts[1]), methods: ['DELETE']};
  parts = /^project\/([^/]+)$/.exec(path);
  if (parts) return {kind: 'projectNote', id: resourceUuid(parts[1]), methods: ['DELETE']};
  parts = /^project\/([^/]+)\/tasks$/.exec(path);
  if (parts) return {kind: 'createTask', sourceKind: 'project', id: resourceUuid(parts[1]), methods: ['POST']};
  parts = /^([^/]+)\/tasks$/.exec(path);
  if (parts) return {kind: 'createTask', sourceKind: 'quick', id: resourceUuid(parts[1]), methods: ['POST']};
  if (path.includes('/')) fail(404, 'not_found');
  return {kind: 'note', id: resourceUuid(path), methods: ['GET', 'PATCH', 'DELETE']};
}
function resourceUuid(value) {
  if (!UUID.test(value)) fail(400, 'invalid_id');
  return value.toLowerCase();
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
  const allowed = new Set(['archived', 'limit', 'offset', 'project_id']);
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
  const projectId = url.searchParams.get('project_id');
  if (projectId !== null && projectId !== 'null' && !UUID.test(projectId)) fail(400, 'invalid_project');
  return {archived: archived === 'true', limit: Number(rawLimit), offset: Number(rawOffset),
    projectId: projectId === null ? undefined : projectId === 'null' ? null : projectId.toLowerCase()};
}

function validDay(value) {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validInstant(value) {
  if (typeof value !== 'string') return false;
  const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  return !!parts && validDay(parts[1]) && +parts[2] < 24 && +parts[3] < 60 && +parts[4] < 60 &&
    (parts[6] === undefined || (+parts[6] < 24 && +parts[7] < 60)) && Number.isFinite(Date.parse(value));
}

function taskValues(data) {
  if (Object.keys(data).some(key => !['request_id', 'task'].includes(key)) ||
      typeof data.request_id !== 'string' || !UUID.test(data.request_id) ||
      !data.task || typeof data.task !== 'object' || Array.isArray(data.task) ||
      Object.keys(data.task).some(key => !TASK_FIELDS.includes(key))) fail(400, 'invalid_task');
  const task = data.task;
  if (typeof task.description !== 'string' || !task.description.trim() || task.description.length > 2000 ||
      task.description.includes('\0')) fail(400, 'invalid_task');
  const values = {description: task.description.trim(), details: own(task, 'details') ? task.details : '',
    status: own(task, 'status') ? task.status : 'open', direction: own(task, 'direction') ? task.direction : 'internal'};
  if (typeof values.details !== 'string' || values.details.length > 64000 || values.details.includes('\0') ||
      !['open', 'paused', 'completed', 'cancelled'].includes(values.status) ||
      !['internal', 'from_me', 'to_me'].includes(values.direction)) fail(400, 'invalid_task');
  for (const key of ['project_id', 'participant_id']) {
    const value = own(task, key) ? task[key] : null;
    if (value !== null && (typeof value !== 'string' || !UUID.test(value))) fail(400, 'invalid_task');
    values[key] = value?.toLowerCase() || null;
  }
  const area = own(task, 'area_key') ? task.area_key : null;
  if (area !== null && (typeof area !== 'string' || !area.trim() || area.length > 100 || area.includes('\0'))) fail(400, 'invalid_task');
  values.area_key = area;
  for (const key of ['deadline', 'planned_on', 'next_check_on', 'planned_start_at', 'planned_end_at', 'deadline_at', 'next_check_at']) {
    const value = own(task, key) ? task[key] : null;
    if (value !== null && !(key.endsWith('_at') ? validInstant(value) : validDay(value))) fail(400, 'invalid_task');
    values[key] = value;
  }
  if (values.planned_end_at && (!values.planned_start_at || Date.parse(values.planned_end_at) < Date.parse(values.planned_start_at))) {
    fail(400, 'invalid_task');
  }
  const estimate = own(task, 'estimate_minutes') ? task.estimate_minutes : null;
  if (estimate !== null && (!Number.isSafeInteger(estimate) || estimate < 1 || estimate > 525600)) fail(400, 'invalid_task');
  values.estimate_minutes = estimate;
  return {requestId: data.request_id.toLowerCase(), task: values};
}

function sourceView(source) {
  if (!source || !['quick', 'project'].includes(source.kind) || !UUID.test(source.id) ||
      (source.project_id !== null && !UUID.test(source.project_id))) fail(503, 'notes_unavailable');
  return {kind: source.kind, id: source.id, project_id: source.project_id};
}

function taskResult(result) {
  if (result?.task?.deleted_at) fail(409, 'task_deleted');
  if (!result?.task || !UUID.test(result.task.id) || typeof result.replayed !== 'boolean') fail(503, 'notes_unavailable');
  return {task: Object.fromEntries(TASK_RESPONSE_FIELDS.filter(key => own(result.task, key)).map(key => [key, result.task[key]])),
    source: sourceView(result.source), replayed: result.replayed};
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
    let creatingTask = false, deletingTask = false;
    try {
      const url = new URL(request.url);
      const route = resource(url);
      const {id} = route;
      const method = request.method;
      if (!route.methods.includes(method)) return json({error: 'method_not_allowed'}, 405);
      if (method !== 'GET' && request.headers.get('Origin') !== APP_ORIGIN) fail(403, 'invalid_origin');
      await authenticate(request);
      if (route.kind === 'deleteTask') {
        deletingTask = true;
        if (url.search) fail(400, 'invalid_request');
        const data = await readJson(request);
        if (Object.keys(data).length !== 1 || !own(data, 'version') || !Number.isSafeInteger(data.version) ||
            data.version < 1 || data.version >= 2147483647) fail(400, 'invalid_task_delete');
        // The service-only RPC locks the row, checks the version and running
        // timers, and retains history/media/backlinks in the same transaction.
        const result = await store.rpc('cos_delete_task', {p_id: id, p_version: data.version});
        if (result?.ok !== true || result.id !== id) fail(503, 'notes_unavailable');
        return json({ok: true, id});
      }
      if (route.kind === 'createTask') {
        creatingTask = true;
        if (url.search) fail(400, 'invalid_request');
        const {requestId, task} = taskValues(await readJson(request));
        // Source existence/archival and replay are checked inside the same
        // service-only transaction as task + private backlink insertion.
        const result = taskResult(await store.rpc('cos_notes_create_task', {
          p_source_kind: route.sourceKind, p_source_id: id, p_request_id: requestId, p_task: task,
        }));
        return json(result, result.replayed ? 200 : 201);
      }
      if (route.kind === 'taskSource') {
        if (url.search) fail(400, 'invalid_request');
        const links = await store.page('cos_note_task_links',
          `select=source_kind,source_id&${eq('commitment_id', id)}&order=request_id.asc&limit=1`, {timeoutMs: 8000});
        if (!links.length) return json({source: null});
        const link = links[0];
        if (!['quick', 'project'].includes(link.source_kind) || !UUID.test(link.source_id)) fail(503, 'notes_unavailable');
        const rows = await store.page(link.source_kind === 'quick' ? 'quick_notes' : 'project_notes',
          `select=id,project_id&${eq('id', link.source_id)}&deleted_at=is.null&limit=1`, {timeoutMs: 8000});
        if (!rows.length) return json({source: null});
        return json({source: sourceView({kind: link.source_kind, id: rows[0].id, project_id: rows[0].project_id})});
      }
      if (method === 'GET') {
        if (id) {
          if (url.search) fail(400, 'invalid_request');
          const rows = await store.page('quick_notes', `${eq('id', id)}&deleted_at=is.null&select=${NOTE_FIELDS.join(',')}&limit=1`, {timeoutMs: 8000});
          if (!rows.length) fail(404, 'note_not_found');
          return json({note: noteView(rows[0])});
        }
        const {archived, limit, offset, projectId} = pagination(url);
        const query = new URLSearchParams({
          select: NOTE_FIELDS.join(','), deleted_at: 'is.null', archived_at: archived ? 'not.is.null' : 'is.null',
          order: 'created_at.desc,id.desc', limit: String(limit + 1), offset: String(offset),
        });
        if (projectId !== undefined) query.set('project_id', projectId === null ? 'is.null' : 'eq.' + projectId);
        const rows = await store.page('quick_notes', query, {timeoutMs: 8000});
        return json({notes: rows.slice(0, limit).map(noteView), nextOffset: rows.length > limit ? offset + limit : null});
      }
      if (url.search) fail(400, 'invalid_request');
      const data = await readJson(request);
      if (method === 'DELETE') {
        const projectNote = route.kind === 'projectNote';
        const version = projectNote ? 'updated_at' : 'revision';
        if (Object.keys(data).length !== 1 || !own(data, version) ||
            (projectNote ? !validInstant(data.updated_at) : !Number.isSafeInteger(data.revision) || data.revision < 1 || data.revision >= 2147483647)) {
          fail(400, projectNote ? 'invalid_request' : 'invalid_revision');
        }
        const table = projectNote ? 'project_notes' : 'quick_notes';
        const timestamp = now().toISOString();
        // Keep tombstones/backlinks and Telegram receipts. Old delivery/task
        // request IDs remain bound to the original records after deletion.
        const rows = await store.patch(table,
          `${eq('id', id)}&${eq(version, data[version])}&deleted_at=is.null`,
          {deleted_at: timestamp, archived_at: timestamp, ...(projectNote ? {pinned: false} : {})}, {timeoutMs: 8000});
        if (rows.length === 1 && rows[0].id === id && rows[0].deleted_at) return json({deleted: true, id});
        if (rows.length !== 0) fail(503, 'notes_unavailable');
        const current = await store.page(table, `${eq('id', id)}&select=${projectNote ? 'id,deleted_at' : NOTE_FIELDS.join(',') + ',deleted_at'}&limit=1`, {timeoutMs: 8000});
        // A repeated delete is safe even if its first response was lost.
        if (current.length === 1 && current[0].deleted_at) return json({deleted: true, id});
        if (!current.length) fail(404, 'note_not_found');
        return json({error: projectNote ? 'project_note_conflict' : 'revision_conflict', ...(!projectNote ? {note: noteView(current[0])} : {})}, 409);
      }
      const values = noteValues(data, method === 'POST', now().toISOString());
      if (method === 'POST') {
        const row = await store.insert('quick_notes', values, {timeoutMs: 8000});
        return json({note: noteView(row)}, 201);
      }
      const rows = await store.patch('quick_notes', `${eq('id', id)}&${eq('revision', data.revision)}&deleted_at=is.null`, values, {timeoutMs: 8000});
      if (rows.length === 1) return json({note: noteView(rows[0])});
      if (rows.length !== 0) fail(503, 'notes_unavailable');
      const current = await store.page('quick_notes', `${eq('id', id)}&deleted_at=is.null&select=${NOTE_FIELDS.join(',')}&limit=1`, {timeoutMs: 8000});
      if (!current.length) fail(404, 'note_not_found');
      return json({error: 'revision_conflict', note: noteView(current[0])}, 409);
    } catch (error) {
      if (error instanceof NotesError) return json({error: error.code}, error.status);
      if (deletingTask) {
        const mappings = {
          PT400: [400, 'invalid_task_delete'], PT404: [404, 'task_not_found'],
          PT409: [409, 'task_version_conflict'], PT423: [409, 'task_timer_running'],
          PT410: [409, 'task_deleted'],
        };
        const mapped = own(mappings, error?.code) ? mappings[error.code] : null;
        return mapped ? json({error: mapped[1]}, mapped[0]) : json({error: 'notes_unavailable'}, 503);
      }
      if (creatingTask && error?.code === 'PT404') return json({error: 'note_not_found'}, 404);
      if (creatingTask && error?.code === 'PT410') return json({error: 'source_archived'}, 409);
      if (creatingTask && error?.code === 'PT409') return json({error: 'task_request_conflict'}, 409);
      if (creatingTask && ['PT400', '23503', '23514', '22001', '22P02', '22007', '22008', '22003'].includes(error?.code)) {
        return json({error: 'invalid_task'}, 400);
      }
      if (error?.code === '23503') return json({error: 'invalid_project'}, 400);
      if (['23514', '22001', '22P02'].includes(error?.code)) return json({error: 'invalid_note'}, 400);
      return json({error: 'notes_unavailable'}, 503);
    }
  };
}
