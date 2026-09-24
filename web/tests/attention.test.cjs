const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const modulePath = require.resolve('../attention.js');
const attention = require(modulePath);
const NOW = new Date('2026-09-24T12:00:00Z');
const task = (id, extra = {}) => ({ id, description: `Задача ${id}`, status: 'open', direction: 'internal', ...extra });
const project = (id, extra = {}) => ({ id, title: `Проект ${id}`, status: 'active', ...extra });
const signals = (tasks = [], projects = [], now = NOW) => attention.buildSignals({ tasks, projects, now });
function storage(initial = null) {
  let value = initial;
  return { getItem: () => value, setItem: (key, next) => { value = next; }, get value() { return value; } };
}
function inTimezone(timezone, code) {
  return JSON.parse(execFileSync(process.execPath, ['-e', `const a=require(${JSON.stringify(modulePath)});${code}`], { env: { ...process.env, TZ: timezone }, encoding: 'utf8' }));
}
const container = () => ({ innerHTML: '', querySelector: () => null, contains: () => true });
function click(element, dataset) { const target = { dataset, closest() { return this; } }; element.onclick({ target }); }

test('attention chooses one most important reason per task and ignores planning dates', () => {
  const result = signals([
    task('all', { deadline: '2026-09-20', next_check_on: '2026-09-22', direction: 'to_me' }),
    task('check', { next_check_on: '2026-09-24', deadline: '2026-09-30', direction: 'to_me' }),
    task('wait', { direction: 'to_me' }),
    task('plan', { planned_on: '2026-09-10', planned_start_at: '2026-09-10T08:00:00Z' }),
    task('future', { next_check_on: '2026-09-25', direction: 'to_me' }),
    task('all', { direction: 'to_me' })
  ]);
  assert.deepEqual(result.map(signal => [signal.id, signal.reason]), [['all', 'overdue'], ['check', 'check_due'], ['wait', 'waiting_no_check']]);
});

test('attention excludes finished/paused tasks and tasks in inactive projects', () => {
  const statuses = ['active', 'paused', 'completed', 'cancelled', 'closed'];
  const projects = statuses.map(status => project(status, { status }));
  const tasks = statuses.map(status => task(status, { project_id: status, deadline: '2026-01-01' }));
  tasks.push(...['completed', 'cancelled', 'paused'].map(status => task(`task-${status}`, { status, deadline: '2026-01-01', direction: 'to_me' })));
  tasks.push(task('unassigned', { deadline: '2026-01-01' }), task('unknown', { project_id: 'missing', deadline: '2026-01-01' }));
  assert.deepEqual(signals(tasks, projects).map(signal => signal.id).sort(), ['active', 'unassigned', 'unknown']);
});

test('active project with a paused task retains a next action; completed and cancelled tasks differ', () => {
  const projects = ['paused-task', 'done', 'cancel', 'empty', 'paused-project'].map(id => project(id, id === 'paused-project' ? { status: 'paused' } : {}));
  const tasks = [task('p', { project_id: 'paused-task', status: 'paused' }), task('d', { project_id: 'done', status: 'completed' }), task('c', { project_id: 'cancel', status: 'cancelled' })];
  assert.deepEqual(signals(tasks, projects).map(signal => [signal.id, signal.reason]), [['cancel', 'project_state'], ['done', 'project_next_step'], ['empty', 'project_state']]);
});

test('date-only deadline lasts the full local day while check becomes due that day', () => {
  const result = inTimezone('America/Los_Angeles', `
    const now=new Date('2026-09-25T06:59:59Z');
    const tasks=[{id:'deadline',deadline:'2026-09-24'},{id:'check',next_check_on:'2026-09-24'}];
    console.log(JSON.stringify([
      a.buildSignals({tasks,now}).map(x=>x.id),
      a.buildSignals({tasks,now:new Date('2026-09-25T07:00:00Z')}).map(x=>x.id)
    ]));
  `);
  assert.deepEqual(result, [['check'], ['deadline', 'check']]);
});

test('timestamps override day fields and exact check/deadline boundaries differ', () => {
  const result = signals([
    task('future', { deadline: '2026-09-01', deadline_at: '2026-09-24T13:00:00Z' }),
    task('past', { deadline: '2026-09-30', deadline_at: '2026-09-24T11:59:59Z' }),
    task('exact-deadline', { deadline_at: '2026-09-24T12:00:00Z' }),
    task('exact-check', { next_check_on: '2026-09-30', next_check_at: '2026-09-24T12:00:00Z' }),
    task('future-check', { next_check_on: '2026-09-01', next_check_at: '2026-09-24T13:00:00Z', direction: 'to_me' })
  ]);
  assert.deepEqual(result.map(signal => [signal.id, signal.reason]), [['past', 'overdue'], ['exact-check', 'check_due']]);
});

test('invalid timestamps never fall back to stale day dates; invalid check needs clarification', () => {
  const invalid = ['2026-02-30T10:00:00Z', '2026-09-24T24:00:00Z', '2026-09-24T10:99:00Z', '2026-09-24T10:00:00', '2026-09-24T10:00:00+99:00', 'broken'];
  for (const value of invalid) {
    assert.equal(signals([task('d', { deadline: '2026-01-01', deadline_at: value })]).length, 0);
    assert.equal(signals([task('c', { next_check_on: '2026-01-01', next_check_at: value, direction: 'to_me' })])[0].reason, 'waiting_no_check');
  }
  assert.equal(signals([task('d', { deadline: '2026-02-30' })]).length, 0);
  assert.deepEqual(signals([], [project('p')], new Date(NaN)), []);
  assert.equal(attention.parseDay('2024-02-29').day, 29);
  assert.equal(attention.parseDay('2023-02-29'), null);
});

test('timestamp labels and due dates follow device timezone on both sides of UTC', () => {
  for (const [timezone, day] of [['America/Los_Angeles', '2026-09-23'], ['Asia/Tokyo', '2026-09-24']]) {
    const result = inTimezone(timezone, `console.log(JSON.stringify(a.buildSignals({tasks:[{id:'t',deadline_at:'2026-09-24T00:30:00Z'}],now:new Date('2026-09-24T01:00:00Z')})[0].dueDay));`);
    assert.equal(result, day);
  }
});

test('defer advances seven calendar days through DST and expires on local return day', () => {
  const result = inTimezone('Europe/Berlin', `
    const store=a.createDeferralStore(null), projects=[{id:'p',status:'active'}];
    const before=new Date('2026-10-24T23:30:00+02:00');
    const signals=a.buildSignals({projects,now:before});
    store.defer(signals[0],before);
    const hidden=store.partition(signals,before).deferred[0].untilDay;
    const dayBefore=store.partition(signals,new Date('2026-10-30T23:59:59+01:00')).visible.length;
    const returnDay=store.partition(signals,new Date('2026-10-31T00:00:00+01:00')).visible.length;
    console.log(JSON.stringify({hidden,dayBefore,returnDay}));
  `);
  assert.deepEqual(result, { hidden: '2026-10-31', dayBefore: 0, returnDay: 1 });
  assert.equal(attention.addDays('2024-02-25', 7), '2024-03-03');
  assert.equal(attention.addDays('9999-12-31', 7), null);
});

test('only project questions can be deferred and a restore immediately returns the signal', () => {
  const data = signals([task('late', { deadline: '2026-01-01' })], [project('p')]);
  const memory = storage(), store = attention.createDeferralStore(memory);
  assert.equal(store.defer(data[0], NOW), false);
  assert.equal(store.defer(data[1], NOW), true);
  assert.deepEqual(store.partition(data, NOW).visible.map(signal => signal.id), ['late']);
  assert.equal(attention.createDeferralStore(memory).partition(data, NOW).deferred[0].id, 'p');
  store.restore('project:p');
  assert.equal(store.partition(data, NOW).visible.length, 2);
});

test('a new completed task or meaningful project change invalidates a previous deferral', () => {
  const p = project('p');
  const first = signals([task('done1', { project_id: 'p', status: 'completed' })], [p]);
  for (const [tasks, projects] of [
    [[task('done1', { project_id: 'p', status: 'completed' }), task('done2', { project_id: 'p', status: 'completed' })], [p]],
    [[task('done1', { project_id: 'p', status: 'completed', description: 'Новый результат' })], [p]],
    [[task('done1', { project_id: 'p', status: 'completed' })], [{ ...p, title: 'Изменился проект' }]]
  ]) {
    const store = attention.createDeferralStore(null);
    store.defer(first[0], NOW);
    assert.equal(store.partition(signals(tasks, projects), NOW).visible.length, 1);
  }
});

test('fingerprints ignore source array order and clearing a project question clears its deferral', () => {
  const projects = [project('p')], tasks = [task('a', { status: 'completed', project_id: 'p' }), task('b', { status: 'cancelled', project_id: 'p' })];
  const data = signals(tasks, projects), store = attention.createDeferralStore(null);
  assert.equal(data[0].fingerprint, signals(tasks.toReversed(), projects)[0].fingerprint);
  store.defer(data[0], NOW);
  assert.equal(store.partition(signals([...tasks, task('open', { project_id: 'p' })], projects), NOW).deferred.length, 0);
  assert.equal(store.partition(data, NOW).visible.length, 1);
});

test('corrupted storage and prototype-like IDs cannot hide unrelated signals', () => {
  const data = signals([], [project('__proto__'), project('constructor')]);
  for (const raw of ['bad json', '{"version":1,"entries":{"__proto__":true}}', 'x'.repeat(64001), '{"version":1,"entries":[null,{"key":"task:t","untilDay":"2026-09-30","fingerprint":"a-b-1"}]}']) {
    assert.equal(attention.createDeferralStore(storage(raw)).partition(data, NOW).visible.length, 2);
  }
  const store = attention.createDeferralStore(storage());
  store.defer(data[0], NOW);
  assert.equal(store.partition(data, NOW).deferred.length, 1);
  assert.equal({}.untilDay, undefined);
});

test('deferrals are capped and unavailable storage falls back to this session', () => {
  const memory = storage(), store = attention.createDeferralStore(memory);
  const data = signals([], Array.from({ length: 130 }, (_, index) => project(`p-${index}`)));
  for (const signal of data) store.defer(signal, NOW);
  assert.equal(JSON.parse(memory.value).entries.length, 100);
  assert.equal(store.partition(data, NOW).deferred.length, 100);
  for (const unavailable of [{ getItem() { throw new Error('denied'); }, setItem() {} }, { getItem() { return null; }, setItem() { throw new Error('quota'); } }]) {
    const fallback = attention.createDeferralStore(unavailable);
    assert.equal(fallback.defer(data[0], NOW), true);
    assert.equal(fallback.sessionOnly, true);
    assert.equal(fallback.partition(data, NOW).deferred.length, 1);
  }
});

test('render escapes content, limits initial list, and invokes only explicit source callbacks', () => {
  const element = container(), opens = [], store = attention.createDeferralStore(null);
  const tasks = Array.from({ length: 8 }, (_, index) => task(`id-${index}`, { deadline: '2026-09-01', description: index ? `Task ${index}` : '<img src=x onerror=alert(1)>' }));
  attention.render(element, { tasks, now: NOW, deferralStore: store, onOpenTask: (...args) => opens.push(args) });
  assert.equal((element.innerHTML.match(/<li class="attention-item/g) || []).length, 5);
  assert.ok(element.innerHTML.includes('&lt;img'));
  assert.ok(!element.innerHTML.includes('<img'));
  assert.deepEqual(opens, []);
  click(element, { attentionOpen: 'task:id-0' });
  assert.deepEqual(opens, [['id-0', 'overdue']]);
  click(element, { attentionAction: 'expand' });
  assert.equal((element.innerHTML.match(/<li class="attention-item/g) || []).length, 8);
  click(element, { attentionAction: 'expand' });
  click(element, { attentionOpen: 'task:missing' });
  assert.equal(opens.length, 1);
});

test('render defers and restores projects without invoking project mutations', () => {
  const element = container(), opens = [], store = attention.createDeferralStore(null);
  attention.render(element, { projects: [project('p')], now: NOW, deferralStore: store, onOpenProject: (...args) => opens.push(args) });
  click(element, { attentionDefer: 'project:p' });
  assert.equal((element.innerHTML.match(/<li class="attention-item/g) || []).length, 0);
  assert.deepEqual(opens, []);
  click(element, { attentionAction: 'deferred' });
  assert.equal((element.innerHTML.match(/<li class="attention-item/g) || []).length, 1);
  click(element, { attentionRestore: 'project:p' });
  click(element, { attentionOpen: 'project:p' });
  assert.deepEqual(opens, [['p', 'project_state']]);
});
