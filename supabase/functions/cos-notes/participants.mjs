// Owner-session participant writes. The handler authorizes before invoking this
// module; existing anonymous reads and RLS policies are unchanged.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELDS = 'id,name,created_at';
const eq = (key, value) => `${key}=eq.${encodeURIComponent(String(value))}`;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export class ParticipantError extends Error {
  constructor(status, code, participant) {
    super(code);
    this.status = status;
    this.code = code;
    if (participant) this.participant = participantView(participant);
  }
}
const fail = (status, code, participant) => { throw new ParticipantError(status, code, participant); };

export function normalizeParticipantName(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f\p{Cs}]/u.test(value)) {
    fail(400, 'invalid_participant');
  }
  const name = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (!name || [...name].length > 200) fail(400, 'invalid_participant');
  return name;
}
const nameKey = value => normalizeParticipantName(value).toLocaleLowerCase('ru');

function participantView(row) {
  if (!row || typeof row !== 'object' || !UUID.test(row.id) || typeof row.name !== 'string' ||
      !row.name.trim() || row.name.includes('\0')) fail(503, 'participants_unavailable');
  return {id: row.id.toLowerCase(), name: row.name,
    ...(own(row, 'created_at') ? {created_at: row.created_at} : {})};
}

function requestValues(data, id) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, 'invalid_participant');
  const allowed = id ? ['name', 'expected_name'] : ['id', 'name'];
  if (Object.keys(data).length !== 2 || Object.keys(data).some(key => !allowed.includes(key))) {
    fail(400, 'invalid_participant');
  }
  if (id ? !UUID.test(id) : typeof data.id !== 'string' || !UUID.test(data.id)) fail(400, 'invalid_participant');
  // expected_name is deliberately not trimmed: the old database value is the
  // comparison token, including any legacy spacing, rather than a new value.
  if (id && (typeof data.expected_name !== 'string' || !data.expected_name ||
      data.expected_name.length > 2000 || /[\u0000\p{Cs}]/u.test(data.expected_name))) fail(400, 'invalid_participant');
  return {id: (id || data.id).toLowerCase(), name: normalizeParticipantName(data.name), expectedName: data.expected_name};
}

async function currentParticipant(store, id) {
  const rows = await store.page('participants', `select=${FIELDS}&${eq('id', id)}&limit=1`, {timeoutMs: 8000});
  if (rows.length > 1) fail(503, 'participants_unavailable');
  return rows.length ? participantView(rows[0]) : null;
}

async function checkDuplicate(store, name, excludedId) {
  const wanted = nameKey(name);
  // Names remain real display names, never invented contact identities. We
  // flag an existing match for explicit selection instead of merging records.
  const rows = await store.list('participants', `select=${FIELDS}&order=id.asc`, {timeoutMs: 8000});
  for (const row of rows) {
    if (row.id.toLowerCase() === excludedId) continue;
    let key;
    try { key = nameKey(row.name); } catch { continue; } // Ignore unusable legacy labels.
    if (key === wanted) fail(409, 'participant_exists', row);
  }
}

export async function createParticipant({store, data}) {
  const values = requestValues(data);
  try {
    const current = await currentParticipant(store, values.id);
    if (current) {
      if (current.name === values.name) return {participant: current, replayed: true};
      fail(409, 'participant_request_conflict', current);
    }
    await checkDuplicate(store, values.name, values.id);
    let row;
    try {
      row = await store.insert('participants', {id: values.id, name: values.name}, {timeoutMs: 8000});
    } catch (error) {
      if (error?.code !== '23505') throw error;
      // Concurrent retries with the same client UUID settle on the same row.
      const retry = await currentParticipant(store, values.id);
      if (!retry) throw error;
      if (retry.name === values.name) return {participant: retry, replayed: true};
      fail(409, 'participant_request_conflict', retry);
    }
    const participant = participantView(row);
    if (participant.id !== values.id || participant.name !== values.name) fail(503, 'participants_unavailable');
    return {participant, replayed: false};
  } catch (error) {
    if (error instanceof ParticipantError) throw error;
    fail(503, 'participants_unavailable');
  }
}

export async function updateParticipant({store, id, data}) {
  const values = requestValues(data, id);
  try {
    const current = await currentParticipant(store, values.id);
    if (!current) fail(404, 'participant_not_found');
    if (current.name === values.name) return {participant: current, replayed: true};
    if (current.name !== values.expectedName) fail(409, 'participant_conflict', current);
    await checkDuplicate(store, values.name, values.id);
    // Keep the participant ID and all task/meeting references. The name filter
    // makes two competing edits safe without schema changes or public writes.
    const rows = await store.patch('participants', `${eq('id', values.id)}&${eq('name', values.expectedName)}`,
      {name: values.name}, {timeoutMs: 8000});
    if (rows.length === 1) {
      const participant = participantView(rows[0]);
      if (participant.id !== values.id || participant.name !== values.name) fail(503, 'participants_unavailable');
      return {participant, replayed: false};
    }
    if (rows.length !== 0) fail(503, 'participants_unavailable');
    const latest = await currentParticipant(store, values.id);
    if (!latest) fail(404, 'participant_not_found');
    if (latest.name === values.name) return {participant: latest, replayed: true};
    fail(409, 'participant_conflict', latest);
  } catch (error) {
    if (error instanceof ParticipantError) throw error;
    fail(503, 'participants_unavailable');
  }
}
