const {test} = require('node:test');
const assert = require('node:assert/strict');
const implementation = import('../calendar/projector.mjs');

const id = '12345678-1234-4123-8123-123456789abc';
const options = {timeZone:'Europe/Moscow'};
const task = {id, description:'Synthetic deadline', status:'open', deadline:'2028-02-29'};
const meeting = {
  id, title:'Synthetic meeting', status:'scheduled',
  starts_at:'2026-10-25T02:30:00+02:00',
  ends_at:'2026-10-25T02:30:00+01:00'
};

test('date-only deadline has exclusive next-day end, including leap day', async () => {
  const {projectCalendarRecord:project} = await implementation;
  const p = project('task', task, options);
  assert.equal(p.kind, 'event');
  assert.deepEqual(p.event.start, {date:'2028-02-29'});
  assert.deepEqual(p.event.end, {date:'2028-03-01'});
  assert.equal(p.event.transparency, 'transparent');
});
test('date-only deadline crosses year boundary', async () => {
  const {projectCalendarRecord:project} = await implementation;
  assert.deepEqual(project('task', {...task, deadline:'2026-12-31'}, options).event.end, {date:'2027-01-01'});
});
test('timestamp takes priority and warns about contradictory date', async () => {
  const {projectCalendarRecord:project} = await implementation;
  const p = project('task', {...task, deadline:'2026-09-21', deadline_at:'2026-09-21T23:30:00Z'}, options);
  assert.equal(p.event.start.dateTime, '2026-09-21T23:30:00.000Z');
  assert.deepEqual(p.warnings, ['deadline_date_differs_from_timestamp']);
});
test('planning and next-check dates do not become deadlines', async () => {
  const {projectCalendarRecord:project} = await implementation;
  const p = project('task', {...task, deadline:null, planned_on:'2026-09-21', next_check_on:'2026-09-22'}, options);
  assert.equal(p.kind, 'absent');
  assert.equal(p.reason, 'deadline_removed');
});
test('invalid calendar date is an error, never removal', async () => {
  const {projectCalendarRecord:project} = await implementation;
  assert.equal(project('task', {...task, deadline:'2026-02-30'}, options).kind, 'error');
});
test('invalid or offset-free timestamp holds the existing event', async () => {
  const {projectCalendarRecord:project, planCalendarChange:plan} = await implementation;
  const old = project('task', task, options).event;
  for (const value of ['broken', '2026-09-21T10:00:00', '2026-02-30T10:00:00Z']) {
    const p = project('task', {...task, deadline_at:value}, options);
    assert.equal(p.kind, 'error');
    assert.equal(plan(p, old).operation, 'hold');
  }
});
test('completion preserves event identity and disables reminders', async () => {
  const {projectCalendarRecord:project} = await implementation;
  const open = project('task', task, options);
  const done = project('task', {...task, status:'completed'}, options);
  assert.equal(done.eventId, open.eventId);
  assert.ok(done.event.summary.startsWith('✓ '));
  assert.deepEqual(done.event.reminders, {useDefault:false, overrides:[]});
});
test('cancellation removes only a positively identified owned event', async () => {
  const {projectCalendarRecord:project, planCalendarChange:plan} = await implementation;
  const old = project('task', task, options).event;
  const p = project('task', {...task, status:'cancelled'}, options);
  assert.equal(plan(p).operation, 'noop');
  assert.equal(plan(p, old).operation, 'delete');
  assert.equal(plan(p, {...old, extendedProperties:{}}).operation, 'hold');
  assert.equal(plan(p, {...old, id:'unrelated'}).operation, 'hold');
});
test('stable valid Google ID allows insert retry recovery through lookup and update', async () => {
  const {projectCalendarRecord:project, planCalendarChange:plan} = await implementation;
  const first = project('task', task, options);
  const moved = project('task', {...task, deadline:'2028-03-02'}, options);
  assert.ok(/^[a-v0-9]{5,1024}$/.test(first.eventId));
  assert.equal(first.eventId, moved.eventId);
  assert.equal(plan(first).operation, 'insert');
  assert.equal(plan(moved, first.event).operation, 'update');
  assert.deepEqual(plan(moved, first.event).event.start, {date:'2028-03-02'});
});
test('meeting preserves actual duration across daylight-saving change', async () => {
  const {projectCalendarRecord:project} = await implementation;
  const p = project('meeting', meeting, {timeZone:'Europe/Berlin'});
  assert.equal(p.kind, 'event');
  assert.equal(Date.parse(p.event.end.dateTime) - Date.parse(p.event.start.dateTime), 3600000);
  assert.equal(p.event.transparency, 'opaque');
  assert.equal(p.event.attendees, undefined);
});
test('meeting without end time requires correction, never invented duration', async () => {
  const {projectCalendarRecord:project} = await implementation;
  const p = project('meeting', {...meeting, ends_at:null}, options);
  assert.equal(p.kind, 'error');
  assert.equal(p.reason, 'meeting_end_required');
});
test('reversed meeting interval is rejected', async () => {
  const {projectCalendarRecord:project} = await implementation;
  assert.equal(project('meeting', {...meeting, ends_at:meeting.starts_at}, options).kind, 'error');
});
test('calendar timezone is required and validated', async () => {
  const {projectCalendarRecord:project} = await implementation;
  assert.equal(project('task', task).kind, 'error');
  assert.equal(project('task', task, {timeZone:'Mars/Olympus'}).kind, 'error');
});
test('timed deadline is a transparent one-minute marker', async () => {
  const {projectCalendarRecord:project} = await implementation;
  const p = project('task', {...task, deadline_at:'2028-02-29T15:00:00+03:00'}, options);
  assert.equal(p.event.transparency, 'transparent');
  assert.equal(Date.parse(p.event.end.dateTime) - Date.parse(p.event.start.dateTime), 60000);
});
test('description escapes metadata and does not export private notes', async () => {
  const {projectCalendarRecord:project} = await implementation;
  const p = project('meeting', {...meeting, raw_notes:'PRIVATE', transcript_text:'PRIVATE'}, {...options, projectTitle:'<script>unsafe</script>'});
  assert.ok(p.event.description.includes('&lt;script&gt;'));
  assert.ok(!p.event.description.includes('PRIVATE'));
});
test('invalid projections and Google tombstones are held for resolution', async () => {
  const {projectCalendarRecord:project, planCalendarChange:plan} = await implementation;
  assert.equal(plan(null).operation, 'hold');
  assert.equal(plan({kind:'unexpected'}).operation, 'hold');
  const p = project('task', task, options);
  assert.equal(plan(p, {...p.event, status:'cancelled'}).operation, 'hold');
});

test('meeting URLs are normalized, escaped and limited to HTTP(S)', async () => {
  const {projectCalendarRecord:project} = await implementation;
  const p = project('meeting', {...meeting, meeting_url:'https://example.com/?a=1&b=2'}, options);
  assert.equal(p.kind, 'event');
  assert.ok(p.event.description.includes('&amp;b=2'));
  assert.equal(project('meeting', {...meeting, meeting_url:'javascript:alert(1)'}, options).kind, 'error');
});
test('reactivation uses a persisted next generation with stable retry identity', async () => {
  const {projectCalendarRecord:project, planCalendarChange:plan} = await implementation;
  const initial = project('task', task, options);
  const next = project('task', task, {...options, generation:16});
  const retry = project('task', {...task, deadline:'2028-03-01'}, {...options, generation:16});
  assert.ok(next.eventId !== initial.eventId);
  assert.ok(/^[a-v0-9]{5,1024}$/.test(next.eventId));
  assert.equal(next.eventId, retry.eventId);
  assert.equal(plan(next, initial.event).operation, 'hold');
  assert.equal(plan(retry, next.event).operation, 'update');
  assert.equal(project('task', task, {...options, generation:-1}).kind, 'error');
});
