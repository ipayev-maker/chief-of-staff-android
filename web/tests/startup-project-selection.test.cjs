// Node.js 24. Exercise the actual inline application; only DOM and HTTP boundaries are replaced.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {randomUUID} = require('node:crypto');
const file = path.join(__dirname, '../index.html');
const script = fs.readFileSync(file, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\bboot\(\);\s*$/, '');
const noteId = '11223344-5566-4788-9900-112233445566';
const note = extra => ({id:noteId,title:'',plain_text:'Existing note',project_id:null,source:'web',revision:2,archived_at:null,...extra});
const projectRows = () => [
  {id:'active',title:'Active <project>',status:'active',area_key:'work'},
  {id:'paused',title:'Paused project',status:'paused',area_key:'work'},
  {id:'completed',title:'Completed project',status:'completed'},
  {id:'cancelled',title:'Cancelled project',status:'cancelled'},
  {id:'unknown',title:'Unknown state'},
];

function fixture({url='https://chief-of-staff-v3-live.vercel.app/',storage=new Map()}={}) {
  const elements=new Map(),calls=[],messages=[],historyCalls=[];
  const element = selector => {
    if(!elements.has(selector)) elements.set(selector,{value:'',innerHTML:'',textContent:'',disabled:false,isConnected:true,dataset:{},style:{},listeners:{},
      addEventListener(name,fn){this.listeners[name]=fn},focus(){this.focused=true},
      classList:{add(){},remove(){},toggle(){},contains(){return false}},parentElement:{querySelector(){return null}},
      querySelector:element,querySelectorAll:()=>[],setAttribute(){},remove(){},appendChild(){},
    });
    return elements.get(selector);
  };
  let publicResponse=async(url,options)=>options.method?[{id:'saved-task',...options.body}]:[];
  let ownerResponse=async()=>({notes:[],nextOffset:null});
  const context=vm.createContext({window:{addEventListener(){}},Date,Intl,URL,Blob,AbortSignal,console,crypto:{randomUUID},
    location:new URL(url),history:{state:null,replaceState(state,title,next){historyCalls.push(next);context.location=new URL(next,context.location)}},
    sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    setTimeout(){},clearTimeout(){},setInterval(){},confirm:()=>true,
    document:{querySelector:element,querySelectorAll:()=>[],createElement:()=>element('created-'+elements.size),body:{appendChild(){}}},
    fetch:async(url,options={})=>{calls.push({channel:'owner',url,...options});const response=await ownerResponse(url,options),status=response.status||200;return {ok:status<400,status,json:async()=>response.body||response}},
  });
  vm.runInContext(script,context,{filename:file});
  context.apiStub=async(url,options={})=>{calls.push({channel:'public',url,...options});return publicResponse(url,options)};
  context.toastStub=(message,type)=>messages.push({message,type});
  const app=vm.runInContext('({S,QN,loadQuickNotes,saveQuickNote,newQuickNote,quickNoteDraft,initQuickNotesRoute,beginTaskDraft,createTaskFromNote,saveTask,taskDrawer,captureBlock,matchProject,projectSelectionOptions,projectSelectionHint,renderNotes:quickNotesPage})',context);
  vm.runInContext('api=apiStub;toast=toastStub;render=()=>{};renderTaskContext=()=>{};renderQuickNotesIfVisible=()=>{};quickNotesPage=()=>{};',context);
  app.S.projects=projectRows();app.S.areas=[{key:'work',title:'Work'}];
  const form=values=>{for(const [id,value] of Object.entries({tdDesc:'Task text',tdDetails:'',tdProject:'',tdArea:'',tdStatus:'open',tdDirection:'internal',tdParticipant:'',tdPlanDate:'',tdPlanStartTime:'',tdPlanEndTime:'',tdDeadlineDate:'',tdDeadlineTime:'',tdCheckDate:'',tdCheckTime:'',tdEstimate:'',...values}))element('#'+id).value=value};
  const noteForm=values=>{for(const [id,value] of Object.entries({quickNoteTitle:'',quickNoteBody:'Edited note',quickNoteProject:'',...values}))element('#'+id).value=value};
  const navigate=async section=>element('#nav').listeners.click({target:{closest:()=>({dataset:{sec:section}})}});
  return {app,context,calls,messages,elements,element,storage,historyCalls,form,noteForm,navigate,owner(fn){ownerResponse=fn},public(fn){publicResponse=fn},evaluate(code){return vm.runInContext(code,context)}};
}

test('ordinary startup remains Today with both kinds of draft backup; notes restore only after authentication',async()=>{
  const draft=note({plain_text:'Unsaved private note'}),taskDraft={id:'draft-pending',_draft:true,description:'Unsaved task',details:'From note',_noteSource:{kind:'quick',id:noteId},_noteRequestId:'request-1'};
  const storage=new Map([['cos.quickNoteDraft.v1',JSON.stringify({draft,conflict:true})],['cos.noteTaskDraft.v1',JSON.stringify(taskDraft)]]);
  const f=fixture({storage});
  assert.equal(f.app.S.section,'today');assert.equal(f.app.S.task,null);assert.equal(f.app.QN.draft,null);
  assert.equal(f.app.QN.pendingBackup.draft.plain_text,draft.plain_text);assert.equal(f.app.QN.pendingTaskDraft.description,taskDraft.description);
  assert.equal(storage.size,2);assert.equal(f.calls.length,0);
  f.owner(async()=>({status:401,body:{error:'unauthorized'}}));await f.app.loadQuickNotes();
  assert.equal(f.app.S.section,'today');assert.equal(f.app.S.task,null);assert.equal(f.app.QN.draft,null);assert.equal(storage.size,2);
  f.owner(async()=>({notes:[note()],nextOffset:null}));await f.app.loadQuickNotes();
  assert.equal(f.app.QN.draft.plain_text,draft.plain_text);assert.equal(f.app.QN.conflict,true);assert.equal(f.app.S.taskDraft.description,taskDraft.description);
  assert.equal(f.app.QN.pendingBackup,null);assert.equal(f.app.QN.pendingTaskDraft,null);assert.equal(storage.size,2);
  assert.ok(f.calls.every(call=>call.method==='GET'));
});

test('explicit note link opens its exact note once and consumes only its own route parameters',async()=>{
  const f=fixture({url:'https://chief-of-staff-v3-live.vercel.app/?section=notes&id='+noteId+'&keep=1#source'});
  assert.equal(f.app.S.section,'notes');assert.equal(f.app.QN.deepLinkId,noteId);
  assert.equal(f.context.location.search,'?keep=1');assert.equal(f.context.location.hash,'#source');assert.equal(f.historyCalls.length,1);
  f.owner(async url=>url==='/api/notes/'+noteId?{note:note({archived_at:'2026-09-20T12:00:00Z'})}:{notes:[],nextOffset:null});
  await f.app.loadQuickNotes();assert.equal(f.calls[0].url,'/api/notes/'+noteId);assert.equal(f.app.QN.draft.id,noteId);assert.equal(f.app.QN.archived,true);
  const reloaded=fixture({url:f.context.location.href});assert.equal(reloaded.app.S.section,'today');assert.equal(reloaded.app.QN.deepLinkId,null);
});

test('manual Notes navigation does not leave a persistent notes route',async()=>{
  const f=fixture();await f.navigate('notes');assert.equal(f.app.S.section,'notes');assert.equal(f.context.location.search,'');
  await f.navigate('tasks');assert.equal(f.app.S.section,'tasks');
  const reloaded=fixture({url:f.context.location.href,storage:f.storage});assert.equal(reloaded.app.S.section,'today');
});

test('task, note and capture project selectors offer only active projects; inactive existing links are preserved invisibly',()=>{
  const f=fixture(),task={id:'existing',description:'Task',status:'open',direction:'internal',project_id:'paused'};
  const taskMarkup=f.app.taskDrawer(task),taskSelect=taskMarkup.match(/<select id="tdProject">([\s\S]*?)<\/select>/)[1];
  f.app.QN.loaded=true;f.app.QN.rows=[note({project_id:'paused'})];f.app.QN.draft=f.app.quickNoteDraft(f.app.QN.rows[0]);f.app.renderNotes();
  const noteMarkup=f.element('#main').innerHTML,noteSelect=noteMarkup.match(/<select id="quickNoteProject"[^>]*>([\s\S]*?)<\/select>/)[1];
  f.app.S.captureDrafts=[{description:'Capture text',project_id:'paused'}];
  const captureSelect=f.app.captureBlock().match(/<select class="cd-project">([\s\S]*?)<\/select>/)[1];
  for(const options of [taskSelect,noteSelect,captureSelect]){
    assert.match(options,/value="active"/);assert.match(options,/Active &lt;project&gt;/);
    assert.doesNotMatch(options,/Paused project|Completed project|Cancelled project|Unknown state/);
    assert.doesNotMatch(options,/value="(?:completed|cancelled|unknown)"/);
  }
  for(const options of [taskSelect,noteSelect])assert.match(options,/<option value="paused" selected hidden disabled>/);
  assert.doesNotMatch(captureSelect,/value="paused"/);
  assert.match(taskMarkup,/Текущий проект: Paused project \(неактивен\)/);assert.match(noteMarkup,/Привязка сохранится/);
  assert.equal(f.app.matchProject('Paused project'),'');assert.equal(f.app.matchProject('Active project'),'active');
});

test('new drafts do not inherit an inactive project from project scope or a source note',async()=>{
  const f=fixture();f.app.beginTaskDraft('paused','work');assert.equal(f.app.S.taskDraft.project_id,null);
  f.app.QN.scopeProjectId='paused';await f.app.newQuickNote();assert.equal(f.app.QN.draft.project_id,null);
  const source=note({project_id:'paused'});f.app.QN.rows=[source];f.app.QN.draft=f.app.quickNoteDraft(source);
  f.noteForm({quickNoteBody:source.plain_text,quickNoteProject:'paused'});f.app.createTaskFromNote('quick');
  assert.equal(f.app.S.taskDraft.project_id,null);assert.equal(f.app.S.taskDraft._noteSource.project_id,'paused');
  assert.equal(f.calls.length,0);
});

test('task save rejects new inactive selections before any request but retains a preexisting inactive association',async()=>{
  const f=fixture();f.app.beginTaskDraft();f.form({tdProject:'paused'});await f.app.saveTask(f.app.S.taskDraft.id);
  assert.equal(f.calls.length,0);assert.match(f.messages.at(-1).message,/активный проект/);
  f.app.S.tasks=[{id:'existing',description:'Original',project_id:'active',status:'open'}];f.app.S.taskDraft=null;f.app.S.task='existing';
  await f.app.saveTask('existing');assert.equal(f.calls.length,0);
  f.app.S.tasks[0].project_id='paused';await f.app.saveTask('existing');
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'PATCH');assert.equal(f.calls[0].body.project_id,'paused');
});

test('capture refuses an inactive project that was deactivated after the draft appeared',async()=>{
  const f=fixture(),fields={'input[type=checkbox]':{checked:true},'.cd-desc':{value:'Capture task'},'.cd-dir':{value:'internal'},'.cd-project':{value:'paused'},'.cd-deadline':{value:''}};
  f.app.S.captureDrafts=[{description:'Capture task',project_id:'paused'}];
  f.context.document.querySelectorAll=selector=>selector==='.capture-draft'?[{dataset:{i:'0'},querySelector:key=>fields[key]}]:[];
  await f.evaluate('saveCaptureDrafts()');
  assert.equal(f.calls.length,0);assert.match(f.messages.at(-1).message,/активный проект/);assert.equal(f.app.S.captureDrafts.length,1);
});

test('note save rejects new inactive associations but preserves an existing inactive link',async()=>{
  const f=fixture();f.app.QN.draft=f.app.quickNoteDraft();f.noteForm({quickNoteProject:'paused'});
  await assert.rejects(f.app.saveQuickNote(),/активный проект/);assert.equal(f.calls.length,0);
  f.app.QN.rows=[note({project_id:'active'})];f.app.QN.draft=f.app.quickNoteDraft(f.app.QN.rows[0]);
  await assert.rejects(f.app.saveQuickNote(),/активный проект/);assert.equal(f.calls.length,0);
  f.app.QN.rows=[note({project_id:'paused'})];f.app.QN.draft=f.app.quickNoteDraft(f.app.QN.rows[0]);
  f.owner(async(url,options)=>({note:note({...JSON.parse(options.body),revision:3})}));await f.app.saveQuickNote();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'PATCH');assert.equal(JSON.parse(f.calls[0].body).project_id,'paused');
});

test('an uncertain note-to-task retry remains identical after its project becomes inactive',async()=>{
  const f=fixture(),body={description:'Pinned task',details:'Source',project_id:'paused',status:'open',direction:'internal',deadline:'2026-10-01'};
  const submission={request_id:'original-request',task:body};
  const draft={id:'draft-pinned',_draft:true,...body,_noteSource:{kind:'quick',id:noteId},_noteRequestId:'original-request',_noteSubmission:JSON.stringify(submission),_notePinned:true,_noteUncertain:true};
  f.app.S.taskDraft=draft;f.app.S.task=draft.id;f.form({tdProject:'paused',tdDesc:'Pinned task',tdDetails:'Source',tdDeadlineDate:'2026-10-01'});
  f.owner(async()=>({task:{id:'created',...body},source:{kind:'quick',id:noteId}}));await f.app.saveTask(draft.id);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,'/api/notes/'+noteId+'/tasks');
  assert.deepEqual(JSON.parse(f.calls[0].body),submission);assert.equal(f.app.S.tasks[0].project_id,'paused');
});

test('calendar offers only active project filters and drops a filter when that project is deactivated',()=>{
  const modulePath=require.resolve('../calendar-view.js');delete require.cache[modulePath];const calendar=require(modulePath);
  const container={innerHTML:'',querySelector(){return null},contains(){return true}};
  const options={projects:projectRows(),tasks:[{id:'a',description:'Open task',status:'open',project_id:'active',deadline:calendar.localDay()}]};
  calendar.render(container,options);
  const select=()=>container.innerHTML.match(/<select data-cv-filter="projectId"[^>]*>([\s\S]*?)<\/select>/)[1];
  assert.match(select(),/value="active"/);assert.doesNotMatch(select(),/value="(?:paused|completed|cancelled|unknown)"/);
  container.onchange({target:{dataset:{cvFilter:'projectId'},value:'active'}});assert.match(select(),/value="active" selected/);
  options.projects[0].status='paused';calendar.render(container,options);
  assert.doesNotMatch(select(),/value="active"/);assert.match(container.innerHTML,/Open task/);
});
