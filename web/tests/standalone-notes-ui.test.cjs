const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const projectHelpers=html.slice(html.indexOf('function activeProjects()'),html.indexOf('function areaTitle('));
const source=html.slice(html.indexOf('// Standalone notes have their own'),html.indexOf('// Calendar owner session'));
const id='11223344-5566-7788-9900-112233445566';
const row=(overrides={})=>({id,title:'',plain_text:'Saved body',project_id:null,source:'telegram',created_at:'2026-09-22T10:00:00Z',updated_at:'2026-09-22T10:00:00Z',archived_at:null,revision:1,...overrides});
function fixture(storage=new Map()){
 const elements=new Map([['#main',{innerHTML:''}]]),calls=[];let respond=async()=>({notes:[],nextOffset:null});
 const ctx=vm.createContext({appendNotesTaskDrawer(){},readNoteTaskBackup:()=>null,sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},Date,Intl,URL,AbortSignal,Map,Number,Error,JSON,String,Promise,console,location:new URL('https://chief-of-staff-v3-live.vercel.app/'),S:{section:'notes',project:null,projects:[]},$:selector=>elements.get(selector)||null,$$:()=>[],esc:s=>String(s??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])),projectName:()=> 'Project',toast(){},openCalendarSettings(){},fetch:async(url,options)=>{calls.push({url,...options});const value=await respond(url,options);return {ok:value.status?value.status<400:true,status:value.status||200,json:async()=>value.body||value}}});
 vm.runInContext(projectHelpers+source+';globalThis.T={QN,quickNoteDraft,quickNoteChanged,syncQuickNoteInputs,quickNotesRequest,loadQuickNotes,saveQuickNote,flushQuickNote,archiveQuickNote,newQuickNote,initQuickNotesRoute,backupQuickNoteDraft,restoreQuickNoteBackup,page:quickNotesPage};quickNotesPage=()=>{}',ctx);
 const T=ctx.T;T.QN.loaded=true;
 return {T,ctx,calls,elements,storage,respond(fn){respond=fn},fields(values={}){for(const [key,value]of Object.entries({Title:T.QN.draft?.title||'',Body:T.QN.draft?.plain_text||'',Project:T.QN.draft?.project_id||'',...values}))elements.set('#quickNote'+key,{value})},select(r){T.QN.rows=[r];T.QN.draft=T.quickNoteDraft(r)}};
}
test('standalone notes use owner cookie API; anonymous status is a login prompt',async()=>{
 const f=fixture();f.respond(async()=>({status:401,body:{error:'unauthorized'}}));await f.T.loadQuickNotes();assert.equal(f.T.QN.authRequired,true);assert.equal(f.calls[0].url,'/api/notes?archived=false&limit=50&offset=0');assert.equal(f.calls[0].credentials,'same-origin');assert.equal(f.calls[0].cache,'no-store');assert.equal(f.calls[0].headers.Authorization,undefined);assert.equal(f.calls[0].headers.apikey,undefined);
 f.elements.set('#quickNotesRefresh',{});f.elements.set('#quickNotesLogin',{});f.T.page();const markup=f.elements.get('#main').innerHTML;assert.ok(markup.includes('Войдите в аккаунт, чтобы открыть заметки'));assert.ok(markup.includes('Войти через Google'));assert.ok(!markup.includes('Saved body'));
});
test('pagination appends and deduplicates records without losing unsaved editor text',async()=>{
 const f=fixture(),first=row(),next=row({id:'second',plain_text:'Other'});f.respond(async()=>({notes:[first],nextOffset:50}));await f.T.loadQuickNotes();assert.equal(f.T.QN.nextOffset,50);f.fields({Body:'My unsaved draft'});f.respond(async()=>({notes:[first,next],nextOffset:null}));await f.T.loadQuickNotes(true);assert.equal(f.T.QN.rows.length,2);assert.equal(f.T.QN.draft.plain_text,'My unsaved draft');assert.ok(f.calls[1].url.endsWith('offset=50'));
});
test('standalone create sends a truly empty title and no Telegram metadata',async()=>{
 const f=fixture();f.T.QN.draft=f.T.quickNoteDraft();f.fields({Title:'',Body:'A standalone idea'});f.respond(async(u,o)=>({note:row({...JSON.parse(o.body),source:'web'})}));await f.T.saveQuickNote();const call=f.calls[0],body=JSON.parse(call.body);assert.equal(call.method,'POST');assert.equal(call.url,'/api/notes');assert.equal(body.title,'');assert.equal(body.project_id,null);assert.equal(body.plain_text,'A standalone idea');assert.equal(body.source,undefined);assert.equal(body.revision,undefined);assert.equal(f.T.QN.draft.title,'');assert.equal(f.T.QN.draft.id,id);
});
test('blank body is rejected before network; existing edits use expected revision',async()=>{
 const f=fixture();f.select(row({title:'Original',revision:7}));f.fields({Title:'',Body:'  '});await assert.rejects(f.T.saveQuickNote(),/Добавьте текст/);assert.equal(f.calls.length,0);f.fields({Title:'',Body:'Updated body'});f.respond(async(u,o)=>({note:row({...JSON.parse(o.body),revision:8})}));await f.T.saveQuickNote();const body=JSON.parse(f.calls[0].body);assert.equal(body.title,'');assert.equal(body.revision,7);assert.equal(f.calls[0].method,'PATCH');assert.equal(f.calls[0].url,'/api/notes/'+id);assert.equal(f.T.QN.draft.revision,8);
});
test('archive saves edited text together with archived boolean; restore removes row from archive view',async()=>{
 const f=fixture();f.select(row({revision:3}));f.fields({Body:'Latest text'});f.respond(async(u,o)=>({note:row({...JSON.parse(o.body),revision:4,archived_at:'2026-09-22T12:00:00Z'})}));await f.T.archiveQuickNote(true);const body=JSON.parse(f.calls[0].body);assert.equal(body.archived,true);assert.equal(body.archived_at,undefined);assert.equal(body.plain_text,'Latest text');assert.equal(body.revision,3);assert.equal(f.T.QN.rows.length,0);
 f.T.QN.archived=true;f.select(row({revision:4,archived_at:'2026-09-22T12:00:00Z'}));f.elements.clear();f.respond(async()=>({note:row({revision:5})}));await f.T.archiveQuickNote(false);assert.equal(JSON.parse(f.calls[1].body).archived,false);assert.equal(f.T.QN.rows.length,0);
});
test('revision conflict preserves draft and blocks automatic overwrite of current server revision',async()=>{
 const f=fixture();f.select(row({revision:1}));f.fields({Body:'My draft'});f.respond(async()=>({status:409,body:{error:'revision_conflict',note:row({plain_text:'Other window text',revision:2})}}));await assert.rejects(f.T.saveQuickNote(),/другом окне/);assert.equal(f.T.QN.draft.plain_text,'My draft');assert.equal(f.T.QN.draft.revision,1);assert.equal(f.T.QN.rows[0].revision,2);assert.equal(f.T.QN.conflict,true);await assert.rejects(f.T.flushQuickNote(),/другом окне/);assert.equal(f.calls.length,1);
});
test('failed creation is not automatically repeated after an unknown network outcome',async()=>{
 const f=fixture();f.T.QN.draft=f.T.quickNoteDraft();f.fields({Body:'Keep this text'});f.respond(async()=>{throw Error('Disconnected')});await assert.rejects(f.T.saveQuickNote(),/не подтверждено/);assert.equal(f.T.QN.createUncertain,true);assert.equal(f.T.QN.draft.plain_text,'Keep this text');await assert.rejects(f.T.saveQuickNote(),/не подтверждено/);assert.equal(f.calls.length,1);
});
test('deep link loads the exact owner-protected note and opens its archive even beyond page one',async()=>{
 const f=fixture();f.ctx.location=new URL('https://chief-of-staff-v3-live.vercel.app/?section=notes&id='+id);f.T.initQuickNotesRoute();assert.equal(f.T.QN.deepLinkId,id);f.respond(async u=>u==='/api/notes/'+id?{note:row({archived_at:'2026-09-20T10:00:00Z'})}:{notes:[],nextOffset:null});await f.T.loadQuickNotes();assert.equal(f.calls[0].url,'/api/notes/'+id);assert.ok(f.calls[1].url.includes('archived=true'));assert.equal(f.T.QN.archived,true);assert.equal(f.T.QN.draft.id,id);assert.equal(f.T.QN.rows.length,1);
});
test('standalone section and accessible mobile navigation exist; editor never inserts placeholder into title',()=>{
 assert.ok(html.includes('data-sec="notes" aria-label="Заметки"'));assert.ok(html.includes("if(S.section==='notes')return quickNotesPage()"));assert.ok(html.includes('grid-template-columns:repeat(4,minmax(0,1fr))'));
 const f=fixture();f.select(row());for(const key of ['#quickNotesRefresh','#quickNoteNew','#quickNoteSave','#quickNoteArchive'])f.elements.set(key,{});f.fields();f.T.page();assert.match(f.elements.get('#main').innerHTML,/<input class="title" id="quickNoteTitle" value="" placeholder="Название \(необязательно\)"/);assert.equal(f.T.QN.draft.title,'');
});

test('expired owner session preserves draft across OAuth reload without revealing stored text before authentication',async()=>{
 const f=fixture();f.select(row());f.fields({Title:'Private draft title',Body:'Private unsaved text'});f.respond(async()=>({status:401,body:{error:'unauthorized'}}));await assert.rejects(f.T.saveQuickNote(),/Войдите/);assert.equal(f.T.QN.backupAvailable,true);assert.equal(f.T.QN.draft.plain_text,'Private unsaved text');assert.equal(f.storage.size,1);
 const reloaded=fixture(f.storage);reloaded.T.initQuickNotesRoute();assert.equal(reloaded.T.QN.draft,null);assert.ok(reloaded.T.QN.pendingBackup);reloaded.respond(async()=>({status:401,body:{error:'unauthorized'}}));await reloaded.T.loadQuickNotes();reloaded.elements.set('#quickNotesRefresh',{});reloaded.elements.set('#quickNotesLogin',{});reloaded.T.page();const markup=reloaded.elements.get('#main').innerHTML;assert.ok(!markup.includes('Private unsaved text'));assert.ok(!markup.includes('Private draft title'));assert.ok(markup.includes('восстановится после входа'));
 reloaded.respond(async()=>({notes:[row()],nextOffset:null}));await reloaded.T.loadQuickNotes();assert.equal(reloaded.T.QN.draft.plain_text,'Private unsaved text');assert.equal(reloaded.T.QN.draft.title,'Private draft title');assert.equal(reloaded.T.QN.draft.revision,1);assert.equal(reloaded.T.QN.pendingBackup,null);assert.ok(reloaded.calls.every(call=>call.method==='GET'));
});
test('503 after POST is an unknown create outcome and cannot trigger duplicate POST',async()=>{
 const f=fixture();f.T.QN.draft=f.T.quickNoteDraft();f.fields({Body:'Potentially already created'});f.respond(async()=>({status:503,body:{error:'notes_unavailable'}}));await assert.rejects(f.T.saveQuickNote());assert.equal(f.T.QN.createUncertain,true);assert.equal(f.T.QN.draft.plain_text,'Potentially already created');await assert.rejects(f.T.saveQuickNote(),/не подтверждено/);assert.equal(f.calls.length,1);const saved=JSON.parse([...f.storage.values()][0]);assert.equal(saved.createUncertain,true);
});
test('blocked browser storage keeps live draft available for export after session expiry',async()=>{
 const f=fixture();f.ctx.sessionStorage={getItem(){throw Error('Blocked')},setItem(){throw Error('Blocked')},removeItem(){throw Error('Blocked')}};f.select(row());f.fields({Body:'Recover by downloading'});f.respond(async()=>({status:401,body:{error:'unauthorized'}}));await assert.rejects(f.T.saveQuickNote());assert.equal(f.T.QN.backupAvailable,false);assert.equal(f.T.QN.draft.plain_text,'Recover by downloading');for(const key of ['#quickNotesRefresh','#quickNotesLogin','#quickNoteDownload'])f.elements.set(key,{});f.T.page();const markup=f.elements.get('#main').innerHTML;assert.ok(markup.includes('Recover by downloading'));assert.ok(markup.includes('Скачайте его перед входом'));assert.ok(markup.includes('quickNoteDownload'));assert.ok(html.includes("window.addEventListener('beforeunload'"));
});
