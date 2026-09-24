// Node.js 24 built-ins. No live database, user data, or network mutations.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const PROJECT = '01234567-abcd-4000-8000-000000000001';
const OTHER = '01234567-abcd-4000-8000-000000000002';
const REQUEST = '11234567-abcd-4000-8000-000000000001';
const ENTRY = '21234567-abcd-4000-8000-000000000001';
const TIME = '2026-09-24T18:00:00Z';
const modulePromise = import('../../supabase/functions/cos-notes/project-brief.mjs');
const entry = (changes = {}) => ({id: ENTRY, kind: 'waiting', text: 'Подтверждение образца', person: '', review_on: null, source: '', status: 'open', ...changes});
async function fixture() {
  const module = await modulePromise;
  const document = module.emptyProjectBrief();
  const calls = [];
  const store = {async rpc(name, args) {
    calls.push({name, args});
    if (name === 'cos_get_project_brief') return {project_id: args.p_project_id, revision: 0, updated_at: null, document, history: []};
    return {project_id: args.p_project_id, revision: args.p_revision + 1, updated_at: TIME, document: args.p_document,
      history: [{revision: args.p_revision + 1, created_at: TIME, changed_fields: ['goal']}], replayed: false};
  }};
  const save = data => module.saveProjectBrief({store, projectId: PROJECT, data: {revision: 0, request_id: REQUEST, document, ...data}});
  return {...module, store, calls, save, document};
}
const rejects = (promise, status, code) => assert.rejects(promise, error => error.status === status && error.code === code);

test('new brief reads as explicit empty state, without fabricating dates, people, or history', async () => {
  const f = await fixture();
  assert.deepEqual(await f.getProjectBrief({store: f.store, projectId: PROJECT.toUpperCase()}), {
    project_id: PROJECT, revision: 0, updated_at: null, document: f.document, history: [],
  });
  assert.deepEqual(f.calls, [{name: 'cos_get_project_brief', args: {p_project_id: PROJECT}}]);
  const doc = f.emptyProjectBrief(); doc.entries.push(entry()); assert.equal(f.emptyProjectBrief().entries.length, 0);
});

test('saving passes a normalized scoped request and expected revision to one atomic RPC', async () => {
  const f = await fixture();
  const document = {...f.document, goal: 'Согласованный образец', entries: [entry({id: ENTRY.toUpperCase()})]};
  const result = await f.save({document, request_id: REQUEST.toUpperCase(), revision: 7});
  assert.equal(result.revision, 8); assert.equal(result.replayed, false);
  assert.deepEqual(f.calls, [{name: 'cos_save_project_brief', args: {p_project_id: PROJECT, p_revision: 7,
    p_request_id: REQUEST, p_document: {...document, entries: [entry()]}}}]);
  assert.equal(document.entries[0].id, ENTRY.toUpperCase(), 'caller document is not mutated');
});

test('request rejects missing/unknown keys, bad UUID, and unsafe or exhausted revision before RPC', async () => {
  const f = await fixture();
  for (const revision of [-1, 0.1, '0', null, true, 2147483647, Number.MAX_SAFE_INTEGER]) {
    await rejects(f.save({revision}), 400, 'invalid_project_brief_request');
  }
  for (const request_id of ['', 'bad', null, [], 123]) await rejects(f.save({request_id}), 400, 'invalid_project_brief_request');
  for (const data of [null, [], {}, {revision: 0, request_id: REQUEST, document: f.document, owner: 'fake'}]) {
    await rejects(f.saveProjectBrief({store: f.store, projectId: PROJECT, data}), 400, 'invalid_project_brief_request');
  }
  await rejects(f.getProjectBrief({store: f.store, projectId: 'bad'}), 400, 'invalid_project');
  assert.equal(f.calls.length, 0);
});

test('document requires the complete schema and rejects hostile Unicode and oversized fields', async () => {
  const f = await fixture();
  const invalid = [null, [], {}, {...f.document, guess: 'invented'}, {...f.document, checkpoint_on: undefined},
    {...f.document, goal: null}, {...f.document, goal: 'x'.repeat(2001)}, {...f.document, current_state: 'x'.repeat(4001)},
    {...f.document, next_step: 'x'.repeat(2001)}, {...f.document, checkpoint_label: 'x'.repeat(501)},
    {...f.document, goal: '\0'}, {...f.document, goal: '\ud800'}, {...f.document, goal: '\udc00'},
    {...f.document, entries: null}, {...f.document, entries: Array.from({length: 61}, (_, i) => entry({id: `21234567-abcd-4000-8000-${String(i).padStart(12, '0')}`}))}];
  for (const document of invalid) await rejects(f.save({document}), 400, 'invalid_project_brief');
  assert.equal(f.calls.length, 0);
  assert.equal(f.validateProjectBriefDocument({...f.document, goal: '😀'.repeat(2000)}).goal.length, 4000, 'limit counts Unicode code points');
});

test('dates must be actual calendar days and decisions cannot carry review dates', async () => {
  const f = await fixture();
  for (const invalid of ['2026-02-29', '2026-04-31', '0000-01-01', '2026-1-01', '24.09.2026', '2026-09-24T00:00:00Z', 0, '', true]) {
    await rejects(f.save({document: {...f.document, checkpoint_on: invalid}}), 400, 'invalid_project_brief');
    await rejects(f.save({document: {...f.document, entries: [entry({review_on: invalid})]}}), 400, 'invalid_project_brief');
  }
  await rejects(f.save({document: {...f.document, entries: [entry({kind: 'decision', review_on: '2026-09-24'})]}}), 400, 'invalid_project_brief');
  assert.equal(f.calls.length, 0);
  for (const day of [null, '2024-02-29', '0001-01-01', '9999-12-31']) {
    f.validateProjectBriefDocument({...f.document, checkpoint_on: day, entries: [entry({review_on: day})]});
  }
});

test('entries validate exact fields, distinct UUIDs, trimmed text, bounds, kinds, and statuses', async () => {
  const f = await fixture();
  for (const badEntry of [null, [], {}, entry({id: 'bad'}), entry({kind: 'task'}), entry({status: 'done'}), entry({text: ''}),
    entry({text: ' text '}), entry({text: '\ntext'}), entry({text: '\u00a0'}), entry({text: 'x'.repeat(2001)}),
    entry({person: 'x'.repeat(301)}), entry({source: 'x'.repeat(1001)}), entry({owner: 'caller'})]) {
    await rejects(f.save({document: {...f.document, entries: [badEntry]}}), 400, 'invalid_project_brief');
  }
  await rejects(f.save({document: {...f.document, entries: [entry(), entry({id: ENTRY.toUpperCase()})]}}), 400, 'invalid_project_brief');
  assert.equal(f.calls.length, 0);
  for (const kind of ['waiting', 'question', 'decision']) for (const status of ['open', 'resolved']) {
    f.validateProjectBriefDocument({...f.document, entries: [entry({kind, status})]});
  }
});

test('overall UTF-8 budget bounds a valid but oversized collection before RPC', async () => {
  const f = await fixture();
  const entries = Array.from({length: 30}, (_, i) => entry({id: `21234567-abcd-4000-8000-${String(i).padStart(12, '0')}`, text: 'я'.repeat(2000), source: 'я'.repeat(1000)}));
  await rejects(f.save({document: {...f.document, entries}}), 400, 'project_brief_too_large');
  assert.equal(f.calls.length, 0);
});

test('retries preserve stable request identity and replay returns current state without overwriting later edits', async () => {
  const f = await fixture();
  const current = {...f.document, current_state: 'Более позднее подтверждение'};
  f.store.rpc = async (name, args) => { f.calls.push({name, args}); return {project_id: PROJECT, revision: 3, updated_at: TIME,
    document: current, history: [{revision: 3, created_at: TIME, changed_fields: ['current_state']}], replayed: true}; };
  for (let i = 0; i < 2; i++) { const result = await f.save(); assert.equal(result.replayed, true); assert.deepEqual(result.document, current); }
  assert.deepEqual(f.calls[0], f.calls[1]);
});

test('responses expose only sanitized history metadata, never private revision documents or request receipts', async () => {
  const f = await fixture();
  f.store.rpc = async () => ({project_id: PROJECT, revision: 1, updated_at: TIME, document: f.document, secret: 'PRIVATE',
    history: [{revision: 1, created_at: TIME, changed_fields: ['goal'], document: {goal: 'PRIVATE OLD DATA'}, request_id: REQUEST}]});
  const result = await f.getProjectBrief({store: f.store, projectId: PROJECT});
  assert.deepEqual(result.history, [{revision: 1, created_at: TIME, changed_fields: ['goal']}]);
  assert.ok(!JSON.stringify(result).includes('PRIVATE')); assert.ok(!JSON.stringify(result).includes(REQUEST));
});

test('malformed, wrong-project, stale, or unconfirmed database responses are never acknowledged as saves', async () => {
  const f = await fixture();
  const good = {project_id: PROJECT, revision: 1, updated_at: TIME, document: f.document, history: [], replayed: false};
  for (const bad of [null, [], {}, {...good, project_id: OTHER}, {...good, revision: 0}, {...good, revision: 1.5},
    {...good, updated_at: null}, {...good, replayed: undefined}, {...good, history: [{revision: 2, created_at: TIME, changed_fields: []}]},
    {...good, history: [{revision: 1, created_at: TIME, changed_fields: ['secret']}]},
    {...good, history: [{revision: 1, created_at: TIME, changed_fields: ['goal', 'goal']}]},
    {...good, document: {...f.document, goal: 'wrong saved payload'}}, {...good, revision: 2}]) {
    f.store.rpc = async () => bad; await rejects(f.save(), 503, 'project_brief_unavailable');
  }
  f.store.rpc = async () => good; await rejects(f.save({revision: 2}), 503, 'project_brief_unavailable');
  f.store.rpc = async () => ({...good, revision: 1, replayed: true}); await rejects(f.save({revision: 2}), 503, 'project_brief_unavailable');
});

test('RPC errors map by allowlisted SQLSTATE and never disclose private database messages', async () => {
  for (const [code, status, expected] of [['PT404', 404, 'project_not_found'], ['PT409', 409, 'project_brief_conflict'],
    ['PT400', 400, 'invalid_project_brief'], ['23514', 400, 'invalid_project_brief'], ['42501', 503, 'project_brief_unavailable'],
    ['STORE_NETWORK', 503, 'project_brief_unavailable'], ['__proto__', 503, 'project_brief_unavailable'], ['constructor', 503, 'project_brief_unavailable']]) {
    const f = await fixture(); f.store.rpc = async () => { throw Object.assign(Error('PRIVATE'), {code}); };
    await rejects(f.save(), status, expected);
    await rejects(f.getProjectBrief({store: f.store, projectId: PROJECT}), status, expected);
  }
});

test('SQL contract retains private additive tables, service-only invoker RPCs, scoped replay, and parent serialization', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../../supabase/project-brief.sql'), 'utf8');
  assert.match(sql, /cos_project_briefs enable row level security/);
  assert.match(sql, /cos_project_brief_history enable row level security/);
  assert.match(sql, /revoke all on public\.cos_project_briefs, public\.cos_project_brief_history from public, anon, authenticated, service_role/);
  assert.doesNotMatch(sql, /security definer|grant\s+.*\s+to\s+(?:anon|authenticated)|alter table public\.projects|update public\.projects/i);
  assert.match(sql, /unique \(project_id, request_id\)/);
  assert.ok(sql.indexOf('for update;') < sql.indexOf('select * into previous'));
  assert.match(sql, /previous\.base_revision<>p_revision or previous\.document<>p_document/);
  assert.match(sql, /coalesce\(brief\.revision,0\)<>p_revision/);
});
