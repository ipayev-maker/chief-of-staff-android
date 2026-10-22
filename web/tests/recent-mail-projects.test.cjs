const test=require('node:test'),assert=require('node:assert/strict');
const recent=require('../recent-tasks.js');
const now=Date.parse('2026-10-22T18:00:00Z');
const task=(id,age,extra={})=>({id,description:id,status:'open',created_at:new Date(now-age*3600000).toISOString(),...extra});
test('recent tasks use creation time, include future deadlines, and exclude completed, deleted and review placeholders',()=>{
 const rows=[task('old',169),task('newest',1,{deadline:'2027-01-01'}),task('no-date',2),task('done',0,{status:'completed'}),task('deleted',0,{deleted_at:'now'}),task('review',0,{description:'Разобрать письмо: test'}),task('future-clock',-2),task('updated-old',200,{updated_at:new Date(now).toISOString()})];
 assert.deepEqual(recent.select(rows,{now}).map(t=>t.id),['newest','no-date']);
});
test('recent list honors the task page area/search filters without changing the original order',()=>{
 const rows=[task('first',2,{area_key:'work',project_id:'p'}),task('second',1,{area_key:'personal'})];
 assert.deepEqual(recent.select(rows,{now,area:'work',areaOf:t=>t.area_key,query:'Проект',projectName:id=>id==='p'?'Проект':''}).map(t=>t.id),['first']);assert.equal(rows[0].id,'first');
});
test('mail project matching uses subject/full names, rejects ambiguity and inactive/other-area guesses',async()=>{
 const {mailProject}=await import('../../supabase/functions/cos-notes/communication-mail-project.mjs');
 const projects=[{id:'a',title:'Интершарм',status:'active',area_key:'work'},{id:'b',title:'Интершарм ТО',status:'active',area_key:'work'},{id:'c',title:'Self Code',status:'active',area_key:'work'},{id:'d',title:'Colryut',status:'completed',area_key:'work'},{id:'e',title:'Отпуск',status:'active',area_key:'personal'}];
 const item=subject=>({source_text:'От: sender\nТема: '+subject+'\nПришлите счёт',source_meta:{type:'gmail'}});
 const value={evidence:'Пришлите счёт'};
 assert.equal(mailProject(value,item('Re: Интершарм ТО'),projects),'b');
 assert.equal(mailProject(value,item('Интершарм и Интершарм ТО'),projects),null);
 assert.equal(mailProject(value,item('Интершарм / Self Code'),projects),null);
 assert.equal(mailProject(value,item('Colryut'),projects),null);assert.equal(mailProject(value,item('Отпуск'),projects),null);
 assert.equal(mailProject(value,{...item('Self Code'),source_meta:{type:'gmail',project_id:'a'}},projects),'a');
 assert.equal(mailProject(value,{...item('Self Code'),proposal:{owner_context:{project_id:'e'}}},projects),'e');
});
test('automatic source labels require creation receipts, never just a pasted source link',async()=>{
 const {taskOrigin}=await import('../../supabase/functions/cos-notes/task-origins.mjs');
 const item={id:'i',source_meta:{type:'gmail',delivery:'review'},proposal:{analysis:{id:'analysis'}},applied_result:{changes:[{kind:'task_create',after:{id:'t'}}]}};
 assert.equal(taskOrigin({id:'other'},item,[]),null);
 assert.equal(taskOrigin({id:'t'},item,[{inbox_id:'i',kind:'apply',request_id:'manual'}]).automatic,false);
 assert.deepEqual(taskOrigin({id:'t'},item,[{inbox_id:'i',kind:'apply',request_id:'i'}]),{task_id:'t',source:'gmail',automatic:true});
 assert.equal(taskOrigin({id:'t'},item,[{inbox_id:'i',kind:'apply',request_id:'other',input_json:{confirmation:{mode:'gmail_hybrid'}}}]).automatic,true);
});
test('origin endpoint validates a bounded UUID batch and rejects unauthenticated callers',async()=>{
 const {taskOrigins}=await import('../../supabase/functions/cos-notes/task-origins.mjs');
 await assert.rejects(taskOrigins({},'bad'),e=>e.code==='invalid_request');
 const {createNotesHandler}=await import('../../supabase/functions/cos-notes/handler.mjs');
 const handler=createNotesHandler({store:{list(){throw Error('must not read')}}});
 const r=await handler(new Request('https://nikodim.vercel.app/api/notes/tasks/origins?ids=00000000-0000-4000-8000-000000000001'));
 assert.equal(r.status,401);
});
