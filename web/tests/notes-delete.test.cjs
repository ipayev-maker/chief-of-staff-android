const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const ID='00000000-0000-4000-8000-000000000001';
const PROJECT='10000000-0000-4000-8000-000000000001';
const TASK='20000000-0000-4000-8000-000000000001';
const ORIGIN='https://chief-of-staff-v3-live.vercel.app';
const TIME='2026-09-24T12:00:00.000Z';
const TOKEN='synthetic-owner-cookie-0123456789012345678901234567';
const row=(extra={})=>({id:ID,project_id:PROJECT,title:'',plain_text:'Saved body',revision:2,updated_at:TIME,created_at:TIME,archived_at:null,deleted_at:null,source:'telegram',...extra});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function apiFixture(){
  const [{createNotesHandler},{sha256}]=await Promise.all([import('../../supabase/functions/cos-notes/handler.mjs'),import('../../supabase/functions/cos-google-calendar/google.mjs')]);
  const tables={quick_notes:[row()],project_notes:[row()],cos_note_task_links:[{source_kind:'quick',source_id:ID,commitment_id:TASK}],cos_calendar_connection:[{id:'owner',google_sub:'owner'}],cos_calendar_sessions:[{token_hash:await sha256(TOKEN),google_sub:'owner',expires_at:'2026-10-01T00:00:00Z'}]};
  const calls=[];
  const matching=(record,query)=>[...new URLSearchParams(query)].every(([key,expression])=>{
    if(['select','order','offset','limit'].includes(key))return true;
    if(expression==='is.null')return record[key]===null;
    if(expression==='not.is.null')return record[key]!==null;
    if(expression.startsWith('eq.'))return String(record[key])===expression.slice(3);
    if(expression.startsWith('gt.'))return String(record[key])>expression.slice(3);
    throw Error('Unexpected fixture predicate');
  });
  const store={
    async list(table,query){return tables[table].filter(record=>matching(record,query))},
    async page(table,query){calls.push({operation:'page',table,query:String(query)});return tables[table].filter(record=>matching(record,query)).map(record=>({...record}))},
    async patch(table,query,values){calls.push({operation:'patch',table,query,values});const rows=tables[table].filter(record=>matching(record,query));for(const record of rows)Object.assign(record,values,{revision:record.revision+1});return rows.map(record=>({...record}))},
    async rpc(){return{task:{id:TASK,deleted_at:TIME},source:{kind:'quick',id:ID,project_id:PROJECT},replayed:true}},
  };
  const handler=createNotesHandler({store,now:()=>new Date(TIME)});
  const request=({kind='quick',id=ID,body,method='DELETE',origin=ORIGIN,owner=true,path:customPath}={})=>new Request(ORIGIN+'/api/notes'+(customPath??(kind==='project'?'/project/':'/')+id),{method,headers:{...(owner?{Cookie:'__Host-cos-calendar-session='+TOKEN}:{}),...(origin?{Origin:origin}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return{tables,calls,store,handler,request};
}
test('note deletion is owner authenticated, origin checked and version guarded for both note kinds',async()=>{
  for(const kind of ['quick','project']){
    const f=await apiFixture(),body=kind==='quick'?{revision:2}:{updated_at:TIME};
    assert.equal((await f.handler(f.request({kind,body,owner:false}))).status,401);
    assert.equal((await f.handler(f.request({kind,body,origin:'https://evil.invalid'}))).status,403);
    for(const invalid of [{},{...body,deleted_at:TIME},kind==='quick'?{revision:0}:{updated_at:'2026-02-30T00:00:00Z'}])assert.equal((await f.handler(f.request({kind,body:invalid}))).status,400);
    assert.equal(f.calls.some(call=>call.operation==='patch'),false);
    const response=await f.handler(f.request({kind,body}));assert.equal(response.status,200);assert.deepEqual(await response.json(),{deleted:true,id:ID});
    const table=kind==='quick'?'quick_notes':'project_notes',deleted=f.tables[table][0];assert.equal(deleted.deleted_at,TIME);assert.equal(deleted.archived_at,TIME);assert.equal(deleted.plain_text,'Saved body');assert.equal(f.tables.cos_note_task_links.length,1);
    assert.match(f.calls.find(call=>call.operation==='patch').query,/deleted_at=is.null/);
    assert.equal((await f.handler(f.request({kind,body}))).status,200,'retry after lost response is idempotent');
  }
});
test('stale note deletion does not delete a newer revision or project timestamp',async()=>{
  const f=await apiFixture();f.tables.quick_notes[0].revision=3;f.tables.project_notes[0].updated_at='2026-09-24T12:00:01.000Z';
  const quick=await f.handler(f.request({body:{revision:2}}));assert.equal(quick.status,409);assert.equal((await quick.json()).note.revision,3);
  const project=await f.handler(f.request({kind:'project',body:{updated_at:TIME}}));assert.equal(project.status,409);assert.deepEqual(await project.json(),{error:'project_note_conflict'});
  assert.equal(f.tables.quick_notes[0].deleted_at,null);assert.equal(f.tables.project_notes[0].deleted_at,null);
});
test('deleted notes leave active and archive lists, cannot be opened/restored and lose visible task backlinks',async()=>{
  const f=await apiFixture();await f.handler(f.request({body:{revision:2}}));
  for(const suffix of ['','?archived=true']){
    const response=await f.handler(f.request({method:'GET',path:suffix}));assert.equal(response.status,200);assert.deepEqual((await response.json()).notes,[]);
  }
  assert.equal((await f.handler(f.request({method:'GET'}))).status,404);
  assert.equal((await f.handler(f.request({method:'PATCH',body:{revision:3,archived:false}}))).status,404);
  const backlink=await f.handler(f.request({method:'GET',path:'/tasks/'+TASK+'/source'}));assert.deepEqual(await backlink.json(),{source:null});
  f.tables.cos_note_task_links[0].source_kind='project';await f.handler(f.request({kind:'project',body:{updated_at:TIME}}));
  assert.deepEqual(await (await f.handler(f.request({method:'GET',path:'/tasks/'+TASK+'/source'}))).json(),{source:null});
});
test('a deleted task returned from a replay cannot reappear in the local task list',async()=>{
  const f=await apiFixture(),response=await f.handler(f.request({method:'POST',path:'/'+ID+'/tasks',body:{request_id:TASK,task:{description:'Do work'}}}));
  assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:'task_deleted'});
});
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const script=html.match(/<script>([\s\S]*)<\/script>/)[1].replace(/\nboot\(\);/,'');
function uiFixture(){
  const elements=new Map(),messages=[],calls=[];const make=()=>({value:'',disabled:false,innerHTML:'',textContent:'',dataset:{},style:{},classList:{add(){},remove(){},toggle(){}},addEventListener(){},appendChild(){},remove(){},focus(){}});
  const document={querySelector(q){if(!elements.has(q))elements.set(q,make());return elements.get(q)},querySelectorAll(){return[]},createElement:make,body:make()};
  const storage=new Map();
  const ctx=vm.createContext({document,window:{addEventListener(){}},location:new URL(ORIGIN),URL,Blob,crypto:webcrypto,setTimeout,clearTimeout,setInterval(){},confirm:()=>true,console,sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}});
  vm.runInContext(script+';globalThis.T={S,QN,taskNoteSources,removeProjectNote,deleteQuickNote,noteState,persistNote,syncNoteInputs,quickNoteDraft,legacyNotesPage,quickNotesPage,uploadNoteFiles};',ctx);
  ctx.notify=(message,type)=>messages.push({message,type});
  ctx.request=async(path,options)=>{calls.push({path,...options});return{deleted:true,id:ID}};
  vm.runInContext('toast=notify;quickNotesRequest=request;notesPage=()=>{};renderQuickNotesIfVisible=()=>{}',ctx);
  const note=row();Object.assign(ctx.T.S,{project:{id:PROJECT},tab:'notes',note,notes:[note],assets:[{id:'asset',note_id:ID}],tasks:[{id:TASK,description:'Keep task'}]});Object.assign(ctx.T.QN,{scopeProjectId:PROJECT,rows:[note],draft:ctx.T.quickNoteDraft(note),loaded:true});
  document.querySelector('#noteTitle').value='';document.querySelector('#noteBody').value='Saved body';document.querySelector('#quickNoteTitle').value='';document.querySelector('#quickNoteBody').value='Saved body';document.querySelector('#quickNoteProject').value=PROJECT;
  return{ctx,T:ctx.T,note,elements,messages,calls,request(fn){ctx.request=fn;vm.runInContext('quickNotesRequest=request',ctx)},api(fn){ctx.mockApi=fn;vm.runInContext('api=mockApi',ctx)}};
}
test('project and text note editors expose Delete separately from Archive, including archive view',()=>{
  const f=uiFixture();f.T.legacyNotesPage();assert.match(f.elements.get('#wb').innerHTML,/id="noteRemove"[^>]*>Удалить/);assert.match(f.elements.get('#wb').innerHTML,/id="noteDelete"[^>]*>В архив/);
  f.note.archived_at=TIME;f.T.S.showArchivedNotes=true;f.T.legacyNotesPage();assert.match(f.elements.get('#wb').innerHTML,/id="noteRemove"[^>]*>Удалить/);assert.match(f.elements.get('#wb').innerHTML,/id="noteRestore"/);
  f.T.S.project=null;f.T.QN.draft.archived_at=null;f.T.quickNotesPage();assert.match(f.elements.get('#main').innerHTML,/id="quickNoteDelete"[^>]*>Удалить/);assert.match(f.elements.get('#main').innerHTML,/id="quickNoteArchive"[^>]*>В архив/);
  f.T.QN.draft.archived_at=TIME;f.T.quickNotesPage();assert.match(f.elements.get('#main').innerHTML,/id="quickNoteDelete"[^>]*>Удалить/);assert.match(f.elements.get('#main').innerHTML,/id="quickNoteRestore"/);
});
test('cancelling confirmation writes nothing and preserves note drafts',async()=>{
  const f=uiFixture();f.ctx.confirm=()=>false;f.elements.get('#noteBody').value='Unsaved';f.elements.get('#quickNoteBody').value='Unsaved quick';await f.T.removeProjectNote();await f.T.deleteQuickNote();assert.equal(f.calls.length,0);assert.equal(f.T.S.note.plain_text,'Unsaved');assert.equal(f.T.QN.draft.plain_text,'Unsaved quick');
});
test('project deletion waits for queued autosave and uses its confirmed timestamp; tasks survive',async()=>{
  const f=uiFixture();let resolveSave;f.api(async()=>await new Promise(resolve=>resolveSave=resolve));f.elements.get('#noteBody').value='Newest saved text';const saving=f.T.persistNote({quiet:true});await tick();
  f.T.taskNoteSources.set(TASK,{kind:'project',id:ID,project_id:PROJECT});const deleting=f.T.removeProjectNote();await tick();assert.equal(f.calls.length,0);const updated='2026-09-24T12:01:00.000Z';resolveSave([{...f.note,updated_at:updated}]);await saving;await deleting;
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'DELETE');assert.equal(f.calls[0].path,'/project/'+ID);assert.equal(f.calls[0].body.updated_at,updated);assert.equal(f.T.S.notes.length,0);assert.equal(f.T.S.assets.length,0);assert.equal(f.T.S.tasks.length,1);assert.equal(f.T.taskNoteSources.get(TASK),null);
});
test('failed project deletion retains unsaved text and assets for retry',async()=>{
  const f=uiFixture();f.elements.get('#noteBody').value='Unsaved text';f.request(async()=>{throw Error('No connection')});await f.T.removeProjectNote();assert.equal(f.T.S.note.plain_text,'Unsaved text');assert.equal(f.T.S.notes.length,1);assert.equal(f.T.S.assets.length,1);assert.ok(f.T.noteState(f.note).revision>f.T.noteState(f.note).savedRevision);assert.ok(f.messages.some(message=>message.type==='error'));
});
test('text-note deletion is serialized, preserves dirty text on failure and removes only confirmed records',async()=>{
  const f=uiFixture();let reject;f.elements.get('#quickNoteBody').value='Retain draft';f.request(async()=>await new Promise((resolve,fail)=>reject=fail));const pending=f.T.deleteQuickNote();await tick();assert.ok(f.T.QN.savePromise);assert.equal(f.T.QN.rows.length,1);await f.T.deleteQuickNote();reject(Error('No connection'));await pending;assert.equal(f.T.QN.savePromise,null);assert.equal(f.T.QN.draft.plain_text,'Retain draft');assert.equal(f.T.QN.rows.length,1);
  f.T.taskNoteSources.set(TASK,{kind:'quick',id:ID,project_id:PROJECT});f.request(async(path,options)=>{assert.equal(path,'/'+ID);assert.equal(options.body.revision,2);return{deleted:true,id:ID}});await f.T.deleteQuickNote();assert.equal(f.T.QN.draft,null);assert.equal(f.T.QN.rows.length,0);assert.equal(f.T.S.tasks.length,1);assert.equal(f.T.taskNoteSources.get(TASK),null);
});
test('text-note delete conflict preserves draft revision and the newer server row',async()=>{
  const f=uiFixture();f.elements.get('#quickNoteBody').value='My unsaved version';f.request(async()=>{throw Object.assign(Error('Conflict'),{code:'revision_conflict',note:row({revision:3,plain_text:'Other window'})})});await f.T.deleteQuickNote();assert.equal(f.T.QN.conflict,true);assert.equal(f.T.QN.draft.plain_text,'My unsaved version');assert.equal(f.T.QN.draft.revision,2);assert.equal(f.T.QN.rows[0].revision,3);
});
