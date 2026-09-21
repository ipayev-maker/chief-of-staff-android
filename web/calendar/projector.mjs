/**
 * Pure Google Calendar projection. Node.js 24+, no dependencies or network.
 * Input: Supabase commitment/meeting row and the target calendar's IANA time zone.
 * Output: event (desired state), absent (explicit removal), or error (keep old event).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP = 'chief-of-staff';
const APP_URL = 'https://chief-of-staff-v3-live.vercel.app/';
function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw Error('invalid_date');
  const parsed = new Date(value + 'T00:00:00.000Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw Error('invalid_date');
  return parsed;
}
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw Error('invalid_timestamp');
  day(value.slice(0, 10));
  const parts = value.slice(11).match(/^(\d{2}):(\d{2}):(\d{2})/);
  if (+parts[1] > 23 || +parts[2] > 59 || +parts[3] > 59) throw Error('invalid_timestamp');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw Error('invalid_timestamp');
  return parsed;
}
function inZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {timeZone, year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(date);
  const get = type => parts.find(part => part.type === type).value;
  return get('year') + '-' + get('month') + '-' + get('day');
}
function html(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
export function projectCalendarRecord(kind, record, options = {}) {
  let identity = null;
  try {
    if (!['task', 'meeting'].includes(kind)) throw Error('invalid_kind');
    if (!record || !UUID.test(record.id)) throw Error('invalid_source_id');
    // The executor must persist and serialize generation changes before API calls.
    // Retry within one generation; increment only after confirmed deletion.
    const generation = options.generation ?? 0;
    if (!Number.isSafeInteger(generation) || generation < 0) throw Error('invalid_generation');
    identity = {sourceKind:kind, sourceId:record.id.toLowerCase(), generation,
      eventId:(kind === 'task' ? 'cosd' : 'cosm') + record.id.replaceAll('-', '').toLowerCase() + (generation ? 'g' + generation.toString(16) : '')};
    const states = kind === 'task' ? ['open','paused','completed','cancelled'] : ['scheduled','in_progress','completed','cancelled'];
    if (!states.includes(record.status)) throw Error('invalid_source_status');
    if (record.status === 'cancelled') return {kind:'absent', ...identity, reason:'cancelled'};
    if (kind === 'task' && !record.deadline && !record.deadline_at) return {kind:'absent', ...identity, reason:'deadline_removed'};
    const timeZone = options.timeZone;
    if (!timeZone || typeof timeZone !== 'string') throw Error('calendar_time_zone_required');
    new Intl.DateTimeFormat('en-US', {timeZone}).format(new Date(0));
    const title = kind === 'task' ? record.description : record.title;
    if (typeof title !== 'string' || !title.trim()) throw Error('source_title_required');
    const warnings = [];
    const description = ['Chief of Staff', options.projectTitle ? 'Проект: ' + html(options.projectTitle) : null].filter(Boolean);
    const event = {
      id:identity.eventId,
      summary:(record.status === 'completed' ? '✓ ' : record.status === 'paused' ? '⏸ ' : '') + (kind === 'task' ? 'Срок: ' : '') + title.trim(),
      status:'confirmed',
      transparency:kind === 'task' ? 'transparent' : 'opaque',
      source:{title:'Chief of Staff', url:APP_URL},
      extendedProperties:{private:{cosApp:APP, cosSourceKind:kind, cosSourceId:identity.sourceId, cosGeneration:String(identity.generation)}},
      reminders:record.status === 'completed' ? {useDefault:false, overrides:[]} : {useDefault:true}
    };
    if (kind === 'task' && record.deadline_at) {
      const start = instant(record.deadline_at);
      event.start = {dateTime:start.toISOString(), timeZone};
      event.end = {dateTime:new Date(start.getTime() + 60000).toISOString(), timeZone};
      description.push('Маркер крайнего срока на одну минуту. Не обозначает продолжительность работы и не занимает время.');
      if (record.deadline) {
        day(record.deadline);
        if (record.deadline !== inZone(start, timeZone)) warnings.push('deadline_date_differs_from_timestamp');
      }
    } else if (kind === 'task') {
      const end = day(record.deadline);
      end.setUTCDate(end.getUTCDate() + 1);
      event.start = {date:record.deadline};
      event.end = {date:end.toISOString().slice(0, 10)};
      description.push('Крайний срок задачи. Время не задано; отметка на весь день не занимает рабочее время.');
    } else {
      const start = instant(record.starts_at);
      if (!record.ends_at) throw Error('meeting_end_required');
      const end = instant(record.ends_at);
      if (end <= start) throw Error('meeting_end_must_follow_start');
      event.start = {dateTime:start.toISOString(), timeZone};
      event.end = {dateTime:end.toISOString(), timeZone};
      if (record.location) event.location = String(record.location);
      if (record.meeting_url) {
        const link = new URL(record.meeting_url);
        if (link.protocol !== 'https:' && link.protocol !== 'http:') throw Error('invalid_meeting_url');
        description.push('Ссылка на встречу: ' + html(link.href));
      }
    }
    event.description = description.join('\n');
    return {kind:'event', ...identity, event, warnings};
  } catch (error) {
    return {kind:'error', ...(identity || {}), reason:error.message || 'projection_failed'};
  }
}
export function planCalendarChange(projection, existing = null) {
  if (!projection || typeof projection !== 'object') return {operation:'hold', reason:'invalid_projection'};
  if (projection.kind === 'error') return {operation:'hold', reason:projection.reason};
  if (!['event','absent'].includes(projection.kind) || !projection.eventId) return {operation:'hold', reason:'invalid_projection'};
  if (existing) {
    const owner = existing.extendedProperties?.private;
    if (existing.id !== projection.eventId || owner?.cosApp !== APP || owner.cosSourceKind !== projection.sourceKind || owner.cosSourceId !== projection.sourceId || owner.cosGeneration !== String(projection.generation)) {
      return {operation:'hold', reason:'event_ownership_mismatch'};
    }
    // Cancelled Google events may be tombstones with no metadata. Never silently
    // recreate or edit them; the connection must resolve this case explicitly.
    if (existing.status === 'cancelled') return {operation:'hold', reason:'google_event_cancelled'};
  }
  if (projection.kind === 'absent') return existing ? {operation:'delete', eventId:existing.id} : {operation:'noop'};
  return {operation:existing ? 'update' : 'insert', event:projection.event, warnings:projection.warnings};
}
