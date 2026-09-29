const test = require('node:test');
const assert = require('node:assert/strict');
const inbox = require('../inbox.js');
const ID='11111111-1111-4111-8111-111111111111',PROJECT='22222222-2222-4222-8222-222222222222',PERSON='33333333-3333-4333-8333-333333333333',CHANGE='44444444-4444-4444-8444-444444444444',REQUEST='55555555-5555-4555-8555-555555555555',OTHER='66666666-6666-4666-8666-666666666666';
const options={projects:[{id:PROJECT,title:'Витрины',status:'active'}],participants:[{id:PERSON,name:'Анна'}],tasks:[]};
const change=(extra={})=>({id:CHANGE,kind:'task_create',selected:true,evidence:'Анна пришлёт чертёж в пятницу',project_id:PROJECT,participant_id:PERSON,text:'Получить чертёж',direction:'to_me',deadline:'2026-10-02',deadline_time:null,next_check_on:null,task_id:null,task_version:null,status:'open',entry_kind:null,brief_revision:null,...extra});
const item=(extra={})=>({id:ID,note_id:OTHER,source_text:'Анна пришлёт чертёж в пятницу',source_meta:{type:'text'},transcript:null,status:'ready',revision:2,created_at:'2026-09-29T12:00:00Z',proposal:{version:1,summary:'Договорились получить чертёж',questions:[],changes:[change()]},...extra});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
let fixtureId=0;
function fixture(request,extra={}){
  const listeners=new Map(),view={crypto:{randomUUID:()=>REQUEST},confirm:()=>true,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
  const container={ownerDocument:{defaultView:view},innerHTML:'',contains:()=>true};
  const controller=inbox.mount(container,{...options,scope:'test-'+ ++fixtureId,request,...extra});
  return{container,controller,listeners,view};
}
async function click(f,action,data={}){
  const node={dataset:{ciAction:action,...data},closest(){return this;}};
  await f.container.onclick({target:node});
}
function input(f,key,value,id=CHANGE){f.container.oninput({target:{dataset:{ciField:key,ciChange:id},value,checked:value}});}
async function selectedFixture(mutate,extra={}){
  const row=item();
  const requests=[];
  const f=fixture(async(path,opt)=>{
    requests.push({path,opt});
    if(path.startsWith('/inbox?'))return{items:[row],nextOffset:null};
    if(path===`/inbox/${ID}`)return{item:row};
    return mutate(path,opt);
  },extra);
  await flush();await click(f,'select',{ciId:ID});
  return{...f,requests};
}
test('renders source and proposals without HTML injection or synthetic task creation',()=>{
  const row=item({source_text:'<img src=x onerror=alert(1)>',proposal:{version:1,summary:'<script>bad</script>',questions:['<button>why</button>'],changes:[change({text:'<svg/onload=bad>',evidence:'<iframe src=bad>'})]}});
  const html=inbox.renderDetail(inbox.createSession(row),options);
  assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html,/&lt;svg\/onload=bad&gt;/);
  assert.doesNotMatch(html,/<script>|<iframe|<svg|<img/);
  assert.match(html,/Основание в сообщении/);
  assert.match(html,/Применить всё/);
  assert.match(html,/после подтверждения/);
});
test('voice original is played through authenticated same-origin inbox endpoint',()=>{
  const html=inbox.renderDetail(inbox.createSession(item({source_meta:{type:'voice',audio_path:'private/secret/file.ogg'},transcript:'Договорились отправить чертёж'})),options);
  assert.match(html,new RegExp(`src="/api/notes/inbox/${ID}/audio"`));
  assert.match(html,/preload="none"/);
  assert.match(html,/Расшифровка/);
  assert.doesNotMatch(html,/secret|file\.ogg/);
});
test('taskless communication stays a note and needs explicit finish',()=>{
  const html=inbox.renderDetail(inbox.createSession(item({proposal:{version:1,summary:'Обсудили цвет',questions:[],changes:[]}})),options);
  assert.match(html,/Готово — оставить заметкой/);
  assert.match(html,/без создания задач/);
  assert.doesNotMatch(html,/Новая задача/);
});
test('active project choices exclude inactive projects without guessing unresolved project',()=>{
  const session=inbox.createSession(item({proposal:{changes:[change({project_id:null})]}}));session.editing=true;
  const html=inbox.renderDetail(session,{...options,projects:[...options.projects,{id:OTHER,title:'Неактивный секрет',status:'paused'}]});
  assert.match(html,/<option value="" selected>Выберите проект/);
  assert.doesNotMatch(html,/Неактивный секрет/);
  assert.equal(inbox.validateProposal(session.proposal,options),'');
  session.proposal.changes[0].kind='project_state';
  assert.match(inbox.validateProposal(session.proposal,options),/Выберите проект/);
});
test('date-only validation keeps day and requires date before exact time',()=>{
  assert.equal(inbox.validDay('2024-02-29'),true);
  assert.equal(inbox.validDay('2026-02-29'),false);
  assert.equal(inbox.validDay('2026-04-31'),false);
  assert.equal(inbox.dayLabel('2026-10-02'),'2 окт. 2026');
  const proposal={changes:[change({deadline:null,deadline_time:'14:30'})]};
  assert.match(inbox.validateProposal(proposal,options),/вместе с датой/);
  proposal.changes[0].deadline='2026-10-02';
  assert.equal(inbox.validateProposal(proposal,options),'');
});
test('unselected incomplete changes do not block reviewed selected changes',()=>{
  const proposal={changes:[change(),change({id:OTHER,selected:false,text:'',project_id:null,kind:'project_state',brief_revision:null})]};
  assert.equal(inbox.validateProposal(proposal,options),'');
});
test('grouping keeps unresolved messages last and never conflates multiple projects',()=>{
  const projects=[...options.projects,{id:OTHER,title:'Кассы',status:'active'}];
  const result=inbox.groupedItems([item({id:OTHER,created_at:'2026-09-30',proposal:{changes:[]}}),item(),item({id:PERSON,proposal:{changes:[change(),change({id:OTHER,project_id:OTHER})]}})],projects);
  assert.deepEqual(result.map(group=>group.id),[PROJECT,'_multiple','_unresolved']);
  assert.equal(result[0].title,'Витрины');
});
test('filters distinguish deferred, pending errors and completed review history',()=>{
  const rows=['ready','captured','processing','error','deferred','applied'].map(status=>item({status}));
  assert.deepEqual(inbox.itemsForFilter(rows,'pending').map(r=>r.status),['ready','captured','processing','error']);
  assert.deepEqual(inbox.itemsForFilter(rows,'deferred').map(r=>r.status),['deferred']);
  assert.deepEqual(inbox.itemsForFilter(rows,'history').map(r=>r.status),['applied']);
});
test('apply payload is immutable and retains request identity after uncertain response',()=>{
  const session=inbox.createSession(item());
  const first=inbox.prepareSubmission(session,REQUEST,options);
  session.proposal.changes[0].text='Не должно попасть в повтор';
  const retry=inbox.prepareSubmission(session,OTHER,options);
  assert.deepEqual(retry,first);
  first.proposal.changes[0].text='Изменение копии';
  assert.equal(inbox.prepareSubmission(session,OTHER,options).proposal.changes[0].text,'Получить чертёж');
});
test('controller never writes tasks on loading or editing, applies only confirmed reviewed proposal',async()=>{
  let sent;
  const f=await selectedFixture(async(path,opt)=>{sent={path,opt};return{item:item({status:'applied',revision:3,applied_at:'2026-09-29T13:00:00Z'})};});
  assert.equal(sent,undefined);
  await click(f,'edit');input(f,'text','Получить финальный чертёж');
  assert.equal(f.controller.hasDraft(),true);
  assert.equal(sent,undefined);
  await click(f,'apply');
  assert.equal(sent.path,`/inbox/${ID}/apply`);
  assert.equal(sent.opt.body.proposal.changes[0].text,'Получить финальный чертёж');
  assert.equal(sent.opt.body.revision,2);
  assert.equal(f.controller.hasDraft(),false);
  assert.match(f.container.innerHTML,/Изменения применены/);
  f.controller.dispose();
});
test('unknown apply result freezes edits and retries exactly the same submission',async()=>{
  const bodies=[];
  const f=await selectedFixture(async(path,opt)=>{bodies.push(opt.body);if(bodies.length===1)throw Error('lost connection');return{item:item({status:'applied',revision:3})};});
  await click(f,'apply');
  assert.match(f.container.innerHTML,/Проверить сохранение/);
  input(f,'text','new text after response lost');
  await click(f,'apply');
  assert.deepEqual(bodies[0],bodies[1]);
  assert.equal(bodies[1].proposal.changes[0].text,'Получить чертёж');
  f.controller.dispose();
});
test('CAS conflict retains correction and prevents another apply until explicit reload',async()=>{
  let calls=0;
  const f=await selectedFixture(async()=>{calls++;throw Object.assign(Error('conflict'),{status:409,code:'inbox_conflict'});});
  await click(f,'edit');input(f,'text','Мои правки');await click(f,'apply');
  assert.match(f.container.innerHTML,/Мои правки/);
  assert.match(f.container.innerHTML,/Загрузить актуальную версию/);
  await click(f,'apply');
  assert.equal(calls,1);
  assert.equal(f.controller.hasDraft(),true);
  f.controller.dispose();
});
test('defer persists the edited proposal without applying it',async()=>{
  let sent;
  const f=await selectedFixture(async(path,opt)=>{sent={path,opt};return{item:item({status:'deferred',revision:3,proposal:opt.body.proposal})};});
  await click(f,'edit');input(f,'text','Уточнить чертёж');await click(f,'defer');
  assert.equal(sent.path,`/inbox/${ID}/defer`);
  assert.equal(sent.opt.body.proposal.changes[0].text,'Уточнить чертёж');
  assert.equal(f.controller.hasDraft(),false);
  assert.match(f.container.innerHTML,/Отложено/);
  f.controller.dispose();
});
test('reanalysis sends correction and replaces proposals only after confirmed server result',async()=>{
  let body;
  const f=await selectedFixture(async(path,opt)=>{assert.equal(path,`/inbox/${ID}/analyze`);body=opt.body;return{item:item({revision:4,proposal:{version:1,summary:'Срок не согласован',questions:[],changes:[change({deadline:null})]}})};});
  await click(f,'edit');input(f,'correction','Срок пока не согласован');await click(f,'analyze');
  assert.deepEqual(body,{revision:2,correction:'Срок пока не согласован'});
  assert.match(f.container.innerHTML,/Срок не согласован/);
  assert.doesNotMatch(f.container.innerHTML,/Срок: 2 окт/);
  f.controller.dispose();
});
test('refresh callback failure does not misreport a committed apply as failed',async()=>{
  const f=await selectedFixture(async()=>({item:item({status:'applied',revision:3})}),{onChanged:async()=>{throw Error('refresh unavailable');}});
  await click(f,'apply');
  assert.match(f.container.innerHTML,/Изменения применены/);
  assert.doesNotMatch(f.container.innerHTML,/Сервер не подтвердил/);
  f.controller.dispose();
});
test('project choice loads observed brief revision before allowing state apply',async()=>{
  const state=item({proposal:{version:1,changes:[change({kind:'project_state',project_id:PROJECT,brief_revision:1})]}});
  const f=fixture(async(path)=>path.startsWith('/inbox?')?{items:[state]}:path.startsWith('/projects/')?{revision:8,document:{current_state:'Текущий обзор'}}:{item:state});
  await flush();await click(f,'select',{ciId:ID});await click(f,'edit');
  input(f,'project_id',PROJECT);await flush();
  assert.match(f.container.innerHTML,/Сейчас: Текущий обзор/);
  assert.equal(f.controller.isBusy(),false);
  f.controller.dispose();
});
test('unauthorized initial load renders sign in without revealing cached message bodies',async()=>{
  const f=fixture(async()=>{throw Object.assign(Error('unauthorized'),{status:401});});
  await flush();
  assert.match(f.container.innerHTML,/Войдите, чтобы открыть входящие/);
  assert.match(f.container.innerHTML,/method="post" target="_blank" rel="noopener"/);
  assert.doesNotMatch(f.container.innerHTML,/Получить чертёж/);
  f.controller.dispose();
});
test('navigation guard retains draft when leaving is rejected and cleans listeners on disposal',async()=>{
  const f=await selectedFixture(async()=>({item:item()}));
  input(f,'text','Правки');f.view.confirm=()=>false;
  assert.equal(f.controller.canLeave(),false);
  assert.equal(f.listeners.has('beforeunload'),true);
  f.controller.dispose();
  assert.equal(f.listeners.has('beforeunload'),false);
});
test('typed correction must be analyzed or cleared before applying old proposals',()=>{
  const session=inbox.createSession(item());session.correction='Срок пока не согласован';
  assert.throws(()=>inbox.prepareSubmission(session,REQUEST,options),/Сначала повторите разбор/);
  assert.equal(session.pending,null);
});
test('apply sends only reviewed changes, preserving private baselines server-side',()=>{
  const row=item();row.proposal.context={briefs:[{project_id:PROJECT,revision:2,current_state:'Private long baseline'}]};row.proposal.time_zone='Europe/Berlin';
  const session=inbox.createSession(row);
  const body=inbox.prepareSubmission(session,REQUEST,options);
  assert.deepEqual(Object.keys(body.proposal).sort(),['changes','version']);
  session.editing=true;
  assert.match(inbox.renderDetail(session,options),/Время срока · Берлин/);
});
test('unchanged inactive project on existing task is allowed but cannot be picked for a new task',()=>{
  const proposal={changes:[change({kind:'task_update',project_id:OTHER,task_id:PERSON,task_version:3})]},baseline=structuredClone(proposal);
  assert.equal(inbox.validateProposal(proposal,options,baseline),'');
  proposal.changes[0].kind='task_create';
  assert.match(inbox.validateProposal(proposal,options,baseline),/активный проект/);
});
test('each list filter requests its own server pagination so history cannot hide older incoming messages',async()=>{
  const requests=[];
  const f=fixture(async path=>{requests.push(path);return{items:[],nextOffset:null};});
  await flush();await click(f,'filter',{ciFilter:'history'});await click(f,'filter',{ciFilter:'deferred'});await click(f,'filter',{ciFilter:'pending'});
  assert.deepEqual(requests.map(path=>new URL('https://example.test'+path).searchParams.get('status')),['pending','applied','deferred','pending']);
  f.controller.dispose();
});
test('defer of failed transcription omits nonexistent analysis instead of submitting empty proposal',async()=>{
  let body;const row=item({status:'error',proposal:{},transcript:null});
  const f=fixture(async(path,opt)=>path.startsWith('/inbox?')?{items:[row]}:path.endsWith('/defer')?(body=opt.body,{item:{...row,status:'deferred',revision:3}}):{item:row});
  await flush();await click(f,'select',{ciId:ID});await click(f,'defer');
  assert.deepEqual(body,{revision:2,request_id:REQUEST});
  f.controller.dispose();
});
