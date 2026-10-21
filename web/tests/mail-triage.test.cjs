const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {randomUUID}=require('node:crypto');
const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\bboot\(\);\s*$/,'');
const source='d04c382f-0156-4eb8-a492-a4758b18669f';
const review=(id,extra={})=>({id,description:'Разобрать письмо: Образец',details:'Нужен разбор.\nИз сообщения: Образец готов\nИсточник: https://nikodim.vercel.app/#/inbox/'+source,status:'open',direction:'internal',cos_version:2,created_at:'2026-10-21T10:00:00Z',...extra});
function fixture(){
  const elements=new Map(),calls=[],messages=[],controls=[{disabled:false,isConnected:true}];
  const element=key=>{if(!elements.has(key))elements.set(key,{value:'',innerHTML:'',addEventListener(){},classList:{add(){},remove(){}},disabled:false,isConnected:true});return elements.get(key)};
  const context=vm.createContext({window:{addEventListener(){}},Date,Intl,URL,console,crypto:{randomUUID},location:new URL('https://nikodim.vercel.app/'),setTimeout(){},clearTimeout(){},setInterval(){},document:{querySelector:element,querySelectorAll:selector=>selector.startsWith('[data-mail-review],')?controls:[]}});
  vm.runInContext(script,context);
  let response=async(_,options)=>[{...app.S.tasks.find(t=>t.id==='mail-1'),...options.body,cos_version:3}];
  context.request=async(url,options)=>{calls.push({url,...options});return response(url,options)};
  context.message=(...args)=>messages.push(args);
  vm.runInContext('api=request;toast=message;renderTaskContext=()=>{};',context);
  const app=vm.runInContext('({S,mailReviewSource,mailReviewLists,mailReviewHtml,globalTasksPage,setMailReviewStatus,taskDrawer})',context);
  app.S.areas=[{key:'work',title:'Работа'}];app.S.tasks=[review('mail-1')];
  return {app,element,calls,messages,controls,response(fn){response=fn}};
}
test('existing generated mail is recognized; normal tasks and arbitrary links are not',()=>{
  const {app}=fixture();assert.equal(app.mailReviewSource(review('x')),source);
  for(const task of [{description:'Разобрать письмо: Образец'},review('x',{description:'Согласовать образец'}),review('x',{details:'Источник: https://evil.test/#/inbox/'+source})])assert.equal(app.mailReviewSource(task),null);
});
test('unreviewed mail is above project filters, newest first, and not duplicated in ordinary tasks',()=>{
  const {app,element}=fixture();app.S.areaFilter='work';
  app.S.tasks=[review('old',{created_at:'2026-10-20T10:00:00Z'}),review('new'),review('ignored',{status:'cancelled'}),review('done',{status:'completed'}),{id:'normal',description:'Позвонить',status:'open',area_key:'work'}];
  const lists=app.mailReviewLists(app.S.tasks);assert.deepEqual(Array.from(lists.pending,t=>t.id),['new','old']);assert.deepEqual(Array.from(lists.ignored,t=>t.id),['ignored']);
  app.globalTasksPage();const main=element('#main').innerHTML,top=element('#mailReviewGroups').innerHTML,normal=element('#globalTaskGroups').innerHTML;
  assert.ok(main.indexOf('id="mailReviewGroups"')<main.indexOf('class="filters'));
  assert.match(top,/Неразобранные/);assert.ok(top.indexOf('data-review-open="new"')<top.indexOf('data-review-open="old"'));
  assert.doesNotMatch(top,/data-review-open="ignored"/);assert.match(normal,/Позвонить/);assert.doesNotMatch(normal,/Разобрать письмо/);
  app.S.taskShowCompleted=true;app.S.taskShowIgnored=true;app.globalTasksPage();assert.match(element('#mailReviewGroups').innerHTML,/data-review-open="ignored"/);assert.doesNotMatch(element('#globalTaskGroups').innerHTML,/data-global-task="ignored"/);
});
test('search filters pending and ignored mail; subject HTML is escaped and source opens original',()=>{
  const {app}=fixture();const task=review('x',{description:'Разобрать письмо: <img src=x onerror=alert(1)>'});
  const markup=app.mailReviewHtml([task],[]);assert.doesNotMatch(markup,/<img/);assert.match(markup,/&lt;img/);
  assert.equal(app.mailReviewLists([task],'другое').pending.length,0);
  const drawer=app.taskDrawer(task);assert.match(drawer,new RegExp('href="#/inbox/'+source+'"'));assert.match(drawer,/id="taskMailIgnore"/);
});
test('ignore persists conditional status, hides mail after reload and supports restore',async()=>{
  const f=fixture();assert.equal(await f.app.setMailReviewStatus('mail-1','cancelled'),true);
  assert.match(f.calls[0].url,/cos_version=eq.2&status=eq.open&deleted_at=is.null/);assert.equal(f.calls[0].body.status,'cancelled');assert.equal(f.app.S.tasks[0].cos_version,3);
  const reloaded=JSON.parse(JSON.stringify(f.app.S.tasks));assert.equal(f.app.mailReviewLists(reloaded).pending.length,0);assert.equal(f.app.mailReviewLists(reloaded).ignored.length,1);
  assert.equal(await f.app.setMailReviewStatus('mail-1','open'),true);assert.equal(f.app.mailReviewLists(f.app.S.tasks).pending.length,1);
  assert.match(f.calls[1].url,/cos_version=eq.3&status=eq.cancelled/);assert.equal(f.calls.length,2);
});
test('conflict, failed request or unexpected response does not hide mail locally',async()=>{
  for(const response of [async()=>[],async()=>{throw Error('offline')},async()=>[{id:'other',status:'cancelled'}]]){
    const f=fixture();f.response(response);assert.equal(await f.app.setMailReviewStatus('mail-1','cancelled'),false);assert.equal(f.app.S.tasks[0].status,'open');assert.equal(f.app.S.taskSaveBusy,false);assert.equal(f.controls[0].disabled,false);assert.equal(f.messages[0][1],'error');
  }
});
test('duplicate clicks, normal tasks, completed mail and active timers cannot trigger ignore',async()=>{
  const f=fixture();let resolve;f.response(()=>new Promise(done=>resolve=done));const pending=f.app.setMailReviewStatus('mail-1','cancelled');
  assert.equal(f.app.S.taskSaveBusy,true);assert.equal(f.controls[0].disabled,true);assert.equal(await f.app.setMailReviewStatus('mail-1','cancelled'),false);assert.equal(f.calls.length,1);
  resolve([{...f.app.S.tasks[0],status:'cancelled',cos_version:3}]);await pending;
  f.app.S.tasks=[review('mail-1',{status:'completed'})];assert.equal(await f.app.setMailReviewStatus('mail-1','cancelled'),false);
  f.app.S.tasks=[{id:'normal',description:'Обычная задача',status:'open'}];assert.equal(await f.app.setMailReviewStatus('normal','cancelled'),false);
  f.app.S.tasks=[review('mail-1')];f.app.S.time=[{commitment_id:'mail-1',source:'timer',ended_at:null}];await f.app.setMailReviewStatus('mail-1','cancelled');assert.equal(f.calls.length,1);
});
