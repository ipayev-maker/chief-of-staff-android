const test=require('node:test'),assert=require('node:assert/strict');
const uid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
test('latest explicit correction repairs only an exact concatenation of source blocks',async()=>{
 const {normalizeInboxProposal}=await import('../../supabase/functions/cos-notes/communication-inbox.mjs');
 const source='Счёт оплатят завтра скорее всего, платёжные дни понедельник, среда, пятница';
 const corrections=[{text:'Проект ТехноМерч - действие проверить оплату, дата 26 октября',created_at:'2026-10-22T07:28:36Z'},{text:'Проект ТехноМерч, задача проверить оплату, срок 26.10',created_at:'2026-10-22T07:29:45Z'}];
 const raw={summary:'Проверить оплату',changes:[{kind:'task_create',text:'Проверить оплату счёта',evidence:source+'\n\n'+corrections.map(c=>c.text).join('\n'),project_id:uid(1),date_text:'26.10',date_status:'explicit',date_kind:'deadline',direction:'internal'}]};
 const opts={item:{source_text:source,source_meta:{type:'text'},created_at:'2026-10-22T07:00:00Z'},context:{projects:[{id:uid(1),title:'ТехноМерч'}],participants:[],tasks:[],briefs:[]},corrections,timeZone:'Europe/Moscow',uuid:()=>uid(2)};
 const result=normalizeInboxProposal(raw,opts);assert.equal(result.changes[0].deadline,'2026-10-26');assert.equal(result.changes[0].evidence,corrections[1].text);
 assert.throws(()=>normalizeInboxProposal({...raw,changes:[{...raw.changes[0],evidence:raw.changes[0].evidence+' выдумка'}]},opts),e=>e.code==='invalid_analysis');
});
test('outgoing request creates a 3 hour check, never a promise or third-party message',async()=>{
 const {followupFor}=await import('../../supabase/functions/cos-gmail/followups.mjs');
 const change={kind:'task_create',mail_intent:'request',mail_relation:'waiting_for_other',source_message_id:'sent'};
 const item={source_meta:{owner_email:'me@example.com',new_message_ids:['sent'],messages:[{id:'sent',email:'me@example.com',to_emails:['anton@example.com'],date:'2026-10-22T09:00:00Z'}]}};
 assert.equal(followupFor(change,item).check_at,'2026-10-22T12:00:00.000Z');assert.equal(followupFor({...change,mail_intent:'promise'},item),null);
 item.source_meta.messages.push({id:'reply',email:'anton@example.com',date:'2026-10-22T10:00:00Z'});assert.equal(followupFor(change,item),null);
});
test('auto replies do not count as human replies',async()=>{const {replyMetadata}=await import('../../supabase/functions/cos-gmail/followups.mjs');const result=replyMetadata([{id:'a',internalDate:'1792659600000',payload:{headers:[{name:'From',value:'anton@example.com'},{name:'Auto-Submitted',value:'auto-replied'}]}}]);assert.equal(result[0].automatic,true);});
test('check is a separate Calendar event and disappears after reply without changing deadline',async()=>{
 const {projectCalendarRecord}=await import('../calendar/projector.mjs');const row={id:uid(1),description:'Создать контрагента',status:'open',deadline:'2026-10-30',next_check_at:'2026-10-22T12:00:00Z'},options={timeZone:'Europe/Moscow'};
 const deadline=projectCalendarRecord('task',row,options),check=projectCalendarRecord('task_check',row,options);assert.notEqual(deadline.eventId,check.eventId);assert.equal(deadline.event.start.date,'2026-10-30');assert.equal(check.event.start.dateTime,'2026-10-22T12:00:00.000Z');assert.deepEqual(check.event.reminders,{useDefault:false,overrides:[{method:'popup',minutes:0}]});assert.equal(projectCalendarRecord('task_check',{...row,next_check_at:null},options).kind,'absent');
});
test('archived participants remain in old records but are absent from picker groups',()=>{const {groups}=require('../participants.js');assert.deepEqual(groups([{id:uid(1),name:'Антон',archived_at:'2026-10-22'}],[{participant_id:uid(1),project_id:uid(2)}],uid(2)),[])});
test('rich note serializes text and stable image IDs without signed URLs or sender HTML',()=>{const e=require('../note-editor.js'),doc=e.documentFor({version:1,blocks:[{type:'text',text:'До картинки'},{type:'image',asset_id:uid(1)},{type:'text',text:'После картинки'}]});assert.equal(e.plainText(doc),'До картинки\nПосле картинки');assert.deepEqual(e.imageIds(doc),[uid(1)]);});
test('existing Google grant can authenticate without forcing another consent screen',async()=>{const {createGoogle}=await import('../../supabase/functions/cos-google-calendar/google.mjs');const google=createGoogle({config:{clientId:'test',clientSecret:'test',allowedEmail:'owner@example.com'}});const url=new URL(await google.authorizationUrl({state:'s'.repeat(40),verifier:'v'.repeat(64),consent:false}));assert.equal(url.searchParams.has('prompt'),false);assert.equal(url.searchParams.get('access_type'),'offline');assert.equal(url.searchParams.get('code_challenge_method'),'S256');});
test('media upload uses only server-chosen session-protected paths and rejects executable image formats',async()=>{
 const {createNoteMedia}=await import('../../supabase/functions/cos-notes/media.mjs');const calls=[];const store={page:async()=>[{id:uid(1),archived_at:null}],insert:async(t,r)=>r};const media=createNoteMedia({store,url:'https://storage.example.com',serviceKey:'private',uuid:()=>uid(2),fetchImpl:async(url,options)=>{calls.push({url:String(url),options});return new Response(JSON.stringify({url:'/object/upload/sign/cos-note-media/'+uid(1)+'/'+uid(2)+'?token=synthetic'}),{status:200});}});
 await assert.rejects(media.prepare(uid(1),{name:'x.svg',mime_type:'image/svg+xml',size_bytes:10}),e=>e.code==='invalid_media');
 const result=await media.prepare(uid(1),{name:'paste.png',mime_type:'image/png',size_bytes:10});assert.equal(result.asset.note_id,uid(1));assert.equal(result.asset.pending,true);assert.equal(result.asset.storage_path,uid(1)+'/'+uid(2));assert.equal(result.upload_url,'/storage/v1/object/cos-note-media/'+uid(1)+'/'+uid(2));assert.equal(calls.length,0);assert.ok(!JSON.stringify(result).includes('private'));
});
