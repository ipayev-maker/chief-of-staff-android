// Node.js 24, built-in test runner only. Runs the application script with DOM/API boundaries stubbed.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {randomUUID}=require('node:crypto');
const file=process.env.COS_TEST_HTML||path.join(__dirname,'../index.html');
const script=fs.readFileSync(file,'utf8').match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\bboot\(\);\s*$/,'');
const plain=value=>JSON.parse(JSON.stringify(value));

function fixture(){
  const nodes=new Map(),dialogs=[],calls=[],messages=[],renders=[];
  const makeNode=()=>({value:'',innerHTML:'',textContent:'',disabled:false,listeners:{},dataset:{},style:{},
    classList:{toggle(){},add(){},remove(){}},
    addEventListener(name,fn){this.listeners[name]=fn},setAttribute(name,value){this[name]=value},focus(){this.focused=true},
    querySelector:select,querySelectorAll(){return this.controls||[]},
    showModal(){this.open=true},close(){this.open=false;this.listeners.close?.()},remove(){if(this.id)nodes.delete('#'+this.id)},
  });
  function select(selector){
    if(selector==='#projectEditor')return nodes.get(selector)||null;
    if(!nodes.has(selector))nodes.set(selector,makeNode());
    return nodes.get(selector);
  }
  const context=vm.createContext({window:{addEventListener(){}},document:{querySelector:select,querySelectorAll:()=>[],
    createElement:makeNode,body:{appendChild(node){nodes.set('#'+node.id,node);dialogs.push(node)}}},
    Date,Intl,URL,console,crypto:{randomUUID},location:new URL('https://example.test/'),
    history:{replaceState(){}},sessionStorage:{getItem(){return null},setItem(){},removeItem(){}},
    setTimeout(){},clearTimeout(){},setInterval(){},confirm:()=>true,
  });
  vm.runInContext(script,context,{filename:file});
  let response=async(_url,options={})=>options.method==='POST'?[{...options.body}]:[];
  context.apiStub=async(url,options={})=>{calls.push({url,...plain(options)});return response(url,options)};
  context.toastStub=(message,type)=>messages.push({message,type});
  context.renderStub=()=>renders.push(true);
  vm.runInContext('api=apiStub;toast=toastStub;render=renderStub;flushNote=async()=>{};flushQuickNote=async()=>{};',context);
  const app=vm.runInContext('({S,projectsPage,openProjectEditor,persistNewProject})',context);
  app.S.section='projects';app.S.areas=[{key:'work',title:'Работа'},{key:'personal',title:'Личное'}];app.S.projects=[];
  function form(values={}){
    const node=select('#projectEditForm');
    node.elements=Object.fromEntries(Object.entries({title:'',status:'active',area_key:'',risk_level:'green',...values}).map(([key,value])=>[key,Object.assign(makeNode(),{value})]));
    node.controls=[...Object.values(node.elements),select('#projectEditCancel'),makeNode()];
    return node;
  }
  form();
  const submit=()=>select('#projectEditForm').onsubmit({preventDefault(){},currentTarget:select('#projectEditForm')});
  return{app,select,calls,dialogs,messages,renders,form,submit,api(fn){response=fn},evaluate(code){return vm.runInContext(code,context)}};
}

test('projects page exposes add action; new dialog has an empty title, current area and active/green defaults',async()=>{
  const f=fixture();f.app.S.areaFilter='work';f.app.projectsPage();
  assert.match(f.select('#main').innerHTML,/id="addProject"[^>]*aria-haspopup="dialog"[^>]*>＋ Добавить проект/);
  await f.select('#addProject').onclick();
  const dialog=f.dialogs[0];assert.equal(dialog.open,true);
  assert.match(dialog.innerHTML,/>Добавить проект<\/h2>/);
  assert.match(dialog.innerHTML,/name="title" required value=""/);
  assert.match(dialog.innerHTML,/option value="work" selected/);
  assert.match(dialog.innerHTML,/option value="active" selected/);
  assert.match(dialog.innerHTML,/option value="green" selected/);
  assert.equal(f.select('input[name=title]').focused,true);assert.equal(f.calls.length,0);
  f.form({title:'  '});await f.submit();
  assert.match(f.select('#projectEditError').textContent,/Введите название/);assert.equal(f.calls.length,0);
  f.select('#projectEditCancel').onclick();assert.equal(dialog.open,false);assert.equal(f.app.S.projects.length,0);
});

test('creation trims title and waits for a confirmed row; duplicate submit, cancel and editing are blocked while saving',async()=>{
  const f=fixture();await f.app.openProjectEditor();
  const form=f.form({title:'  Colryut  ',area_key:'work'});let finish;
  f.api((_url,options)=>new Promise(resolve=>{finish=()=>resolve([{...options.body}])}));
  const saving=f.submit();await f.submit();await f.app.openProjectEditor();
  assert.equal(f.calls.length,1);assert.equal(f.dialogs.length,1);assert.equal(f.app.S.projects.length,0);
  assert.equal(form['aria-busy'],'true');assert.ok(form.controls.every(control=>control.disabled));
  f.select('#projectEditCancel').onclick();assert.equal(f.dialogs[0].open,true);
  let prevented=false;f.dialogs[0].listeners.cancel({preventDefault(){prevented=true}});assert.equal(prevented,true);
  const call=f.calls[0];assert.equal(call.method,'POST');assert.equal(call.prefer,'return=representation');
  assert.equal(call.url,'/rest/v1/projects');assert.match(call.body.id,/^[0-9a-f-]{36}$/);
  assert.equal(call.body.title,'Colryut');assert.equal(call.body.status,'active');assert.equal(call.body.risk_level,'green');
  finish();await saving;
  assert.equal(f.app.S.projects.length,1);assert.equal(f.app.S.projects[0].title,'Colryut');assert.equal(f.dialogs[0].open,false);
  assert.equal(f.messages.at(-1).message,'Проект создан');assert.equal(form['aria-busy'],'false');
});

test('a lost POST response is confirmed with a read by the same UUID without a second write',async()=>{
  const f=fixture();let stored;
  f.api(async(_url,options)=>{
    if(options.method==='POST'){stored={...options.body};throw Error('Ответ потерян')}
    return[stored];
  });
  const row=await f.app.persistNewProject('project-id',{title:'Pilot',status:'active',area_key:null,risk_level:'green'});
  assert.equal(row.id,'project-id');assert.equal(f.app.S.projects.length,1);
  assert.equal(f.calls.length,2);assert.equal(f.calls.filter(call=>call.method==='POST').length,1);
  assert.equal(f.calls[1].url,'/rest/v1/projects?select=*&id=eq.project-id&limit=1');
});

test('unconfirmed creation preserves form and state; explicit retry reuses the same UUID',async()=>{
  const f=fixture();await f.app.openProjectEditor();
  const form=f.form({title:'My project',area_key:'work'});
  f.api(async(_url,options)=>{if(options.method==='POST')throw Error('Нет связи');return[]});
  await f.submit();
  assert.equal(f.app.S.projects.length,0);assert.equal(f.dialogs[0].open,true);
  assert.equal(form.elements.title.value,'My project');assert.equal(form.elements.area_key.value,'work');
  assert.match(f.select('#projectEditError').textContent,/Не удалось создать проект: Нет связи/);
  assert.ok(form.controls.every(control=>!control.disabled));
  const firstId=f.calls[0].body.id;
  f.api(async(_url,options)=>[{...options.body}]);await f.submit();
  assert.equal(f.calls.filter(call=>call.method==='POST').length,2);
  assert.equal(f.calls.at(-1).body.id,firstId);assert.equal(f.app.S.projects.length,1);assert.equal(f.dialogs[0].open,false);
});

test('retry cannot overwrite an already-created project when the form was changed after a lost response',async()=>{
  const f=fixture();const existing={id:'project-id',title:'Original title',status:'active',area_key:null,risk_level:'green'};
  f.api(async(_url,options)=>{if(options.method==='POST')throw Error('duplicate key');return[existing]});
  await assert.rejects(f.app.persistNewProject(existing.id,{...existing,title:'Edited after network error'}),/уже создан с названием «Original title»/);
  assert.equal(f.app.S.projects.length,1);assert.equal(f.app.S.projects[0].title,'Original title');
  assert.equal(f.calls.filter(call=>call.method==='PATCH').length,0);
});

test('empty or malformed returned rows do not produce false creation success',async()=>{
  const f=fixture();f.api(async()=>[]);
  await assert.rejects(f.app.persistNewProject('new',{title:'Name',status:'active',area_key:null,risk_level:'green'}),/не подтверждено/);
  assert.equal(f.app.S.projects.length,0);
  f.api(async()=>[{id:'new',title:'Name'}]);
  await assert.rejects(f.app.persistNewProject('new',{title:'Name',status:'active',area_key:null,risk_level:'green'}),/не подтверждено/);
  assert.equal(f.app.S.projects.length,0);
});
