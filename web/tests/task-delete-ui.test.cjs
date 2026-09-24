// Node.js 24 built-ins only. Exercise the actual application script with fake DOM/API boundaries.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {randomUUID}=require('node:crypto');
const file=process.env.COS_TEST_HTML||path.join(__dirname,'../index.html');
const script=fs.readFileSync(file,'utf8').match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\bboot\(\);\s*$/,'');
const copy=value=>JSON.parse(JSON.stringify(value));

function fixture(){
  const elements=new Map(),calls=[],messages=[],dialogs=[],renders=[];
  function makeElement(){return {value:'',innerHTML:'',textContent:'',disabled:false,isConnected:true,listeners:{},style:{},dataset:{},
    classList:{add(){},remove(){},toggle(){}},parentElement:{querySelector(){return null}},
    addEventListener(name,fn){this.listeners[name]=fn},setAttribute(name,value){this[name]=value},focus(){this.focused=true},
    querySelector:element,querySelectorAll(selector){return selector==='button'?[element('#taskDeleteConfirm'),element('#taskDeleteCancel')]:[]},
    showModal(){this.open=true},close(){this.open=false;this.listeners.close?.()},remove(){this.isConnected=false;if(this.id)elements.delete('#'+this.id)}}}
  function element(selector){if(selector==='#taskDeleteDialog')return elements.get(selector)||null;if(!elements.has(selector))elements.set(selector,makeElement());return elements.get(selector)}
  const controls=['#tdDesc','#tdArea','#taskSave','#taskCancel','#taskDelete'].map(element);
  let request=async path=>({ok:true,id:path.split('/').at(-1)});
  const context=vm.createContext({window:{addEventListener(){}},Date,Intl,URL,console,crypto:{randomUUID},
    location:new URL('https://chief-of-staff-v3-live.vercel.app/'),setTimeout(){},clearTimeout(){},setInterval(){},
    document:{querySelector:element,querySelectorAll:selector=>selector.startsWith('.task-drawer input')?controls:[],createElement:makeElement,body:{appendChild(dialog){elements.set('#'+dialog.id,dialog);dialogs.push(dialog)}}},
    sessionStorage:{getItem(){return null},setItem(){},removeItem(){}}});
  vm.runInContext(script,context,{filename:file});
  context.requestStub=async(path,options)=>{calls.push({path,...options});return request(path,options)};
  context.toastStub=(...args)=>messages.push(args);context.renderStub=()=>renders.push(true);
  vm.runInContext('quickNotesRequest=requestStub;toast=toastStub;renderTaskContext=renderStub;',context);
  const app=vm.runInContext('({S,taskDrawer,closeTaskDrawer,openTaskDeleteDialog,deleteTask,taskDeleteError,patchTask,beginTaskDraft})',context);
  const task={id:'task-1',description:'Проверить образец',details:'Контекст',status:'open',direction:'internal',cos_version:7,project_id:null};
  app.S.tasks=[task];app.S.task=task.id;
  return {app,task,calls,messages,dialogs,element,renders,controls,request(fn){request=fn}};
}

test('existing task has distinct discard and delete controls; discard changes no saved data',()=>{
  const f=fixture(),before=copy(f.task),html=f.app.taskDrawer(f.task);
  assert.match(html,/id="taskCancel"[^>]*>Отменить изменения<\/button>/);
  assert.match(html,/id="taskDelete"[^>]*>Удалить задачу<\/button>/);
  f.element('#tdDesc').value='Не сохранять';f.app.closeTaskDrawer();
  assert.equal(f.app.S.task,null);assert.deepEqual(copy(f.app.S.tasks),[before]);assert.equal(f.calls.length,0);
  const draft=f.app.taskDrawer({...f.task,_draft:true});assert.doesNotMatch(draft,/id="taskDelete"/);assert.match(draft,/id="taskCancel"/);
});

test('opening then dismissing deletion confirmation makes no request and escapes task content',()=>{
  const f=fixture();f.task.description='<img src=x onerror=alert(1)>';f.app.openTaskDeleteDialog(f.task.id);
  const dialog=f.dialogs[0];assert.equal(dialog.open,true);assert.match(dialog.innerHTML,/&lt;img/);assert.doesNotMatch(dialog.innerHTML,/<img/);
  assert.match(dialog.innerHTML,/Учтённое время, файлы и заметка-источник сохранятся/);
  assert.equal(f.element('#taskDeleteCancel').focused,true);assert.equal(f.calls.length,0);
  f.element('#taskDeleteCancel').onclick();assert.equal(dialog.open,false);assert.equal(f.calls.length,0);assert.equal(f.app.S.tasks.length,1);
});

test('confirmed deletion sends captured version once, removes visible task and graph, preserves history/media',async()=>{
  const f=fixture();f.app.S.links=[{id:'related',source_commitment_id:'task-1',target_commitment_id:'other'},{id:'keep',source_commitment_id:'x',target_commitment_id:'other'}];
  f.app.S.layouts=[{commitment_id:'task-1'},{commitment_id:'other'}];f.app.S.time=[{id:'elapsed',commitment_id:'task-1',source:'timer',ended_at:'2026-09-24T10:00:00Z'}];f.app.S.taskAssets=[{id:'asset',commitment_id:'task-1'}];
  const times=f.app.S.time,assets=f.app.S.taskAssets;f.app.openTaskDeleteDialog('task-1');
  await f.element('#taskDeleteForm').onsubmit({preventDefault(){}});
  assert.deepEqual(copy(f.calls),[{path:'/tasks/task-1',method:'DELETE',body:{version:7}}]);
  assert.equal(f.app.S.tasks.length,0);assert.equal(f.app.S.task,null);assert.deepEqual(copy(f.app.S.links).map(x=>x.id),['keep']);assert.deepEqual(copy(f.app.S.layouts),[{commitment_id:'other'}]);
  assert.equal(f.app.S.time,times);assert.equal(f.app.S.taskAssets,assets);assert.equal(f.dialogs[0].open,false);assert.equal(f.app.S.taskSaveBusy,false);
});

test('active timer blocks deletion both before dialog and if started before confirmation',async()=>{
  const f=fixture();f.app.S.time=[{commitment_id:'task-1',source:'timer',ended_at:null}];f.app.openTaskDeleteDialog('task-1');
  assert.equal(f.dialogs.length,0);await assert.rejects(f.app.deleteTask('task-1'),{code:'task_timer_running'});assert.equal(f.calls.length,0);
  f.app.S.time=[];f.app.openTaskDeleteDialog('task-1');f.app.S.time=[{commitment_id:'task-1',source:'timer',ended_at:null}];
  await f.element('#taskDeleteForm').onsubmit({preventDefault(){}});assert.match(f.element('#taskDeleteError').textContent,/остановите таймер/);assert.equal(f.calls.length,0);
});

test('pending deletion locks duplicate submits, task saves, closing and navigation until resolved',async()=>{
  const f=fixture();let resolve;f.request(()=>new Promise(done=>{resolve=done}));f.element('#tdArea').disabled=true;
  const deletion=f.app.deleteTask('task-1');assert.equal(f.app.S.taskSaveBusy,true);assert.equal(f.controls.every(node=>node.disabled),true);
  assert.equal(await f.app.deleteTask('task-1'),false);f.app.closeTaskDrawer();f.app.beginTaskDraft();await f.app.patchTask('task-1',{status:'completed'});
  assert.equal(f.calls.length,1);assert.equal(f.app.S.task,'task-1');resolve({ok:true,id:'task-1'});assert.equal(await deletion,true);
  assert.equal(f.app.S.taskSaveBusy,false);assert.equal(f.element('#tdArea').disabled,true);assert.equal(f.element('#tdDesc').disabled,false);
});

test('server conflict, authorization failure and ambiguous responses preserve task and edited fields',async()=>{
  for(const failure of [{code:'task_version_conflict',status:409},{code:'unauthorized',status:401},{uncertain:true}]){
    const f=fixture(),before=copy(f.task);f.element('#tdDesc').value='Мой несохранённый текст';f.request(async()=>{throw Object.assign(Error('Backend failure'),failure)});
    f.app.openTaskDeleteDialog('task-1');await f.element('#taskDeleteForm').onsubmit({preventDefault(){}});
    assert.deepEqual(copy(f.app.S.tasks),[before]);assert.equal(f.app.S.task,'task-1');assert.equal(f.element('#tdDesc').value,'Мой несохранённый текст');assert.equal(f.dialogs[0].open,true);assert.equal(f.app.S.taskSaveBusy,false);assert.notEqual(f.element('#taskDeleteError').textContent,'Backend failure');
  }
  const f=fixture();f.request(async()=>({ok:true,id:'different-task'}));await assert.rejects(f.app.deleteTask('task-1'),{uncertain:true});assert.equal(f.app.S.tasks.length,1);assert.equal(f.app.S.taskSaveBusy,false);
});

test('draft and unversioned task cannot be sent to deletion endpoint',async()=>{
  const f=fixture();f.task._draft=true;assert.equal(await f.app.deleteTask('task-1'),false);f.app.openTaskDeleteDialog('task-1');assert.equal(f.dialogs.length,0);
  delete f.task._draft;delete f.task.cos_version;await assert.rejects(f.app.deleteTask('task-1'),{code:'invalid_task_delete'});assert.equal(f.calls.length,0);
});
