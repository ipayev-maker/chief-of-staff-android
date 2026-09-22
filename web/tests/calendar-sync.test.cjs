// Node.js 24 built-in tests. All source rows, storage and Google calls are synthetic.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const modules=Promise.all([import('../../supabase/functions/cos-google-calendar/sync.mjs'),import('../calendar/projector.mjs')]);
const clone=value=>structuredClone(value);
const uuid=n=>'12345678-1234-4123-8123-'+String(n).padStart(12,'0');
const task=(n=1,extra={})=>({id:uuid(n),description:'Synthetic '+n,status:'open',deadline:'2028-02-29',...extra});
const connection={connection_key:uuid(900),calendar_id:'dedicated@example.invalid',time_zone:'Europe/Berlin'};
const key=row=>row.source_kind+':'+row.source_id;
const error=(status,reason)=>Object.assign(new Error('private response body must not be logged'),{status,reason});
async function fixture(tasks=[task()],meetings=[]) {
  const [{syncCalendar},projector]=await modules;
  let clock=Date.parse('2026-09-22T12:00:00Z'),serial=0;
  const data={commitments:clone(tasks),meetings:clone(meetings),cos_calendar_bindings:[]};
  const dbCalls=[],googleCalls=[],events=new Map();
  const env={data,events,dbCalls,googleCalls,connection:clone(connection),projector,
    advance(ms=61_000){clock+=ms},now:()=>new Date(clock),storeHook:null,googleHook:null};
  function matches(row,query) {
    for(const [name,value] of new URLSearchParams(query))if(value.startsWith('eq.') && String(row[name])!==value.slice(3))return false;
    return true;
  }
  const store={
    async list(table,query='') {
      dbCalls.push({operation:'list',table,query});await env.storeHook?.({operation:'list',table,query});
      return clone(data[table].filter(row=>matches(row,query)));
    },
    async insert(table,row) {
      dbCalls.push({operation:'insert',table,row:clone(row)});await env.storeHook?.({operation:'insert',table,row});
      if(data[table].some(existing=>key(existing)===key(row)))throw error(409);
      data[table].push(clone(row));return clone(row);
    },
    async patch(table,query,values) {
      dbCalls.push({operation:'patch',table,query,values:clone(values)});await env.storeHook?.({operation:'patch',table,query,values});
      const matchesRows=data[table].filter(row=>matches(row,query));for(const row of matchesRows)Object.assign(row,clone(values));return clone(matchesRows);
    }
  };
  const google={async request(path,options={}) {
    const request={path,...clone(options)};googleCalls.push(request);
    assert.ok(options.timeoutMs>0 && options.timeoutMs<=10_000);
    await env.googleHook?.(request,'before');
    const pathname=path.split('?')[0],base='calendars/'+encodeURIComponent(connection.calendar_id);
    let response;
    if(pathname===base) {
      assert.equal(options.method,'GET');response={id:connection.calendar_id,timeZone:connection.time_zone};
    } else {
      assert.ok(pathname.startsWith(base+'/events'));const id=decodeURIComponent(pathname.slice((base+'/events/').length));
      if(options.method==='GET') {if(!events.has(id))throw error(404,'notFound');response=clone(events.get(id));}
      else {
        assert.ok(path.includes('sendUpdates=none'));assert.equal(options.body?.attendees,undefined);
        if(options.method==='POST') {
          assert.ok(options.body.id);if(events.has(options.body.id))throw error(409,'duplicate');
          response={...clone(options.body),etag:'"v'+(++serial)+'"'};events.set(response.id,response);
        } else {
          const existing=events.get(id);if(!existing || existing.status==='cancelled')throw error(410,'deleted');
          if(options.headers?.['If-Match']!==existing.etag)throw error(412,'conditionNotMet');
          if(options.method==='PUT') {response={...clone(options.body),id,etag:'"v'+(++serial)+'"'};events.set(id,response);}
          else if(options.method==='DELETE') {events.set(id,{id,status:'cancelled',etag:'"v'+(++serial)+'"'});response=null;}
          else throw Error('unexpected_method');
        }
      }
    }
    await env.googleHook?.(request,'after');return clone(response);
  }};
  env.run=(options={})=>syncCalendar({store,connection:env.connection,google,projector,now:env.now,...options});
  env.binding=(n=1,kind='task')=>data.cos_calendar_bindings.find(row=>row.source_id===uuid(n)&&row.source_kind===kind);
  env.event=(n=1,kind='task')=>events.get(env.binding(n,kind)?.event_id);
  env.mutations=()=>googleCalls.filter(call=>call.method!=='GET');
  env.desired=(row,kind='task',generation=0)=>{
    const projected=projector.projectCalendarRecord(kind,row,{generation,timeZone:connection.time_zone});
    projected.event.extendedProperties.private.cosConnectionKey=connection.connection_key;
    return {...projected.event,etag:'"existing"'};
  };
  return env;
}

test('lifecycle: import, move to exact instant, complete, cancel, reactivate in persisted new generation',async()=>{
  const env=await fixture();let result=await env.run();assert.equal(result.created,1);assert.equal(result.mutations,1);
  const firstId=env.binding().event_id;assert.equal(env.binding().generation,0);
  assert.deepEqual(env.event().start,{date:'2028-02-29'});assert.deepEqual(env.event().end,{date:'2028-03-01'});
  env.data.commitments[0].deadline_at='2028-03-01T00:30:00+03:00';result=await env.run();
  assert.equal(result.updated,1);assert.equal(env.binding().event_id,firstId);
  assert.deepEqual(env.event().start,{dateTime:'2028-02-29T21:30:00.000Z',timeZone:'Europe/Berlin'});assert.equal(env.event().start.date,undefined);
  env.data.commitments[0].status='completed';await env.run();assert.match(env.event().summary,/^✓ /);assert.deepEqual(env.event().reminders,{useDefault:false,overrides:[]});
  env.data.commitments[0].status='cancelled';result=await env.run();assert.equal(result.deleted,1);assert.equal(env.binding().state,'deleted');assert.equal(env.events.get(firstId).status,'cancelled');
  env.data.commitments[0].status='open';env.googleHook=async(request,phase)=>{
    if(request.method==='POST'&&phase==='before') {assert.equal(env.binding().generation,1);assert.equal(env.binding().state,'pending');assert.equal(env.binding().pending_operation,'create');}
  };
  await env.run();assert.equal(env.binding().generation,1);assert.notEqual(env.binding().event_id,firstId);assert.equal(env.binding().state,'active');
  assert.equal(env.events.size,2);assert.equal(env.data.commitments[0].description,'Synthetic 1');
});

test('initial import includes completed history and meetings preserve DST UTC instants',async()=>{
  const meeting={id:uuid(2),title:'Synthetic DST meeting',status:'completed',starts_at:'2026-10-25T02:30:00+02:00',ends_at:'2026-10-25T02:30:00+01:00',location:'Room',meeting_url:'https://example.invalid/call'};
  const env=await fixture([task(1,{status:'completed'})],[meeting]);await env.run();
  assert.equal(env.events.size,2);assert.match(env.event().summary,/^✓ /);
  const event=env.event(2,'meeting');assert.equal(new Date(event.end.dateTime)-new Date(event.start.dateTime),3600_000);assert.equal(event.start.timeZone,'Europe/Berlin');assert.equal(event.attendees,undefined);
  env.data.meetings[0].location=null;env.data.meetings[0].meeting_url=null;await env.run();assert.equal(env.event(2,'meeting').location,undefined);assert.equal(env.event(2,'meeting').description.includes('/call'),false);
});

test('source hash avoids unchanged event API calls and ignores planned/next-check fields',async()=>{
  const env=await fixture();await env.run();const before=env.googleCalls.length;
  env.data.commitments[0].planned_on='2030-01-01';env.data.commitments[0].next_check_on='2030-02-01';
  const result=await env.run();assert.equal(result.unchanged,1);assert.equal(env.googleCalls.length-before,1);
  assert.match(env.binding().source_hash,/^[a-f0-9]{64}$/);
});

test('removing a deadline retracts only the owned event; planned date is not substituted',async()=>{
  const env=await fixture();await env.run();env.data.commitments[0].deadline=null;env.data.commitments[0].planned_on='2030-01-01';
  const result=await env.run();assert.equal(result.deleted,1);assert.equal(env.binding().state,'deleted');assert.equal(env.event().status,'cancelled');
});

test('POST timeout with successful remote insert recovers through ownership-checked GET',async()=>{
  const env=await fixture();let once=true;
  env.googleHook=async(request,phase)=>{if(once&&request.method==='POST'&&phase==='after'){once=false;throw error(0)}};
  const result=await env.run();assert.equal(result.created,1);assert.equal(env.binding().state,'active');assert.equal(env.events.size,1);
  await env.run();assert.equal(env.mutations().filter(call=>call.method==='POST').length,1);
});

test('lost POST response and unavailable recovery survive another run without duplicate',async()=>{
  const env=await fixture();let inserted=false;
  env.googleHook=async(request,phase)=>{
    if(request.method==='POST'&&phase==='after'){inserted=true;throw error(0)}
    if(inserted&&request.method==='GET'&&request.path.includes('/events/'))throw error(503);
  };
  await env.run();const id=env.binding().event_id;assert.equal(env.binding().state,'pending');assert.equal(env.binding().pending_operation,'create');
  env.googleHook=null;env.advance();await env.run();assert.equal(env.binding().state,'active');assert.equal(env.binding().event_id,id);assert.equal(env.binding().generation,0);
  assert.equal(env.mutations().filter(call=>call.method==='POST').length,1);
});

test('409 is recovered only when deterministic GET verifies the existing owner',async()=>{
  const env=await fixture();const existing=env.desired(task());env.events.set(existing.id,existing);let hide=true;
  env.googleHook=async(request,phase)=>{if(hide&&phase==='before'&&request.method==='GET'&&request.path.includes('/events/')){hide=false;throw error(404)}};
  await env.run();assert.equal(env.binding().state,'active');assert.equal(env.events.size,1);assert.equal(env.mutations().length,1);
});

test('an unrelated event with the same ID or another connection is never overwritten',async()=>{
  for(const unrelated of ['app','connection']){
    const env=await fixture();const event=env.desired(task());
    if(unrelated==='app')event.extendedProperties.private.cosApp='other-app';else event.extendedProperties.private.cosConnectionKey=uuid(999);
    env.events.set(event.id,event);await env.run();assert.equal(env.binding().state,'conflict');assert.equal(env.binding().last_error,'event_ownership_mismatch');assert.equal(env.mutations().length,0);
  }
});

test('ETag protects against concurrent changes between GET and PUT',async()=>{
  const env=await fixture();await env.run();env.data.commitments[0].description='Source changed';
  env.googleHook=async(request,phase)=>{if(request.method==='PUT'&&phase==='before')env.events.get(env.binding().event_id).etag='"external-version"'};
  await env.run();assert.equal(env.binding().state,'conflict');assert.equal(env.binding().last_error,'google_etag_conflict');assert.equal(env.event().summary,'Срок: Synthetic 1');
});

test('manual Google deletion is held as conflict rather than recreating the event',async()=>{
  for(const tombstone of [true,false]){
    const env=await fixture();await env.run();const id=env.binding().event_id;
    if(tombstone)env.events.set(id,{id,status:'cancelled'});else env.events.delete(id);
    env.data.commitments[0].description='Changed after deletion';await env.run();assert.equal(env.binding().state,'conflict');assert.equal(env.binding().generation,0);
    assert.equal(env.mutations().filter(call=>call.method==='POST').length,1);
    await env.run();assert.equal(env.binding().state,'conflict');
  }
});

test('DELETE timeout with a tombstone is confirmed and permits one new generation',async()=>{
  const env=await fixture();await env.run();env.data.commitments[0].status='cancelled';
  env.googleHook=async(request,phase)=>{if(request.method==='DELETE'&&phase==='after')throw error(0)};
  await env.run();assert.equal(env.binding().state,'deleted');env.googleHook=null;env.data.commitments[0].status='open';await env.run();
  assert.equal(env.binding().generation,1);assert.equal(env.mutations().filter(call=>call.method==='DELETE').length,1);
});

test('pending DELETE is finished before reactivation; old generation is not reused',async()=>{
  const env=await fixture();await env.run();const old=env.binding().event_id;env.data.commitments[0].status='cancelled';
  env.googleHook=async(request,phase)=>{if(request.method==='DELETE'&&phase==='before')throw error(0)};
  await env.run();assert.equal(env.binding().pending_operation,'delete');assert.equal(env.event().status,'confirmed');
  env.data.commitments[0].status='open';env.googleHook=null;env.advance();await env.run();assert.equal(env.binding().state,'deleted');
  await env.run();assert.equal(env.binding().generation,1);assert.notEqual(env.binding().event_id,old);
});

test('invalid source keeps its old event and reports a safe projection code',async()=>{
  const env=await fixture();await env.run();const old=clone(env.event());env.data.commitments[0].deadline='2026-02-30';const result=await env.run();
  assert.equal(result.errors,1);assert.equal(env.binding().state,'error');assert.equal(env.binding().last_error,'invalid_date');assert.deepEqual(env.event(),old);
  env.data.commitments[0].deadline='2028-03-02';env.advance();await env.run();assert.equal(env.binding().state,'active');assert.equal(env.event().start.date,'2028-03-02');
});

test('partial source snapshot failure cannot delete even an apparently missing source',async()=>{
  const env=await fixture();await env.run();env.data.commitments=[];const count=env.mutations().length;
  env.storeHook=async({operation,table})=>{if(operation==='list'&&table==='meetings')throw error(503)};
  await assert.rejects(env.run(),{message:'source_snapshot_failed'});assert.equal(env.mutations().length,count);assert.equal(env.binding().state,'active');
});

test('full successful snapshot and fresh lookup permit hard-source deletion',async()=>{
  const env=await fixture();await env.run();env.data.commitments=[];const result=await env.run();assert.equal(result.deleted,1);assert.equal(env.binding().state,'deleted');
});

test('calendar 403/404 is fatal, not an empty calendar or a deletion instruction',async()=>{
  for(const status of [403,404]){
    const env=await fixture();env.googleHook=async()=>{throw error(status)};
    await assert.rejects(env.run(),{message:'calendar_access_failed'});assert.equal(env.dbCalls.length,0);assert.equal(env.mutations().length,0);
  }
});

test('25 records progress across bounded runs without first-page starvation',async()=>{
  const env=await fixture(Array.from({length:25},(_,index)=>task(index+1)));
  const first=await env.run({maxMutations:100});assert.equal(first.created,20);assert.equal(first.mutations,20);assert.equal(first.truncated,true);
  const second=await env.run();assert.equal(second.created,5);assert.equal(second.mutations,5);assert.equal(env.events.size,25);
  assert.equal(env.data.cos_calendar_bindings.filter(row=>row.state==='active').length,25);
});

test('elapsed budget stops new mutations and passes remaining timeout to Google',async()=>{
  const env=await fixture();env.googleHook=async(request,phase)=>{if(phase==='after'&&request.method==='GET')env.advance(40_001)};
  const result=await env.run();assert.equal(result.truncated,true);assert.equal(result.mutations,0);assert.equal(env.data.cos_calendar_bindings.length,0);
});

test('candidate is reread before Google writes; snapshot with a now-cancelled task creates nothing',async()=>{
  const env=await fixture();env.storeHook=async({operation,table,query})=>{if(operation==='list'&&table==='commitments'&&query.includes('id=eq.'))env.data.commitments[0].status='cancelled'};
  await env.run();assert.equal(env.events.size,0);assert.equal(env.data.cos_calendar_bindings.length,0);
});

test('a failed post-insert DB acknowledgement leaves recoverable persisted intent',async()=>{
  const env=await fixture();env.storeHook=async({operation,values})=>{if(operation==='patch'&&values.state==='active')throw error(503)};
  await assert.rejects(env.run(),{message:'binding_write_failed'});assert.equal(env.events.size,1);assert.equal(env.binding().pending_operation,'create');
  env.storeHook=null;await env.run();assert.equal(env.binding().state,'active');assert.equal(env.mutations().filter(call=>call.method==='POST').length,1);
});

test('PUT timeout after success is recovered and removing timestamp clears stale time fields',async()=>{
  const env=await fixture([task(1,{deadline_at:'2028-02-29T09:15:00Z'})]);await env.run();env.data.commitments[0].deadline_at=null;
  env.googleHook=async(request,phase)=>{if(request.method==='PUT'&&phase==='after')throw error(0)};
  await env.run();assert.equal(env.binding().state,'active');assert.deepEqual(env.event().start,{date:'2028-02-29'});assert.equal(env.mutations().filter(call=>call.method==='PUT').length,1);
});

test('rate limit errors contain no raw Google response body and stop further work',async()=>{
  const env=await fixture([task(1),task(2)]);env.googleHook=async(request,phase)=>{if(phase==='before'&&request.method==='POST')throw error(403,'rateLimitExceeded')};
  const result=await env.run();assert.equal(result.truncated,true);assert.equal(env.binding().last_error,'google_rate_limited');assert.equal(env.mutations().length,1);
  assert.equal(JSON.stringify(result).includes('private response'),false);assert.equal(JSON.stringify(env.data.cos_calendar_bindings).includes('private response'),false);
});

test('binding omitted by a changing full snapshot is not deleted when fresh source still exists',async()=>{
  const env=await fixture();await env.run();const source=clone(env.data.commitments[0]),before=env.mutations().length;
  env.storeHook=async({operation,table,query})=>{
    if(operation==='list'&&table==='commitments')env.data.commitments=query.includes('id=eq.')?[source]:[];
  };
  await env.run();assert.equal(env.binding().state,'active');assert.equal(env.mutations().length,before);assert.equal(env.event().status,'confirmed');
});

test('failed fresh lookup of an orphan is held without deleting the event',async()=>{
  const env=await fixture();await env.run();env.data.commitments=[];const before=env.mutations().length;
  env.storeHook=async({operation,table,query})=>{if(operation==='list'&&table==='commitments'&&query.includes('id=eq.'))throw error(503)};
  await env.run();assert.equal(env.binding().last_error,'source_read_failed');assert.equal(env.mutations().length,before);assert.equal(env.event().status,'confirmed');
});

test('generation CAS lost race cannot issue a new Google insert',async()=>{
  const env=await fixture();await env.run();env.data.commitments[0].status='cancelled';await env.run();env.data.commitments[0].status='open';
  const before=env.mutations().length;
  env.storeHook=async({operation,values})=>{if(operation==='patch'&&values.generation===1)env.binding().generation=2};
  await assert.rejects(env.run(),{message:'binding_changed'});assert.equal(env.mutations().length,before);
});

test('missing Google event during pending-delete recovery requires calendar access again',async()=>{
  const env=await fixture();await env.run();env.data.commitments[0].status='cancelled';let afterDelete=false;
  env.googleHook=async(request,phase)=>{
    if(request.method==='DELETE'&&phase==='after'){afterDelete=true;throw error(0)}
    if(afterDelete&&phase==='before'&&request.method==='GET'&&!request.path.includes('/events/'))throw error(403);
  };
  await env.run();assert.equal(env.binding().state,'pending');assert.equal(env.binding().pending_operation,'delete');assert.equal(env.binding().last_error,'calendar_access_failed');
});

test('public projectionHash is identical to a successfully stored source hash',async()=>{
  const env=await fixture();await env.run();const [{projectionHash}]=await modules;
  const projection=env.projector.projectCalendarRecord('task',env.data.commitments[0],{generation:env.binding().generation,timeZone:env.connection.time_zone});
  assert.equal(await projectionHash(projection,env.connection.connection_key),env.binding().source_hash);
  assert.equal(await projectionHash({kind:'absent'},env.connection.connection_key),null);
});

test('time budget expiry after durable create intent starts no Google mutation',async()=>{
  const env=await fixture();env.storeHook=async({operation})=>{if(operation==='insert')env.advance(40_001)};
  const result=await env.run();assert.equal(result.truncated,true);assert.equal(env.mutations().length,0);assert.equal(env.binding().state,'pending');assert.equal(env.binding().pending_operation,'create');
});

test('cancelled source retains an uncertain create until a late POST appears and can be deleted',async()=>{
  const env=await fixture();let lateEvent;
  env.googleHook=async(request,phase)=>{
    if(request.method==='POST'&&phase==='before'){lateEvent={...clone(request.body),etag:'"late-create"'};throw error(0)}
  };
  await env.run();assert.equal(env.binding().pending_operation,'create');assert.equal(env.events.size,0);
  env.googleHook=null;env.data.commitments[0].status='cancelled';env.advance();await env.run();
  assert.equal(env.binding().state,'pending');assert.equal(env.binding().pending_operation,'create');assert.equal(env.binding().last_error,'google_create_outcome_unknown');assert.equal(env.binding().generation,0);
  env.events.set(lateEvent.id,lateEvent);env.advance();await env.run();
  assert.equal(env.binding().state,'deleted');assert.equal(env.events.get(lateEvent.id).status,'cancelled');
  assert.equal(env.mutations().filter(call=>call.method==='POST').length,1);assert.equal(env.mutations().filter(call=>call.method==='DELETE').length,1);
});
