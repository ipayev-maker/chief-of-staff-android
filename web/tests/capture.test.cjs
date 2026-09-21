// Node.js 24; built-in modules only. Uses synthetic DOM/API; no network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const htmlPath = process.argv[2] || path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const start = html.indexOf('async function saveCaptureDrafts(){');
const end = html.indexOf('\nfunction pcount', start);
assert(start >= 0 && end > start, 'capture function found');
const source = html.slice(start, end);

function fixture(deadline = '') {
  const calls = [], toasts = [], button = { disabled: false };
  const draft = { description: 'Synthetic task', deadline: '2026-09-30' };
  const fields = {
    'input[type=checkbox]': { checked: true },
    '.cd-desc': { value: 'Synthetic task' },
    '.cd-dir': { value: 'internal' },
    '.cd-project': { value: '' },
    '.cd-deadline': { value: deadline },
  };
  const row = { dataset: { i: '0' }, querySelector: selector => fields[selector] };
  const state = { captureDrafts: [draft], tasks: [] };
  const context = vm.createContext({
    S: state, $: () => button, $$: () => [row], R: x => x,
    matchParticipant: () => null,
    api: (route, options) => new Promise((resolve, reject) => {
      calls.push({ route, options, resolve, reject });
    }),
    todayPage: () => {}, toast: (...args) => toasts.push(args),
  });
  vm.runInContext(source, context);
  return { context, state, calls, button, fields, toasts };
}

(async () => {
  const f = fixture();
  const first = f.context.saveCaptureDrafts();
  const second = f.context.saveCaptureDrafts();
  assert.equal(f.calls.length, 1, 'double click creates one POST');
  assert.equal(f.button.disabled, true, 'save disabled while POST pending');
  assert.equal(f.calls[0].options.body[0].deadline, null, 'cleared suggested deadline stays null');
  f.calls[0].resolve([{ id: 'synthetic-id' }]);
  await Promise.all([first, second]);
  assert.equal(f.state.tasks.length, 1, 'one confirmed task added');
  assert.equal(f.state.captureDrafts.length, 0, 'confirmed drafts cleared');
  assert.equal(f.state.captureSaveBusy, false);
  assert.equal(f.button.disabled, false);

  const g = fixture('2026-10-02');
  const failed = g.context.saveCaptureDrafts();
  assert.equal(g.calls[0].options.body[0].deadline, '2026-10-02', 'edited deadline preserved');
  g.calls[0].reject(new Error('synthetic rejection'));
  await failed;
  assert.equal(g.state.captureDrafts.length, 1, 'failed request keeps drafts');
  assert.equal(g.state.tasks.length, 0);
  assert.equal(g.state.captureSaveBusy, false);
  assert.equal(g.button.disabled, false, 'failure unlocks button');

  const empty = fixture();
  empty.fields['input[type=checkbox]'].checked = false;
  await empty.context.saveCaptureDrafts();
  assert.equal(empty.calls.length, 0, 'no selection sends no POST');
  assert.equal(empty.button.disabled, false);
  console.log('PASS capture: duplicate-click guard; cleared/edited deadline; success/failure state; empty selection.');
})().catch(error => { console.error(error); process.exitCode = 1; });
