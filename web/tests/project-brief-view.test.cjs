const test = require('node:test');
const assert = require('node:assert/strict');
const brief = require('../project-brief.js');
const PROJECT = '11111111-1111-4111-8111-111111111111';
const ENTRY = '22222222-2222-4222-8222-222222222222';
const REQUEST = '33333333-3333-4333-8333-333333333333';
const NOW = '2026-09-24T12:00:00Z';
const snapshot = (document = {}, extra = {}) => ({ project_id: PROJECT, revision: 0, updated_at: null, document: { ...brief.emptyDocument(), ...document }, history: [], ...extra });
const task = (id, extra = {}) => ({ id, project_id: PROJECT, description: `Задача ${id}`, status: 'open', ...extra });
const entry = (extra = {}) => ({ id: ENTRY, kind: 'waiting', text: 'Получить согласование', person: '', review_on: null, source: '', status: 'open', ...extra });
const model = (extra = {}, state = snapshot()) => brief.buildModel({ project: { id: PROJECT, title: 'Образцы' }, now: NOW, ...extra }, state);
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(request, extra = {}, viewOptions = {}) {
  const listeners = new Map();
  const document = { defaultView: { addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); }, ...viewOptions } };
  const container = { ownerDocument: document, innerHTML: '', contains: () => true };
  const controller = brief.mount(container, { project: { id: PROJECT, title: 'Образцы' }, request, ...extra });
  return { container, controller, listeners };
}
function click(container, action, id) {
  const target = { dataset: { pbAction: action, pbId: id }, closest() { return this; } };
  container.onclick({ target });
}

test('project overview includes only this project, deduplicates rows and excludes deleted/archived notes', () => {
  const result = model({
    tasks: [task('open'), task('open'), task('paused', { status: 'paused' }), task('completed', { status: 'completed' }), task('cancelled', { status: 'cancelled' }), task('removed', { deleted_at: NOW }), task('foreign', { project_id: 'foreign' })],
    notes: [task('note'), task('archive', { archived_at: NOW }), task('deleted-note', { deleted_at: NOW }), task('foreign-note', { project_id: 'foreign' })],
    meetings: [task('meeting'), task('cancelled-meeting', { status: 'cancelled' })]
  });
  assert.deepEqual(result.active.map(row => row.id), ['open', 'paused']);
  assert.deepEqual(result.tasks.map(row => row.id), ['open', 'paused', 'completed', 'cancelled']);
  assert.deepEqual(result.notes.map(row => row.id), ['note']);
  assert.deepEqual(result.meetings.map(row => row.id), ['meeting']);
});

test('waiting records derive from task direction and use actual participant names without guessing missing people', () => {
  const result = model({ tasks: [task('waiting', { direction: 'to_me', participant_id: 'person' }), task('unknown', { direction: 'to_me' }), task('own', { direction: 'from_me' }), task('finished', { direction: 'to_me', status: 'completed' })], participants: [{ id: 'person', name: 'Анна' }] });
  assert.deepEqual(result.waiting.map(row => [row.id, row.person]), [['waiting', 'Анна'], ['unknown', '']]);
});

test('empty project asks for context and never derives project completion or stoppage from lack of tasks', () => {
  const html = brief.renderOverview(model(), { snapshot: snapshot() });
  assert.match(html, /Открытых задач нет/);
  assert.match(html, /работа может продолжаться через ожидания и согласования/);
  assert.match(html, /Что сейчас происходит с проектом/);
  assert.doesNotMatch(html, /Проект (завершён|остановлен|приостановлен)/);
  assert.doesNotMatch(html, /value="Новая/);
});

test('meeting schedule derives from actual instants even when stored status is stale', () => {
  const result = model({ meetings: [task('future', { status: 'completed', starts_at: '2026-09-25T12:00:00Z', ends_at: '2026-09-25T13:00:00Z' }), task('past', { status: 'scheduled', starts_at: '2026-09-23T12:00:00Z', ends_at: '2026-09-23T13:00:00Z' }), task('ongoing', { starts_at: '2026-09-24T11:00:00Z', ends_at: '2026-09-24T13:00:00Z' }), task('cancelled', { status: 'cancelled', starts_at: '2026-09-25T12:00:00Z' }), task('unknown-date')] });
  assert.deepEqual(result.scheduled.map(row => row.id), ['future', 'ongoing']);
});

test('history uses creation and update timestamps and never presents them as completion or decision dates', () => {
  const state = snapshot({}, { revision: 2, history: [{ revision: 2, created_at: '2026-09-24T11:00:00Z', changed_fields: ['current_state', 'invented'] }] });
  const result = model({ tasks: [task('no-timestamp', { deadline: '2026-09-20', status: 'completed' }), task('updated', { created_at: '2026-09-20T10:00:00Z', updated_at: '2026-09-24T12:00:00Z', status: 'completed' })], notes: [task('note', { created_at: '2026-09-21T10:00:00Z' })], meetings: [task('only-starts', { starts_at: '2026-09-24T10:00:00Z' })] }, state);
  assert.deepEqual(result.history.map(row => [row.kind, row.id]), [['task', 'updated'], ['brief', '2'], ['note', 'note']]);
  assert.equal(result.history[0].label, 'Задача обновлена');
  assert.equal(result.history[1].detail, 'Что происходит сейчас');
  assert.doesNotMatch(JSON.stringify(result.history), /завершена|решение принято|no-timestamp|only-starts/);
});

test('date-only values reject invalid dates and retain calendar day labels without timezone conversion', () => {
  assert.equal(brief.validDay('2024-02-29'), true);
  for (const value of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-9-24', '0000-01-01', '2026-09-24T00:00:00Z']) assert.equal(brief.validDay(value), false);
  assert.equal(brief.dayLabel('2026-09-24'), '24 сентября 2026');
  assert.equal(brief.dayLabel('2026-02-29'), '');
});

test('all manual fields and dates are optional but incomplete structured entries must be fixed explicitly', () => {
  assert.equal(brief.validateDocument(brief.emptyDocument()), '');
  assert.equal(brief.validateDocument({ ...brief.emptyDocument(), checkpoint_label: 'Уточнить образец' }), '');
  assert.match(brief.validateDocument({ ...brief.emptyDocument(), checkpoint_on: '2026-09-25' }), /что нужно проверить/);
  assert.match(brief.validateDocument({ ...brief.emptyDocument(), entries: [entry({ text: '' })] }), /текст каждой записи/);
  assert.match(brief.validateDocument({ ...brief.emptyDocument(), entries: [entry(), entry()] }), /определить запись/);
  assert.match(brief.validateDocument({ ...brief.emptyDocument(), entries: [entry({ kind: 'decision', review_on: '2026-09-25' })] }), /дату/);
  assert.match(brief.validateDocument({ ...brief.emptyDocument(), goal: 'x'.repeat(2001) }), /2000/);
});

test('unconfirmed submission remains byte-equivalent after retry and is independent of mutable draft references', () => {
  const session = brief.createSession(snapshot());
  session.document.current_state = 'Образец у заказчика';
  assert.equal(brief.dirty(session), true);
  const first = brief.prepareSubmission(session, REQUEST);
  first.document.current_state = 'Mutation outside module';
  session.document.current_state = 'Attempted later mutation';
  const retry = brief.prepareSubmission(session, ENTRY);
  assert.equal(retry.request_id, REQUEST);
  assert.equal(retry.document.current_state, 'Образец у заказчика');
  assert.equal(retry.revision, 0);
});

test('current snapshot after idempotent replay is accepted without replacing it with the old submitted document', () => {
  const state = snapshot({ current_state: 'Более позднее уточнение' }, { revision: 5, replayed: true });
  assert.equal(brief.assertSnapshot(state, PROJECT).document.current_state, 'Более позднее уточнение');
  assert.throws(() => brief.assertSnapshot({ ...state, project_id: 'foreign' }, PROJECT), /не подтвердил/);
  assert.throws(() => brief.assertSnapshot({ ...state, revision: -1 }, PROJECT), /не подтвердил/);
});

test('manual text, names, source strings and record IDs cannot inject markup into overview', () => {
  const dangerous = '<img src=x onerror=alert(1)>';
  const state = snapshot({ current_state: dangerous, entries: [entry({ text: dangerous, person: dangerous, source: dangerous })] });
  const html = brief.renderOverview(model({ tasks: [task('" onclick="alert(1)', { direction: 'to_me', description: dangerous })], notes: [task('note', { title: dangerous })] }, state), { snapshot: state });
  assert.doesNotMatch(html, /<img|data-pb-id="" onclick=/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&quot; onclick=&quot;/);
});

test('overview shows existing records while private request is pending; initial mount never writes', async () => {
  let resolve, calls = [];
  const request = options => { calls.push(options); return new Promise(done => { resolve = done; }); };
  const { container, controller, listeners } = fixture(request, { tasks: [task('waiting', { direction: 'to_me', description: 'Уже существующее ожидание' })] });
  assert.match(container.innerHTML, /Уже существующее ожидание/);
  assert.match(container.innerHTML, /Загружаю уточнения/);
  assert.deepEqual(calls, [undefined]);
  assert.equal(controller.hasDraft(), false);
  assert.equal(listeners.has('beforeunload'), true);
  resolve(snapshot()); await flush();
  assert.match(container.innerHTML, /Уточнить проект/);
  controller.dispose();
  assert.equal(listeners.has('beforeunload'), false);
});

test('unauthenticated overview keeps derived records and provides Google sign-in without fabricated manual state', async () => {
  let logins = 0;
  const { container, controller } = fixture(async () => { throw Object.assign(Error('unauthorized'), { status: 401 }); }, { tasks: [task('existing')], onLogin: () => logins++ });
  await flush();
  assert.match(container.innerHTML, /Личные уточнения доступны после входа/);
  assert.match(container.innerHTML, /<b>1<\/b> открытых задач/);
  assert.doesNotMatch(container.innerHTML, /data-pb-action="edit"/);
  click(container, 'login'); assert.equal(logins, 1);
  controller.dispose();
});

test('source navigation accepts only visible IDs from current project', async () => {
  const opened = [];
  const { container, controller } = fixture(async () => snapshot(), { tasks: [task('valid'), task('foreign', { project_id: 'other' })], notes: [task('removed', { deleted_at: NOW })], onTask: id => opened.push(id), onNote: id => opened.push(id) });
  await flush();
  click(container, 'task', 'foreign'); click(container, 'note', 'removed'); click(container, 'task', 'invented'); click(container, 'task', 'valid');
  assert.deepEqual(opened, ['valid']); controller.dispose();
});

test('late GET cannot redraw disposed project or leak another project response', async () => {
  let resolve;
  const { container, controller } = fixture(() => new Promise(done => { resolve = done; }));
  controller.dispose(); const before = container.innerHTML;
  resolve(snapshot({ current_state: 'Поздний ответ' })); await flush();
  assert.equal(container.innerHTML, before); assert.equal(container.onclick, null);
  const foreign = fixture(async () => snapshot({ current_state: 'Чужой проект' }, { project_id: 'foreign' }));
  await flush();
  assert.doesNotMatch(foreign.container.innerHTML, /Чужой проект/);
  assert.match(foreign.container.innerHTML, /Не удалось загрузить/);
  foreign.controller.dispose();
});

test('draft export contains only actual entered facts and explicitly distinguishes missing dates', () => {
  const output = brief.draftText({ ...brief.emptyDocument(), current_state: 'Образец отправлен', entries: [entry({ person: 'Анна', source: 'Письмо 24 сентября' })] }, 'Оборудование');
  assert.match(output, /Образец отправлен/);
  assert.match(output, /Дата проверки: не назначена/);
  assert.match(output, /Участник: Анна/);
  assert.match(output, /Основание: Письмо 24 сентября/);
  assert.doesNotMatch(output, /выполнено|2026-09-25/);
});

test('entry text is normalized before payload is pinned so trailing newlines cannot trigger backend rejection', () => {
  const session = brief.createSession(snapshot({ entries: [entry({ text: '  Согласовать чертёж\n' })] }));
  const payload = brief.prepareSubmission(session, REQUEST);
  assert.equal(payload.document.entries[0].text, 'Согласовать чертёж');
  assert.equal(brief.prepareSubmission(session, ENTRY).document.entries[0].text, 'Согласовать чертёж');
});

test('bounded project-scoped backup restores pending request exactly but never a busy lock', () => {
  const session = brief.createSession(snapshot());
  session.document.current_state = 'Образец передан заказчику';
  const payload = brief.prepareSubmission(session, REQUEST);
  session.busy = true;
  const raw = brief.serializeSession(session, PROJECT);
  const restored = brief.parseStoredSession(raw, PROJECT);
  assert.equal(restored.busy, false);
  assert.equal(restored.restored, true);
  assert.deepEqual(brief.prepareSubmission(restored, ENTRY), payload);
  assert.equal(brief.parseStoredSession(raw, 'foreign'), null);
  assert.equal(brief.parseStoredSession('x'.repeat(1000001), PROJECT), null);
  assert.equal(brief.parseStoredSession('{bad JSON', PROJECT), null);
});

test('backup restores blank unsaved entry but rejects excessive fields, invalid IDs and malformed pending payloads', () => {
  const session = brief.createSession(snapshot());
  session.document.entries.push(entry({ text: '' }));
  const raw = brief.serializeSession(session, PROJECT);
  assert.equal(brief.parseStoredSession(raw, PROJECT).document.entries[0].text, '');
  const malformed = JSON.parse(raw);
  malformed.document.entries[0].id = 'invalid';
  assert.equal(brief.parseStoredSession(JSON.stringify(malformed), PROJECT), null);
  malformed.document.entries[0] = entry({ person: 'x'.repeat(301) });
  assert.equal(brief.parseStoredSession(JSON.stringify(malformed), PROJECT), null);
  malformed.document.entries = [];
  malformed.pending = { revision: 0, request_id: REQUEST, document: { ...brief.emptyDocument(), entries: [entry({ text: '' })] } };
  assert.equal(brief.parseStoredSession(JSON.stringify(malformed), PROJECT), null);
});

test('unsaved draft can be resumed after failed login even if private GET is still unauthorized', async () => {
  const session = brief.createSession(snapshot());
  session.document.current_state = 'Черновик до входа';
  const raw = brief.serializeSession(session, PROJECT);
  const { container, controller } = fixture(async () => { throw Object.assign(Error('unauthorized'), { status: 401 }); }, {}, { sessionStorage: { getItem: () => raw, removeItem() {}, setItem() {} } });
  await flush();
  assert.match(container.innerHTML, /Продолжить редактирование/);
  assert.match(container.innerHTML, /Личные уточнения доступны после входа/);
  assert.equal(controller.hasDraft(), false, 'cached draft must not block unrelated rerenders');
  controller.dispose();
});
