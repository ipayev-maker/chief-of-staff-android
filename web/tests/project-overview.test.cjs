const test=require('node:test');
const assert=require('node:assert/strict');
const brief=require('../project-brief.js');
const project={id:'p',title:'Project'};
const now='2026-10-01T10:00:00Z';
const row=(id,extra={})=>({id,project_id:'p',status:'open',...extra});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function mount(options={}){
  const container={innerHTML:'',onclick:null,contains:()=>true};
  const controller=brief.mount(container,{automatic:true,project,now,...options});
  return{container,controller,click(action,id,tab){container.onclick?.({target:{closest:()=>({dataset:{pbAction:action,pbId:id,pbTab:tab}})}})}};
}
test('overview separates work, waiting and paused records and only flags actual overdue deadlines',()=>{
  const model=brief.automaticModel({project,now,participants:[{id:'person',name:'Supplier'}],tasks:[
    row('no-date',{next_check_on:'2026-09-01'}),row('later',{deadline_at:'2026-10-03T12:00:00Z'}),
    row('late',{deadline_at:'2026-09-30T12:00:00Z'}),row('wait',{direction:'to_me',participant_id:'person'}),
    row('pause',{status:'paused',deadline:'2026-09-01'}),row('done',{status:'completed'}),row('cancel',{status:'cancelled'}),
    row('foreign',{project_id:'q'}),row('deleted',{deleted_at:now}),row('late')
  ]});
  assert.deepEqual(model.actions.map(t=>t.id),['late','later','no-date']);
  assert.deepEqual(model.overdue.map(t=>t.id),['late']);
  assert.equal(model.waiting[0].person,'Supplier');assert.deepEqual(model.paused.map(t=>t.id),['pause']);
  assert.equal(model.active.length,4);
});
test('date-only deadlines stay open until the end of their local calendar day',()=>{
  const localNow=new Date(2026,9,1,12);
  const model=brief.automaticModel({project,now:localNow,tasks:[row('today',{deadline:'2026-10-01'}),row('yesterday',{deadline:'2026-09-30'})]});
  assert.deepEqual(model.overdue.map(t=>t.id),['yesterday']);
});
test('overview displays upcoming meetings and recent live notes from both note stores',()=>{
  const model=brief.automaticModel({project,now,notes:[row('same',{kind:'project',title:'Media',created_at:'2026-09-30T09:00:00Z'}),row('same',{kind:'quick',title:'Telegram',created_at:now}),row('archive',{archived_at:now})],meetings:[
    row('future',{starts_at:'2026-10-02T12:00:00Z'}),row('past',{starts_at:'2026-09-30T12:00:00Z'}),row('cancel',{status:'cancelled',starts_at:'2026-10-02T12:00:00Z'}),row('complete',{status:'completed',starts_at:'2026-10-02T12:00:00Z'})
  ]});
  assert.deepEqual(model.recentNotes.map(n=>n.title),['Telegram','Media']);assert.deepEqual(model.upcoming.map(m=>m.id),['future']);
  const html=brief.renderAutomatic(model);
  assert.match(html,/data-pb-action="quick-note"/);assert.match(html,/data-pb-action="note"/);
  assert.doesNotMatch(html,/<textarea|<input|Уточнить проект|Заполнить|Что сейчас происходит с проектом/);
});
test('stored project information stays collapsed and escapes source text',()=>{
  const unsafe='<img src=x onerror=alert(1)>';
  const html=brief.renderAutomatic(brief.automaticModel({project,now,tasks:[row('t',{description:unsafe})]}, {document:{current_state:unsafe}}));
  assert.match(html,/<details class="po-saved"><summary>Ранее сохранённые сведения/);
  assert.ok(html.includes('&lt;img'));assert.ok(!html.includes(unsafe));assert.doesNotMatch(html,/<details[^>]*open/);
});
test('private note load preserves visible tasks on authorization failure and can retry',async()=>{
  let fail=true,reads=0;const f=mount({tasks:[row('t',{description:'Existing task'})],request:async()=>{throw Error('401')},requestNotes:async()=>{reads++;if(fail)throw Object.assign(Error('Sign in'),{status:401});return{notes:[row('n',{title:'Telegram note'})]}}});
  await tick();assert.match(f.container.innerHTML,/Existing task/);assert.match(f.container.innerHTML,/доступны после входа/);assert.doesNotMatch(f.container.innerHTML,/Записей пока нет/);
  fail=false;f.click('reload-notes');await tick();assert.equal(reads,2);assert.match(f.container.innerHTML,/Telegram note/);assert.doesNotMatch(f.container.innerHTML,/доступны после входа/);
});
test('source actions stay scoped to their note store and reject foreign records',async()=>{
  const opened=[];const f=mount({notes:[row('same',{title:'Media'})],requestNotes:async()=>({notes:[row('same',{title:'Telegram'}),row('foreign',{project_id:'q'}),row('archived',{archived_at:now})]}),onNote:id=>opened.push('media:'+id),onQuickNote:note=>opened.push('quick:'+note.title),onOpenTab:tab=>opened.push(tab)});
  await tick();f.click('note','same');f.click('quick-note','same');f.click('quick-note','foreign');f.click('quick-note','archived');f.click('tab',null,'notes');f.click('tab',null,'invalid');
  assert.deepEqual(opened,['media:same','quick:Telegram','notes']);
});
test('late private responses and clicks do not repaint a disposed project',async()=>{
  let resolve,opened=0;const pending=new Promise(r=>resolve=r);const f=mount({requestNotes:()=>pending,onCreateTask:()=>opened++});
  assert.equal(f.controller.canLeave(),true);f.controller.dispose();const before=f.container.innerHTML;resolve({notes:[row('late',{title:'Late response'})]});await tick();f.click('create-task');
  assert.equal(f.container.innerHTML,before);assert.equal(opened,0);
});
