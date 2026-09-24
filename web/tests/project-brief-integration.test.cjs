// Node.js 24, built-in test runner. Real index navigation, with only rendering/network boundaries stubbed.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {randomUUID}=require('node:crypto');
const file=process.env.COS_TEST_HTML||path.join(__dirname,'../index.html');
const script=fs.readFileSync(file,'utf8').match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\bboot\(\);\s*$/,'');
const plain=value=>JSON.parse(JSON.stringify(value));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes});return {promise,resolve}};

function fixture(){
  const nodes=new Map(),mounts=[],requests=[],messages=[],views=[],signings=[];
  let tabs=[],apiResponse=async()=>[],privateResponse=async()=>({brief:null}),signResponse=async()=>{};
  function node(key=''){
    let html='';
    return {value:'',textContent:'',disabled:false,isConnected:true,dataset:{},style:{},listeners:{},
      get innerHTML(){return html},set innerHTML(value){html=value;if(key==='#main'){
        if(nodes.has('#wb'))nodes.get('#wb').isConnected=false;
        nodes.delete('#wb');tabs=[];
        if(value.includes('id="wb"')){nodes.set('#wb',node('#wb'));tabs=[...value.matchAll(/data-tab="([^"]+)"/g)].map(match=>Object.assign(node(),{dataset:{tab:match[1]}}))}
      }},
      classList:{toggle(){},add(){},remove(){}},addEventListener(name,fn){this.listeners[name]=fn},
      setAttribute(name,value){this[name]=value},focus(){this.focused=true},closest(){return null},querySelector:select,querySelectorAll(){return[]},
      showModal(){this.open=true},close(){this.open=false;this.listeners.close?.()},remove(){this.isConnected=false},
    };
  }
  function select(selector){if(selector==='#wb')return nodes.get(selector)||null;if(!nodes.has(selector))nodes.set(selector,node(selector));return nodes.get(selector)}
  const context=vm.createContext({window:{addEventListener(){},CoSProjectBrief:{mount(container,options){
    const state={dirty:false,busy:false,leave:true,disposed:false};
    const controller={hasDraft:()=>state.dirty,isBusy:()=>state.busy,canLeave:()=>state.leave,dispose(){state.disposed=true}};
    mounts.push({container,options,state,controller});return controller;
  }}},document:{querySelector:select,querySelectorAll:selector=>selector==='.tabs button'?tabs:[],createElement:()=>node(),body:{appendChild(){}}},
    Date,Intl,URL,console,crypto:{randomUUID},location:new URL('https://chief-of-staff-v3-live.vercel.app/'),history:{replaceState(){}},
    sessionStorage:{getItem(){return null},setItem(){},removeItem(){}},setTimeout(){},clearTimeout(){},setInterval(){},requestAnimationFrame(){},confirm:()=>true,
  });
  vm.runInContext(script,context,{filename:file});
  context.apiStub=async(url,options={})=>{requests.push({url,...options});return apiResponse(url,options)};
  context.privateStub=async(url,options={})=>{requests.push({url,...options,private:true});return privateResponse(url,options)};
  context.toastStub=(message,type)=>messages.push({message,type});
  context.signStub=async id=>{signings.push(id);return signResponse(id)};
  context.viewStub=name=>{views.push(name);const target=select('#wb');if(target)target.innerHTML=name};
  vm.runInContext(`api=apiStub;quickNotesRequest=privateStub;toast=toastStub;signTaskAssets=signStub;
    flushNote=async()=>{};flushQuickNote=async()=>{};bindTaskDrawer=()=>{};
    space=()=>viewStub('space');notesPage=()=>viewStub('notes');meetingsPage=()=>viewStub('meetings');
    tasksPage=()=>viewStub('tasks');timePage=()=>viewStub('time');globalTasksPage=()=>{$('#main').innerHTML='global tasks'};
    projectsPage=()=>{$('#main').innerHTML='projects'};openCalendarSettings=()=>viewStub('login');`,context);
  const app=vm.runInContext('({S,QN,workspace,overview,render,openProject,beginTaskDraft})',context);
  app.S.section='projects';app.S.tab='overview';app.QN.loaded=true;
  app.S.projects=[{id:'project-1',title:'Pilot',status:'active',area_key:'work'},{id:'project-2',title:'Other',status:'active',area_key:'work'}];
  app.S.project=app.S.projects[0];app.S.areas=[{key:'work',title:'Work'}];
  const navigate=async section=>{const button=node();button.dataset.sec=section;await select('#nav').listeners.click({target:{closest:()=>button}})};
  const tab=async name=>{const button=tabs.find(tab=>tab.dataset.tab===name);assert.ok(button,'tab '+name);await button.onclick()};
  return{app,context,select,mounts,requests,messages,views,signings,navigate,tab,
    api(fn){apiResponse=fn},privateApi(fn){privateResponse=fn},sign(fn){signResponse=fn},
    evaluate(code){return vm.runInContext(code,context)},mount(){app.S.tab='overview';app.workspace();return mounts.at(-1)}};
}

test('project state mounts scoped records and each request retains its original project endpoint',async()=>{
  const f=fixture();
  f.app.S.tasks=[{id:'t1',project_id:'project-1',description:'Wait',status:'open'},{id:'t2',project_id:'project-2',status:'open'}];
  f.app.S.notes=[{id:'n1',project_id:'project-1',plain_text:'Known fact'},{id:'n2',project_id:'project-2'},{id:'deleted',project_id:'project-1',deleted_at:'2026-09-24'}];
  f.app.S.meetings=[{id:'m1',project_id:'project-1'},{id:'m2',project_id:'project-2'}];f.app.S.participants=[{id:'person',name:'Supplier'}];
  const mount=f.mount();
  assert.equal(mount.options.project,f.app.S.project);assert.deepEqual(plain(mount.options.tasks).map(x=>x.id),['t1']);
  assert.deepEqual(plain(mount.options.notes).map(x=>x.id),['n1']);assert.deepEqual(plain(mount.options.meetings).map(x=>x.id),['m1']);
  assert.equal(mount.options.participants,f.app.S.participants);assert.equal(f.requests.length,0);
  f.app.S.project=f.app.S.projects[1];await mount.options.request({method:'PATCH',body:{revision:0,result:'Confirmed'}});
  assert.equal(f.requests[0].url,'/projects/project-1/brief');assert.equal(f.requests[0].method,'PATCH');
});

test('private brief authorization failure does not prevent switching existing project tabs',async()=>{
  const f=fixture(),mount=f.mount();f.privateApi(async()=>{throw Object.assign(Error('Sign in'),{status:401})});
  await assert.rejects(mount.options.request(),error=>error.status===401);
  assert.equal(f.app.S.project.id,'project-1');assert.equal(f.app.S.tab,'overview');
  await f.tab('tasks');assert.equal(f.app.S.tab,'tasks');assert.equal(f.views.at(-1),'tasks');assert.equal(mount.state.disposed,true);
  assert.equal(f.requests.length,1);assert.ok(!f.requests[0].method);
});

test('busy or declined brief departure blocks navigation, tabs, back and another project without reads or writes',async()=>{
  const f=fixture(),mount=f.mount();mount.state.dirty=true;mount.state.leave=false;
  const before=f.select('#main').innerHTML;
  await f.navigate('tasks');await f.tab('notes');await f.select('#back').onclick();await f.app.openProject('project-2');
  f.app.render();f.app.workspace();
  assert.equal(f.app.S.project.id,'project-1');assert.equal(f.app.S.tab,'overview');assert.equal(f.app.S.section,'projects');
  assert.equal(f.select('#main').innerHTML,before);assert.equal(mount.state.disposed,false);assert.equal(f.mounts.length,1);assert.equal(f.requests.length,0);
  mount.state.dirty=false;mount.state.busy=true;f.app.render();assert.equal(f.mounts.length,1);assert.equal(mount.state.disposed,false);
  mount.state.busy=false;mount.state.leave=true;await f.navigate('tasks');
  assert.equal(f.app.S.project,null);assert.equal(f.app.S.section,'tasks');assert.equal(mount.state.disposed,true);
});

test('callbacks from a disposed mount cannot change a new project or a fresh mount of the same project',async()=>{
  const f=fixture();f.app.S.tasks=[{id:'t1',project_id:'project-1',status:'open'}];f.app.S.notes=[{id:'n1',project_id:'project-1'}];f.app.S.meetings=[{id:'m1',project_id:'project-1'}];
  const old=f.mount();f.app.workspace();assert.equal(old.state.disposed,true);
  await old.options.onTask('t1');old.options.onNote('n1');old.options.onMeeting('m1');old.options.onCreateTask();old.options.onLogin();old.options.onError('stale');
  assert.equal(f.app.S.tab,'overview');assert.equal(f.app.S.task,null);assert.equal(f.app.S.taskDraft,null);assert.equal(f.signings.length,0);assert.equal(f.views.length,0);assert.equal(f.messages.length,0);
  f.app.S.project=f.app.S.projects[1];f.app.workspace();await old.options.onTask('t1');old.options.onCreateTask();
  assert.equal(f.app.S.project.id,'project-2');assert.equal(f.app.S.tab,'overview');assert.equal(f.requests.length,0);
});

test('task signing cannot replace a tab or project selected while its media request was pending',async()=>{
  const f=fixture(),gate=deferred();f.app.S.tasks=[{id:'t1',project_id:'project-1',status:'open'}];f.sign(()=>gate.promise);
  const mount=f.mount(),opening=mount.options.onTask('t1');await tick();
  await f.tab('meetings');gate.resolve();await opening;
  assert.equal(f.app.S.tab,'meetings');assert.equal(f.app.S.task,null);assert.deepEqual(f.views,['meetings']);assert.equal(f.requests.length,0);
  const g=fixture(),next=deferred();g.app.S.tasks=[{id:'t1',project_id:'project-1',status:'open'}];g.sign(()=>next.promise);
  const previous=g.mount(),pending=previous.options.onTask('t1');await tick();await g.app.openProject('project-2');next.resolve();await pending;
  assert.equal(g.app.S.project.id,'project-2');assert.equal(g.app.S.tab,'overview');assert.equal(g.app.S.task,null);
});

test('task action opens the existing editor, rejects foreign records, and contains media failures',async()=>{
  const f=fixture();f.app.S.tasks=[{id:'t1',project_id:'project-1',status:'open',description:'Known task'},{id:'foreign',project_id:'project-2',status:'open'}];
  const mount=f.mount();await mount.options.onTask('foreign');assert.equal(f.signings.length,0);
  f.sign(async()=>{throw Error('Media unavailable')});await mount.options.onTask('t1');
  assert.equal(f.app.S.tab,'overview');assert.equal(f.app.S.task,null);assert.match(f.messages.at(-1).message,/Media unavailable/);
  f.sign(async()=>{});const before=plain(f.app.S.tasks);await mount.options.onTask('t1');
  assert.equal(f.app.S.tab,'space');assert.equal(f.app.S.task,'t1');assert.equal(mount.state.disposed,true);assert.deepEqual(plain(f.app.S.tasks),before);assert.equal(f.requests.length,0);
});

test('note and meeting actions preserve the exact project selection and archive context without creating records',()=>{
  const f=fixture();f.app.S.notes=[{id:'archived',project_id:'project-1',archived_at:'2026-09-20'},{id:'foreign',project_id:'project-2'},{id:'deleted',project_id:'project-1',deleted_at:'2026-09-24'}];
  let mount=f.mount();mount.options.onNote('foreign');mount.options.onNote('deleted');assert.equal(f.app.S.tab,'overview');
  mount.options.onNote('archived');assert.equal(f.app.S.tab,'notes');assert.equal(f.app.S.note.id,'archived');assert.equal(f.app.S.projectNoteKind,'project');assert.equal(f.app.QN.archived,true);
  f.app.S.meetings=[{id:'selected',project_id:'project-1',title:'Review'},{id:'foreign',project_id:'project-2'}];mount=f.mount();mount.options.onMeeting('foreign');assert.equal(f.app.S.tab,'overview');
  mount.options.onMeeting('selected');assert.equal(f.app.S.tab,'meetings');assert.equal(f.app.S.meeting.id,'selected');assert.equal(f.app.S.project.id,'project-1');assert.equal(f.requests.length,0);
});

test('create action opens a blank local task in its active project and makes no automatic writes',()=>{
  const f=fixture(),mount=f.mount();mount.options.onCreateTask();
  assert.equal(f.app.S.tab,'space');assert.equal(f.app.S.taskDraft._draft,true);assert.equal(f.app.S.taskDraft.project_id,'project-1');
  assert.equal(f.app.S.taskDraft.description,'');assert.equal(f.app.S.taskDraft.details,'');assert.equal(f.app.S.taskDraft.area_key,'work');assert.equal(f.requests.length,0);
  const busy=fixture(),blocked=busy.mount();busy.app.S.taskSaveBusy=true;blocked.options.onCreateTask();assert.equal(busy.app.S.tab,'overview');assert.equal(busy.app.S.taskDraft,null);
});

test('project overview still opens when the optional brief bundle is absent',async()=>{
  const f=fixture();f.evaluate('delete window.CoSProjectBrief');
  assert.equal(await f.app.openProject('project-1'),true);assert.match(f.select('#wb').innerHTML,/Не удалось загрузить экран/);
  await f.tab('tasks');assert.equal(f.views.at(-1),'tasks');assert.equal(f.app.S.project.id,'project-1');assert.ok(f.requests.every(call=>!call.method));
});
