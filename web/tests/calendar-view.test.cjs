const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const calendarPath = require.resolve('../calendar-view.js');
const calendar = require(calendarPath);
const task = (id, extra = {}) => ({ id, status: 'open', description: `Задача ${id}`, ...extra });
const meeting = (id, extra = {}) => ({ id, status: 'scheduled', title: `Встреча ${id}`, ...extra });
function inTimezone(timezone, code) {
  return JSON.parse(execFileSync(process.execPath, ['-e', `const c=require(${JSON.stringify(calendarPath)});${code}`], { env: { ...process.env, TZ: timezone }, encoding: 'utf8' }));
}
function fakeContainer() {
  return { innerHTML: '', querySelector() { return null; }, contains() { return true; } };
}
function click(container, dataset) {
  const target = { dataset, closest() { return this; } };
  container.onclick({ target });
}

test('calendar month grid begins Monday, includes leap day and has six complete weeks', () => {
  const grid = calendar.monthGrid('2024-02-17');
  assert.equal(grid.length, 42);
  assert.equal(grid[0], '2024-01-29');
  assert.equal(grid.at(-1), '2024-03-10');
  assert.ok(grid.includes('2024-02-29'));
  assert.equal(calendar.addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(calendar.addMonths('2023-01-31', 1), '2023-02-28');
  assert.equal(calendar.addDays('2024-02-28', 2), '2024-03-01');
  assert.equal(calendar.addDays('2024-01-01', -1), '2023-12-31');
});

test('calendar rejects nonexistent dates and handles supported-year boundaries', () => {
  for (const value of ['2023-02-29', '2024-04-31', '2024-13-01', '2024-01-00', '0000-01-01', '2024-2-01', '', null]) assert.equal(calendar.parseDay(value), null);
  assert.deepEqual(calendar.parseDay('2024-02-29'), { year: 2024, month: 2, day: 29 });
  assert.equal(calendar.addDays('9999-12-31', 1), null);
  assert.equal(calendar.addDays('0001-01-01', -1), null);
  assert.equal(calendar.addMonths('0001-01-01', -1), null);
  assert.deepEqual(calendar.monthGrid('bad'), []);
});

test('deadline timestamp takes precedence and date-only stays unchanged west of UTC', () => {
  const result = inTimezone('America/Los_Angeles', `
    const timed=c.taskDeadline({deadline:'2026-09-23',deadline_at:'2026-09-23T00:30:00Z'});
    const dateOnly=c.taskDeadline({deadline:'2026-09-23'});
    console.log(JSON.stringify({timed:timed.day,dateOnly:dateOnly.day,dateOnlyTime:dateOnly.start}));
  `);
  assert.deepEqual(result, { timed: '2026-09-22', dateOnly: '2026-09-23', dateOnlyTime: null });
});

test('positive timezone and daylight-saving boundaries use timestamp local day', () => {
  const result = inTimezone('Europe/Berlin', `
    console.log(JSON.stringify([
      c.taskDeadline({deadline_at:'2026-09-23T22:30:00Z'}).day,
      c.taskDeadline({deadline_at:'2026-03-28T23:30:00Z'}).day,
      c.taskDeadline({deadline_at:'2026-03-29T22:30:00Z'}).day
    ]));
  `);
  assert.deepEqual(result, ['2026-09-24', '2026-03-29', '2026-03-30']);
});

test('planning and follow-up dates do not become deadlines; invalid timestamp does not use stale date', () => {
  assert.equal(calendar.taskDeadline({ planned_on: '2026-09-23', planned_start_at: '2026-09-23T10:00:00Z', next_check_on: '2026-09-24' }), null);
  assert.equal(calendar.taskDeadline({ deadline: '2026-09-23', deadline_at: 'not-a-date' }), null);
  for (const value of ['2026-02-30T10:00:00Z', '2026-09-23T24:00:00Z', '2026-09-23T10:99:00Z', '2026-09-23T10:00:00', '2026-09-23']) assert.equal(calendar.taskDeadline({ deadline_at: value }), null);
  assert.equal(calendar.taskDeadline({ deadline: '2026-02-30' }), null);
});

test('cancelled never appears, completed tasks are optional, meeting history and paused tasks remain', () => {
  const sources = {
    tasks: ['open', 'paused', 'completed', 'cancelled'].map(status => task(status, { status, deadline: '2026-09-23' })),
    meetings: ['scheduled', 'completed', 'cancelled'].map(status => meeting(status, { status, starts_at: '2026-09-23T12:00:00Z' }))
  };
  const defaults = calendar.projectRecords(sources).records;
  assert.deepEqual(defaults.map(record => record.id), ['open', 'paused', 'scheduled', 'completed']);
  const all = calendar.projectRecords(sources, { completed: true }).records;
  assert.equal(all.length, 5);
  assert.ok(all.every(record => record.status !== 'cancelled'));
});

test('duplicate source IDs are counted once; task and meeting with same ID remain distinct', () => {
  const repeated = task('same', { deadline: '2026-09-23' });
  const { records, undatedTasks } = calendar.projectRecords({ tasks: [repeated, repeated, task('undated'), task('undated')], meetings: [meeting('same', { starts_at: '2026-09-23T10:00:00Z' })] });
  assert.equal(records.length, 2);
  assert.equal(undatedTasks, 1);
  assert.deepEqual(records.map(record => record.key), ['task:same', 'meeting:same']);
});

test('invalid source dates are distinguished from tasks without a deadline and respect filters', () => {
  const sources = { tasks: [task('empty'), task('broken', { deadline: '2026-02-30' }), task('cancelled', { status: 'cancelled', deadline: 'bad' })], meetings: [meeting('invalid', { starts_at: 'bad' })] };
  const result = calendar.projectRecords(sources);
  assert.equal(result.undatedTasks, 1);
  assert.equal(result.invalidDates, 2);
  assert.equal(result.records.length, 0);
  assert.equal(calendar.projectRecords(sources, { tasks: false }).invalidDates, 1);
  assert.equal(calendar.projectRecords(sources, { meetings: false }).invalidDates, 1);
});

test('only explicit date, month and filter navigation invalidates a pending record open', () => {
  const container = fakeContainer();
  let changes = 0;
  const options = { onViewChange: () => { changes++; } };
  calendar.render(container, options);
  assert.equal(changes, 0);
  click(container, { cvDay: calendar.localDay() });
  click(container, { cvStep: '1' });
  container.onchange({ target: { dataset: { cvFilter: 'meetings' }, checked: false } });
  assert.equal(changes, 3);
  calendar.render(container, options);
  assert.equal(changes, 3);
  container.onchange({ target: { dataset: { cvFilter: 'meetings' }, checked: true } });
  click(container, { cvAction: 'today' });
});

test('project and kind filters apply to records and undated task counts', () => {
  const sources = { tasks: [task('a', { project_id: 'p', deadline: '2026-09-23' }), task('b', { project_id: 'p' }), task('c'), task('d', { status: 'cancelled' })], meetings: [meeting('m', { project_id: 'p', starts_at: '2026-09-23T12:00:00Z' })], projects: [{ id: 'p', title: 'Проект' }] };
  const filtered = calendar.projectRecords(sources, { projectId: 'p' });
  assert.equal(filtered.records.length, 2);
  assert.equal(filtered.undatedTasks, 1);
  assert.ok(filtered.records.every(record => record.projectTitle === 'Проект'));
  assert.equal(calendar.projectRecords(sources, { projectId: '__none__' }).undatedTasks, 1);
  assert.equal(calendar.projectRecords(sources, { tasks: false }).undatedTasks, 0);
  assert.equal(calendar.projectRecords(sources, { tasks: false }).records.length, 1);
  assert.equal(calendar.projectRecords(sources, { meetings: false }).records.length, 1);
});

test('meeting midnight end is exclusive while an interior day remains occupied', () => {
  const result = inTimezone('Europe/Berlin', `
    const records=c.projectRecords({meetings:[{id:'m',status:'scheduled',title:'Встреча',starts_at:'2026-09-23T22:00:00+02:00',ends_at:'2026-09-25T00:00:00+02:00'}]}).records;
    console.log(JSON.stringify({first:records[0].day,last:records[0].lastDay,counts:['2026-09-22','2026-09-23','2026-09-24','2026-09-25'].map(day=>c.recordsForDay(records,day).length)}));
  `);
  assert.deepEqual(result, { first: '2026-09-23', last: '2026-09-24', counts: [0, 1, 1, 0] });
});

test('meeting coverage follows local dates across daylight-saving change without fixed-day duration', () => {
  const result = inTimezone('Europe/Berlin', `
    const records=c.projectRecords({meetings:[{id:'m',starts_at:'2026-03-28T23:30:00+01:00',ends_at:'2026-03-30T00:00:00+02:00'}]}).records;
    console.log(JSON.stringify(['2026-03-28','2026-03-29','2026-03-30'].map(day=>c.recordsForDay(records,day).length)));
  `);
  assert.deepEqual(result, [1, 1, 0]);
});

test('missing, reversed and invalid meeting ends never invent duration or additional occupied days', () => {
  for (const ends_at of [null, 'not-a-date', '2026-09-22T12:00:00Z', '2026-09-23T12:00:00Z']) {
    const { records } = calendar.projectRecords({ meetings: [meeting('m', { starts_at: '2026-09-23T12:00:00Z', ends_at })] });
    assert.equal(records.length, 1);
    assert.equal(records[0].end, null);
    assert.equal(records[0].lastDay, records[0].day);
  }
  assert.equal(calendar.projectRecords({ meetings: [meeting('bad', { starts_at: '2026-02-30T12:00:00Z' })] }).records.length, 0);
});

test('selected-day agenda puts date-only deadlines before times and sorts times chronologically', () => {
  const result = inTimezone('UTC', `
    const records=c.projectRecords({tasks:[{id:'late',description:'Late',deadline_at:'2026-09-23T17:00:00Z'},{id:'date',description:'Date',deadline:'2026-09-23'}],meetings:[{id:'early',title:'Early',starts_at:'2026-09-23T09:00:00Z',ends_at:'2026-09-23T10:00:00Z'}]}).records;
    console.log(JSON.stringify(c.recordsForDay(records,'2026-09-23').map(record=>record.id)));
  `);
  assert.deepEqual(result, ['date', 'early', 'late']);
});

test('render escapes source content and callbacks require explicit user actions', () => {
  const container = fakeContainer(), today = calendar.localDay(), calls = [];
  const title = '<img src=x onerror="alert(1)">';
  calendar.render(container, { tasks: [task('unsafe"id', { description: title, deadline: today, project_id: 'p' })], projects: [{ id: 'p', title }], onOpenTask: id => calls.push(['open', id]), onCreateTask: day => calls.push(['create', day]), onConnect: () => calls.push(['connect']) });
  assert.ok(!container.innerHTML.includes('<img'));
  assert.ok(container.innerHTML.includes('&lt;img'));
  assert.ok(container.innerHTML.includes('unsafe&quot;id'));
  assert.deepEqual(calls, []);
  click(container, { cvOpen: 'task', cvId: 'unsafe"id' });
  click(container, { cvAction: 'create' });
  click(container, { cvAction: 'connect' });
  assert.deepEqual(calls, [['open', 'unsafe"id'], ['create', today], ['connect']]);
});

test('parent render preserves selected month/day and filters; keyboard moves across month boundary', () => {
  const container = fakeContainer();
  calendar.render(container, {});
  click(container, { cvDay: '2028-02-29' });
  container.onchange({ target: { dataset: { cvFilter: 'completed' }, checked: true } });
  calendar.render(container, {});
  assert.ok(container.innerHTML.includes('Февраль <span>2028</span>'));
  assert.ok(container.innerHTML.includes('data-cv-day="2028-02-29" tabindex="0"'));
  assert.ok(container.innerHTML.includes('data-cv-filter="completed" checked'));
  let prevented = false;
  container.onkeydown({ target: { dataset: { cvDay: '2028-02-29' } }, key: 'ArrowRight', preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.ok(container.innerHTML.includes('Март <span>2028</span>'));
  assert.ok(container.innerHTML.includes('data-cv-day="2028-03-01" tabindex="0"'));
  container.onkeydown({ target: { dataset: { cvDay: '2028-03-01' } }, key: 'Home', preventDefault() {} });
  assert.ok(container.innerHTML.includes('data-cv-day="2028-02-28" tabindex="0"'));
});
