import {inScope,searchQuery,selectMessages,snapshot,validId} from './mail.mjs';
const eq=(k,v)=>k+'=eq.'+encodeURIComponent(v);
const THREADS='cos_gmail_threads',CONNECTION='cos_gmail_connection';
export async function discover({store,mail,connection,now=()=>new Date()}){
  const config=connection.settings;
  let cursor=connection.cursor||{},queued=0;
  const known=new Map();
  const enqueue=async id=>{
    if(!validId(id))return;
    const old=known.get(id)||(await store.page(THREADS,'select=thread_id,pending&'+eq('thread_id',id)+'&limit=1'))[0];
    if(old){if(!old.pending)await store.patch(THREADS,eq('thread_id',id),{pending:true});}
    else{
      await store.insert(THREADS,{thread_id:id,pending:true,context_days:config.context_days||7});
      known.set(id,{thread_id:id,pending:true});
    }
    queued++;
  };
  if(cursor.mode==='candidates'){
    const remaining=[...cursor.pending_ids];
    for(const id of remaining.slice(0,20)){
      let metadata;try{metadata=await mail.thread(id)}catch(error){if(error.status!==404)throw error;}
      if(metadata&&inScope(metadata.messages||[],config))await enqueue(id);
      remaining.shift();
      cursor=remaining.length?{...cursor,pending_ids:remaining}:cursor.next_cursor;
      await store.patch(CONNECTION,'id=eq.owner',{cursor});
    }
    return {queued,cursor};
  }
  if(cursor.mode==='history'&&cursor.history_id){
    let result;
    try{result=await mail.get('history',{startHistoryId:cursor.history_id,maxResults:'50',...(cursor.page_token?{pageToken:cursor.page_token}:{})})}
    catch(error){if(error.status!==404)throw error;cursor={};}
    if(result){
      const ids=new Set();
      for(const entry of result.history||[])for(const field of ['messagesAdded','labelsAdded','labelsRemoved','messagesDeleted'])for(const v of entry[field]||[])if(v.message?.threadId)ids.add(v.message.threadId);
      // Candidate IDs (no bodies) are durable before the history cursor moves.
      // Filter their headers in later bounded batches; unrelated mail cannot
      // occupy the import queue or cause selected mail to be skipped.
      const next=result.nextPageToken?{...cursor,page_token:result.nextPageToken}:{mode:'history',history_id:result.historyId||cursor.history_id};
      cursor=ids.size?{mode:'candidates',pending_ids:[...ids].filter(validId),next_cursor:next}:next;
      await store.patch(CONNECTION,'id=eq.owner',{cursor});return {queued,cursor};
    }
  }
  if(cursor.mode!=='initial'){
    const profile=await mail.profile();
    if(!profile.historyId)throw Error('invalid_gmail_response');
    cursor={mode:'initial',history_id:profile.historyId,filter:0,page_token:null,started_at:now().toISOString()};
  }
  const filters=[...config.label_ids.map(id=>({labelIds:id})),...(config.emails.length?[{q:'{'+config.emails.flatMap(a=>['from:'+a,'to:'+a,'cc:'+a]).join(' ')+'}'}]:[])];
  if(!filters.length)throw Error('scope_required');
  const filter=filters[cursor.filter]||filters[0],base=searchQuery(config,new Date(cursor.started_at));
  const result=await mail.get('threads',{...filter,q:base+(filter.q?' '+filter.q:''),maxResults:'20',includeSpamTrash:'false',...(cursor.page_token?{pageToken:cursor.page_token}:{})});
  for(const row of result.threads||[])await enqueue(row.id);
  cursor=result.nextPageToken?{...cursor,page_token:result.nextPageToken}:cursor.filter+1<filters.length?{...cursor,filter:cursor.filter+1,page_token:null}:{mode:'history',history_id:cursor.history_id};
  await store.patch(CONNECTION,'id=eq.owner',{cursor});return {queued,cursor};
}
export async function importThread({store,mail,connection,thread,now=()=>new Date()}){
  let metadata;try{metadata=await mail.thread(thread.thread_id)}catch(error){if(error.status!==404)throw error;await store.patch(THREADS,eq('thread_id',thread.thread_id),{pending:false,last_error:'thread_unavailable'});return {imported:false};}
  const messages=metadata.messages||[];
  // Re-evaluate the scope even for an already-known thread. Removing a label or
  // changing the settings stops content ingestion at the next fetch.
  if(!inScope(messages,connection.settings)){
    await store.patch(THREADS,eq('thread_id',thread.thread_id),{pending:false,last_error:null});return {imported:false};
  }
  const automatic=connection.settings.auto_tasks===true;
  const contextDays=automatic?7:thread.context_days,limit=thread.message_limit||10;
  // A pending review is immutable until reviewed. Leave new mail queued, so
  // a background refresh never wipes the owner's editor or saved corrections.
  let previousReadIds=[];
  if(thread.inbox_id){
    const item=(await store.page('cos_communication_inbox','select=status,note_id,source_meta&'+eq('id',thread.inbox_id)+'&limit=1'))[0];
    if(item&&item.status!=='applied')return {imported:false,waiting:true};
    previousReadIds=item?.source_meta?.messages?.map(m=>m.id)||thread.message_ids||[];
  }
  const processedIds=[...new Set([...(thread.processed_ids||[]),...previousReadIds])];
  let selection=selectMessages(messages,{now:now(),contextDays,limit}),backlog=false;
  if(automatic){
    // Read only the last seven days. Batches progress oldest-first; all retained
    // IDs are durable. A long thread must not silently discard its oldest work.
    const eligible=messages.filter(m=>selectMessages([m],{now:now(),contextDays:7,limit:10}).selected.length)
      .sort((a,b)=>Number(a.internalDate)-Number(b.internalDate)||a.id.localeCompare(b.id));
    const unread=eligible.filter(m=>!processedIds.includes(m.id));
    const fresh=unread.slice(0,3),context=eligible.filter(m=>processedIds.includes(m.id)&&Number(m.internalDate)<=Number(fresh[0]?.internalDate)).slice(-2);
    selection={selected:[...context,...fresh],eligible:eligible.length,total:messages.length,omitted:messages.length-context.length-fresh.length};
    backlog=unread.length>fresh.length;
    if(!fresh.length)selection.selected=[];
  }
  const ids=selection.selected.map(m=>m.id);
  if(!ids.length||JSON.stringify(ids)===JSON.stringify(thread.message_ids||[])){
    await store.patch(THREADS,eq('thread_id',thread.thread_id),{pending:false,last_error:null,history_id:metadata.historyId||null});return {imported:false};
  }
  const bodies=[];
  for(let i=0;i<selection.selected.length;i+=3){
    const batch=await Promise.all(selection.selected.slice(i,i+3).map(m=>mail.message(m.id)));
    for(const body of batch){if(!ids.includes(body.id)||body.threadId!==thread.thread_id)throw Error('invalid_gmail_response');bodies.push(body);}
  }
  bodies.sort((a,b)=>Number(a.internalDate)-Number(b.internalDate)||a.id.localeCompare(b.id));
  const captured=snapshot(bodies,{threadId:thread.thread_id,selection,ownerEmail:connection.email,processedIds,contextDays,limit,projectId:thread.project_id});
  if(automatic)captured.meta.delivery='tasks';
  if(!captured.meta.messages.length)throw Error('mail_too_large');
  const result=await store.rpc('cos_gmail_capture',{p_thread_id:thread.thread_id,p_text:captured.source,p_meta:captured.meta,p_subject:captured.subject,p_message_ids:captured.meta.messages.map(m=>m.id),p_history_id:metadata.historyId||null});
  if(backlog||captured.meta.messages.length<ids.length)await store.patch(THREADS,eq('thread_id',thread.thread_id),{pending:true});
  return {imported:!result.duplicate,item:result.item};
}
export async function syncMail({store,mail,connection,now=()=>new Date(),analyze,recover,deliver}){
  if(connection?.status!=='connected'||!connection.settings?.enabled)return {ok:false,reason:'import_paused'};
  const automatic=connection.settings.auto_tasks===true;
  let delivered=0,delivery_errors=0;
  const deliverReady=async()=>{
    if(!automatic||!connection.settings.ai_consent||!deliver)return;
    const rows=await store.page('cos_communication_inbox','select=id&source_meta->>delivery=eq.tasks&status=in.(ready,error)&order=created_at.asc&limit=20');
    const results=await Promise.allSettled(rows.map(row=>deliver(row)));
    for(const result of results){if(result.status==='fulfilled'&&result.value?.item?.status==='applied')delivered++;else delivery_errors++;}
  };
  await deliverReady();
  let found={queued:0},current=connection;
  // A 15-minute tick drains metadata pages immediately, within a fixed budget.
  // IDs are committed before advancing history, including the 51st thread.
  const discoveryStarted=Date.now();
  for(let i=0;i<(automatic?8:1);i++){
    const step=await discover({store,mail,connection:current,now});found.queued+=step.queued;
    current={...current,cursor:step.cursor};
    if(step.cursor?.mode==='history'&&!step.cursor.page_token||Date.now()-discoveryStarted>15000)break;
  }
  const sourceFilter=automatic?'&source_meta->>delivery=eq.tasks':'';
  // Capture and analysis have separate durable queues. A failed model response
  // cannot block downloading other threads or lose a captured source.
  const queue=await store.page(THREADS,'pending=eq.true&order=updated_at.asc,thread_id.asc&limit=5');
  let imported=0,waiting=0,analyzed=0,analysis_errors=0,recovered=0;
  const imports=await Promise.allSettled(queue.map(async thread=>{
    try{
      const result=await importThread({store,mail,connection,thread,now});
      imported+=result.imported?1:0;waiting+=result.waiting?1:0;
      await store.patch(THREADS,eq('thread_id',thread.thread_id),{updated_at:now().toISOString(),last_error:null});
    }catch(error){
      await store.patch(THREADS,eq('thread_id',thread.thread_id),{updated_at:now().toISOString(),last_error:'thread_import_failed'});throw error;
    }
  }));
  if(connection.settings.ai_consent){
    if(recover){
      const errors=await store.page('cos_communication_inbox','select=id&source_meta->>type=eq.gmail'+sourceFilter+'&status=eq.error&error_code=eq.invalid_analysis&order=updated_at.asc&limit=5');
      const repaired=await Promise.allSettled(errors.map(item=>recover(item)));
      recovered=repaired.filter(r=>r.status==='fulfilled'&&r.value?.item?.status==='ready').length;
    }
    if(analyze){
      // One automatic retry for invalid/temporary analysis, in a later tick.
      // Never loop paid model calls indefinitely, and leave slots for new mail.
      const retry=await store.page('cos_communication_inbox','select=id,revision&source_meta->>type=eq.gmail'+sourceFilter+'&status=eq.error&error_code=in.(invalid_analysis,analysis_unavailable)&or=(proposal->analysis->>attempts.is.null,proposal->analysis->>attempts.eq.1)&order=updated_at.asc&limit=2');
      const captured=await store.page('cos_communication_inbox','select=id,revision&source_meta->>type=eq.gmail'+sourceFilter+'&status=eq.captured&order=created_at.asc&limit='+(5-retry.length));
      const results=await Promise.allSettled([...retry,...captured].map(item=>analyze(item)));
      for(const result of results){if(result.status==='fulfilled'&&result.value?.item?.status==='ready')analyzed++;else analysis_errors++;}
    }
  }
  await deliverReady();
  if(delivery_errors)throw Error('mail_delivery_failed');
  const failed=imports.find(r=>r.status==='rejected');if(failed)throw failed.reason;
  return {ok:true,queued:found.queued,imported,waiting,analyzed,analysis_errors,recovered,delivered};
}
