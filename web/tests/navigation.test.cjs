const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const navigation = require('../navigation.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {let resolve;const promise = new Promise(yes => {resolve = yes;});return {resolve, promise};};

function browser(url='https://example.test/?calendar=connected') {
  const listeners = new Map(), frames = new Map(), nodes = new Map();
  for (const id of ['html', 'body', '#main', '#wb']) nodes.set(id, {scrollTop:730, scrollLeft:41});
  const entries = [{state:null, url:'https://other.test/'}, {state:{unrelated:'kept'}, url}], applied = [];
  let position = 1, frameID = 0, scrollCalls = 0;
  const win = {
    location:new URL(url),
    document:{scrollingElement:nodes.get('html'), documentElement:nodes.get('html'), body:nodes.get('body'), querySelector:key => nodes.get(key)},
    addEventListener:(name, handler) => listeners.set(name, handler), removeEventListener:name => listeners.delete(name),
    requestAnimationFrame:fn => {frames.set(++frameID, fn);return frameID;}, cancelAnimationFrame:id => frames.delete(id),
    scrollTo(){scrollCalls++;},
    history:{scrollRestoration:'auto', get state(){return entries[position].state;},
      replaceState(state, title, target){entries[position] = {state, url:new URL(target, win.location).href};win.location.href = entries[position].url;},
      pushState(state, title, target){entries.splice(position+1);entries.push({state, url:new URL(target, win.location).href});position++;win.location.href = entries[position].url;},
      go(delta){const next=position+delta;if(next<0||next>=entries.length)return;position=next;win.location.href=entries[position].url;queueMicrotask(()=>listeners.get('popstate')?.({state:entries[position].state}));},
    },
  };
  const options={window:win, initialRoute:{section:'today'}, apply:async route=>{applied.push(route);return true;}};
  return {win, nodes, entries, applied, options, position:()=>position, scrollCalls:()=>scrollCalls,
    frame(){const callbacks=[...frames.values()];frames.clear();callbacks.forEach(fn=>fn());},
    back:async()=>{win.history.go(-1);await tick();},forward:async()=>{win.history.go(1);await tick();},
  };
}

test('routes recognize only known sections and project tabs, preserving unrelated query parameters', () => {
  assert.equal(navigation.readRoute(new URL('https://example.test/')), null);
  assert.equal(navigation.readRoute(new URL('https://example.test/#/people')).section, 'people');
  assert.deepEqual(navigation.readRoute(new URL('https://example.test/#/projects/project-1/notes')), {section:'projects', projectId:'project-1', tab:'notes', calendarReturn:false});
  for (const hash of ['#/unknown', '#/projects/../notes', '#/projects/%2Fbad/notes', '#/projects/p/unknown', '#/%E0%A4%A']) assert.equal(navigation.readRoute({hash}), null);
  assert.equal(navigation.routeURL(new URL('https://example.test/app?section=notes&id=123'), {section:'people'}), '/app?section=notes&id=123#/people');
});

test('navigation adds one history entry per actual screen change; rerenders never push or reset scroll', () => {
  const b=browser(), controller=navigation.create(b.options);
  assert.equal(b.entries.length,2);assert.equal(b.win.history.scrollRestoration,'manual');assert.equal(b.win.history.state.unrelated,'kept');
  assert.equal(controller.record({section:'today'}),false);b.frame();assert.equal(b.scrollCalls(),0);
  assert.equal(controller.record({section:'tasks'}),true);b.frame();assert.equal(b.entries.length,3);assert.equal(b.scrollCalls(),1);
  b.nodes.get('#main').scrollTop=480;
  assert.equal(controller.record({section:'tasks'}),false);b.frame();assert.equal(b.nodes.get('#main').scrollTop,480);assert.equal(b.scrollCalls(),1);
  controller.dispose();assert.equal(b.win.history.scrollRestoration,'auto');
});

test('Back and Forward restore section and project tab without adding duplicate entries', async () => {
  const b=browser(), controller=navigation.create(b.options);
  controller.record({section:'projects'});
  controller.record({section:'projects',projectId:'project-1',tab:'overview'});
  controller.record({section:'projects',projectId:'project-1',tab:'notes'});
  const length=b.entries.length;
  await b.back();assert.equal(b.applied.at(-1).tab,'overview');assert.equal(controller.getRoute().projectId,'project-1');
  await b.back();assert.equal(b.applied.at(-1).projectId,null);assert.equal(controller.getRoute().section,'projects');
  await b.forward();assert.equal(b.applied.at(-1).tab,'overview');assert.equal(b.entries.length,length);
});

test('all document and application scroll surfaces reset at navigation, including Back', async () => {
  const b=browser(), controller=navigation.create(b.options);
  controller.resetScroll();b.frame();for(const node of b.nodes.values()){assert.equal(node.scrollTop,0);assert.equal(node.scrollLeft,0);}
  controller.record({section:'calendar'});b.frame();
  for(const node of b.nodes.values()){node.scrollTop=900;node.scrollLeft=16;}
  await b.back();b.frame();for(const node of b.nodes.values()){assert.equal(node.scrollTop,0);assert.equal(node.scrollLeft,0);}
});

test('cancelled draft guard restores the exact browser position without duplicating history', async () => {
  const b=browser(), controller=navigation.create({...b.options,canLeave:()=>false});
  controller.record({section:'projects'});controller.record({section:'notes'});
  const length=b.entries.length, position=b.position();
  await b.back();await tick();
  assert.equal(b.position(),position);assert.equal(b.win.location.hash,'#/notes');assert.equal(controller.getRoute().section,'notes');
  assert.equal(b.entries.length,length);assert.equal(b.applied.length,0);assert.equal(controller.isNavigating(),false);
});

test('failed page load restores address/history and reports an error without losing the current route', async () => {
  const b=browser(), errors=[], controller=navigation.create({...b.options,apply:async()=>{throw Error('offline');},onError:error=>errors.push(error.message)});
  controller.record({section:'tasks'});await b.back();await tick();
  assert.equal(b.win.location.hash,'#/tasks');assert.equal(controller.getRoute().section,'tasks');assert.deepEqual(errors,['offline']);assert.equal(b.entries.length,3);
});

test('rapid Back actions ignore completion from an older in-flight route', async () => {
  const b=browser(), pending=deferred(), commits=[];
  const controller=navigation.create({...b.options,apply:async(route,{isCurrent})=>{if(route.section==='projects')await pending.promise;if(isCurrent())commits.push(route.section);return true;}});
  controller.record({section:'projects'});controller.record({section:'notes'});
  await b.back();assert.equal(controller.isNavigating(),true);
  await b.back();assert.equal(controller.getRoute().section,'today');
  pending.resolve();await tick();
  assert.deepEqual(commits,['today']);assert.equal(controller.getRoute().section,'today');assert.equal(b.win.location.hash,'#/today');
});

test('browser Back can leave the dashboard once the actual in-app history is exhausted', async () => {
  const b=browser(), controller=navigation.create(b.options);
  controller.record({section:'tasks'});await b.back();await b.back();
  assert.equal(b.win.location.origin,'https://other.test');assert.equal(b.position(),0);assert.equal(b.entries.length,3);assert.equal(b.applied.length,1);
});

test('reload keeps known history positions and calendar return context for a project', () => {
  const b=browser(), first=navigation.create(b.options);
  first.record({section:'calendar',projectId:'project-1',tab:'meetings',calendarReturn:true});first.dispose();
  const second=navigation.create({...b.options,initialRoute:b.win.history.state.cosNavigation.route});
  assert.equal(b.win.history.state.cosNavigation.index,1);assert.equal(second.getRoute().calendarReturn,true);assert.equal(second.getRoute().section,'calendar');assert.equal(b.entries.length,3);
});

function appFixture({linkedNavigation=false}={}) {
  const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  const source=html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\bboot\(\);\s*$/,'');
  const elements=new Map(), events=[], messages=[];
  function element(selector){
    if(!elements.has(selector))elements.set(selector,{value:'',innerHTML:'',textContent:'',dataset:{},style:{},classList:{add(){},remove(){},toggle(){}},addEventListener(){},querySelector(){return null;},querySelectorAll(){return [];},focus(){},closest(){return null;}});
    return elements.get(selector);
  }
  const browserState=linkedNavigation?browser('https://example.test/'):null;
  const document={querySelector:element,querySelectorAll:()=>[]};
  const win=browserState?.win||{addEventListener(){}};win.document=document;
  const context=vm.createContext({window:win,document,location:win.location||new URL('https://example.test/'),history:win.history||{replaceState(){}},sessionStorage:{getItem(){return null;},setItem(){},removeItem(){}},Date,Intl,URL,console,setTimeout(){},clearTimeout(){},setInterval(){},confirm:()=>false,crypto:{randomUUID:()=> 'uuid'},events,messages});
  if(linkedNavigation){
    const tag=html.match(/<script\b([^>]*)\bsrc=["'](\/navigation\.js[^"']*)["']([^>]*)>\s*<\/script>/);
    assert.ok(tag,'The actual application must load navigation.js, not merely define optional integration hooks.');
    assert.ok(tag.index<html.indexOf('<script>'),'Navigation must be available before the inline application script.');
    assert.doesNotMatch(tag[1]+tag[3],/\b(?:async|defer)\b/,'The startup helper is synchronously loaded.');
    const pathname=new URL(tag[2],'https://example.test/').pathname;
    vm.runInContext(fs.readFileSync(path.join(__dirname,'..',pathname),'utf8'),context,{filename:pathname});
    assert.equal(typeof win.CoSNavigation?.create,'function');
  }
  vm.runInContext(source,context);
  vm.runInContext("toast=(message)=>messages.push(message);flushNote=async()=>{};flushQuickNote=async()=>{};",context);
  if(!linkedNavigation)vm.runInContext("render=()=>events.push({section:S.section,project:S.project?.id,tab:S.tab});",context);
  const evaluate=code=>vm.runInContext(code,context);
  return {element,evaluate,events,messages,context,browserState};
}

test('actual HTML loads the helper before boot and the real application bridge supports Back and Forward', async()=>{
  const f=appFixture({linkedNavigation:true});
  f.evaluate("api=async()=>[];syncMeetingStatuses=async()=>{};checkMeetingReminders=()=>{};todayPage=()=>events.push('today');globalTasksPage=()=>events.push('tasks');participantsPage=()=>events.push('people');");
  await f.evaluate('boot()');
  assert.equal(f.browserState.win.location.hash,'#/today');assert.equal(f.evaluate('S.section'),'today');assert.equal(f.events.at(-1),'today');
  await f.evaluate("navigateDashboardSection('tasks')");await f.evaluate("navigateDashboardSection('people')");
  assert.equal(f.browserState.win.location.hash,'#/people');assert.equal(f.browserState.entries.length,4);
  await f.browserState.back();assert.equal(f.evaluate('S.section'),'tasks');assert.equal(f.events.at(-1),'tasks');
  await f.browserState.back();assert.equal(f.evaluate('S.section'),'today');assert.equal(f.events.at(-1),'today');
  await f.browserState.forward();assert.equal(f.evaluate('S.section'),'tasks');assert.equal(f.events.at(-1),'tasks');assert.equal(f.browserState.entries.length,4);
});

test('actual app refuses to lose task edits and does not navigate during a task save', async () => {
  const f=appFixture();f.evaluate("S.tasks=[{id:'task-1',description:'Original',status:'open',direction:'internal'}];S.task='task-1';");
  f.element('#tdDesc').value='Edited';f.element('#tdStatus').value='open';f.element('#tdDirection').value='internal';
  assert.equal(await f.evaluate("navigateDashboardSection('projects')"),false);assert.equal(f.evaluate('S.section'),'today');assert.equal(f.element('#tdDesc').value,'Edited');
  f.evaluate('S.taskSaveBusy=true;');assert.equal(await f.evaluate("navigateDashboardSection('notes')"),false);assert.equal(f.events.length,0);
});

test('project-state refusal leaves the mounted editor and its request identity intact', async () => {
  const f=appFixture();f.evaluate("S.project={id:'project-1'};S.projects=[S.project,{id:'project-2'}];projectOpenSequence=42;projectBriefController={canLeave:()=>false};");
  await f.evaluate("openProject('project-2')");assert.equal(f.evaluate('projectOpenSequence'),42);assert.equal(f.evaluate('S.project.id'),'project-1');
  await f.evaluate("navigateDashboardSection('today')");assert.equal(f.evaluate('projectOpenSequence'),42);assert.equal(f.evaluate('S.project.id'),'project-1');
});

test('a failed note flush leaves the visible page and draft selected', async () => {
  const f=appFixture();f.evaluate("S.section='notes';QN.draft={id:'note-1',title:'Keep'};flushQuickNote=async()=>{throw Error('not saved')};");
  assert.equal(await f.evaluate("navigateDashboardSection('calendar')"),false);assert.equal(f.evaluate('S.section'),'notes');assert.equal(f.evaluate('QN.draft.title'),'Keep');assert.deepEqual(f.messages,['not saved']);
});
