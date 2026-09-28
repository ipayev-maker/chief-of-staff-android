// Actual inline UI plus pure participant helpers. Synthetic DOM/API, no external writes.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {randomUUID}=require('node:crypto');
const people=require('../participants.js');
const file=path.join(__dirname,'../index.html');
const script=fs.readFileSync(file,'utf8').match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\bboot\(\);\s*$/,'');
const plain=value=>JSON.parse(JSON.stringify(value));
const person=(id,name)=>({id,name});

function fixture(){
  const elements=new Map(),dialogs=[],calls=[],messages=[],storage=new Map(),captureRows=[];
  const decode=value=>value.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
  function makeElement(tag='div'){
    let markup='';const children=new Map();
    const el={tagName:tag.toUpperCase(),value:'',textContent:'',hidden:false,disabled:false,isConnected:true,dataset:{},style:{},listeners:{},
      classList:{add(){},remove(){},toggle(){},contains(){return false}},parentElement:{querySelector(){return null}},
      addEventListener(name,fn){(this.listeners[name]||=[]).push(fn)},setAttribute(name,value){this[name]=value},focus(){this.focused=true},
      dispatch(name,event={}){for(const fn of this.listeners[name]||[])fn({target:this,...event})},
      querySelector(selector){if(!children.has(selector))children.set(selector,makeElement());return children.get(selector)},querySelectorAll(){return []},
      showModal(){this.open=true},close(){this.open=false;this.dispatch('close')},remove(){this.isConnected=false;if(this.id)elements.delete('#'+this.id)},
    };
    Object.defineProperty(el,'innerHTML',{get:()=>markup,set(value){markup=value;
      for(const match of value.matchAll(/<(input|button)\b([^>]*\bid="([^"]+)"[^>]*)>/g)){
        const child=el.querySelector('#'+match[3]);child.value=decode(match[2].match(/\bvalue="([^"]*)"/)?.[1]||'');child.hidden=/\bhidden\b/.test(match[2]);child.disabled=/\bdisabled\b/.test(match[2]);
      }
      if(/<option\b/.test(value)){const option=[...value.matchAll(/<option\b([^>]*)>/g)].find(m=>/\bselected\b/.test(m[1]));el.value=decode(option?.[1].match(/value="([^"]*)"/)?.[1]||'');}
    }});
    return el;
  }
  function element(selector){if(selector==='#participantDialog')return elements.get(selector)||null;if(!elements.has(selector))elements.set(selector,makeElement());return elements.get(selector)}
  let owner=async(route,options)=>({participant:{id:options.body.id||route.split('/').at(-1),name:options.body.name}});
  let publicApi=async(route,options)=>Array.isArray(options.body)?options.body.map((row,i)=>({id:'saved-'+i,...row})):[{id:'saved-task',...options.body}];
  const context=vm.createContext({window:{CoSParticipants:people,addEventListener(){}},Date,Intl,URL,console,crypto:{randomUUID},
    location:new URL('https://chief-of-staff-v3-live.vercel.app/'),setTimeout(){},clearTimeout(){},setInterval(){},confirm:()=>true,
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
    sessionStorage:{getItem(){return null},setItem(){},removeItem(){}},
    document:{querySelector:element,querySelectorAll:selector=>selector==='.capture-draft'?captureRows:[],createElement:makeElement,
      body:{appendChild(dialog){elements.set('#'+dialog.id,dialog);dialogs.push(dialog)}}},
    ownerStub:async(route,options)=>{calls.push({channel:'owner',route,...plain(options)});return owner(route,options)},
    apiStub:async(route,options)=>{calls.push({channel:'public',route,...plain(options)});return publicApi(route,options)},
    toastStub:(...args)=>messages.push(args),
  });
  vm.runInContext(script,context,{filename:file});
  vm.runInContext('quickNotesRequest=ownerStub;api=apiStub;toast=toastStub;renderTaskContext=()=>{};todayPage=()=>{};',context);
  const app=vm.runInContext('({S,participantOptions,upsertParticipant,openParticipantEditor,bindTaskParticipantControls,participantRecent,beginTaskDraft,rememberTaskDraft,saveTask,bindCaptureParticipants,saveCaptureDrafts})',context);
  const setForm=values=>{for(const [id,value] of Object.entries({tdDesc:'Draft task',tdDetails:'Draft context',tdProject:'',tdArea:'',tdStatus:'open',tdDirection:'internal',tdParticipant:'',tdPlanDate:'',tdPlanStartTime:'',tdPlanEndTime:'',tdDeadlineDate:'',tdDeadlineTime:'',tdCheckDate:'',tdCheckTime:'',tdEstimate:'',...values}))element('#'+id).value=value};
  setForm({});
  const control=selector=>dialogs.at(-1).querySelector(selector);
  const submit=()=>control('form').onsubmit({preventDefault(){}});
  const recent=()=>people.readRecent(context.localStorage);
  return {app,context,calls,messages,dialogs,element,control,submit,setForm,recent,storage,makeElement,captureRows,
    owner(fn){owner=fn},public(fn){publicApi=fn}};
}

test('relevance groups project participation first, recent selection second and remaining names alphabetically',()=>{
  const rows=[person('z','Яна'),person('b','Борис'),person('a','Анна'),person('p','Павел'),person('c','Сергей'),person('blank','  ')];
  const tasks=[{project_id:'project',participant_id:'p',status:'completed'},{project_id:'project',participant_id:'b',deleted_at:'2026-01-01'},{project_id:'other',participant_id:'a'}];
  const recent=[{id:'b',at:300},{id:'p',at:100},{id:'c',at:200},{id:'missing',at:500}];
  const before=plain(rows),groups=people.groups(rows,tasks,'project',recent);
  assert.deepEqual(groups.map(group=>[group.label,group.people.map(p=>p.id)]),[['В этом проекте',['p']],['Недавно выбирали',['b','c']],['Все участники',['a','z']]]);
  assert.deepEqual(rows,before);assert.equal(groups[0].people[0],rows[3],'sort retains the person identity');
  assert.deepEqual(people.groups(rows,tasks,null,[])[0].people.map(p=>p.id),['a','b','p','c','z']);
});

test('duplicate names normalize whitespace, case and unicode without merging distinct people',()=>{
  const rows=[person('ivan','  Иван   Петров '),person('same','Иван Петров — другая компания'),person('unicode','Й')];
  assert.equal(people.duplicate(rows,'иван\nпетров').id,'ivan');assert.equal(people.duplicate(rows,'Иван Петров','ivan'),undefined);
  assert.equal(people.duplicate(rows,'И\u0306').id,'unicode');assert.equal(people.normalize('  Новый\n участник  '),'Новый участник');
});

test('recent choices expire after 90 days, exclude future/malformed entries and tolerate blocked storage',()=>{
  const now=1800000000000,storage=new Map(),adapter={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)};
  storage.set('cos.participantSelections.v1',JSON.stringify([{id:'future',at:now+1},{id:'expired',at:now-91*86400000},{id:'good',at:now-100},null,{id:'broken',at:'yesterday'}]));
  assert.deepEqual(people.readRecent(adapter,now),[{id:'good',at:now-100}]);
  people.remember(adapter,'good',now);people.remember(adapter,'next',now+1);
  assert.deepEqual(people.readRecent(adapter,now+1),[{id:'next',at:now+1},{id:'good',at:now}]);
  assert.doesNotThrow(()=>people.remember({getItem(){throw Error('blocked')},setItem(){throw Error('blocked')}},'person'));
});

test('participant options keep selected IDs, escape names, and rename without changing task references',()=>{
  const f=fixture(),original=person('old','Анна');f.app.S.participants=[original,person('html','<img src=x>')];
  f.app.S.tasks=[{id:'task',project_id:'project',participant_id:'old'}];
  f.app.upsertParticipant(person('old','Анна Новая'));
  assert.equal(f.app.S.participants.length,2);assert.equal(f.app.S.participants[0],original);assert.equal(f.app.S.tasks[0].participant_id,'old');
  const markup=f.app.participantOptions('project','old');assert.match(markup,/value="old" selected>Анна Новая/);
  assert.match(markup,/&lt;img src=x&gt;/);assert.doesNotMatch(markup,/<img/);
  assert.match(f.app.participantOptions(null,'missing'),/value="missing" selected>Текущий участник/);
  assert.deepEqual(f.recent(),[]);
});

test('cancelling creation writes nothing; duplicate choice reuses the existing ID',async()=>{
  const f=fixture();f.app.openParticipantEditor();f.control('#participantName').value='Discard me';f.control('#participantCancel').onclick();
  assert.equal(f.calls.length,0);assert.equal(f.app.S.participants.length,0);assert.equal(f.dialogs[0].open,false);
  const existing=person('existing','Иван Петров');f.app.S.participants=[existing];let selected;
  f.app.openParticipantEditor(null,{onSelect:p=>{selected=p}});f.control('#participantName').value='  иван   петров ';await f.submit();
  assert.equal(f.calls.length,0);assert.equal(f.control('#participantExisting').hidden,false);f.control('#participantExisting').onclick();
  assert.equal(selected.id,'existing');assert.equal(f.app.S.participants.length,1);assert.equal(f.dialogs.at(-1).open,false);assert.deepEqual(f.recent(),[]);
});

test('creation double-submit guard sends one normalized UUID request and selects only after confirmation',async()=>{
  const f=fixture();let resolve,selected;f.owner((route,options)=>new Promise(done=>{resolve=()=>done({participant:{...options.body}})}));
  f.app.openParticipantEditor(null,{onSelect:p=>{selected=p}});f.control('#participantName').value='  Новый   участник ';
  const saving=f.submit();await f.submit();assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'POST');
  assert.match(f.calls[0].body.id,/^[0-9a-f-]{36}$/);assert.equal(f.calls[0].body.name,'Новый участник');
  assert.equal(selected,undefined);assert.equal(f.control('#participantCancel').disabled,true);
  f.control('#participantCancel').onclick();assert.equal(f.dialogs[0].open,true);
  resolve();await saving;assert.equal(selected.id,f.calls[0].body.id);assert.equal(f.app.S.participants.length,1);assert.equal(f.dialogs[0].open,false);assert.deepEqual(f.recent(),[]);
});

test('uncertain creation retries exactly the same UUID and payload, even if input is changed programmatically',async()=>{
  const f=fixture();f.app.openParticipantEditor();f.control('#participantName').value='Новый участник';
  f.owner(async()=>{throw Object.assign(Error('lost response'),{uncertain:true})});await f.submit();
  assert.equal(f.app.S.participants.length,0);assert.equal(f.control('#participantName').disabled,true);assert.match(f.control('#participantSave').textContent,/Проверить сохранение/);
  f.control('#participantName').value='Different input';f.owner(async(route,options)=>({participant:options.body}));await f.submit();
  assert.deepEqual(f.calls[1].body,f.calls[0].body);assert.equal(f.app.S.participants.length,1);assert.equal(f.app.S.participants[0].name,'Новый участник');
});

test('editing retains ID and linked tasks; conflict requires loading current name before corrected save',async()=>{
  const f=fixture();f.app.S.participants=[person('same-id','Иван')];f.app.S.tasks=[{id:'task',participant_id:'same-id'}];
  f.app.openParticipantEditor('same-id');f.control('#participantName').value='Иван — поставщик';
  f.owner(async()=>{throw Object.assign(Error('conflict'),{code:'participant_conflict',status:409,participant:person('same-id','Иван Петров')})});await f.submit();
  assert.deepEqual(f.calls[0].body,{name:'Иван — поставщик',expected_name:'Иван'});assert.equal(f.app.S.participants[0].name,'Иван');
  assert.equal(f.control('#participantExisting').hidden,false);f.control('#participantExisting').onclick();
  assert.equal(f.control('#participantName').value,'Иван Петров');f.control('#participantName').value='Иван Петров — поставщик';
  f.owner(async(route,options)=>({participant:person('same-id',options.body.name)}));await f.submit();
  assert.deepEqual(f.calls[1].body,{name:'Иван Петров — поставщик',expected_name:'Иван Петров'});assert.equal(f.calls[1].method,'PATCH');assert.equal(f.calls[1].route,'/participants/same-id');
  assert.equal(f.app.S.participants.length,1);assert.equal(f.app.S.participants[0].id,'same-id');assert.equal(f.app.S.tasks[0].participant_id,'same-id');
});

test('server duplicate response selects the existing person; unauthorized response keeps form text',async()=>{
  const f=fixture();f.app.openParticipantEditor();f.control('#participantName').value='Existing remotely';
  f.owner(async()=>{throw Object.assign(Error('duplicate'),{code:'participant_exists',status:409,participant:person('remote','Existing remotely')})});await f.submit();
  assert.equal(f.app.S.participants.length,0);f.control('#participantExisting').onclick();assert.equal(f.app.S.participants[0].id,'remote');assert.equal(f.calls.length,1);
  const g=fixture();g.app.openParticipantEditor();g.control('#participantName').value='Keep this text';
  g.owner(async()=>{throw Object.assign(Error('auth'),{code:'unauthorized',status:401})});await g.submit();
  assert.equal(g.control('#participantName').value,'Keep this text');assert.equal(g.control('#participantLogin').hidden,false);
  assert.equal(g.control('#participantName').disabled,false);assert.equal(g.dialogs[0].open,true);assert.equal(g.app.S.participants.length,0);
});

test('creating a participant from a task preserves its draft text, timing and project; recency waits for task save',async()=>{
  const f=fixture();f.app.S.projects=[{id:'project',title:'Project',status:'active'}];f.app.beginTaskDraft('project');
  f.setForm({tdDesc:'Несохранённая задача',tdDetails:'Важные подробности',tdProject:'project',tdDeadlineDate:'2026-10-02',tdDeadlineTime:'14:25'});
  const draft=f.app.S.taskDraft;f.app.bindTaskParticipantControls(draft);f.element('#tdParticipantNew').onclick();
  assert.equal(draft.description,'Несохранённая задача');assert.equal(draft._timing.deadlineTime,'14:25');
  f.control('#participantName').value='Павел';await f.submit();const id=f.app.S.participants[0].id;
  assert.equal(f.element('#tdParticipant').value,id);assert.equal(draft.participant_id,id);assert.equal(draft.project_id,'project');
  assert.equal(draft.description,'Несохранённая задача');assert.equal(draft.details,'Важные подробности');assert.equal(draft._timing.deadlineTime,'14:25');assert.deepEqual(f.recent(),[]);
  f.public(async()=>{throw Error('offline')});await f.app.saveTask(draft.id);assert.deepEqual(f.recent(),[]);assert.equal(f.app.S.taskDraft.id,draft.id);
  f.public(async(route,options)=>[{id:'confirmed-task',...options.body}]);await f.app.saveTask(draft.id);
  assert.equal(f.recent()[0].id,id);assert.equal(f.app.S.tasks[0].participant_id,id);assert.equal(f.app.S.tasks[0].deadline_at,new Date('2026-10-02T14:25').toISOString());
});

test('capture participant creation preserves the draft and failed capture save does not affect relevance',async()=>{
  const f=fixture(),row=f.makeElement();row.dataset.i='0';
  const fields={'.cd-desc':'Capture edited text','.cd-dir':'to_me','.cd-project':'','.cd-deadline':'2026-10-02','.cd-deadline-time':'10:40','.cd-participant':''};
  for(const [selector,value] of Object.entries(fields))row.querySelector(selector).value=value;
  row.querySelector('input[type=checkbox]').checked=true;f.captureRows.push(row);f.app.S.captureDrafts=[{description:'Initial',who:'Ольга'}];
  f.app.bindCaptureParticipants();row.querySelector('[data-participant-new]').onclick();
  assert.equal(f.control('#participantName').value,'Ольга');await f.submit();const id=f.app.S.participants[0].id;
  assert.equal(f.app.S.captureDrafts[0].participant_id,id);assert.equal(f.app.S.captureDrafts[0]._deadlineTime,'10:40');assert.equal(f.app.S.captureDrafts[0].description,'Capture edited text');assert.deepEqual(f.recent(),[]);
  f.public(async()=>{throw Error('offline')});await f.app.saveCaptureDrafts();assert.deepEqual(f.recent(),[]);assert.equal(f.app.S.captureDrafts.length,1);
  f.public(async(route,options)=>options.body.map((task,i)=>({id:'confirmed-'+i,...task})));await f.app.saveCaptureDrafts();
  assert.equal(f.recent()[0].id,id);assert.equal(f.app.S.tasks[0].participant_id,id);assert.equal(f.app.S.captureDrafts.length,0);
});
