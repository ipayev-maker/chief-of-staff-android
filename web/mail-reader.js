(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.CoSMailReader=api;})(typeof window!=='undefined'?window:null,function(){
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clone=v=>JSON.parse(JSON.stringify(v));
  const date=v=>Number.isFinite(Date.parse(v))?new Date(v).toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'';
  const name=v=>String(v||'').replace(/\s*<[^>]*>/g,'').replace(/^"|"$/g,'')||'Отправитель';
  const kinds={task_create:'Задача',task_update:'Изменение задачи',meeting_create:'Встреча',project_state:'Состояние проекта',project_entry:'Запись в проекте'};
  const safeLink=value=>{try{const url=new URL(value);return ['https:','http:','mailto:'].includes(url.protocol)?url.href:null}catch{return null}};
  // Rebuild a passive document from an allowlist. Never put sender HTML in the
  // dashboard DOM. CSP + a scriptless sandbox provide independent boundaries.
  function emailDocument(message,{document,remote=false,zoom=1}={}){
    const source=document.createElement('template');source.innerHTML=message.html||'<pre>'+esc(message.text||'В письме нет текстового содержимого.')+'</pre>';
    const allowed=new Set('a abbr b blockquote br caption center code col colgroup dd del details div dl dt em font h1 h2 h3 h4 h5 h6 hr i img li ol p pre s small span strong sub summary sup table tbody td th thead tfoot tr u ul style'.split(' '));
    const drop=new Set('script iframe frame frameset object embed form input button textarea select option meta link base svg math noscript template audio video source'.split(' '));
    const attrs=new Set('align valign width height colspan rowspan cellpadding cellspacing border color bgcolor face size title alt dir lang'.split(' '));
    const inline=new Map((message.inline||[]).filter(x=>/^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(x.src)).map(x=>[x.cid,x.src]));
    let blockedImages=0;
    const walk=node=>{
      if(node.nodeType===3)return esc(node.nodeValue);
      if(node.nodeType!==1)return '';
      const tag=node.localName.toLowerCase();if(drop.has(tag))return '';
      if(!allowed.has(tag))return [...node.childNodes].map(walk).join('');
      if(tag==='style')return '<style>'+node.textContent.replace(/@import[^;]+;?/gi,'').replace(/url\s*\([^)]*\)/gi,'none').replace(/<\/style/gi,'')+'</style>';
      const out=[];
      for(const a of node.attributes){const key=a.name.toLowerCase();if(attrs.has(key))out.push(key+'="'+esc(a.value)+'"');
        if(key==='style')out.push('style="'+esc(a.value.replace(/url\s*\([^)]*\)/gi,'none').replace(/(?:expression|behavior|-moz-binding)\s*[:(][^;]*/gi,''))+'"');}
      if(tag==='a'){const href=safeLink(node.getAttribute('href'));if(href)out.push('href="'+esc(href)+'" target="_blank" rel="noopener noreferrer"');}
      if(tag==='img'){
        const src=node.getAttribute('src')||'';let resolved=src.startsWith('cid:')?inline.get(src.slice(4)):null;
        if(!resolved&&remote&&/^https:\/\//i.test(src)){try{const u=new URL(src);if(!u.username&&!u.password)resolved=u.href;}catch{}}
        if(resolved)out.push('src="'+esc(resolved)+'" referrerpolicy="no-referrer"');
        else{blockedImages++;return '<span class="mail-image-placeholder">'+esc(node.getAttribute('alt')||'Изображение')+'</span>';}
      }
      return '<'+tag+(out.length?' '+out.join(' '):'')+'>'+[...node.childNodes].map(walk).join('')+(['img','br','hr','col'].includes(tag)?'':'</'+tag+'>');
    };
    const body=[...source.content.childNodes].map(walk).join('');
    const csp="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:"+(remote?' https:':'')+"; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
    return {blockedImages,html:'<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="'+esc(csp)+'"><style>html{background:#fff}body{margin:0;padding:4px;color:#202c3e;font:17px/1.65 Arial,sans-serif;overflow-wrap:anywhere;zoom:'+Math.max(1,Math.min(1.4,zoom))+'}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap;font:inherit}a{color:#315f9f}.mail-image-placeholder{display:inline-block;font:13px Arial;color:#778397;padding:4px;border:1px solid #e4e8ef}blockquote{margin-left:12px;padding-left:16px;border-left:2px solid #dee5ef}</style></head><body>'+body+'</body></html>'};
  }
  function recordsForMessage(records,id){return (records||[]).filter(r=>(r.source_meta?.messages||[]).some(m=>m.id===id));}
  function proposalsForMessage(records,id){return recordsForMessage(records,id).flatMap(r=>{
    if(r.source_meta?.delivery==='tasks')return [];
    return (r.proposal?.changes||[]).filter(c=>!c.source_message_id||c.source_message_id===id||c.trigger_message_id===id).map(c=>({record:r,change:c}));
  });}
  function mount(container,options){
    const doc=container.ownerDocument,view=doc.defaultView;
    const state={rows:[],nextOffset:null,selected:options.selectedId||null,message:null,thread:null,body:null,loading:true,error:'',bodyError:'',auth:false,query:'',filter:'all',remote:false,zoom:1,busy:false,editing:null,draft:null,actionError:'',requests:new Map()};
    let disposed=false,sequence=0,bodySequence=0,observer=null;
    const request=options.mailRequest,notes=options.notesRequest;
    const canLeave=()=>!state.busy&&(!state.draft||view.confirm('Есть правки предложения. Перейти без сохранения?'));
    const gmailLink=()=>`https://mail.google.com/mail/?authuser=${encodeURIComponent(state.thread?.owner_email||'')}#all/${encodeURIComponent(state.message||state.selected||'')}`;
    function listHTML(){
      const rows=state.rows.filter(r=>(state.filter!=='review'||r.needs_review>0)&&(!state.query||[r.subject,r.from,r.summary].join(' ').toLowerCase().includes(state.query.toLowerCase())));
      return rows.map(r=>`<button class="mr-letter ${state.selected===r.id?'is-selected':''}" data-letter="${esc(r.id)}" aria-pressed="${state.selected===r.id}"><span class="mr-letter-top"><b>${esc(name(r.from))}</b><time>${esc(date(r.date))}</time></span><strong>${esc(r.subject)}</strong><span class="mr-snippet">${esc(r.summary||'Открыть письмо')}</span>${r.needs_review?`<span class="mr-review-count">${r.needs_review} к решению</span>`:''}</button>`).join('')||`<p class="mr-empty">${state.loading?'Загружаю письма…':state.query?'По запросу ничего не найдено.':'Писем пока нет. Проверьте настройки импорта Gmail.'}</p>`;
    }
    function editorHTML(c){
      const field=(label,key,type='text')=>`<label>${label}<input data-edit="${key}" type="${type}" value="${esc(c[key]||'')}" ${type==='number'?'min="1" max="1440"':''}></label>`;
      const select=(label,key,rows)=>`<label>${label}<select data-edit="${key}">${rows.map(([id,title])=>`<option value="${esc(id)}" ${String(c[key]||'')===id?'selected':''}>${esc(title)}</option>`).join('')}</select></label>`;
      return `<div class="mr-editor"><label>Действие<textarea data-edit="text" maxlength="2000" rows="3">${esc(c.text)}</textarea></label><div class="mr-fields">${!c.kind.startsWith('project_')?select('Проект','project_id',[['','Без проекта'],...(options.projects||[]).filter(p=>p.status==='active').map(p=>[p.id,p.title])]):''}${select('Участник','participant_id',[['','Не указан'],...(options.participants||[]).filter(p=>!p.deleted_at&&!p.archived_at).map(p=>[p.id,p.name])])}${c.kind.startsWith('task_')?select('Кто действует','direction',[['internal','Моё действие'],['from_me','Мне сделать'],['to_me','Жду от участника']])+field('Срок результата','deadline','date')+field('Время срока','deadline_time','time')+(Object.hasOwn(c,'planned_on')?field('Когда заняться','planned_on','date')+field('Время работы','planned_time','time'):''):''}${c.kind==='meeting_create'?field('Дата встречи','meeting_date','date')+field('Время встречи','meeting_time','time')+field('Длительность, минут','duration_minutes','number'):''}</div><button class="mr-text-button" data-action="person">＋ Новый участник</button></div>`;
    }
    function agentHTML(){
      if(!state.thread||!state.message)return '';
      const records=recordsForMessage(state.thread.records,state.message),parent=records.find(r=>!r.source_meta?.review_parent_id),proposals=proposalsForMessage(state.thread.records,state.message);
      const billing=records.some(r=>r.proposal?.analysis?.provider_status===402),failed=records.some(r=>r.status==='error'||r.proposal?.analysis?.technical_failure);
      const created=records.filter(r=>r.status==='applied').flatMap(r=>(r.applied_result?.tasks||[]).map(t=>t.description));
      const summary=parent?.proposal?.summary||'';
      return `<section class="mr-agent" aria-labelledby="mrAgentHeading"><header><span class="mr-agent-symbol">✦</span><div><h2 id="mrAgentHeading">Никодим · разбор письма</h2><p>Предложения появятся в задачах после подтверждения</p></div></header>${summary?`<p class="mr-summary">${esc(summary)}</p>`:''}${billing?'<p class="mr-notice">Разбор приостановлен: OpenRouter отклонил запрос из-за оплаты или лимита. Письмо доступно для чтения.</p>':failed?'<p class="mr-notice">Агент не смог завершить разбор. Можно повторить попытку.</p>':''}${!records.length?'<p class="mr-muted">Это письмо ещё не разобрано. Оно попадёт в обработку при ближайшей синхронизации.</p>':''}${parent&&['captured','processing'].includes(parent.status)?'<p class="mr-muted">Ожидает разбора агентом.</p>':''}${created.length?`<details class="mr-created"><summary>Ранее созданные задачи · ${created.length}</summary><ul>${[...new Set(created)].map(t=>'<li>'+esc(t)+'</li>').join('')}</ul></details>`:''}${proposals.map(({record:r,change:c})=>{
        const applied=r.status==='applied',ignored=r.status==='deferred',edit=state.editing===c.id;
        const info=[c.project_title,c.participant_name,c.deadline?'Срок: '+c.deadline:'',c.meeting_date?[c.meeting_date,c.meeting_time].filter(Boolean).join(' '):'',c.mail_proposed_date?'Предлагаемый срок: '+c.mail_proposed_date:''].filter(Boolean).join(' · ');
        return `<article class="mr-proposal ${ignored?'is-ignored':''}" data-record="${esc(r.id)}" data-change="${esc(c.id)}"><span class="mr-kind">${esc(kinds[c.kind]||'Действие')}${applied?' · принято':ignored?' · отклонено':''}</span>${edit?editorHTML(state.draft):`<h3>${esc(c.text)}</h3>${info?`<p class="mr-muted">${esc(info)}</p>`:''}`}${c.mail_review_reason&&!applied&&!ignored?`<p class="mr-muted">${esc(c.mail_review_reason)}</p>`:''}${c.evidence?`<details class="mr-evidence"><summary>На чём основано</summary><blockquote>${esc(c.evidence)}</blockquote></details>`:''}${!applied?`<div class="mr-actions">${ignored?'<button class="btn" data-action="resume">Вернуть</button>':`<button class="btn primary" data-action="apply">${edit?'Сохранить и принять':'Принять'}</button><button class="btn" data-action="${edit?'cancel-edit':'edit'}">${edit?'Отменить правки':'Исправить'}</button><button class="mr-text-button" data-action="defer">Отклонить</button>`}</div>`:''}</article>`;
      }).join('')}${state.actionError?`<p class="error" role="alert">${esc(state.actionError)}</p>`:''}${parent&&['captured','error','ready'].includes(parent.status)&&!proposals.length?`<button class="btn" ${parent.status==='ready'?'data-prepare':'data-analyze'}="${esc(parent.id)}" ${state.busy?'disabled':''}>${parent.status==='ready'?'Показать предложения':failed?'Повторить разбор':'Разобрать письмо'}</button>`:''}${parent?.status==='applied'&&!proposals.length&&!created.length&&!failed?'<p class="mr-muted">Действий, требующих решения, не найдено.</p>':''}</section>`;
    }
    function drawReader(){
      observer?.disconnect();const reader=container.querySelector('.mr-reader');if(!reader)return;
      if(!state.thread){reader.innerHTML=`<div class="mr-reader-empty"><span>✉</span><h2>${state.selected?'Открываю письмо…':'Выберите письмо'}</h2><p>Письмо целиком и предложения Никодима — здесь.</p></div>`;return;}
      const meta=state.thread.messages.find(m=>m.id===state.message),body=state.body;
      reader.innerHTML=`<div class="mr-reading-bar"><button class="mr-back" data-action="back">← Письма</button><a href="${esc(gmailLink())}" target="_blank" rel="noopener noreferrer">Открыть в Gmail ↗</a><button class="mr-text-button" data-action="zoom" aria-label="Увеличить текст">Аа ${Math.round(state.zoom*100)}%</button></div><article class="mr-message"><h1>${esc(meta?.subject||state.thread.subject)}</h1><div class="mr-envelope"><span class="mr-avatar">${esc(name(meta?.from).slice(0,1).toUpperCase())}</span><div><b>${esc(name(meta?.from))}</b><details><summary>Кому и когда</summary><p>От: ${esc(meta?.from)}<br>Кому: ${esc(meta?.to)}<br>${esc(date(meta?.date))}</p></details></div></div>${state.thread.messages.length>1?`<label class="mr-conversation">В переписке ${state.thread.messages.length} писем<select aria-label="Письмо в переписке" data-message>${[...state.thread.messages].reverse().map(m=>`<option value="${esc(m.id)}" ${m.id===state.message?'selected':''}>${esc(date(m.date)+' · '+name(m.from))}</option>`).join('')}</select></label>`:''}${state.bodyError?`<p class="error">${esc(state.bodyError)} <button class="btn" data-action="retry-body">Повторить</button></p>`:!body?'<p class="mr-muted">Загружаю оригинал…</p>':'<div class="mr-email-body"></div>'}${body?.attachments?.length?`<div class="mr-attachments"><span>Вложения</span>${body.attachments.map(a=>`<a href="${esc(gmailLink())}" target="_blank" rel="noopener noreferrer">▧ ${esc(a.name)} ↗</a>`).join('')}<small>Открываются в Gmail</small></div>`:''}</article><div class="mr-agent-slot">${agentHTML()}</div>`;
      if(body){
        const rendered=emailDocument(body,{document:doc,remote:state.remote,zoom:state.zoom}),host=reader.querySelector('.mr-email-body');
        if(rendered.blockedImages&&!state.remote||body.omittedImages){const button=doc.createElement('button');button.className='mr-images';button.textContent=body.omittedImages?'Некоторые изображения доступны в Gmail':'Показать внешние изображения';button.dataset.action=body.omittedImages?'original':'images';host.append(button);}
        const frame=doc.createElement('iframe');frame.title='Содержимое письма';frame.className='mr-email-frame';frame.setAttribute('sandbox','allow-same-origin allow-popups allow-popups-to-escape-sandbox');frame.referrerPolicy='no-referrer';
        frame.onload=()=>{if(disposed||!frame.isConnected)return;try{const resize=()=>{frame.style.height=Math.max(80,frame.contentDocument.documentElement.scrollHeight,frame.contentDocument.body.scrollHeight)+'px';};resize();observer=new view.ResizeObserver(resize);observer.observe(frame.contentDocument.body);}catch{frame.style.height='70vh';}};
        frame.srcdoc=rendered.html;host.append(frame);
      }
      reader.querySelectorAll('.mr-proposal button').forEach(b=>b.disabled=state.busy);
    }
    function draw(){
      if(disposed)return;
      container.innerHTML=`<section class="mail-workspace ${state.selected?'has-selection':''}"><header class="mr-header"><div><h1>Почта</h1><p>Рабочая переписка · последние 7 дней</p></div><div><button class="btn" data-action="refresh" ${state.loading||state.busy?'disabled':''}>Обновить</button><button class="mr-text-button" data-action="settings">Настройки</button></div></header>${state.error?`<p class="mr-alert" role="alert">${esc(state.error)}${state.auth?'<button class="btn" data-action="login">Войти через Google</button>':''}</p>`:''}<div class="mr-workspace"><aside class="mr-list-pane" aria-label="Письма"><div class="mr-list-tools"><input type="search" data-search placeholder="Поиск по письмам" aria-label="Поиск по письмам" value="${esc(state.query)}"><div class="mr-filters"><button data-filter="all" class="${state.filter==='all'?'active':''}">Все письма</button><button data-filter="review" class="${state.filter==='review'?'active':''}">К решению</button></div></div><div class="mr-letters">${listHTML()}</div>${state.nextOffset!==null?'<button class="mr-more" data-action="more">Загрузить ещё</button>':''}</aside><div class="mr-reader" tabindex="-1"></div></div></section>`;
      drawReader();
    }
    async function load(append=false){
      state.loading=true;state.error='';state.auth=false;draw();
      try{const data=await request('letters?offset='+(append?state.nextOffset||0:0));if(disposed)return;state.rows=append?[...new Map([...state.rows,...data.items].map(r=>[r.id,r])).values()]:data.items;state.nextOffset=data.nextOffset;}
      catch(e){if(disposed)return;state.error=e.message;state.auth=e.status===401;}
      finally{if(!disposed){state.loading=false;draw();}}
      if(!disposed&&!state.thread&&(state.selected||view.matchMedia('(min-width: 901px)').matches&&state.rows[0]?.id))await select(state.selected||state.rows[0].id,false);
    }
    async function showMessage(id){
      const n=++bodySequence;state.message=id;state.body=null;state.bodyError='';state.remote=false;drawReader();
      try{const data=await request('message?thread='+encodeURIComponent(state.selected)+'&id='+encodeURIComponent(id));if(disposed||n!==bodySequence)return;state.body=data;}
      catch(e){if(disposed||n!==bodySequence)return;state.bodyError=e.message;}
      if(!disposed&&n===bodySequence)drawReader();
    }
    async function select(id,notify=true){
      if(disposed||!canLeave())return false;const n=++sequence;bodySequence++;state.selected=id;state.thread=null;state.body=null;state.draft=null;state.editing=null;state.actionError='';draw();if(notify)options.onSelect?.(id);
      if(!id)return true;
      try{const data=await request('thread?id='+encodeURIComponent(id));if(disposed||n!==sequence)return false;state.thread=data;await showMessage(data.messages.at(-1)?.id);}
      catch(e){if(disposed||n!==sequence)return false;state.error=e.message;state.auth=e.status===401;draw();}return true;
    }
    async function reloadThread(){const id=state.selected;const data=await request('thread?id='+encodeURIComponent(id));if(disposed||state.selected!==id)return;state.thread=data;drawReader();}
    async function act(action,article){
      if(state.busy||!article)return;
      const record=state.thread.records.find(r=>r.id===article.dataset.record),change=record?.proposal?.changes?.find(c=>c.id===article.dataset.change);if(!change)return;
      if(action==='edit'){state.editing=change.id;state.draft=clone(change);state.actionError='';drawReader();return;}
      if(action==='cancel-edit'){state.editing=null;state.draft=null;drawReader();return;}
      if(action==='person'){options.onNewParticipant?.(person=>{if(state.draft){state.draft.participant_id=person.id;drawReader();}});return;}
      let pending=state.requests.get(record.id);if(pending&&pending.action!==action){state.actionError='Повторите предыдущую операцию: ответ сервера пока не подтверждён.';drawReader();return;}
      if(!pending){
        const edited=state.editing===change.id?clone(state.draft):clone(change);edited.selected=true;
        if(action==='apply'&&(!edited.text.trim()||edited.kind==='meeting_create'&&(!edited.meeting_date||!edited.meeting_time))){state.actionError='Укажите действие, а для встречи — дату и время.';state.editing=change.id;state.draft=edited;drawReader();return;}
        if(action==='apply'&&record.proposal.changes.length!==1){state.actionError='Сначала завершите разбор письма, чтобы принимать предложения отдельно.';drawReader();return;}
        pending={action,body:{revision:record.revision,request_id:view.crypto.randomUUID(),...(action==='apply'?{proposal:{version:1,changes:[edited]}}:{})}};state.requests.set(record.id,pending);
      }
      state.busy=true;state.actionError='';drawReader();
      try{const result=await notes('/inbox/'+record.id+'/'+action,{method:'POST',body:pending.body});if(result.item?.id!==record.id)throw Error('Сервер не подтвердил действие. Повторите попытку.');state.requests.delete(record.id);Object.assign(record,result.item);state.editing=null;state.draft=null;const row=state.rows.find(r=>r.id===state.selected);if(row)row.needs_review=Math.max(0,(row.needs_review||0)+(action==='resume'?1:-1));container.querySelector('.mr-letters').innerHTML=listHTML();await options.onChanged?.(result);}
      catch(e){state.actionError=e.message;if([400,401,404,409,422].includes(e.status)){state.requests.delete(record.id);if(e.status===409)state.actionError='Предложение уже изменилось. Нажмите «Обновить» и проверьте актуальную версию.';}}
      finally{state.busy=false;if(!disposed)drawReader();}
    }
    container.addEventListener('input',input);
    function input(event){const t=event.target;if(t.matches('[data-search]')){state.query=t.value;container.querySelector('.mr-letters').innerHTML=listHTML();}if(t.dataset.edit&&state.draft){state.draft[t.dataset.edit]=t.type==='number'?Number(t.value):t.value||(['project_id','participant_id','deadline','deadline_time','planned_on','planned_time','meeting_date','meeting_time'].includes(t.dataset.edit)?null:'');}}
    async function click(event){
      const b=event.target.closest('button,a');if(!b||!container.contains(b))return;
      if(b.dataset.letter){await select(b.dataset.letter);return;}
      if(b.dataset.filter){state.filter=b.dataset.filter;draw();return;}
      const action=b.dataset.action;
      if(b.closest('.mr-proposal')){event.preventDefault();await act(action,b.closest('.mr-proposal'));return;}
      if(b.dataset.analyze||b.dataset.prepare){
        if(state.busy)return;const record=state.thread.records.find(r=>r.id===(b.dataset.analyze||b.dataset.prepare));if(!record)return;state.busy=true;state.actionError='';drawReader();
        try{const result=b.dataset.prepare?{item:record}:await notes('/inbox/'+record.id+'/analyze',{method:'POST',body:{revision:record.revision}});if(result.item?.status==='ready'&&record.source_meta?.delivery==='tasks')await notes('/inbox/'+record.id+'/deliverMail',{method:'POST',body:{}});await reloadThread();}
        catch(e){state.actionError=e.message;}finally{state.busy=false;if(!disposed)drawReader();}return;
      }
      if(action==='refresh'){if(!canLeave())return;state.draft=null;state.editing=null;await load();if(state.selected)await select(state.selected,false);return;}
      if(action==='more'){await load(true);return;}
      if(action==='settings'){options.onSettings?.();return;}
      if(action==='login'){options.onLogin?.();return;}
      if(action==='back'){await select(null);return;}
      if(action==='images'){state.remote=true;drawReader();return;}
      if(action==='original'){view.open(gmailLink(),'_blank','noopener,noreferrer');return;}
      if(action==='zoom'){state.zoom=state.zoom>=1.4?1:Math.round((state.zoom+.2)*10)/10;drawReader();return;}
      if(action==='retry-body')await showMessage(state.message);
    }
    async function change(event){if(event.target.matches('[data-message]')){if(!canLeave()){event.target.value=state.message;return;}state.editing=null;state.draft=null;await showMessage(event.target.value);}}
    function unload(e){if(state.draft||state.requests.size){e.preventDefault();e.returnValue='';}}
    container.addEventListener('click',click);container.addEventListener('change',change);view.addEventListener('beforeunload',unload);
    draw();void load();
    return {select,canLeave,hasDraft:()=>!!state.draft||state.busy,dispose(){disposed=true;sequence++;bodySequence++;observer?.disconnect();container.removeEventListener('click',click);container.removeEventListener('input',input);container.removeEventListener('change',change);view.removeEventListener('beforeunload',unload);}};
  }
  return {mount,emailDocument,recordsForMessage,proposalsForMessage,safeLink};
});
