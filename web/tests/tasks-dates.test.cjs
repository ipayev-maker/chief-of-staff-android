// Run with Node.js 24: TZ=Europe/Moscow node --test cos-fixes/tests/tasks-dates.test.cjs
// The actual application script runs in an isolated VM; API and DOM are mocked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {randomUUID} = require('node:crypto');
const file = process.env.COS_TEST_HTML || path.join(__dirname, '../index.html');
const script = fs.readFileSync(file, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\bboot\(\);\s*$/, '');
function fixture() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {value:'', disabled:false, isConnected:true,
      addEventListener(){}, focus(){this.focused=true}, classList:{add(){},remove(){}},
      parentElement:{querySelector(){return null}}});
    return elements.get(id);
  };
  const calls=[],messages=[];
  const context = vm.createContext({window:{addEventListener(){}},Date,Intl,URL,location:new URL('https://chief-of-staff-v3-live.vercel.app/'),console,crypto:{randomUUID},setInterval(){},
    setTimeout(){},clearTimeout(){},confirm:()=>true,
    document:{querySelector:element,querySelectorAll:()=>[]}});
  vm.runInContext(script,context,{filename:file});
  context.apiStub=async (url,options)=>{calls.push({url,...options});return [{id:'saved-task',...options.body}]};
  context.toastStub=(...args)=>messages.push(args);
  vm.runInContext('api=apiStub;toast=toastStub;renderTaskContext=()=>{};',context);
  const app=vm.runInContext('({S,newGlobalTask,createProjectTask,closeTaskDrawer,saveTask,taskTimingPayload,taskDrawer,rememberTaskDraft,patchTask,addLink,uploadTaskFiles,due,plan,isTaskOverdue,today})',context);
  const setForm=values=>{for(const [id,value] of Object.entries({tdDesc:'',tdDetails:'',tdProject:'',tdArea:'',tdStatus:'open',tdDirection:'internal',tdParticipant:'',tdPlanDate:'',tdPlanStartTime:'',tdPlanEndTime:'',tdDeadlineDate:'',tdDeadlineTime:'',tdCheckDate:'',tdCheckTime:'',tdEstimate:'',...values}))element('#'+id).value=value};
  setForm({});
  return {app,context,element,calls,messages,setForm};
}
const empty = {planDate:'',planStart:'',planEnd:'',deadlineDate:'',deadlineTime:'',checkDate:'',checkTime:''};
const plain = value => JSON.parse(JSON.stringify(value));
test('global and project creation are local drafts; cancelling writes nothing',()=>{
  const {app,calls}=fixture();app.S.areaFilter='work';app.newGlobalTask();
  assert.equal(app.S.taskDraft.description,'');assert.equal(app.S.taskDraft.area_key,'work');
  assert.equal(app.S.tasks.length,0);assert.equal(calls.length,0);app.closeTaskDrawer();
  assert.equal(app.S.taskDraft,null);assert.equal(app.S.task,null);
  app.S.project={id:'project-1',area_key:'personal'};app.createProjectTask();
  assert.equal(app.S.taskDraft.project_id,'project-1');assert.equal(app.S.taskDraft.area_key,'personal');
  app.closeTaskDrawer();assert.equal(calls.length,0);
});
test('blank draft cannot be posted; one explicit save posts the entered text',async()=>{
  const {app,calls,setForm,element}=fixture();app.newGlobalTask();const id=app.S.task;
  setForm({tdDesc:'   '});await app.saveTask(id);assert.equal(calls.length,0);assert.equal(element('#tdDesc').focused,true);
  setForm({tdDesc:'  Обсудить образец  ',tdDeadlineDate:'2026-09-25'});await app.saveTask(id);
  assert.equal(calls.length,1);assert.equal(calls[0].method,'POST');assert.equal(calls[0].url,'/rest/v1/commitments');
  assert.equal(calls[0].body.description,'Обсудить образец');assert.equal(calls[0].body.deadline,'2026-09-25');assert.equal(calls[0].body.deadline_at,null);
  assert.equal('_draft' in calls[0].body,false);assert.equal(app.S.taskDraft,null);assert.equal(app.S.tasks.length,1);
});
test('save lock prevents duplicate requests; failure preserves draft for correction',async()=>{
  const {app,context,calls,setForm}=fixture();app.newGlobalTask();setForm({tdDesc:'Результат'});
  let reject;context.apiStub=(url,opt)=>{calls.push({url,...opt});return new Promise((_,r)=>{reject=r})};vm.runInContext('api=apiStub',context);
  const id=app.S.task, saving=app.saveTask(id);await app.saveTask(id);app.closeTaskDrawer();app.newGlobalTask();
  assert.equal(calls.length,1);assert.equal(app.S.task,id);reject(Error('offline'));await saving;
  assert.equal(app.S.taskSaveBusy,false);assert.equal(app.S.taskDraft.id,id);assert.equal(app.S.tasks.length,0);
});
test('existing task is patched and date-only values retain null timestamps',async()=>{
  const {app,calls,setForm}=fixture();app.S.tasks=[{id:'existing',project_id:null}];app.S.task='existing';
  setForm({tdDesc:'Изменено',tdPlanDate:'2026-09-22',tdDeadlineDate:'2026-09-24',tdCheckDate:'2026-09-23'});await app.saveTask('existing');
  assert.equal(calls.length,1);assert.equal(calls[0].method,'PATCH');assert.match(calls[0].url,/id=eq.existing/);
  assert.equal(app.S.tasks[0].description,'Изменено');
  assert.equal(calls[0].body.planned_start_at,null);assert.equal(calls[0].body.deadline_at,null);assert.equal(calls[0].body.next_check_at,null);
});
test('three independent calendar dates stay separate and explicit times become ISO instants',()=>{
  const {app}=fixture();const input={...empty,planDate:'2026-09-22',planStart:'09:05',planEnd:'10:15',deadlineDate:'2026-09-25',deadlineTime:'00:15',checkDate:'2026-09-23',checkTime:'12:40'};
  const body=app.taskTimingPayload(input);
  assert.equal(body.planned_on,'2026-09-22');assert.equal(body.deadline,'2026-09-25');assert.equal(body.next_check_on,'2026-09-23');
  assert.equal(body.planned_start_at,new Date('2026-09-22T09:05').toISOString());
  assert.equal(body.planned_end_at,new Date('2026-09-22T10:15').toISOString());
  assert.equal(body.deadline_at,new Date('2026-09-25T00:15').toISOString());
  assert.equal(body.next_check_at,new Date('2026-09-23T12:40').toISOString());
  assert.equal(app.due(body),'2026-09-25');assert.equal(app.plan(body),'2026-09-22');
});
test('clearing optional times clears stale instants without deleting calendar dates',()=>{
  const {app}=fixture();const body=app.taskTimingPayload({...empty,deadlineDate:'2026-09-25'});
  assert.equal(body.deadline,'2026-09-25');assert.equal(body.deadline_at,null);
  assert.deepEqual(plain(app.taskTimingPayload(empty)),{planned_on:null,planned_start_at:null,planned_end_at:null,deadline:null,deadline_at:null,next_check_on:null,next_check_at:null});
});
test('invalid time-only and reversed planned intervals are rejected before saving',async()=>{
  const {app,calls,setForm}=fixture();
  for(const [field,value] of [['planStart','09:00'],['deadlineTime','12:00'],['checkTime','12:00']])assert.throws(()=>app.taskTimingPayload({...empty,[field]:value}));
  assert.throws(()=>app.taskTimingPayload({...empty,planDate:'2026-09-22',planEnd:'10:00'}));
  assert.throws(()=>app.taskTimingPayload({...empty,planDate:'2026-09-22',planStart:'11:00',planEnd:'10:00'}));
  app.newGlobalTask();setForm({tdDesc:'Задача',tdDeadlineTime:'12:00'});await app.saveTask(app.S.task);assert.equal(calls.length,0);
});
test('draft controls cannot create relations, media or completion writes',async()=>{
  const {app,calls}=fixture();app.S.project={id:'project-1',area_key:'work'};app.createProjectTask();
  const markup=app.taskDrawer(app.S.taskDraft);
  assert.match(markup,/placeholder="Что нужно сделать\?" required value=""/);
  for(const id of ['timerStart','timerStop','taskMediaInput','linkAdd','taskComplete'])assert.equal(markup.includes(`id="${id}"`),false,id);
  assert.match(markup,/id="taskCancel"/);assert.equal((markup.match(/class="task-timing-extra" open/g)||[]).length,0);
  await app.patchTask(app.S.task,{status:'completed'});await app.addLink(app.S.task);await app.uploadTaskFiles(app.S.task,[{}]);assert.equal(calls.length,0);
});
test('draft edits and timing survive rerender; filled optional sections are visible',()=>{
  const {app,setForm}=fixture();app.newGlobalTask();setForm({tdDesc:'Не потерять',tdPlanDate:'2026-09-22',tdCheckDate:'2026-09-23'});app.rememberTaskDraft();
  const markup=app.taskDrawer(app.S.taskDraft);assert.match(markup,/value="Не потерять"/);assert.equal((markup.match(/class="task-timing-extra" open/g)||[]).length,2);
});
test('exact deadline becomes overdue during the day; date-only today does not',()=>{
  const {app}=fixture();assert.equal(app.isTaskOverdue({deadline:app.today()}),false);
  assert.equal(app.isTaskOverdue({deadline_at:new Date(Date.now()-60000).toISOString()}),true);
  assert.equal(app.isTaskOverdue({deadline_at:new Date(Date.now()+60000).toISOString()}),false);
  assert.equal(app.isTaskOverdue({}),false);
});
