// Independent regressions for preserving existing obligations during review.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const implementation=import('../../supabase/functions/cos-notes/communication-inbox.mjs');
const ID='a1000000-0000-4000-8000-000000000001';
const NOTE='a1000000-0000-4000-8000-000000000002';
const TASK='a1000000-0000-4000-8000-000000000003';
const CHANGE='a1000000-0000-4000-8000-000000000004';
const REQUEST='a1000000-0000-4000-8000-000000000005';
const clone=value=>structuredClone(value);

async function fixture({task={},raw={},source='Статус образца обновился',sourceMeta={},corrections=[]}={}){
  const {normalizeInboxProposal,createCommunicationInbox}=await implementation;
  const existing={id:TASK,description:'Получить образец',details:'Сохранить этот контекст',project_id:null,participant_id:null,
    status:'open',direction:'to_me',deadline:'2026-10-02',deadline_at:'2026-10-02T13:00:45.000Z',
    next_check_on:'2026-09-30',next_check_at:'2026-09-30T07:15:00.000Z',cos_version:7,deleted_at:null,...task};
  const item={id:ID,note_id:NOTE,source_text:source,source_meta:{message_date:'2026-09-29T08:00:00.000Z',...sourceMeta},
    created_at:'2026-09-29T08:00:00.000Z',status:'ready',revision:1,transcript:null};
  const context={projects:[],participants:[],tasks:[existing],briefs:[]};
  const value={kind:'task_update',task_id:TASK,text:'Проверить новый статус образца',evidence:source,project_id:null,participant_id:null,
    date_text:null,date_status:'none',...raw};
  item.proposal=normalizeInboxProposal({summary:'',questions:[],changes:[value]},{item,context,corrections,timeZone:'Europe/Berlin',uuid:()=>CHANGE});
  const calls=[];
  const store={
    page:async table=>{assert.equal(table,'cos_communication_inbox');return [clone(item)]},
    list:async()=>[],
    rpc:async(name,args)=>{calls.push({name,args:clone(args)});assert.equal(name,'cos_inbox_apply');return {item:{...clone(item),status:'applied',revision:2},result:{tasks:[],briefs:[]}}}
  };
  const service=createCommunicationInbox({store,timeZone:'Europe/Berlin'});
  return {existing,item,calls,apply:async proposal=>service.apply(ID,{revision:1,request_id:REQUEST,proposal:proposal||clone(item.proposal)})};
}

test('unrelated update preserves exact deadline timestamp and next-check timestamp',async()=>{
  const f=await fixture();await f.apply();
  const patch=f.calls[0].args.p_actions[0].patch;
  assert.equal(patch.description,'Проверить новый статус образца');
  for(const key of ['deadline','deadline_at','next_check_on','next_check_at','details','direction'])assert.equal(Object.hasOwn(patch,key),false,key);
});

test('deadline-at-only task remains valid without populating date or changing the instant',async()=>{
  const f=await fixture({task:{deadline:null,deadline_at:'2026-10-25T00:30:45.000Z'}}); // Berlin repeated 02:30.
  assert.equal(f.item.proposal.changes[0].deadline,'2026-10-25');
  assert.equal(f.item.proposal.changes[0].deadline_time,'02:30');
  await f.apply();
  const patch=f.calls[0].args.p_actions[0].patch;
  assert.equal(Object.hasOwn(patch,'deadline'),false);
  assert.equal(Object.hasOwn(patch,'deadline_at'),false);
});

test('exact duplicate becomes existing obligation without clearing timing or direction',async()=>{
  const f=await fixture({raw:{kind:'task_create',task_id:null,text:'Получить образец'}});
  const change=f.item.proposal.changes[0];
  assert.equal(change.kind,'task_update');assert.equal(change.task_id,TASK);assert.equal(change.task_version,7);
  assert.equal(change.direction,'to_me');assert.equal(change.deadline,'2026-10-02');assert.equal(change.next_check_on,'2026-09-30');
  await f.apply();assert.deepEqual(f.calls[0].args.p_actions,[]);
});

test('explicit date-only change clears old deadline time and retains independent check date',async()=>{
  const source='Образец обещали завтра';
  const f=await fixture({source,raw:{evidence:source,date_text:'завтра',date_status:'explicit'}});
  await f.apply();const patch=f.calls[0].args.p_actions[0].patch;
  assert.equal(patch.deadline,'2026-09-30');assert.equal(patch.deadline_at,null);
  assert.equal(Object.hasOwn(patch,'next_check_on'),false);assert.equal(Object.hasOwn(patch,'next_check_at'),false);
});

test('reviewed check-date change clears a stale check timestamp',async()=>{
  const f=await fixture();const edited=clone(f.item.proposal);edited.changes[0].next_check_on='2026-10-01';
  await f.apply(edited);const patch=f.calls[0].args.p_actions[0].patch;
  assert.equal(patch.next_check_on,'2026-10-01');assert.equal(patch.next_check_at,null);
  assert.equal(Object.hasOwn(patch,'deadline_at'),false);
});

test('explicit Cyrillic clock phrase becomes the configured-zone instant',async()=>{
  const source='Образец пришлют завтра в 15:20';
  const f=await fixture({source,raw:{evidence:source,date_text:'завтра в 15:20',date_status:'explicit'}});
  assert.equal(f.item.proposal.changes[0].deadline_time,'15:20');
  await f.apply();const patch=f.calls[0].args.p_actions[0].patch;
  assert.equal(patch.deadline,'2026-09-30');assert.equal(patch.deadline_at,'2026-09-30T13:20:00.000Z');
});

test('relative correction uses its own timestamp instead of original forwarded timestamp',async()=>{
  const correction='Перенесли на завтра';
  const f=await fixture({source:'Образец обсуждали',sourceMeta:{forwarded:true,original_date:'2026-09-24T08:00:00.000Z'},
    corrections:[{text:correction,created_at:'2026-09-29T09:00:00.000Z'}],raw:{evidence:correction,date_text:'завтра',date_status:'explicit'}});
  assert.equal(f.item.proposal.changes[0].deadline,'2026-09-30');
});
