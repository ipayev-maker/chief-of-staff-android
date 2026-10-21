const test=require('node:test'),assert=require('node:assert/strict');
const id='11111111-1111-4111-8111-111111111111';
function source(body,{from='anton@example.com',to='owner@example.com',newIds=['m']}={}){
 const text=`Письмо m · 2026-10-21T10:00:00Z\nОт: ${from}\nКому: ${to}\nТема: Образец\n${body}`;
 return {id,source_text:text,created_at:'2026-10-21T10:00:00Z',source_meta:{type:'gmail',owner_email:'owner@example.com',messages:[{id:'m',email:from,date:'2026-10-21T10:00:00Z',start:0,end:text.length}],new_message_ids:newIds}};
}
const action=(evidence,extra={})=>({id,kind:'task_create',text:'Получить образец',status:'open',selected:true,evidence,source_message_id:'m',trigger_message_id:'m',mail_relation:'waiting_for_other',mail_intent:'promise',mail_responsibility_evidence:evidence,mail_trigger_evidence:evidence,...extra});
test('clear promises and requests need no optional project, contact or deadline',async()=>{
 const {mailActionDecision}=await import('../../supabase/functions/cos-notes/communication-mail-auto.mjs');
 let quote='Пришлю образец.';assert.equal(mailActionDecision(action(quote),source(quote)).mode,'automatic');
 quote='Пришлите чертёж.';assert.equal(mailActionDecision(action(quote,{mail_relation:'owner_request',mail_intent:'request'}),source(quote)).mode,'automatic');
 assert.equal(mailActionDecision(action(quote,{mail_intent:'request'}),source(quote,{from:'owner@example.com',to:'anton@example.com'})).direction,'to_me');
});
test('CC-only, quoted history, unknown responsibility and old triggers require review',async()=>{
 const {mailActionDecision}=await import('../../supabase/functions/cos-notes/communication-mail-auto.mjs');const quote='Пришлю образец.';
 for(const item of [source(quote,{to:'other@example.com'}),source('Спасибо.\n> '+quote),source(quote,{newIds:[]})])assert.equal(mailActionDecision(action(quote),item).mode,'review');
 assert.equal(mailActionDecision(action(quote,{mail_relation:'unclear'}),source(quote)).mode,'review');
 assert.equal(mailActionDecision(action(quote,{kind:'task_update'}),source(quote)).mode,'review');
});
test('proposed deadline stays a suggestion while a clear request can be automatic',async()=>{
 const {normalizeInboxProposal}=await import('../../supabase/functions/cos-notes/communication-inbox.mjs');const {mailActionDecision}=await import('../../supabase/functions/cos-notes/communication-mail-auto.mjs');
 const quote='Пришлите чертёж, желательно завтра.',item=source(quote),context={projects:[],participants:[],tasks:[],briefs:[]};
 const proposal=normalizeInboxProposal({summary:'Чертёж',changes:[{kind:'task_create',text:'Прислать чертёж',evidence:quote,source_message_id:'m',trigger_message_id:'m',trigger_evidence:quote,responsibility_evidence:quote,owner_relation:'owner_request',action_intent:'request',date_text:'завтра',date_status:'ambiguous',deadline_agreement:'proposed',agreement:'proposed'}]},{item,context});
 assert.equal(proposal.changes[0].deadline,null);assert.equal(proposal.changes[0].mail_proposed_date,'завтра');assert.equal(mailActionDecision(proposal.changes[0],item).mode,'automatic');
});
test('one bad quote preserves another grounded action and produces a review warning',async()=>{
 const {normalizeInboxProposal}=await import('../../supabase/functions/cos-notes/communication-inbox.mjs');const quote='Пришлю образец.',item=source(quote);
 const valid={kind:'task_create',text:'Получить образец',evidence:quote,source_message_id:'m',trigger_evidence:quote};
 const p=normalizeInboxProposal({summary:'Образец',changes:[valid,{...valid,evidence:'Вымышленное поручение'}]},{item,context:{projects:[],participants:[],tasks:[],briefs:[]}});
 assert.equal(p.changes.length,1);assert.match(p.questions.join(' '),/Часть предложений/);
});
test('provider failure exposes HTTP status without response body or credentials',async()=>{
 const {createInboxModel}=await import('../../supabase/functions/cos-notes/communication-inbox.mjs');
 const generate=createInboxModel({openRouterKey:'private-key',fetchImpl:async()=>new Response(JSON.stringify({error:{message:'private provider details'}}),{status:429})});
 await assert.rejects(generate({text:'test',context:{},refDate:'2026-10-21T10:00:00Z',timeZone:'Europe/Moscow'}),e=>e.code==='analysis_unavailable'&&e.provider_status===429&&!e.message.includes('private'));
});
