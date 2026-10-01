// Run with Node.js 24: node --test tests/calendar-integration-ui.test.cjs
// The actual application script runs with DOM, calendar rendering and API boundaries stubbed.
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
  const makeElement = () => ({value:'',innerHTML:'',textContent:'',disabled:false,isConnected:true,dataset:{},style:{},listeners:{},
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
  const context=vm.createContext({window:{addEventListener(){},CoSCalendarView:{render(target,options){
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
  const app=vm.runInContext('({S,QN,createCalendarTask,calendarPage,openCalendarMeeting,openTaskFromAnywhere,saveTask,closeTaskDrawer})',context);
  app.S.section='calendar';app.QN.loaded=true;
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

test('calendar creates only a local blank task with the selected deadline; invalid days and cancel write nothing',()=>{
  const f=fixture();
  for(const day of ['2026-02-30','2026-13-01','2026-9-23','',null])f.app.createCalendarTask(day);
  assert.equal(f.app.S.taskDraft,null);
  f.app.createCalendarTask('2026-09-23');
  const draft=f.app.S.taskDraft;
  assert.equal(draft.description,'');assert.equal(draft.project_id,null);
  assert.equal(draft.deadline,'2026-09-23');
  for(const field of ['deadline_at','planned_on','planned_start_at','planned_end_at','next_check_on','next_check_at'])assert.ok(!draft[field],field);
  assert.match(f.element('#main').innerHTML,/id="tdDeadlineDate" type="date" value="2026-09-23"/);
  assert.equal(f.renders.length,1);assert.equal(f.calls.length,0);
  f.app.closeTaskDrawer();assert.equal(f.app.S.taskDraft,null);assert.equal(f.app.S.section,'calendar');
  assert.equal(f.calls.length,0);assert.equal(f.renders.length,2);
});

test('selected day cannot replace a pinned note task or a task being saved',()=>{
  const f=fixture(),pending={id:'draft-pending',_draft:true,description:'Keep request',details:'Source',status:'open',direction:'internal',project_id:null,deadline:'2026-10-02',
    _noteSource:{kind:'quick',id:'note-1'},_noteRequestId:'request-1',_noteSubmission:{request_id:'request-1',task:{description:'Keep request',deadline:'2026-10-02'}},_notePinned:true};
  f.app.S.taskDraft=pending;f.app.S.task=null;
  f.app.createCalendarTask('2026-11-04');
  assert.equal(f.app.S.task,'draft-pending');assert.equal(f.app.S.taskDraft,pending);
  assert.equal(pending.deadline,'2026-10-02');assert.equal(pending._noteSubmission.task.deadline,'2026-10-02');
  const before=plain(pending),renderCount=f.renders.length;
  f.app.S.taskSaveBusy=true;f.app.createCalendarTask('2026-12-08');
  assert.deepEqual(plain(pending),before);assert.equal(f.renders.length,renderCount);assert.equal(f.calls.length,0);
});

test('task opened from calendar uses one existing-task PATCH and returns updated data to the same calendar screen',async()=>{
  const f=fixture();f.app.S.tasks=[{id:'task-1',description:'Original',details:'',status:'open',direction:'internal',project_id:null,deadline:'2026-09-23'}];
  f.api(async(url,options)=>[{id:'task-1',...options.body}]);
  await f.app.openTaskFromAnywhere('task-1');
  assert.equal(f.app.S.section,'calendar');assert.equal(f.renders.length,1);
  f.form({tdDesc:'Adjusted',tdDeadlineDate:'2026-09-25'});
  await f.app.saveTask('task-1');
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'PATCH');assert.equal(f.calls[0].url,'/rest/v1/commitments?id=eq.task-1');
  assert.equal(f.renders.at(-1).tasks[0].deadline,'2026-09-25');assert.equal(f.renders.at(-1).tasks[0].description,'Adjusted');
  assert.equal(f.app.S.project,null);assert.equal(f.app.S.section,'calendar');
  f.app.closeTaskDrawer();assert.equal(f.app.S.task,null);assert.equal(f.app.S.section,'calendar');
  assert.doesNotMatch(f.element('#main').innerHTML,/class="task-drawer"/);assert.equal(f.calls.length,1);
});

test('failed project load leaves calendar usable and late meeting load cannot replace a newly selected screen',async()=>{
  const failed=fixture();failed.app.S.meetings=[{id:'meeting-1',project_id:'project-1',title:'Meeting'}];
  failed.api(async()=>{throw Error('offline')});
  await failed.app.openCalendarMeeting('meeting-1');
  assert.equal(failed.app.S.project,null);assert.equal(failed.app.S.section,'calendar');assert.equal(failed.app.S.meeting,null);
  failed.app.createCalendarTask('2026-09-23');assert.equal(failed.app.S.taskDraft.deadline,'2026-09-23');assert.equal(failed.workspaces.length,0);

  const late=fixture(),gate=deferred();late.app.S.meetings=[{id:'meeting-1',project_id:'project-1',title:'Meeting'}];
  late.api(async()=>gate.promise);
  const opening=late.app.openCalendarMeeting('meeting-1');await tick();
  await late.navigate('tasks');gate.resolve([]);await opening;
  assert.equal(late.app.S.section,'tasks');assert.equal(late.app.S.project,null);assert.equal(late.app.S.meeting,null);
  assert.equal(late.workspaces.length,0);
});

test('two meeting opens in the same project keep only the newest selection',async()=>{
  const f=fixture(),first=deferred(),second=deferred();let noteRequests=0;
  f.app.S.meetings=[{id:'meeting-1',project_id:'project-1',title:'First'},{id:'meeting-2',project_id:'project-1',title:'Second'}];
  f.api(async url=>url.startsWith('/rest/v1/project_notes')?(++noteRequests===1?first.promise:second.promise):[]);
  const openingFirst=f.app.openCalendarMeeting('meeting-1');await tick();
  const openingSecond=f.app.openCalendarMeeting('meeting-2');await tick();
  second.resolve([]);await openingSecond;first.resolve([]);await openingFirst;
  assert.equal(f.app.S.meeting.id,'meeting-2');assert.equal(f.app.S.tab,'meetings');assert.equal(f.app.S.calendarReturn,true);
  assert.ok(f.workspaces.some(state=>state.meeting==='meeting-2'));
  assert.ok(f.workspaces.every(state=>state.meeting!=='meeting-1'));
  assert.ok(f.calls.every(call=>!call.method||call.method==='GET'));
});

test('orphan meeting opens escaped details with reminder settings and supersedes a pending project meeting without writes',async()=>{
  const f=fixture(),gate=deferred();f.app.S.meetings=[
    {id:'linked',project_id:'project-1',title:'Linked'},
    {id:'orphan',project_id:null,title:'<img src=x onerror=alert(1)>',starts_at:'2026-09-23T09:00:00Z',ends_at:'2026-09-23T10:00:00Z',agenda:'<script>unsafe</script>',meeting_url:'javascript:alert(1)'},
  ];
  f.api(async()=>gate.promise);
  const opening=f.app.openCalendarMeeting('linked');await tick();
  await f.app.openCalendarMeeting('orphan');
  const dialog=f.dialogs.at(-1);
  assert.equal(dialog.open,true);assert.match(dialog.innerHTML,/&lt;img/);assert.match(dialog.innerHTML,/&lt;script&gt;/);
  assert.doesNotMatch(dialog.innerHTML,/<input|<textarea|javascript:|meetingSave|<script>/);
  gate.resolve([]);await opening;
  assert.equal(f.app.S.project,null);assert.equal(f.app.S.section,'calendar');assert.equal(dialog.open,true);
  assert.equal(f.workspaces.length,0);assert.ok(f.calls.every(call=>!call.method||call.method==='GET'));
});

test('editing a multi-day meeting preserves its custom duration and original end time on save',async()=>{
  const f=fixture(),meeting={id:'long-meeting',project_id:'project-1',title:'Original',status:'scheduled',
    starts_at:'2026-09-23T09:00:00.000Z',ends_at:'2026-09-25T09:45:00.000Z'};
  f.app.S.project=f.app.S.projects[0];f.app.S.meetings=[meeting];f.app.S.meeting=meeting;
  f.app.S.minutes[meeting.id]=null;
  f.api(async(url,options)=>[{id:meeting.id,...options.body}]);
  f.evaluate('meetingsPage()');
  const html=f.element('#wb').innerHTML;
  const selected=id=>html.match(new RegExp(`<select id="${id}"[^>]*>([\\s\\S]*?)<\\/select>`))[1]
    .match(/<option value="([^"]+)" selected>/)[1];
  const duration=selected('mDuration');
  assert.equal(duration,'2925');
  f.element('#mDate').value=html.match(/id="mDate" type="date" value="([^"]+)"/)[1];
  f.element('#mStartTime').value=selected('mStartTime');
  f.element('#mDuration').value=duration;
  f.element('#mReminder').value=selected('mReminder');
  f.element('#mTitle').value='Adjusted title';
  await f.evaluate('saveMeeting()');
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'PATCH');
  assert.equal(f.calls[0].url,'/rest/v1/meetings?id=eq.long-meeting');
  assert.equal(f.calls[0].body.title,'Adjusted title');
  assert.equal(f.calls[0].body.starts_at,'2026-09-23T09:00:00.000Z');
  assert.equal(f.calls[0].body.ends_at,'2026-09-25T09:45:00.000Z');
});

test('standalone meeting reminder saves zero and disabled without changing appointment times',async()=>{
  const f=fixture(),meeting={id:'orphan',title:'Meeting',project_id:null,starts_at:'2028-02-29T09:00:00Z',ends_at:'2028-02-29T10:00:00Z',remind_before_minutes:15,reminder_sent_at:'2026-01-01T00:00:00Z'};
  f.app.S.meetings=[meeting];f.api(async(url,options)=>[{...meeting,...options.body}]);
  await f.app.openCalendarMeeting(meeting.id);
  assert.match(f.dialogs.at(-1).innerHTML,/<option value="none">Не напоминать/);
  for(const [value,expected] of [['0',0],['none',null],['60',60]]){
    f.element('#calendarMeetingReminder').value=value;
    await f.element('#calendarMeetingReminderSave').onclick();
    assert.equal(meeting.remind_before_minutes,expected);
    assert.deepEqual(plain(f.calls.at(-1).body),{remind_before_minutes:expected,reminder_sent_at:null});
    assert.equal(f.calls.at(-1).method,'PATCH');assert.equal(f.calls.at(-1).url,'/rest/v1/meetings?id=eq.orphan');
  }
  f.api(async()=>{throw Error('offline')});f.element('#calendarMeetingReminder').value='none';
  await f.element('#calendarMeetingReminderSave').onclick();assert.equal(meeting.remind_before_minutes,60);assert.equal(f.messages.at(-1).type,'error');assert.equal(f.element('#calendarMeetingReminderSave').disabled,false);
});

test('project editor preserves disabled and custom reminders when saving',async()=>{
  const f=fixture();f.evaluate('meetingsPage=()=>{}');
  f.app.S.meeting={id:'meeting-1',status:'scheduled',remind_before_minutes:null};
  for(const [key,value] of Object.entries({mDate:'2028-02-29',mStartTime:'12:00',mDuration:'30',mTitle:'Meeting',mLocation:'',mUrl:'',mAgenda:'',mNotes:'',mTranscript:''}))f.element('#'+key).value=value;
  for(const [value,expected] of [['none',null],['0',0],['45',45]]){
    f.element('#mReminder').value=value;await f.evaluate('saveMeeting()');assert.equal(f.calls.at(-1).body.remind_before_minutes,expected);
  }
  assert.match(f.evaluate('meetingReminderOptions(45)'),/<option value="45" selected>за 45 минут/);
  assert.match(f.evaluate('meetingReminderOptions(null)'),/<option value="none" selected>/);
});

test('disabled local reminder stays silent while zero fires once at the start',async()=>{
  const f=fixture();f.evaluate("S.meetings=[{id:'quiet',title:'Quiet',status:'scheduled',starts_at:new Date(Date.now()-1000).toISOString(),ends_at:new Date(Date.now()+3600000).toISOString(),remind_before_minutes:null},{id:'now',title:'Now',status:'scheduled',starts_at:new Date(Date.now()-1000).toISOString(),ends_at:new Date(Date.now()+3600000).toISOString(),remind_before_minutes:0}]");
  f.api(async(url,options)=>[{id:'now',...options.body}]);
  await f.evaluate('checkMeetingReminders()');assert.equal(f.calls.length,1);assert.match(f.calls[0].url,/id=eq.now/);assert.equal(f.messages.length,1);
  await f.evaluate('checkMeetingReminders()');assert.equal(f.calls.length,1);assert.equal(f.messages.length,1);
});
