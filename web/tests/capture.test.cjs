// Actual inline application; synthetic DOM and API only. No network or real records.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const htmlPath = process.argv[2] || path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\bboot\(\);\s*$/, '');

function fixture(deadline = '', time = '') {
  const calls = [], toasts = [], elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {value:'', disabled:false, listeners:{},
      addEventListener(name,handler){this.listeners[name]=handler},classList:{add(){},remove(){},toggle(){}}});
    return elements.get(selector);
  };
  const fields = {
    'input[type=checkbox]': { checked: true },
    '.cd-desc': { value: 'Synthetic task' },
    '.cd-dir': { value: 'internal' },
    '.cd-project': { value: '' },
    '.cd-deadline': { value: deadline },
    '.cd-deadline-time': { value: time },
  };
  const row = { dataset: { i: '0' }, querySelector: selector => fields[selector] };
  const context = vm.createContext({window:{addEventListener(){}},Date,Intl,URL,console,crypto:{randomUUID},
    location:new URL('https://chief-of-staff-v3-live.vercel.app/'),setInterval(){},setTimeout(){},clearTimeout(){},
    document:{querySelector:element,querySelectorAll:selector=>selector==='.capture-draft'?[row]:[]},
    apiStub:(route,options)=>new Promise((resolve,reject)=>calls.push({route,options,resolve,reject})),
    toastStub:(...args)=>toasts.push(args),
  });
  vm.runInContext(source, context);
  vm.runInContext('api=apiStub;toast=toastStub;todayPage=()=>{};',context);
  const app=vm.runInContext('({S,saveCaptureDrafts,captureBlock,bindCapture,rememberCaptureDrafts})',context);
  app.S.captureDrafts=[{description:'Synthetic task',deadline:'2026-09-30'}];
  return {app,context,state:app.S,calls,button:element('#captureSave'),fields,toasts,row};
}

test('capture duplicate-click guard creates one POST and confirmed drafts clear',async()=>{
  const f=fixture(),first=f.app.saveCaptureDrafts(),second=f.app.saveCaptureDrafts();
  assert.equal(f.calls.length,1);assert.equal(f.button.disabled,true);
  assert.equal(f.calls[0].options.body[0].deadline,null,'cleared suggestion stays cleared');
  assert.equal(f.calls[0].options.body[0].deadline_at,null);
  f.calls[0].resolve([{id:'synthetic-id'}]);await Promise.all([first,second]);
  assert.equal(f.state.tasks.length,1);assert.equal(f.state.captureDrafts.length,0);
  assert.equal(f.state.captureSaveBusy,false);assert.equal(f.button.disabled,false);
});

test('capture saves an explicit deadline time in the local timezone; midnight remains explicit',async()=>{
  for(const time of ['15:45','00:00']){
    const f=fixture('2026-10-02',time),saving=f.app.saveCaptureDrafts(),body=f.calls[0].options.body[0];
    assert.equal(body.deadline,'2026-10-02');assert.equal(body.deadline_at,new Date(`2026-10-02T${time}`).toISOString());
    assert.equal('_deadlineTime' in body,false);
    f.calls[0].resolve([{id:'synthetic-id',...body}]);await saving;
  }
});

test('date without time stays date-only; no time is invented from an AI draft',async()=>{
  const f=fixture('2026-10-02');f.state.captureDrafts[0].deadline_at='2026-10-02T08:00:00Z';
  assert.match(f.app.captureBlock(),/class="cd-deadline-time"[^>]*value=""/);
  const saving=f.app.saveCaptureDrafts();assert.equal(f.calls[0].options.body[0].deadline_at,null);
  f.calls[0].resolve([]);await saving;
});

test('invalid dates/times and time without date are rejected before a request',async()=>{
  for(const [date,time] of [['','13:30'],['2026-02-30','13:30'],['2026-10-02','25:00'],['2026-10-02','09:61'],['2026-10-02','broken']]){
    const f=fixture(date,time);await f.app.saveCaptureDrafts();assert.equal(f.calls.length,0);
    assert.match(f.toasts[0][0],/дату|время/);assert.equal(f.button.disabled,false);
  }
  const f=fixture('2026-10-02');f.fields['.cd-deadline-time'].validity={badInput:true};
  await f.app.saveCaptureDrafts();assert.equal(f.calls.length,0);assert.match(f.toasts[0][0],/дату и время/);
});

test('edited capture values and selection survive a rerender and API failure',async()=>{
  const f=fixture('2026-10-02','16:30');f.app.bindCapture();
  f.fields['.cd-desc'].value='Edited task';f.fields['.cd-dir'].value='to_me';f.row.oninput();
  const markup=f.app.captureBlock();assert.match(markup,/value="Edited task"/);
  assert.match(markup,/value="to_me" selected/);assert.match(markup,/class="cd-deadline-time"[^>]*value="16:30"/);
  const saving=f.app.saveCaptureDrafts();f.calls[0].reject(Error('synthetic rejection'));await saving;
  assert.equal(f.state.captureDrafts[0]._deadlineTime,'16:30');assert.equal(f.state.captureDrafts[0].deadline,'2026-10-02');
  assert.equal(f.state.captureDrafts.length,1);assert.equal(f.state.tasks.length,0);assert.equal(f.button.disabled,false);
  f.fields['input[type=checkbox]'].checked=false;f.row.oninput();
  assert.match(f.app.captureBlock(),/data-i="0"><input type="checkbox" >/);
});

test('clearing the date also clears its optional time; empty selection sends nothing',async()=>{
  const f=fixture('2026-10-02','13:30');f.app.bindCapture();f.fields['.cd-deadline'].value='';
  f.row.onchange({target:{value:'',matches:selector=>selector==='.cd-deadline'}});
  assert.equal(f.fields['.cd-deadline-time'].value,'');assert.equal(f.state.captureDrafts[0]._deadlineTime,'');
  assert.equal(f.state.captureDrafts[0].deadline,null);
  f.fields['input[type=checkbox]'].checked=false;await f.app.saveCaptureDrafts();
  assert.equal(f.calls.length,0);assert.equal(f.button.disabled,false);
});
