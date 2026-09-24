// Owner authentication and same-origin checks belong to the enclosing notes handler.
// Node.js 24 / Deno Web APIs only; this module never exposes private history snapshots.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELDS = Object.freeze(['goal', 'current_state', 'next_step', 'checkpoint_label', 'checkpoint_on', 'entries']);
const ENTRY_FIELDS = Object.freeze(['id', 'kind', 'text', 'person', 'review_on', 'source', 'status']);
const MAX_REVISION = 2147483646;
const MAX_DOCUMENT_BYTES = 96 * 1024;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
export class ProjectBriefError extends Error {
  constructor(status, code) { super(code); this.name = 'ProjectBriefError'; this.status = status; this.code = code; }
}
const fail = (status, code) => { throw new ProjectBriefError(status, code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length && fields.every(key => own(value, key));
function text(value, maximum) {
  if (typeof value !== 'string' || value.includes('\0')) return false;
  const points = [...value];
  return points.length <= maximum && !points.some(point => point.codePointAt(0) >= 0xd800 && point.codePointAt(0) <= 0xdfff);
}
function day(value) {
  if (value === null) return true;
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function databaseJson(value) {
  if (Array.isArray(value)) return '[' + value.map(databaseJson).join(', ') + ']';
  if (object(value)) return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ': ' + databaseJson(item)).join(', ') + '}';
  return JSON.stringify(value);
}
function projectId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail(400, 'invalid_project');
  return value.toLowerCase();
}
export function emptyProjectBrief() {
  return {goal: '', current_state: '', next_step: '', checkpoint_label: '', checkpoint_on: null, entries: []};
}
export function validateProjectBriefDocument(value) {
  if (!exact(value, FIELDS) || !text(value.goal, 2000) || !text(value.current_state, 4000) ||
      !text(value.next_step, 2000) || !text(value.checkpoint_label, 500) || !day(value.checkpoint_on) ||
      !Array.isArray(value.entries) || value.entries.length > 60) fail(400, 'invalid_project_brief');
  const ids = new Set();
  const entries = value.entries.map(entry => {
    if (!exact(entry, ENTRY_FIELDS) || typeof entry.id !== 'string' || !UUID.test(entry.id) ||
        !['waiting', 'question', 'decision'].includes(entry.kind) || !text(entry.text, 2000) ||
        !entry.text.trim() || entry.text !== entry.text.trim() || !text(entry.person, 300) ||
        !text(entry.source, 1000) || !day(entry.review_on) ||
        (entry.kind === 'decision' && entry.review_on !== null) || !['open', 'resolved'].includes(entry.status)) {
      fail(400, 'invalid_project_brief');
    }
    const id = entry.id.toLowerCase();
    if (ids.has(id)) fail(400, 'invalid_project_brief');
    ids.add(id);
    return {...entry, id};
  });
  const result = {...value, entries};
  if (new TextEncoder().encode(databaseJson(result)).length > MAX_DOCUMENT_BYTES) fail(400, 'project_brief_too_large');
  return result;
}
function mapError(error) {
  if (error instanceof ProjectBriefError) return error;
  const mappings = {
    PT404: [404, 'project_not_found'], PT409: [409, 'project_brief_conflict'],
    PT400: [400, 'invalid_project_brief'], '23514': [400, 'invalid_project_brief'],
    '22001': [400, 'invalid_project_brief'], '22P02': [400, 'invalid_project_brief'],
  };
  const mapped = own(mappings, error?.code) ? mappings[error.code] : null;
  return mapped ? new ProjectBriefError(...mapped) : new ProjectBriefError(503, 'project_brief_unavailable');
}
function snapshot(result, id, saving) {
  if (!object(result) || result.project_id !== id || !Number.isSafeInteger(result.revision) ||
      result.revision < (saving ? 1 : 0) || result.revision > MAX_REVISION + 1 ||
      (result.revision === 0 ? result.updated_at !== null : typeof result.updated_at !== 'string' || !Number.isFinite(Date.parse(result.updated_at))) ||
      !Array.isArray(result.history) || result.history.length > 20 ||
      (saving && typeof result.replayed !== 'boolean')) fail(503, 'project_brief_unavailable');
  let document;
  try { document = validateProjectBriefDocument(result.document); }
  catch { fail(503, 'project_brief_unavailable'); }
  let lastRevision = result.revision + 1;
  const history = result.history.map(item => {
    if (!object(item) || !Number.isSafeInteger(item.revision) || item.revision < 1 || item.revision >= lastRevision ||
        typeof item.created_at !== 'string' || !Number.isFinite(Date.parse(item.created_at)) ||
        !Array.isArray(item.changed_fields) || new Set(item.changed_fields).size !== item.changed_fields.length ||
        item.changed_fields.some(key => !FIELDS.includes(key))) fail(503, 'project_brief_unavailable');
    lastRevision = item.revision;
    return {revision: item.revision, created_at: item.created_at, changed_fields: [...item.changed_fields]};
  });
  if (result.revision === 0 && (history.length || FIELDS.some(key => key === 'entries' ? document.entries.length !== 0 : document[key] !== emptyProjectBrief()[key]))) {
    fail(503, 'project_brief_unavailable');
  }
  return {project_id: id, revision: result.revision, updated_at: result.updated_at, document, history,
    ...(saving ? {replayed: result.replayed} : {})};
}
export async function getProjectBrief({store, projectId: value}) {
  const id = projectId(value);
  try { return snapshot(await store.rpc('cos_get_project_brief', {p_project_id: id}), id, false); }
  catch (error) { throw mapError(error); }
}
export async function saveProjectBrief({store, projectId: value, data}) {
  const id = projectId(value);
  if (!exact(data, ['revision', 'request_id', 'document']) || !Number.isSafeInteger(data.revision) ||
      data.revision < 0 || data.revision > MAX_REVISION || typeof data.request_id !== 'string' || !UUID.test(data.request_id)) {
    fail(400, 'invalid_project_brief_request');
  }
  const document = validateProjectBriefDocument(data.document);
  try {
    const result = snapshot(await store.rpc('cos_save_project_brief', {p_project_id: id, p_revision: data.revision,
      p_request_id: data.request_id.toLowerCase(), p_document: document}), id, true);
    if (result.revision < data.revision + 1 || (!result.replayed &&
        (result.revision !== data.revision + 1 || databaseJson(result.document) !== databaseJson(document)))) {
      fail(503, 'project_brief_unavailable');
    }
    return result;
  } catch (error) { throw mapError(error); }
}
