/**
 * One-way, bounded Calendar reconciliation. Deno 2 / Node 24; no dependencies.
 * The caller owns token refresh, owner authorization and a singleton DB lease.
 * list() MUST return a fully paginated snapshot or throw. No source rows are changed.
 * Google request() must honor timeoutMs and reject with {status, reason}; error
 * messages/bodies are deliberately never returned, stored or logged here.
 */
const BINDINGS = 'cos_calendar_bindings';
const SOURCES = {
  task: {table:'commitments', select:'id,description,status,deadline,deadline_at,planned_on,next_check_on'},
  meeting: {table:'meetings', select:'id,title,status,starts_at,ends_at,location,meeting_url'}
};
const RETRY_DELAY_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECTION_REASONS = new Set(['invalid_date','invalid_timestamp','invalid_source_id','invalid_source_status','invalid_kind','invalid_generation','calendar_time_zone_required','source_title_required','meeting_end_required','meeting_end_must_follow_start','invalid_meeting_url']);
const copy = value => structuredClone(value);
const identityKey = (kind, id) => kind + ':' + String(id).toLowerCase();
const codedError = code => Object.assign(new Error(code), {code});
class BudgetStop extends Error {}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(key=>value[key] !== undefined).map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(bytes), byte=>byte.toString(16).padStart(2,'0')).join('');
}
/** The status endpoint uses exactly the same desired-state hash as the worker. */
export async function projectionHash(projection, connectionKey) {
  if (projection?.kind !== 'event' || !projection.event) return null;
  const event=copy(projection.event);
  event.extendedProperties ??= {};
  event.extendedProperties.private ??= {};
  event.extendedProperties.private.cosConnectionKey=String(connectionKey).toLowerCase();
  return digest(event);
}

function safeGoogleCode(error) {
  const status = Number(error?.status);
  if (status === 412) return 'google_etag_conflict';
  if (status === 409) return 'google_id_conflict';
  if (status === 429 || ['rateLimitExceeded','userRateLimitExceeded','quotaExceeded'].includes(error?.reason)) return 'google_rate_limited';
  if (status === 401 || status === 403) return 'google_access_denied';
  if (status === 404 || status === 410) return 'google_event_missing';
  if (status >= 500 && status <= 599) return 'google_temporarily_unavailable';
  if (status >= 400 && status < 500) return 'google_request_rejected';
  return 'google_network_error';
}
function transientOrUncertain(error) {
  const status = Number(error?.status);
  return !status || status === 409 || status === 429 || status >= 500;
}
function ownEvent(event, projection, connectionKey) {
  const owner = event?.extendedProperties?.private;
  return event?.id === projection.eventId && owner?.cosApp === 'chief-of-staff'
    && owner.cosSourceKind === projection.sourceKind && owner.cosSourceId === projection.sourceId
    && owner.cosGeneration === String(projection.generation) && owner.cosConnectionKey === connectionKey;
}
function timeView(value) {
  if (value?.date) return {date:value.date};
  if (value?.dateTime) return {instant:new Date(value.dateTime).getTime(), timeZone:value.timeZone || ''};
  return null;
}
function eventView(event) {
  return {
    id:event.id, summary:event.summary || '', description:event.description || '',
    status:event.status || 'confirmed', transparency:event.transparency || 'opaque',
    location:event.location || '', start:timeView(event.start), end:timeView(event.end),
    source:{title:event.source?.title || '',url:event.source?.url || ''},
    owner:Object.fromEntries(['cosApp','cosSourceKind','cosSourceId','cosGeneration','cosConnectionKey'].map(key=>[key,event.extendedProperties?.private?.[key]])),
    reminders:{useDefault:event.reminders?.useDefault !== false,
      overrides:(event.reminders?.overrides || []).map(({method,minutes})=>({method,minutes})).sort((a,b)=>canonical(a).localeCompare(canonical(b)))}
  };
}
function eventMatches(event, desired) { return canonical(eventView(event)) === canonical(eventView(desired)); }
function validateSnapshot(rows, kind) {
  if (!Array.isArray(rows)) throw codedError('source_snapshot_failed');
  const ids = new Set();
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || ids.has(row.id.toLowerCase())) throw codedError('source_snapshot_failed');
    ids.add(row.id.toLowerCase());
  }
  return rows.map(row=>({kind, row}));
}

export async function syncCalendar({store, connection, google, projector, now=()=>new Date(), maxMutations=20, maxMillis=40_000}) {
  const project = typeof projector === 'function' ? projector : projector?.projectCalendarRecord;
  if (!project || !UUID.test(connection?.connection_key || '') || !connection?.calendar_id || !connection?.time_zone) throw codedError('invalid_sync_configuration');
  try { new Intl.DateTimeFormat('en-US',{timeZone:connection.time_zone}).format(new Date(0)); }
  catch { throw codedError('invalid_calendar_time_zone'); }
  const connectionKey = connection.connection_key.toLowerCase();
  const calendarPath = 'calendars/' + encodeURIComponent(connection.calendar_id);
  const eventPath = id => calendarPath + '/events/' + encodeURIComponent(id);
  const clock = () => new Date(now()).getTime();
  const startedAt = clock();
  const duration = Math.max(0,Math.min(40_000,Number(maxMillis) || 0));
  const mutationLimit = Math.max(0,Math.min(20,Math.floor(Number(maxMutations) || 0)));
  const result = {scanned:0,processed:0,created:0,updated:0,deleted:0,unchanged:0,conflicts:0,errors:0,deferred:0,mutations:0,truncated:false};
  const timestamp = () => new Date(now()).toISOString();
  const remaining = () => duration - (clock() - startedAt);
  const assertBudget = (mutation=false) => {
    if (remaining() <= 0 || (mutation && result.mutations >= mutationLimit)) throw new BudgetStop();
  };
  async function request(path, options={}) {
    assertBudget();
    return google.request(path,{...options,timeoutMs:Math.max(1,Math.min(10_000,remaining()))});
  }
  async function checkCalendar() {
    try {
      const calendar = await request(calendarPath,{method:'GET'});
      if (!calendar || (calendar.id && calendar.id !== connection.calendar_id)) throw codedError('calendar_access_failed');
    } catch (error) {
      if (error instanceof BudgetStop) throw error;
      throw codedError('calendar_access_failed');
    }
  }
  if (duration === 0) return {...result,truncated:true};
  // A calendar permission error must never be interpreted as an empty event list.
  try { await checkCalendar(); } catch (error) { if (error instanceof BudgetStop || remaining()<=0) return {...result,truncated:true};throw error; }
  let entries, bindings;
  try {
    const snapshots = await Promise.all([
      store.list(SOURCES.task.table,'select='+SOURCES.task.select+'&order=id.asc',{timeoutMs:remaining()}),
      store.list(SOURCES.meeting.table,'select='+SOURCES.meeting.select+'&order=id.asc',{timeoutMs:remaining()}),
      store.list(BINDINGS,'connection_key=eq.'+encodeURIComponent(connectionKey)+'&order=source_kind.asc,source_id.asc',{timeoutMs:remaining()})
    ]);
    entries = [...validateSnapshot(snapshots[0],'task'),...validateSnapshot(snapshots[1],'meeting')];
    bindings = snapshots[2];
    if (!Array.isArray(bindings)) throw Error();
  } catch { if (remaining()<=0) return {...result,truncated:true};throw codedError('source_snapshot_failed'); }
  const bindingMap = new Map();
  for (const binding of bindings) {
    const key = identityKey(binding.source_kind,binding.source_id);
    if (binding.connection_key !== connectionKey || !SOURCES[binding.source_kind] || !UUID.test(binding.source_id || '') || bindingMap.has(key)) throw codedError('binding_snapshot_failed');
    bindingMap.set(key,binding);
  }
  const present = new Set(entries.map(entry=>identityKey(entry.kind,entry.row.id)));
  // Only after all source and binding reads have succeeded may an orphan be removed.
  for (const binding of bindings) if (!present.has(identityKey(binding.source_kind,binding.source_id))) {
    entries.push({kind:binding.source_kind,row:{id:binding.source_id,status:'cancelled'},orphan:true});
  }
  entries.sort((a,b)=> {
    const left=bindingMap.get(identityKey(a.kind,a.row.id)),right=bindingMap.get(identityKey(b.kind,b.row.id));
    return (new Date(left?.last_attempt_at || 0).getTime() || 0) - (new Date(right?.last_attempt_at || 0).getTime() || 0) || identityKey(a.kind,a.row.id).localeCompare(identityKey(b.kind,b.row.id));
  });
  result.scanned=entries.length;
  function query(binding, state=false) {
    return 'connection_key=eq.'+encodeURIComponent(connectionKey)+'&source_kind=eq.'+binding.source_kind+'&source_id=eq.'+encodeURIComponent(binding.source_id)+'&generation=eq.'+binding.generation+(state?'&state=eq.'+binding.state:'');
  }
  async function persist(binding, values, matchState=false) {
    assertBudget();
    let rows;
    try { rows=await store.patch(BINDINGS,query(binding,matchState),values,{timeoutMs:remaining()}); }
    catch { if (remaining()<=0) throw new BudgetStop();throw codedError('binding_write_failed'); }
    if (!Array.isArray(rows) || rows.length !== 1) throw codedError('binding_changed');
    Object.assign(binding,rows[0]);
    return binding;
  }
  async function createBinding(entry, projection, values) {
    const row={connection_key:connectionKey,source_kind:entry.kind,source_id:entry.row.id.toLowerCase(),generation:projection.generation ?? 0,
      event_id:projection.eventId || null,state:'error',pending_operation:null,source_hash:null,last_error:null,last_synced_at:null,last_attempt_at:timestamp(),...values};
    assertBudget();
    let saved;
    try { saved=await store.insert(BINDINGS,row,{timeoutMs:remaining()}); } catch { if (remaining()<=0) throw new BudgetStop();throw codedError('binding_write_failed'); }
    if (!saved || saved.source_id !== row.source_id) throw codedError('binding_write_failed');
    bindingMap.set(identityKey(entry.kind,entry.row.id),saved);
    return saved;
  }
  function projectionFor(entry, generation) {
    let projection;
    try { projection=project(entry.kind,entry.row,{generation,timeZone:connection.time_zone}); }
    catch { return {kind:'error',reason:'projection_failed'}; }
    if (!projection || !['event','absent','error'].includes(projection.kind)) return {kind:'error',reason:'projection_failed'};
    if (projection.kind === 'event') {
      projection=copy(projection);
      if (!projection.event || projection.event.id !== projection.eventId || projection.event.attendees?.length) return {kind:'error',reason:'projection_failed'};
      projection.event.extendedProperties ??= {};
      projection.event.extendedProperties.private ??= {};
      projection.event.extendedProperties.private.cosConnectionKey=connectionKey;
    }
    return projection;
  }
  async function conflict(binding, code) {
    await persist(binding,{state:'conflict',pending_operation:null,last_error:code,last_attempt_at:timestamp()});
    result.conflicts++;
  }
  async function success(binding, projection, hash, operation) {
    await persist(binding,{state:projection.kind==='absent'?'deleted':'active',pending_operation:null,source_hash:hash,last_error:null,last_synced_at:timestamp(),last_attempt_at:timestamp()});
    if (operation) result[operation]++; else result.unchanged++;
  }
  async function getEvent(id) {
    try { return {event:await request(eventPath(id),{method:'GET'})}; }
    catch (error) {
      if ([404,410].includes(Number(error?.status))) return {missing:true};
      throw error;
    }
  }
  function unsafeRemote(event) {
    if (event?.attendees?.length) return 'google_event_has_attendees';
    if (event?.recurrence?.length || event?.recurringEventId) return 'google_event_is_recurring';
    if (!event?.etag) return 'google_etag_missing';
    return null;
  }
  async function verifiedExisting(binding, projection, found, allowMissing=false) {
    if (found.missing) {
      if (allowMissing || binding.pending_operation==='delete') { await checkCalendar(); return null; }
      await conflict(binding,'google_event_missing'); return false;
    }
    if (found.event?.status==='cancelled') {
      if (binding.pending_operation==='delete') { await checkCalendar(); return null; }
      await conflict(binding,'google_event_deleted'); return false;
    }
    if (!ownEvent(found.event,projection,connectionKey)) { await conflict(binding,'event_ownership_mismatch'); return false; }
    const unsafe=unsafeRemote(found.event);
    if (unsafe) { await conflict(binding,unsafe); return false; }
    return found.event;
  }
  async function recover(binding, projection, hash, operation, originalError) {
    // A successful request whose response was lost is recovered by deterministic
    // lookup, never by another ID or blind conflict acceptance.
    const found=await getEvent(binding.event_id);
    const existing=await verifiedExisting(binding,projection,found,operation==='create');
    if (existing===false) return true;
    if (operation==='delete' && !existing) { await success(binding,projection,hash,'deleted'); return true; }
    if (operation!=='delete' && existing && eventMatches(existing,projection.event)) {
      await success(binding,projection,hash,operation==='create'?'created':'updated'); return true;
    }
    const code=safeGoogleCode(originalError);
    await persist(binding,{last_error:code,last_attempt_at:timestamp()});
    if (code==='google_rate_limited') throw codedError(code);
    result.errors++;
    return true;
  }
  async function mutate(binding, projection, hash, operation, existing=null) {
    assertBudget(true);
    // This intent must be durable before the remote side effect. In particular,
    // delete recovery can then distinguish our timeout from a manual deletion.
    await persist(binding,{state:'pending',pending_operation:operation,last_error:null,last_attempt_at:timestamp()});
    assertBudget(true);
    result.mutations++;
    const path=operation==='create'?calendarPath+'/events?sendUpdates=none':eventPath(binding.event_id)+'?sendUpdates=none';
    const body=projection.kind==='event'?copy(projection.event):undefined;
    if (body && operation!=='create') delete body.id;
    try {
      const response=await request(path,{method:operation==='create'?'POST':operation==='delete'?'DELETE':'PUT',
        ...(body?{body}:{}),...(existing?{headers:{'If-Match':existing.etag}}:{})});
      if (operation!=='delete' && (!response || !ownEvent(response,projection,connectionKey) || response.status==='cancelled')) {
        await recover(binding,projection,hash,operation,{status:0});return;
      }
      await success(binding,projection,hash,operation==='create'?'created':operation==='delete'?'deleted':'updated');
    } catch (error) {
      if (error instanceof BudgetStop || error?.code==='binding_write_failed' || error?.code==='binding_changed') throw error;
      if (Number(error?.status)===412) return conflict(binding,'google_etag_conflict');
      if (transientOrUncertain(error) || (operation==='delete' && [404,410].includes(Number(error?.status)))) {
        await recover(binding,projection,hash,operation,error);return;
      }
      const code=safeGoogleCode(error);
      await persist(binding,{last_error:code,last_attempt_at:timestamp()});
      if (code==='google_access_denied' || code==='google_rate_limited') throw codedError(code);
      result.errors++;
    }
  }
  for (let index=0;index<entries.length;index++) {
    const entry=entries[index];
    if (remaining()<=0 || result.mutations>=mutationLimit) {result.deferred+=entries.length-index;result.truncated=true;break;}
    let binding=bindingMap.get(identityKey(entry.kind,entry.row.id));
    try {
      if (binding?.state==='conflict') {result.conflicts++;continue;}
      let projection=projectionFor(entry,binding?.generation ?? 0);
      let hash=await projectionHash(projection,connectionKey);
      if (binding?.state==='active' && projection.kind==='event' && binding.source_hash===hash) {result.unchanged++;continue;}
      if (projection.kind==='absent' && (!binding || binding.state==='deleted')) {result.unchanged++;continue;}
      if (binding && ['pending','error'].includes(binding.state) && binding.last_error && clock()-new Date(binding.last_attempt_at || 0).getTime()<RETRY_DELAY_MS) {result.deferred++;continue;}
      assertBudget();
      // Re-read a candidate before a side effect so work based on the snapshot
      // cannot apply an already superseded source version.
      let fresh;
      try {fresh=await store.list(SOURCES[entry.kind].table,'select='+SOURCES[entry.kind].select+'&id=eq.'+encodeURIComponent(entry.row.id),{timeoutMs:remaining()});}
      catch {throw codedError('source_read_failed');}
      if (!Array.isArray(fresh) || fresh.length>1) throw codedError('source_read_failed');
      entry.row=fresh[0] || {id:entry.row.id,status:'cancelled'};
      projection=projectionFor(entry,binding?.generation ?? 0);
      if (projection.kind==='error') {
        const code=PROJECTION_REASONS.has(projection.reason)?projection.reason:'projection_failed';
        if (binding) await persist(binding,{state:binding.pending_operation?'pending':'error',last_error:code,last_attempt_at:timestamp()});
        else if (UUID.test(entry.row.id)) binding=await createBinding(entry,projection,{last_error:code});
        result.errors++;continue;
      }
      if (projection.kind==='absent' && (!binding || binding.state==='deleted')) {result.unchanged++;continue;}
      if (binding?.state==='deleted' && projection.kind==='event') {
        const next=projectionFor(entry,binding.generation+1);
        if (next.kind!=='event') throw codedError('projection_failed');
        binding=await persist(binding,{generation:next.generation,event_id:next.eventId,state:'pending',pending_operation:'create',source_hash:null,last_error:null,last_attempt_at:timestamp()},true);
        projection=next;
      }
      hash=projection.kind==='event'?await projectionHash(projection,connectionKey):await digest({absent:true});
      if (!binding) binding=await createBinding(entry,projection,{state:'pending',pending_operation:'create'});
      if (!binding.event_id && binding.state==='error' && !binding.source_hash && !binding.last_synced_at) await persist(binding,{event_id:projection.eventId,state:'pending',pending_operation:'create',last_error:null});
      if (binding.event_id!==projection.eventId) {await conflict(binding,'binding_event_id_mismatch');continue;}
      await persist(binding,{last_attempt_at:timestamp()});
      const canCreate=binding.pending_operation==='create' || (binding.state==='error' && !binding.source_hash && !binding.last_synced_at);
      const found=await getEvent(binding.event_id);
      const existing=await verifiedExisting(binding,projection,found,canCreate);
      if (existing===false) continue;
      result.processed++;
      if (binding.pending_operation==='delete') {
        // Finish a durable delete intent even if the source was reactivated.
        // Reusing this generation could race a DELETE whose response was lost.
        const absent={...projection,kind:'absent'}, absentHash=await digest({absent:true});
        if (!existing) await success(binding,absent,absentHash,'deleted');
        else await mutate(binding,absent,absentHash,'delete',existing);
        if (projection.kind==='event') {result.deferred++;result.truncated=true;}
        continue;
      }
      if (projection.kind==='absent') {
        if (!existing && binding.pending_operation==='create') {
          // A timed-out POST can still commit after this GET returned 404.
          // Keep reconciling this same generation; absence is not proof that
          // the outstanding create will never appear. A later owned event
          // is then deleted normally, without leaving an untracked orphan.
          await persist(binding,{state:'pending',pending_operation:'create',last_error:'google_create_outcome_unknown',last_attempt_at:timestamp()});
          result.errors++;
        } else if (!existing) await success(binding,projection,hash,'deleted');
        else await mutate(binding,projection,hash,'delete',existing);
      } else if (!existing) {
        if (!canCreate) await conflict(binding,'google_event_missing');
        else await mutate(binding,projection,hash,'create');
      } else if (eventMatches(existing,projection.event)) {
        await success(binding,projection,hash);
      } else {
        await mutate(binding,projection,hash,'update',existing);
      }
    } catch (error) {
      if (error instanceof BudgetStop || remaining()<=0) {result.deferred+=entries.length-index;result.truncated=true;break;}
      if (error?.code==='binding_write_failed' || error?.code==='binding_changed') throw codedError(error.code);
      const code=['source_read_failed','projection_failed','calendar_access_failed','google_access_denied','google_rate_limited'].includes(error?.code)?error.code:safeGoogleCode(error);
      if (binding) await persist(binding,{state:binding.pending_operation?'pending':'error',last_error:code,last_attempt_at:timestamp()});
      result.errors++;
      if (code==='calendar_access_failed' || code==='google_access_denied' || code==='google_rate_limited') {result.deferred+=entries.length-index-1;result.truncated=true;break;}
    }
  }
  return result;
}
