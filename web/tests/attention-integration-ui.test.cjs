// Run with Node.js 24: node --test tests/attention-integration-ui.test.cjs
// The actual application script runs with DOM, attention rendering and API boundaries stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {randomUUID} = require('node:crypto');
const file = process.env.COS_TEST_HTML || path.join(__dirname, '../index.html');
const script = fs.readFileSync(file, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\bboot\(\);\s*$/, '');
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {let resolve; const promise = new Promise(yes => {resolve = yes}); return {promise, resolve}};

function fixture() {
  const elements = new Map(), calls = [], messages = [], renders = [], workspaces = [], dialogs = [];
  const makeElement = () => ({value:'',innerHTML:'',textContent:'',disabled:false,isConnected:true,dataset:{},style:{},listeners:{},closest(){return null},
    classList:{add(){},remove(){},toggle(){}},parentElement:{querySelector(){return null}},
    addEventListener(name, fn){this.listeners[name]=fn},focus(){this.focused=true},
    setAttribute(name,value){this[name]=value},querySelector:element,querySelectorAll:()=>[],
    showModal(){this.open=true},close(){this.open=false;this.listeners.close?.()},
    remove(){this.isConnected=false;if(this.id)elements.delete('#'+this.id)},
  });
  function element(selector) {
    if(selector === '#calendarMeetingDetails')return elements.get(selector)||null;
    if(!elements.has(selector))elements.set(selector,makeElement());
    return elements.get(selector);
  }
  let apiResponse=async(url,options={})=>options.method ? [{id:'saved-task',...options.body}] : [];
  const context=vm.createContext({window:{addEventListener(){},CoSAttention:{render(target,options){
    renders.push({target,options,tasks:plain(options.tasks)});
  }}},Date,Intl,URL,console,crypto:{randomUUID},location:new URL('https://chief-of-staff-v3-live.vercel.app/'),
    history:{replaceState(){}},sessionStorage:{getItem(){return null},setItem(){},removeItem(){}},
    setTimeout(){},clearTimeout(){},setInterval(){},confirm:()=>true,
    document:{querySelector:element,querySelectorAll:()=>[],createElement:makeElement,body:{appendChild(node){
      if(node.id)elements.set('#'+node.id,node);dialogs.push(node);
    }}},
  });
  vm.runInContext(script,context,{filename:file});
  context.apiStub=async(url,options={})=>{calls.push({url,...options});return apiResponse(url,options)};
  context.toastStub=(message,type)=>messages.push({message,type});
  context.workspaceStub=()=>workspaces.push(vm.runInContext('({section:S.section,project:S.project?.id,tab:S.tab,meeting:S.meeting?.id})',context));
  vm.runInContext('api=apiStub;toast=toastStub;bindTaskDrawer=()=>{};workspace=workspaceStub;',context);
  const app=vm.runInContext('({S,QN,todayPage,renderTodayAttention,openAttentionTask,openAttentionProject,saveTask,closeTaskDrawer})',context);
  app.S.section='today';app.QN.loaded=true;
  app.S.projects=[{id:'project-1',title:'Project',status:'active',area_key:'work'}];
  app.S.areas=[{key:'work',title:'Work'}];
  const form=values=>{for(const [key,value] of Object.entries({tdDesc:'',tdDetails:'',tdProject:'',tdArea:'',tdStatus:'open',tdDirection:'internal',tdParticipant:'',tdPlanDate:'',tdPlanStartTime:'',tdPlanEndTime:'',tdDeadlineDate:'',tdDeadlineTime:'',tdCheckDate:'',tdCheckTime:'',tdEstimate:'',...values}))element('#'+key).value=value};
  form({});
  const navigate=async section=>{
    const button=makeElement();button.dataset.sec=section;
    await element('#nav').listeners.click({target:{closest:()=>button}});
  };
  return {app,context,element,calls,messages,renders,workspaces,dialogs,form,navigate,
    api(response){apiResponse=response},evaluate(code){return vm.runInContext(code,context)},
  };
}

test('today passes complete current task and project arrays to attention without dashboard prefiltering',()=>{
  const f=fixture(),tasks=[
    {id:'open',description:'Due',status:'open',direction:'to_me',project_id:'project-1',deadline:'2026-01-01'},
    {id:'completed',description:'History',status:'completed',project_id:'project-1'},
    {id:'paused',description:'Still unfinished',status:'paused',project_id:null},
  ],projects=[...f.app.S.projects,{id:'paused-project',title:'Paused',status:'paused'}];
  f.app.S.tasks=tasks;f.app.S.projects=projects;f.app.todayPage();
  const first=f.renders.at(-1);
  assert.equal(first.target,f.element('#todayAttention'));
  assert.equal(first.options.tasks,tasks);assert.equal(first.options.projects,projects);
  assert.equal(first.options.onOpenTask,f.app.openAttentionTask);assert.equal(first.options.onOpenProject,f.app.openAttentionProject);
  const replacement=[{id:'new',description:'New state',status:'open'}];
  f.app.S.tasks=replacement;f.app.renderTodayAttention();
  assert.equal(f.renders.at(-1).options.tasks,replacement);assert.equal(f.calls.length,0);
  f.app.S.section='tasks';f.app.renderTodayAttention();assert.equal(f.renders.length,2);
  f.app.S.section='today';f.app.S.project=projects[0];f.app.renderTodayAttention();assert.equal(f.renders.length,2);
});

test('attention opens the independent check section or deadline field without changing the task',async()=>{
  const f=fixture(),task={id:'task-1',description:'Wait for sample',status:'open',direction:'to_me',project_id:null,deadline:'2026-10-02'};
  f.app.S.tasks=[task];const before=plain(task),details={open:false};
  f.element('#tdCheckDate').closest=selector=>selector==='details'?details:null;
  await f.app.openAttentionTask(task.id,'waiting');
  assert.equal(f.app.S.task,task.id);assert.equal(details.open,true);assert.equal(f.element('#tdCheckDate').focused,true);
  assert.match(f.element('#main').innerHTML,/id="tdDeadlineDate" type="date" value="2026-10-02"/);
  assert.deepEqual(plain(task),before);assert.equal(f.calls.length,0);
  await f.app.openAttentionTask(task.id,'overdue');
  assert.equal(f.element('#tdDeadlineDate').focused,true);assert.deepEqual(plain(task),before);assert.equal(f.calls.length,0);
});

test('saving a check from attention preserves the separate deadline and planned day in one existing-task patch',async()=>{
  const f=fixture(),task={id:'task-1',description:'Wait for sample',details:'',status:'open',direction:'to_me',project_id:null,
    deadline:'2026-10-02',planned_on:'2026-09-28',next_check_on:null};
  f.app.S.tasks=[task];f.api(async(url,options)=>[{id:task.id,...options.body}]);
  await f.app.openAttentionTask(task.id,'waiting');
  const html=f.element('#main').innerHTML,day=id=>html.match(new RegExp(`id="${id}" type="date" value="([^"]*)"`))[1];
  f.form({tdDesc:task.description,tdDirection:'to_me',tdDeadlineDate:day('tdDeadlineDate'),tdPlanDate:day('tdPlanDate'),tdCheckDate:'2026-09-25'});
  await f.app.saveTask(task.id);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'PATCH');assert.equal(f.calls[0].url,'/rest/v1/commitments?id=eq.task-1');
  assert.equal(f.calls[0].body.deadline,'2026-10-02');assert.equal(f.calls[0].body.planned_on,'2026-09-28');
  assert.equal(f.calls[0].body.next_check_on,'2026-09-25');assert.equal(task.deadline,'2026-10-02');
  assert.equal(f.renders.at(-1).tasks[0].next_check_on,'2026-09-25');assert.equal(f.app.S.section,'today');assert.equal(f.app.S.project,null);
});

test('attention task and project actions respect a busy save and the pinned note task',async()=>{
  const f=fixture(),pinned={id:'draft-pending',_draft:true,description:'Keep request',details:'Source',status:'open',direction:'internal',
    project_id:null,_noteSource:{kind:'quick',id:'note-1'},_noteRequestId:'request-1',_noteSubmission:'{"request_id":"request-1"}',_notePinned:true};
  f.app.S.tasks=[{id:'task-1',description:'Other',status:'open'}];f.app.S.taskDraft=pinned;f.app.S.task='unchanged';
  f.app.S.taskSaveBusy=true;
  await f.app.openAttentionTask('task-1','check');await f.app.openAttentionProject('project-1');
  assert.equal(f.app.S.task,'unchanged');assert.equal(f.app.S.project,null);assert.equal(f.calls.length,0);assert.equal(f.renders.length,0);
  f.app.S.taskSaveBusy=false;const before=plain(pinned);
  await f.app.openAttentionTask('task-1','check');await f.app.openAttentionProject('project-1');
  assert.equal(f.app.S.task,pinned.id);assert.equal(f.app.S.taskDraft,pinned);assert.deepEqual(plain(pinned),before);
  assert.equal(f.app.S.project,null);assert.equal(f.calls.length,0);assert.ok(f.messages.every(message=>message.type==='error'));
});

test('failed project open recovers today and late project data cannot replace later navigation',async()=>{
  const failed=fixture();failed.api(async()=>{throw Error('offline')});
  await failed.app.openAttentionProject('project-1');
  assert.equal(failed.app.S.project,null);assert.equal(failed.app.S.section,'today');assert.equal(failed.workspaces.length,0);
  assert.equal(failed.renders.length,1);assert.ok(failed.messages.some(message=>message.message.includes('offline')));

  const late=fixture(),gate=deferred();late.api(async()=>gate.promise);
  const opening=late.app.openAttentionProject('project-1');await tick();
  await late.navigate('tasks');late.element('#main').innerHTML='Current task search';gate.resolve([]);await opening;
  assert.equal(late.app.S.section,'tasks');assert.equal(late.app.S.project,null);assert.equal(late.workspaces.length,0);
  assert.equal(late.element('#main').innerHTML,'Current task search');assert.ok(late.calls.every(call=>!call.method));
});

test('a late task media load does not render over the screen selected while it was pending',async()=>{
  const failed=fixture();failed.app.S.tasks=[{id:'task-1',description:'With media',status:'open'}];
  failed.context.signingStub=async()=>{throw Error('media unavailable')};failed.evaluate('signTaskAssets=signingStub');
  await failed.app.openAttentionTask('task-1','check');
  assert.equal(failed.renders.length,0);assert.equal(failed.calls.length,0);
  assert.ok(failed.messages.some(message=>message.type==='error'&&message.message.includes('media unavailable')));

  const f=fixture(),gate=deferred();f.app.S.tasks=[{id:'task-1',description:'With media',status:'open',direction:'internal'}];
  f.context.signingStub=()=>gate.promise;f.evaluate('signTaskAssets=signingStub');
  const opening=f.app.openAttentionTask('task-1','check');await tick();
  await f.navigate('tasks');f.element('#main').innerHTML='Current task search';gate.resolve();await opening;
  assert.equal(f.app.S.section,'tasks');assert.equal(f.app.S.task,null);
  assert.equal(f.element('#main').innerHTML,'Current task search');assert.equal(f.calls.length,0);
});

test('failure of an older project open cannot clear a newer successful open of the same project',async()=>{
  const f=fixture(),first=deferred();let noteRequests=0;
  f.api(async url=>url.startsWith('/rest/v1/project_notes')&&++noteRequests===1?first.promise:[]);
  const earlier=f.app.openAttentionProject('project-1');await tick();
  await f.app.openAttentionProject('project-1');
  assert.equal(f.app.S.project.id,'project-1');assert.equal(f.workspaces.length,1);
  first.resolve(Promise.reject(Error('older request failed')));await earlier;
  assert.equal(f.app.S.project?.id,'project-1');assert.equal(f.workspaces.length,1);assert.equal(f.renders.length,0);
});

test('navigation during note flushing invalidates the project action before it loads data',async()=>{
  const f=fixture(),gate=deferred();let flushes=0;
  f.context.flushStub=()=>++flushes===1?gate.promise:Promise.resolve();f.evaluate('flushNote=flushStub');
  const opening=f.app.openAttentionProject('project-1');await tick();
  await f.navigate('tasks');f.element('#main').innerHTML='Current task search';gate.resolve();await opening;
  assert.equal(f.app.S.section,'tasks');assert.equal(f.app.S.project,null);
  assert.equal(f.element('#main').innerHTML,'Current task search');assert.equal(f.workspaces.length,0);assert.equal(f.calls.length,0);
});

test('opening an attention task cancels the project still loading behind the visible today screen',async()=>{
  const f=fixture(),gate=deferred(),details={open:false};
  f.app.S.tasks=[{id:'task-1',description:'Check the sample',status:'open',direction:'to_me',project_id:'project-1'}];
  f.element('#tdCheckDate').closest=selector=>selector==='details'?details:null;
  f.app.todayPage();f.api(async()=>gate.promise);
  const projectOpening=f.app.openAttentionProject('project-1');await tick();
  assert.equal(f.app.S.project.id,'project-1');assert.equal(f.workspaces.length,0);
  await f.app.openAttentionTask('task-1','waiting');
  assert.equal(f.app.S.project,null);assert.equal(f.app.S.task,'task-1');assert.equal(f.app.S.section,'today');
  assert.match(f.element('#main').innerHTML,/class="task-drawer"/);
  assert.equal(details.open,true);assert.equal(f.element('#tdCheckDate').focused,true);
  const rendersAfterTask=f.renders.length;f.element('#main').innerHTML='Current task edit';
  gate.resolve([]);await projectOpening;
  assert.equal(f.app.S.project,null);assert.equal(f.app.S.task,'task-1');assert.equal(f.app.S.section,'today');
  assert.equal(f.element('#main').innerHTML,'Current task edit');assert.equal(f.renders.length,rendersAfterTask);
  assert.equal(f.workspaces.length,0);assert.ok(f.calls.every(call=>!call.method));
});
