// Run with Node.js 24: node --test tests/notes-workflow-ui.test.cjs
// Execute the actual browser script, with only DOM and network boundaries stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {randomUUID} = require('node:crypto');
const file = process.env.COS_TEST_HTML || path.join(__dirname, '../index.html');
const html = fs.readFileSync(file, 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\bboot\(\);\s*$/, '');
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes,no) => {resolve=yes;reject=no}); return {promise,resolve,reject}; };
const NOTE_ID = '11223344-5566-4788-9900-112233445566';
const PROJECT_ID = '21223344-5566-4788-9900-112233445566';
const OTHER_PROJECT_ID = '31223344-5566-4788-9900-112233445566';
const TASK_ID = '41223344-5566-4788-9900-112233445566';
const quickRow = (extra={}) => ({id:NOTE_ID,title:'',plain_text:'First line\nSecond line of the source',project_id:PROJECT_ID,source:'telegram',revision:2,created_at:'2026-09-23T10:00:00Z',updated_at:'2026-09-23T10:00:00Z',archived_at:null,...extra});
const legacyRow = (extra={}) => ({id:NOTE_ID,title:'Legacy note',plain_text:'Legacy source body',project_id:PROJECT_ID,pinned:false,archived_at:null,updated_at:'2026-09-23T09:00:00Z',...extra});

function fixture(exports) {
  const elements = new Map(),calls=[],messages=[],storage=new Map();
  const element = selector => {
    if(!elements.has(selector)) elements.set(selector,{
      value:'',innerHTML:'',textContent:'',disabled:false,isConnected:true,selectionStart:0,selectionEnd:0,dataset:{},style:{},
      parentElement:{querySelector(){return null}},classList:{add(){},remove(){},toggle(){},contains(){return false}},
      addEventListener(){},appendChild(){},remove(){},focus(){this.focused=true},
      querySelector:element,querySelectorAll:()=>[],insertAdjacentHTML(position,markup){this.innerHTML+=markup},
      setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end},
    });
    return elements.get(selector);
  };
  let ownerResponse=async()=>({notes:[],nextOffset:null}),publicResponse=async()=>[];
  const selectAll=selector=>selector.includes('.task-drawer')&&/(input|textarea|select)/.test(selector)?[...elements.entries()].filter(([id,item])=>/^#td/.test(id)&&item).map(([,item])=>item):[];
  const context=vm.createContext({window:{addEventListener(){}},Date,Intl,URL,Blob,AbortSignal,console,crypto:{randomUUID},
    location:new URL('https://chief-of-staff-v3-live.vercel.app/'),history:{replaceState(){}},
    sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    setTimeout(){},clearTimeout(){},setInterval(){},confirm:()=>true,
    document:{querySelector:element,querySelectorAll:selectAll,createElement:()=>element('created-'+elements.size),body:{appendChild(){}}},
    fetch:async(url,options={})=>{
      calls.push({channel:'owner',url,...options});
      const value=await ownerResponse(url,options),status=value?.status||200;
      return {ok:status<400,status,json:async()=>value?.body||value};
    },
  });
  vm.runInContext(script,context,{filename:file});
  context.publicStub=async(url,options={})=>{calls.push({channel:'public',url,...options});return publicResponse(url,options)};
  context.toastStub=(message,type)=>messages.push({message,type});
  vm.runInContext('api=publicStub;toast=toastStub;renderTaskContext=()=>{};render=()=>{};',context);
  const app=vm.runInContext(`({S,QN,${exports}})`,context);
  app.QN.loaded=true;
  app.S.projects=[{id:PROJECT_ID,title:'Project one',area_key:'work'},{id:OTHER_PROJECT_ID,title:'Project two',area_key:'personal'}];
  app.S.areas=[{key:'work',title:'Work'},{key:'personal',title:'Personal'}];
  const taskForm=values=>{
    for(const [id,value] of Object.entries({tdDesc:'',tdDetails:'',tdProject:'',tdArea:'',tdStatus:'open',tdDirection:'internal',tdParticipant:'',tdPlanDate:'',tdPlanStartTime:'',tdPlanEndTime:'',tdDeadlineDate:'',tdDeadlineTime:'',tdCheckDate:'',tdCheckTime:'',tdEstimate:'',...values}))element('#'+id).value=value;
  };
  taskForm({});
  return {app,context,calls,messages,element,elements,taskForm,storage,
    owner(fn){ownerResponse=fn},public(fn){publicResponse=fn},
    evaluate(code){return vm.runInContext(code,context)},
  };
}

const workflowExports='selectedNoteText,createTaskFromNote,saveTask,closeTaskDrawer,beginTaskDraft,bindTaskDrawer,rememberTaskDraft,saveNoteTaskDraft,setQuickNotesScope,loadQuickNotes,projectNotesRows,selectProjectNote,openTaskNoteSource,loadTaskNoteSource,taskNoteSources,taskDrawer,quickNoteDraft,openProject,createNote,restoreNote';
function sourceFixture(kind='quick',extra={}){
  const f=fixture(workflowExports),row=kind==='quick'?quickRow(extra):legacyRow(extra);
  if(kind==='quick'){
    f.app.S.section='notes';f.app.S.project=null;
    f.app.QN.rows=[row];f.app.QN.draft=f.app.quickNoteDraft(row);
    f.element('#quickNoteTitle').value=row.title;f.element('#quickNoteBody').value=row.plain_text;f.element('#quickNoteProject').value=row.project_id||'';
  }else{
    f.app.S.project=f.app.S.projects[0];f.app.S.tab='notes';f.app.S.notes=[row];f.app.S.note=row;
    f.element('#noteTitle').value=row.title;f.element('#noteBody').value=row.plain_text;
  }
  return {...f,row};
}
function bindFreshTaskInputs(f){
  // The browser replaces controls on rerender; reproduce each new control's
  // initial disabled attribute before running the application's real binding.
  const markup=f.app.taskDrawer(f.app.S.taskDraft);
  for(const tag of markup.matchAll(/<(?:input|textarea|select)\b([^>]*\bid="(td[^"]+)"[^>]*)>/g))f.element('#'+tag[2]).disabled=/\bdisabled\b/.test(tag[1]);
  f.elements.set('#taskNoteSource',null);f.app.bindTaskDrawer();
}

test('note text uses an actual selected range, otherwise the complete body',()=>{
  const f=fixture(workflowExports),textarea=f.element('#noteBody');
  textarea.value='First line\nSecond line';textarea.setSelectionRange(11,22);
  assert.equal(f.app.selectedNoteText(textarea),'Second line');
  textarea.setSelectionRange(3,3);assert.equal(f.app.selectedNoteText(textarea),'First line\nSecond line');
});

test('selected quick note opens a local task draft; cancellation creates nothing',async()=>{
  const f=sourceFixture('quick'),textarea=f.element('#quickNoteBody');
  textarea.setSelectionRange(11,textarea.value.length);
  await f.app.createTaskFromNote('quick');
  const draft=f.app.S.taskDraft;
  assert.equal(draft._draft,true);assert.equal(draft.details,'Second line of the source');
  assert.equal(draft.description,'Second line of the source');
  assert.deepEqual(plain(draft._noteSource),{kind:'quick',id:NOTE_ID,project_id:PROJECT_ID});
  assert.equal(draft.project_id,PROJECT_ID);assert.equal(draft.area_key,'work');
  assert.match(draft._noteRequestId,/^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
  for(const field of ['deadline','deadline_at','planned_on','planned_start_at','planned_end_at','next_check_on','next_check_at'])assert.ok(!draft[field],field+' must remain empty');
  assert.equal(f.calls.filter(call=>call.method&&call.method!=='GET').length,0);
  f.app.closeTaskDrawer();assert.equal(f.app.S.taskDraft,null);assert.equal(f.app.S.task,null);
  assert.equal(f.calls.filter(call=>call.method&&call.method!=='GET').length,0);
});

test('whole note body seeds task details and first nonempty line seeds the task name',async()=>{
  const f=sourceFixture('quick',{title:'A separate note title',plain_text:'\n  First actionable line\nSecond paragraph'});
  await f.app.createTaskFromNote('quick');
  assert.equal(f.app.S.taskDraft.description,'First actionable line');
  assert.equal(f.app.S.taskDraft.details,'First actionable line\nSecond paragraph');
  assert.equal(f.app.S.taskDraft._noteSource.id,NOTE_ID);
  assert.equal(f.calls.filter(call=>call.method&&call.method!=='GET').length,0);
});

test('legacy project note creates a linked local draft without editing the source note',async()=>{
  const f=sourceFixture('project'),before=plain(f.row);
  await f.app.createTaskFromNote('project');
  assert.deepEqual(plain(f.app.S.taskDraft._noteSource),{kind:'project',id:NOTE_ID,project_id:PROJECT_ID});
  assert.equal(f.app.S.taskDraft.details,f.row.plain_text);
  assert.deepEqual(plain(f.row),before);assert.equal(f.calls.length,0);
});

test('an unknown task POST outcome retries the exact request id and payload and adds only one task',async()=>{
  const f=sourceFixture('quick');await f.app.createTaskFromNote('quick');
  const draftId=f.app.S.task,id=f.app.S.taskDraft._noteRequestId;
  f.taskForm({tdDesc:'Review the selected text',tdDetails:'Edited task context',tdProject:PROJECT_ID,tdDeadlineDate:'2026-10-02'});
  let attempts=0;
  f.owner(async()=>{
    if(++attempts===1)throw Error('Connection closed after the server accepted the request');
    return {task:{id:TASK_ID,description:'Review the selected text',details:'Edited task context',project_id:PROJECT_ID},source:{kind:'quick',id:NOTE_ID,project_id:PROJECT_ID},replayed:true};
  });
  await f.app.saveTask(draftId);
  assert.equal(f.app.S.taskDraft.id,draftId);assert.equal(f.app.S.tasks.length,0);
  // Editing controls after an uncertain response must not change the idempotent retry.
  f.taskForm({tdDesc:'This changed text must not replace the original retry',tdDetails:'Changed',tdProject:OTHER_PROJECT_ID});
  await f.app.saveTask(draftId);
  const requests=f.calls.filter(call=>call.channel==='owner'&&call.method==='POST');
  assert.equal(requests.length,2);assert.equal(requests[0].credentials,'same-origin');
  assert.equal(requests[0].url,'/api/notes/'+NOTE_ID+'/tasks');
  assert.equal(requests[0].headers.Authorization,undefined);assert.equal(requests[0].headers.apikey,undefined);
  const first=JSON.parse(requests[0].body),second=JSON.parse(requests[1].body);
  assert.equal(first.request_id,id);assert.deepEqual(second,first);
  assert.equal(f.calls.filter(call=>call.channel==='public'&&call.method==='POST').length,0);
  assert.equal(f.app.S.tasks.length,1);assert.equal(f.app.S.tasks[0].id,TASK_ID);assert.equal(f.app.S.taskDraft,null);
});

test('project note union retains a quick note and a legacy note with the same UUID',()=>{
  const f=fixture(workflowExports),quick=quickRow(),legacy=legacyRow();
  f.app.S.project=f.app.S.projects[0];f.app.S.notes=[legacy];
  f.app.setQuickNotesScope(PROJECT_ID);f.app.QN.rows=[quick];
  const rows=f.app.projectNotesRows();
  assert.equal(rows.length,2);
  assert.equal(rows.find(item=>item.kind==='quick').note,quick);
  assert.equal(rows.find(item=>item.kind==='project').note,legacy);
  assert.notEqual(rows[0].kind+':'+rows[0].note.id,rows[1].kind+':'+rows[1].note.id);
});

test('switching project scope invalidates an older load so it cannot reveal or overwrite the new project',async()=>{
  const f=fixture(workflowExports),old=deferred(),current=quickRow({id:'51223344-5566-4788-9900-112233445566',project_id:OTHER_PROJECT_ID,plain_text:'Project two private text'});
  f.evaluate('quickNotesPage=()=>{};notesPage=()=>{}');
  f.owner(async url=>url.includes('project_id='+PROJECT_ID)?old.promise:{notes:[current],nextOffset:null});
  f.app.setQuickNotesScope(PROJECT_ID);const first=f.app.loadQuickNotes();await tick();
  assert.ok(f.calls[0].url.includes('project_id='+PROJECT_ID));
  f.app.setQuickNotesScope(OTHER_PROJECT_ID);await f.app.loadQuickNotes();
  assert.ok(f.calls[1].url.includes('project_id='+OTHER_PROJECT_ID));
  assert.equal(f.app.QN.rows[0].id,current.id);
  old.resolve({notes:[quickRow({plain_text:'Stale first project text'})],nextOffset:50});await first;
  assert.equal(f.app.QN.scopeProjectId,OTHER_PROJECT_ID);
  assert.deepEqual(plain(f.app.QN.rows),[current]);assert.equal(f.app.QN.nextOffset,null);
  assert.equal(f.app.QN.draft.id,current.id);
});

test('changing from project scope to global notes removes project_id from the owner request',async()=>{
  const f=fixture(workflowExports);f.evaluate('quickNotesPage=()=>{};notesPage=()=>{}');
  f.app.setQuickNotesScope(PROJECT_ID);f.owner(async()=>({notes:[quickRow()],nextOffset:null}));await f.app.loadQuickNotes();
  f.app.setQuickNotesScope(null);await f.app.loadQuickNotes();
  assert.equal(f.app.QN.scopeProjectId,null);
  assert.equal(new URL(f.calls.at(-1).url,'https://example.test').searchParams.has('project_id'),false);
});

test('a task backlink reloads through the owner API, coalesces concurrent reads and then uses its cache',async()=>{
  const f=fixture(workflowExports),request=deferred(),source={kind:'quick',id:NOTE_ID,project_id:null};
  f.owner(async()=>request.promise);
  const first=f.app.loadTaskNoteSource(TASK_ID),second=f.app.loadTaskNoteSource(TASK_ID);await tick();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,'/api/notes/tasks/'+TASK_ID+'/source');
  assert.equal(f.calls[0].credentials,'same-origin');assert.equal(f.calls[0].headers.apikey,undefined);
  request.resolve({source});assert.deepEqual(plain(await first),source);assert.deepEqual(plain(await second),source);
  assert.deepEqual(plain(await f.app.loadTaskNoteSource(TASK_ID)),source);assert.equal(f.calls.length,1);
});

test('quick note backlink opens the exact archived source even when it is not in the loaded list',async()=>{
  const f=fixture(workflowExports),note=quickRow({project_id:null,archived_at:'2026-09-23T10:30:00Z'});
  f.app.S.section='tasks';f.app.S.task=TASK_ID;
  f.owner(async url=>url.endsWith('/source')?{source:{kind:'quick',id:NOTE_ID,project_id:null}}:{note});
  await f.app.openTaskNoteSource(TASK_ID);
  assert.deepEqual(f.calls.map(call=>call.url),['/api/notes/tasks/'+TASK_ID+'/source','/api/notes/'+NOTE_ID]);
  assert.equal(f.app.S.section,'notes');assert.equal(f.app.S.project,null);assert.equal(f.app.S.task,null);
  assert.equal(f.app.QN.draft.id,NOTE_ID);assert.equal(f.app.QN.draft.plain_text,note.plain_text);assert.equal(f.app.QN.archived,true);
  assert.equal(f.app.QN.deepLinkId,NOTE_ID);
  assert.ok(f.calls.every(call=>call.method==='GET'));
});

test('legacy source backlink opens its project and archive without mistaking a same-id quick note for it',async()=>{
  const f=fixture(workflowExports),note=legacyRow({archived_at:'2026-09-23T10:30:00Z'});
  f.app.S.section='tasks';f.app.S.task=TASK_ID;f.app.QN.rows=[quickRow({plain_text:'Different quick source with the same ID'})];
  f.app.taskNoteSources.set(TASK_ID,{kind:'project',id:NOTE_ID,project_id:PROJECT_ID});
  f.evaluate('workspace=()=>{}');
  f.public(async url=>url.startsWith('/rest/v1/project_notes?')?[note]:[]);
  await f.app.openTaskNoteSource(TASK_ID);
  assert.equal(f.app.S.project.id,PROJECT_ID);assert.equal(f.app.S.tab,'notes');assert.equal(f.app.S.projectNoteKind,'project');
  assert.equal(f.app.S.note.id,NOTE_ID);assert.equal(f.app.S.note.plain_text,note.plain_text);assert.equal(f.app.QN.archived,true);
  assert.equal(f.app.S.task,null);assert.ok(f.calls.every(call=>!call.method||call.method==='GET'));
});

test('a missing backlink preserves the task view and reports that no source exists',async()=>{
  const f=fixture(workflowExports);f.app.S.section='tasks';f.app.S.task=TASK_ID;
  f.owner(async()=>({source:null}));await f.app.openTaskNoteSource(TASK_ID);
  assert.equal(f.app.S.section,'tasks');assert.equal(f.app.S.task,TASK_ID);assert.equal(f.app.QN.draft,null);
  assert.ok(f.messages.some(item=>/нет связанной заметки/.test(item.message)));
});

test('slower legacy project loading cannot overwrite the current project notes or media',async()=>{
  const f=fixture(workflowExports),first=deferred(),current=legacyRow({id:'61223344-5566-4788-9900-112233445566',project_id:OTHER_PROJECT_ID,plain_text:'Current project body'});
  f.public(async url=>{
    if(url.includes('project_id=eq.'+PROJECT_ID))return first.promise;
    if(url.startsWith('/rest/v1/project_notes?'))return [current];
    return [];
  });
  const opening=f.app.openProject(PROJECT_ID);await tick();await f.app.openProject(OTHER_PROJECT_ID);
  assert.equal(f.app.S.project.id,OTHER_PROJECT_ID);assert.equal(f.app.S.note.id,current.id);
  first.resolve([]);await opening;
  assert.equal(f.app.S.project.id,OTHER_PROJECT_ID);assert.deepEqual(plain(f.app.S.notes),[current]);
  assert.equal(f.app.S.note.id,current.id);assert.equal(f.app.QN.scopeProjectId,OTHER_PROJECT_ID);
});

test('unknown task creation followed by 401 keeps the same immutable submission through a later successful retry',async()=>{
  const f=sourceFixture('quick');await f.app.createTaskFromNote('quick');
  const id=f.app.S.task;f.taskForm({tdDesc:'Submitted text',tdDetails:'Submitted details',tdProject:PROJECT_ID});
  let attempt=0;f.owner(async()=>{
    attempt++;
    if(attempt===1)throw Error('Network closed after request delivery');
    if(attempt===2)return {status:401,body:{error:'unauthorized'}};
    return {task:{id:TASK_ID,description:'Submitted text',details:'Submitted details',project_id:PROJECT_ID},source:{kind:'quick',id:NOTE_ID,project_id:PROJECT_ID},replayed:true};
  });
  await f.app.saveTask(id);const submission=f.app.S.taskDraft._noteSubmission;
  assert.ok(submission);
  f.taskForm({tdDesc:'Changed after unknown response',tdDetails:'Changed',tdProject:OTHER_PROJECT_ID});await f.app.saveTask(id);
  assert.equal(f.app.S.taskDraft._noteSubmission,submission,'401 cannot clear a previously ambiguous request');
  assert.equal(f.app.S.taskDraft._noteAuthRequired,true);
  bindFreshTaskInputs(f);
  for(const key of ['tdDesc','tdDetails','tdProject','tdDeadlineDate','tdParticipant'])assert.equal(f.element('#'+key).disabled,true,key+' stays frozen after 401');
  const backup=JSON.parse(f.storage.get('cos.noteTaskDraft.v1'));assert.equal(backup._noteSubmission,submission);
  f.taskForm({tdDesc:'Changed after authentication',tdDetails:'Changed again',tdProject:OTHER_PROJECT_ID});await f.app.saveTask(id);
  const posts=f.calls.filter(call=>call.method==='POST');assert.equal(posts.length,3);
  assert.deepEqual(posts.map(call=>call.body),[submission,submission,submission]);
  assert.equal(f.app.S.tasks.length,1);assert.equal(f.app.S.taskDraft,null);assert.equal(f.storage.has('cos.noteTaskDraft.v1'),false);
});

test('a 409 response retains an immutable submission and never leaves its controls editable',async()=>{
  const f=sourceFixture('quick');await f.app.createTaskFromNote('quick');const id=f.app.S.task;
  f.taskForm({tdDesc:'Original request',tdDetails:'Original details',tdProject:PROJECT_ID});
  f.owner(async()=>({status:409,body:{error:'task_request_conflict'}}));await f.app.saveTask(id);
  const submission=f.app.S.taskDraft._noteSubmission;assert.ok(submission);
  bindFreshTaskInputs(f);
  for(const key of ['tdDesc','tdDetails','tdProject','tdStatus','tdDeadlineDate','tdEstimate'])assert.equal(f.element('#'+key).disabled,true,key+' is immutable after 409');
  f.taskForm({tdDesc:'Changed text that must not replace the conflict request',tdDetails:'Changed',tdProject:OTHER_PROJECT_ID});await f.app.saveTask(id);
  const posts=f.calls.filter(call=>call.method==='POST');assert.equal(posts.length,2);
  assert.equal(posts[0].body,submission);assert.equal(posts[1].body,submission);assert.equal(f.app.S.tasks.length,0);
});

test('a definitive source_archived 409 can be cancelled, clearing its backup and allowing a new task draft',async()=>{
  const f=sourceFixture('quick');await f.app.createTaskFromNote('quick');const original=f.app.S.taskDraft;
  f.taskForm({tdDesc:'Task from a now archived source',tdDetails:'Original context',tdProject:PROJECT_ID});
  f.owner(async()=>({status:409,body:{error:'source_archived'}}));await f.app.saveTask(original.id);
  assert.equal(original._noteSubmission,undefined);assert.equal(!!original._notePinned,false);assert.equal(!!original._noteUncertain,false);assert.equal(f.storage.has('cos.noteTaskDraft.v1'),true);
  f.app.closeTaskDrawer();assert.equal(f.app.S.task,null);assert.equal(f.app.S.taskDraft,null);
  assert.equal(f.storage.has('cos.noteTaskDraft.v1'),false);
  f.app.beginTaskDraft(OTHER_PROJECT_ID,'personal');assert.notEqual(f.app.S.taskDraft.id,original.id);
  assert.equal(f.app.S.taskDraft.project_id,OTHER_PROJECT_ID);assert.equal(f.app.S.taskDraft._noteSource,undefined);
  assert.equal(f.calls.filter(call=>call.method==='POST').length,1);
});

test('a definitive source_archived response after an unknown outcome releases the immutable payload for an edited retry',async()=>{
  const f=sourceFixture('quick');await f.app.createTaskFromNote('quick');const original=f.app.S.taskDraft;
  f.taskForm({tdDesc:'Original uncertain request',tdDetails:'Original context',tdProject:PROJECT_ID});
  let attempt=0;f.owner(async()=>{
    attempt++;
    if(attempt===1)throw Error('Response lost');
    if(attempt===2)return {status:409,body:{error:'source_archived'}};
    return {task:{id:TASK_ID,description:'Edited after definitive rejection',details:'Edited context',project_id:PROJECT_ID},source:{kind:'quick',id:NOTE_ID,project_id:PROJECT_ID},replayed:false};
  });
  await f.app.saveTask(original.id);assert.ok(original._noteSubmission);assert.equal(original._noteUncertain,true);
  await f.app.saveTask(original.id);
  assert.equal(original._noteSubmission,undefined);assert.equal(!!original._notePinned,false);assert.equal(!!original._noteUncertain,false);
  bindFreshTaskInputs(f);
  for(const key of ['tdDesc','tdDetails','tdProject','tdDeadlineDate'])assert.equal(f.element('#'+key).disabled,false,key+' is editable after definitive rejection');
  f.taskForm({tdDesc:'Edited after definitive rejection',tdDetails:'Edited context',tdProject:PROJECT_ID});await f.app.saveTask(original.id);
  const posts=f.calls.filter(call=>call.method==='POST').map(call=>JSON.parse(call.body));assert.equal(posts.length,3);
  assert.deepEqual(posts[0],posts[1]);assert.notEqual(posts[2].task.description,posts[0].task.description);
  assert.equal(posts[2].task.description,'Edited after definitive rejection');assert.equal(posts[2].task.details,'Edited context');
  assert.equal(f.app.S.tasks.length,1);assert.equal(f.app.S.taskDraft,null);
});

test('hiding a pinned task draft and requesting another draft cannot replace its pending request or backup',async()=>{
  const f=sourceFixture('quick');await f.app.createTaskFromNote('quick');const original=f.app.S.taskDraft;
  f.taskForm({tdDesc:'Pending request',tdDetails:'Keep source context',tdProject:PROJECT_ID});
  f.owner(async()=>{throw Error('Response lost')});await f.app.saveTask(original.id);
  const submission=original._noteSubmission,requestId=original._noteRequestId;
  f.app.closeTaskDrawer();assert.equal(f.app.S.task,null);assert.equal(f.app.S.taskDraft,original);
  f.app.beginTaskDraft(OTHER_PROJECT_ID,'personal');assert.equal(f.app.S.taskDraft,original);
  await f.app.createTaskFromNote('quick');assert.equal(f.app.S.taskDraft,original);
  assert.equal(original._noteSubmission,submission);assert.equal(original._noteRequestId,requestId);
  const backup=JSON.parse(f.storage.get('cos.noteTaskDraft.v1'));assert.equal(backup.id,original.id);assert.equal(backup._noteSubmission,submission);
  assert.equal(f.calls.filter(call=>call.method==='POST').length,1);
});

test('note task controls freeze while POST is pending and new draft requests cannot replace it',async()=>{
  const f=sourceFixture('quick');await f.app.createTaskFromNote('quick');const original=f.app.S.taskDraft,request=deferred();
  f.taskForm({tdDesc:'Pending text',tdDetails:'Pending details',tdProject:PROJECT_ID});
  f.owner(async()=>request.promise);const save=f.app.saveTask(original.id);await tick();
  assert.equal(f.app.S.taskSaveBusy,true);
  for(const key of ['tdDesc','tdDetails','tdProject','tdStatus','tdDirection','tdParticipant','tdDeadlineDate','tdPlanDate','tdCheckDate','tdEstimate'])assert.equal(f.element('#'+key).disabled,true,key+' freezes before the response');
  f.app.beginTaskDraft(OTHER_PROJECT_ID,'personal');await f.app.createTaskFromNote('quick');f.app.closeTaskDrawer();
  assert.equal(f.app.S.taskDraft,original);assert.equal(f.app.S.task,original.id);
  request.resolve({task:{id:TASK_ID,description:'Pending text',details:'Pending details',project_id:PROJECT_ID},source:{kind:'quick',id:NOTE_ID,project_id:PROJECT_ID}});await save;
  assert.equal(f.app.S.taskSaveBusy,false);assert.equal(f.app.S.tasks.length,1);assert.equal(f.app.S.taskDraft,null);
});

for(const action of ['createNote','restoreNote'])test('legacy '+action+' leaves the unified archive, reloads active project notes and ignores a late archive response',async()=>{
  const f=fixture(workflowExports),old=deferred(),archived=legacyRow({archived_at:'2026-09-23T10:30:00Z'}),active=quickRow({id:'71223344-5566-4788-9900-112233445566',plain_text:'Active quick note'});
  f.app.S.project=f.app.S.projects[0];f.app.S.tab='notes';f.app.S.projectNoteKind='project';f.app.S.notes=[archived];f.app.S.note=archived;
  f.element('#noteTitle').value=action==='restoreNote'?archived.title:'';f.element('#noteBody').value=action==='restoreNote'?archived.plain_text:'';
  f.app.setQuickNotesScope(PROJECT_ID);f.app.QN.archived=true;f.app.QN.loaded=true;f.app.QN.nextOffset=50;
  f.app.QN.rows=[quickRow({archived_at:'2026-09-23T10:30:00Z'})];f.app.QN.draft=f.app.quickNoteDraft(f.app.QN.rows[0]);
  // Preserve the real notesPage load gate while omitting unrelated DOM layout.
  f.evaluate('notesPage=()=>{if(!QN.loaded&&!QN.loading&&!QN.error&&!QN.authRequired)loadQuickNotes()}');
  f.owner(async url=>new URL(url,'https://example.test').searchParams.get('archived')==='true'?old.promise:{notes:[active],nextOffset:null});
  f.public(async(url,options)=>options.method==='POST'?[legacyRow({id:'81223344-5566-4788-9900-112233445566',title:'',plain_text:''})]:[{...archived,archived_at:null}]);
  const archiveLoad=f.app.loadQuickNotes();await tick();const oldSequence=f.app.QN.requestSeq;
  await f.app[action]();await tick();
  assert.equal(f.app.QN.archived,false);assert.ok(f.app.QN.requestSeq>oldSequence);
  const ownerCalls=f.calls.filter(call=>call.channel==='owner'),activeCalls=ownerCalls.filter(call=>new URL(call.url,'https://example.test').searchParams.get('archived')==='false');
  assert.equal(activeCalls.length,1);assert.equal(new URL(activeCalls[0].url,'https://example.test').searchParams.get('project_id'),PROJECT_ID);
  assert.deepEqual(plain(f.app.QN.rows),[active]);assert.equal(f.app.QN.draft.id,active.id);assert.equal(f.app.QN.nextOffset,null);
  old.resolve({notes:[quickRow({plain_text:'Late archived text',archived_at:'2026-09-23T10:30:00Z'})],nextOffset:50});await archiveLoad;
  assert.equal(f.app.QN.archived,false);assert.deepEqual(plain(f.app.QN.rows),[active]);assert.equal(f.app.QN.draft.id,active.id);assert.equal(f.app.QN.nextOffset,null);
});
