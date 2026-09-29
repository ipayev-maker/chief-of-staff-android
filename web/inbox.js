(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) root.CoSInbox = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  const memory = new Map();
  const array = value => Array.isArray(value) ? value : [];
  const text = value => value == null ? '' : String(value);
  const clone = value => JSON.parse(JSON.stringify(value));
  const escape = value => text(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
  const kinds = {task_create:'Новая задача',task_update:'Обновление задачи',project_state:'Состояние проекта',project_entry:'Запись в обзоре проекта'};
  const statuses = {captured:'Сохранено',processing:'Разбираю',ready:'Готово к проверке',deferred:'Отложено',applied:'Разобрано',error:'Нужна повторная обработка'};
  const taskStatuses = {open:'Открыта',paused:'На паузе',completed:'Завершена',cancelled:'Отменена'};
  const editableStatuses = ['ready','deferred'];
  function validDay(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text(value)) || +value.slice(0,4) < 1) return false;
    const date = new Date(value+'T12:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value;
  }
  function dayLabel(value) {
    if (!validDay(value)) return '';
    const [year,month,day] = value.split('-');
    return `${+day} ${['янв.','февр.','мар.','апр.','мая','июн.','июл.','авг.','сент.','окт.','нояб.','дек.'][+month-1]} ${year}`;
  }
  function timeLabel(value) {
    const at = Date.parse(value);
    return Number.isFinite(at) ? new Date(at).toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : '';
  }
  const activeProjects = rows => array(rows).filter(row => row && row.id && !row.deleted_at && row.status === 'active');
  const emptyProposal = () => ({version:1,summary:'',questions:[],changes:[]});
  function normalizedProposal(value) {
    const result = value && typeof value === 'object' ? clone(value) : emptyProposal();
    result.version = 1;
    result.summary = text(result.summary);
    result.questions = array(result.questions).filter(q=>typeof q==='string');
    result.changes = array(result.changes).filter(c=>c && UUID.test(c.id) && Object.hasOwn(kinds,c.kind)).map(c=>({...c,selected:c.selected!==false,text:text(c.text),evidence:text(c.evidence)}));
    return result;
  }
  function createSession(item) {
    const proposal = normalizedProposal(item.proposal);
    const stored=proposal.context?.briefs,briefs={};
    if(Array.isArray(stored))stored.forEach(brief=>{if(brief?.project_id)briefs[brief.project_id]=brief;});
    else if(stored&&typeof stored==='object')Object.assign(briefs,stored);
    return {item:clone(item),base:clone(proposal),proposal,correction:'',editing:false,pending:null,busy:false,error:'',conflict:false,briefs,loadingProject:null};
  }
  function dirty(session) {
    return !!session && (!!session.pending || !!session.correction.trim() || JSON.stringify(session.proposal)!==JSON.stringify(session.base));
  }
  function titleFor(change) {
    if (change.kind === 'task_create' && change.direction === 'to_me') return 'Ожидание от участника';
    if (change.kind === 'project_entry') return change.entry_kind === 'question' ? 'Открытый вопрос' : 'Решение';
    return kinds[change.kind] || 'Предложение';
  }
  function validateProposal(proposal, options = {}, baseProposal = null) {
    const projects = new Set(activeProjects(options.projects).map(p=>p.id));
    const people = new Set(array(options.participants).map(p=>p.id));
    for (const change of array(proposal.changes).filter(c=>c.selected!==false)) {
      if (!change.text.trim()) return 'Добавьте текст каждого выбранного изменения.';
      if (change.text.length > 2000) return 'Сократите длинный текст изменения.';
      const original=array(baseProposal?.changes).find(c=>c.id===change.id);
      if (change.project_id && !projects.has(change.project_id) && !(change.kind==='task_update'&&original?.project_id===change.project_id)) return 'Выберите активный проект для изменения или снимите его выбор.';
      if (change.participant_id && !people.has(change.participant_id)) return 'Уточните участника изменения.';
      if (['project_state','project_entry'].includes(change.kind) && !change.project_id) return 'Выберите проект для его состояния или записи в обзоре.';
      if (['project_state','project_entry'].includes(change.kind) && (!Number.isSafeInteger(change.brief_revision) || change.brief_revision<0)) return 'Загрузите актуальное состояние выбранного проекта.';
      if (change.kind === 'task_update' && (!UUID.test(text(change.task_id)) || !Number.isSafeInteger(change.task_version))) return 'Задачу для обновления нужно уточнить повторным разбором.';
      if (change.deadline && !validDay(change.deadline)) return 'Укажите корректную дату срока.';
      if (change.next_check_on && !validDay(change.next_check_on)) return 'Укажите корректную дату проверки.';
      if (change.deadline_time && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(change.deadline_time) || !change.deadline)) return 'Время срока должно быть указано вместе с датой.';
    }
    return '';
  }
  function prepareSubmission(session, requestId, options) {
    if (session.pending) return clone(session.pending.body);
    if(session.correction.trim())throw Error('Сначала повторите разбор с вашим уточнением или очистите его. Иначе будут применены прежние предложения.');
    const error = validateProposal(session.proposal,options,session.base);
    if (error) throw Error(error);
    const proposal = {version:1,changes:clone(session.proposal.changes)};
    proposal.changes.forEach(change=>{change.text=change.text.trim();});
    const body = {revision:session.item.revision,request_id:requestId,proposal};
    session.pending = {action:'apply',body};
    return clone(body);
  }
  function itemsForFilter(items, filter) {
    return array(items).filter(item => filter==='history' ? item.status==='applied' : filter==='deferred' ? item.status==='deferred' : !['applied','deferred'].includes(item.status));
  }
  function groupedItems(items, projects) {
    const names = new Map(array(projects).map(p=>[p.id,p.title||p.name||'Проект'])), groups = new Map();
    for (const item of [...array(items)].sort((a,b)=>(Date.parse(b.created_at)||0)-(Date.parse(a.created_at)||0))) {
      const ids = [...new Set(array(item.proposal?.changes).filter(c=>c.selected!==false&&c.project_id).map(c=>c.project_id))];
      const key = ids.length===1&&names.has(ids[0]) ? ids[0] : ids.length>1 ? '_multiple' : '_unresolved';
      if (!groups.has(key)) groups.set(key,{id:key,title:key==='_multiple'?'Несколько проектов':key==='_unresolved'?'Без проекта':names.get(key),items:[]});
      groups.get(key).items.push(item);
    }
    return [...groups.values()].sort((a,b)=>(a.id==='_unresolved'?1:0)-(b.id==='_unresolved'?1:0));
  }
  function itemExcerpt(item) { return text(item.proposal?.summary || item.transcript || item.source_text || (isVoice(item)?'Голосовое сообщение':'Сообщение')).replace(/\s+/g,' ').slice(0,180); }
  function isVoice(item) { return item.source_meta?.type==='voice' || item.source_meta?.voice === true || !!item.source_meta?.voice || !!item.source_meta?.audio_path; }
  function button(label,action,attrs='',primary=false) { return `<button type="button" class="ci-button${primary?' ci-primary':''}" data-ci-action="${action}" ${attrs}>${label}</button>`; }
  function option(value,label,selected,disabled=false) { return `<option value="${escape(value)}"${value===selected?' selected':''}${disabled?' disabled':''}>${escape(label)}</option>`; }
  function field(label,html) { return `<label class="ci-field"><span>${label}</span>${html}</label>`; }
  function zoneLabel(zone) { return ({'Europe/Berlin':'Берлин','Europe/Moscow':'Москва','Etc/UTC':'UTC','UTC':'UTC'})[zone]||text(zone)||'часовой пояс проекта'; }
  function changeHTML(change,index,session,options) {
    const locked = session.busy || !!session.pending || !!session.loadingProject || session.item.status==='applied';
    const attrs = `data-ci-change="${escape(change.id)}"`;
    const disabled = locked?' disabled':'';
    const project = array(options.projects).find(p=>p.id===change.project_id);
    const person = array(options.participants).find(p=>p.id===change.participant_id);
    const target = array(options.tasks).find(t=>t.id===change.task_id);
    const isTask = change.kind==='task_create'||change.kind==='task_update';
    const editing = session.editing && session.item.status!=='applied';
    const select = (key,rows) => `<select ${attrs} data-ci-field="${key}"${disabled}>${rows}</select>`;
    const input = (key,type,value,extra='') => `<input type="${type}" ${attrs} data-ci-field="${key}" value="${escape(value)}" ${extra}${disabled}>`;
    const summary = [`${project?'Проект: '+(project.title||project.name):'Проект не выбран'}`,person?'Участник: '+person.name:'',isTask&&change.deadline?'Срок: '+dayLabel(change.deadline)+(change.deadline_time?' в '+change.deadline_time+' · '+zoneLabel(session.proposal.time_zone):''):'',isTask&&change.next_check_on?'Проверить: '+dayLabel(change.next_check_on):'',change.kind==='task_update'&&change.status?'Статус: '+(taskStatuses[change.status]||change.status):''].filter(Boolean);
    const personOptions = option('','Не указан',change.participant_id||'')+array(options.participants).filter(p=>p.id&&!p.deleted_at).sort((a,b)=>text(a.name).localeCompare(text(b.name),'ru')).map(p=>option(p.id,p.name,change.participant_id)).join('');
    const projectOptions = option('','Выберите проект',change.project_id||'')+activeProjects(options.projects).map(p=>option(p.id,p.title||p.name||'Проект',change.project_id)).join('');
    const editor = editing ? `<div class="ci-change-editor">${field('Текст',`<textarea rows="3" maxlength="2000" ${attrs} data-ci-field="text"${disabled}>${escape(change.text)}</textarea>`)}<div class="ci-fields-grid">${field('Проект',select('project_id',projectOptions))}${isTask||change.kind==='project_entry'?field('Участник',select('participant_id',personOptions)):''}${isTask?field('Кто действует',select('direction',Object.entries({internal:'Моё действие',from_me:'Обещал участнику',to_me:'Жду от участника'}).map(([id,label])=>option(id,label,change.direction||'internal')).join(''))):''}${change.kind==='task_update'?field('Статус',select('status',Object.entries(taskStatuses).map(([id,label])=>option(id,label,change.status||'open')).join(''))):''}${isTask?field('Срок',input('deadline','date',change.deadline||''))+field('Время срока · '+escape(zoneLabel(session.proposal.time_zone)),input('deadline_time','time',change.deadline_time||''))+field('Вернуться и проверить',input('next_check_on','date',change.next_check_on||'')):''}${change.kind==='project_entry'?field('Тип записи',select('entry_kind',option('decision','Решение',change.entry_kind)+option('question','Открытый вопрос',change.entry_kind))):''}</div>${isTask?'<p class="ci-hint">Срок — когда нужен результат. Проверка — когда связаться или уточнить. Обе даты необязательны.</p>':''}${session.loadingProject===change.id?'<p class="ci-hint" role="status">Загружаю состояние проекта…</p>':''}</div>` : `<p class="ci-change-text">${escape(change.text)}</p><p class="ci-change-meta">${summary.map(escape).join('<span aria-hidden="true"> · </span>')}</p>`;
    const before = session.briefs[change.project_id]?.document?.current_state || session.briefs[change.project_id]?.current_state || (change.kind==='project_state'?change.before?.text:'');
    return `<article class="ci-change${change.selected===false?' ci-unselected':''}"><div class="ci-change-head"><label class="ci-check"><input type="checkbox" ${attrs} data-ci-field="selected"${change.selected!==false?' checked':''}${disabled}><span>${escape(titleFor(change))}</span></label><span class="ci-change-number">${index+1}</span></div>${change.kind==='task_update'?`<p class="ci-target">Изменение существующей задачи: ${escape(target?.description||change.text)}</p>`:''}${change.kind==='project_state'&&before?`<p class="ci-before">Сейчас: ${escape(before)}</p>`:''}${editor}${change.evidence?`<details class="ci-evidence"><summary>Основание в сообщении</summary><blockquote>${escape(change.evidence)}</blockquote></details>`:''}</article>`;
  }
  function renderDetail(session, options = {}) {
    if (!session) return '<div class="ci-empty-detail"><span class="ci-empty-symbol" aria-hidden="true">↗</span><h2>Выберите сообщение</h2><p>Исходник и предложения будут рядом. Проверьте их и подтвердите одной кнопкой.</p></div>';
    const item = session.item, proposal=session.proposal;
    const finished = item.status==='applied';
    const busy = session.busy, locked=busy||!!session.pending;
    const changes=array(proposal.changes), selected=changes.filter(c=>c.selected!==false);
    const source=text(item.source_text), transcript=text(item.transcript);
    const sourceBody=source||(transcript?'':isVoice(item)?'Голосовое сообщение сохранено. Текст появится после распознавания.':'Исходный текст пока недоступен.');
    const processing=item.status==='processing';
    const failed=item.status==='error';
    const actionable=editableStatuses.includes(item.status)&&Array.isArray(item.proposal?.changes)&&!session.loadingProject;
    const heading=finished?'Изменения применены':processing?'Разбираю сообщение':failed?'Исходник сохранён':changes.length?'Проверить предложения':'Сообщение и контекст';
    const feedback=session.error?`<div class="ci-alert" role="alert"><p>${escape(session.error)}</p>${session.conflict?button('Загрузить актуальную версию','reload-detail')+button('Скопировать правки','copy'):''}</div>`:'';
    const audioSource=typeof options.audioSource==='function'?options.audioSource(item):`/api/notes/inbox/${encodeURIComponent(item.id)}/audio`;
    const sourceHTML=`<details class="ci-source"${!changes.length||failed?' open':''}><summary>Исходное сообщение${isVoice(item)?' · голосовое':''}</summary>${isVoice(item)?`<audio controls preload="none" src="${escape(audioSource)}" aria-label="Исходное голосовое сообщение"></audio>`:''}${sourceBody?`<p>${escape(sourceBody)}</p>`:''}${transcript&&transcript!==source?`<div class="ci-transcript"><span>Расшифровка</span><p>${escape(transcript)}</p></div>`:''}</details>`;
    const questions=array(proposal.questions).length?`<div class="ci-questions"><span>Нужно уточнить</span><ul>${proposal.questions.map(q=>`<li>${escape(q)}</li>`).join('')}</ul></div>`:'';
    const correction=!finished&&session.editing?`<div class="ci-correction">${field('Уточнение для повторного разбора',`<textarea rows="3" maxlength="4000" data-ci-field="correction" placeholder="Например: это относится к другому проекту; срок пока не согласован"${locked?' disabled':''}>${escape(session.correction)}</textarea>`)}${button('Повторить разбор','analyze',locked?'disabled':'')}<p class="ci-hint">Предложения будут составлены заново с учётом уточнения. Исходное сообщение сохранится.</p></div>`:'';
    const applyLabel=session.pending?.action==='apply'?'Проверить сохранение':selected.length===0?'Готово — оставить заметкой':selected.length===changes.length?'Применить всё':`Применить выбранное · ${selected.length}`;
    const actions=finished?`<p class="ci-done">Разобрано ${escape(timeLabel(item.applied_at||item.updated_at))}. Исходник сохранён в заметках.</p>`:`<div class="ci-action-bar">${actionable||session.pending?.action==='apply'?button(applyLabel,'apply',(busy||session.conflict||session.loadingProject||session.pending&&session.pending.action!=='apply'?'disabled ':'')+(busy?'aria-busy="true"':''),true):button(processing?'Проверить результат':failed?'Повторить обработку':'Разобрать сообщение',processing?'reload-detail':'analyze',locked?'disabled':'',true)}${button(session.editing?'Свернуть редактор':'Исправить','edit',locked?'disabled':'')}${item.status!=='deferred'?button(session.pending?.action==='defer'?'Проверить перенос':'Разобрать позже','defer',busy||!!session.pending&&session.pending.action!=='defer'?'disabled':''):''}</div><p class="ci-confirm-hint">${actionable?selected.length?'Задачи и состояние проекта изменятся после подтверждения.':'Заметка сохранится без создания задач.':processing?'Сообщение уже сохранено. Можно вернуться к нему позже.':'Задачи пока не изменены.'}</p>`;
    return `<section class="ci-review" aria-label="Разбор сообщения"><header class="ci-review-head"><div><span class="ci-eyebrow">${isVoice(item)?'Голосовое в Telegram':'Сообщение в Telegram'}${timeLabel(item.created_at)?' · '+escape(timeLabel(item.created_at)):''}</span><h2>${heading}</h2></div><span class="ci-status ci-status-${escape(item.status)}">${escape(statuses[item.status]||'Сохранено')}</span></header>${proposal.summary?`<p class="ci-summary">${escape(proposal.summary)}</p>`:''}${sourceHTML}${feedback}${failed?'<p class="ci-notice">Не удалось закончить обработку. Исходное сообщение доступно; повторите попытку или добавьте уточнение.</p>':''}${questions}${changes.length?`<div class="ci-changes">${changes.map((c,i)=>changeHTML(c,i,session,options)).join('')}</div>`:actionable?'<p class="ci-note-only">Задач и изменений проекта не предложено. Сообщение можно оставить самостоятельной заметкой.</p>':''}${correction}${actions}</section>`;
  }
  function renderInbox(state, options = {}) {
    const items=array(state.items), filtered=itemsForFilter(items,state.filter||'pending');
    const groups=groupedItems(filtered,options.projects);
    const tabs=[['pending','Входящие'],['deferred','Отложено'],['history','История']].map(([key,label])=>`<button type="button" class="ci-tab${state.filter===key?' ci-active':''}" data-ci-action="filter" data-ci-filter="${key}" aria-pressed="${state.filter===key}">${label}${state.filter===key&&!state.loading?`<span>${filtered.length}${state.nextOffset!=null?'+':''}</span>`:''}</button>`).join('');
    const list=groups.map(group=>`<section class="ci-group"><h3>${escape(group.title)}<span>${group.items.length}</span></h3><div>${group.items.map(item=>`<button type="button" class="ci-list-item${state.selectedId===item.id?' ci-selected':''}" data-ci-action="select" data-ci-id="${escape(item.id)}"${state.selectedId===item.id?' aria-current="true"':''}><span class="ci-list-top"><span>${isVoice(item)?'Голосовое':'Сообщение'}</span><time>${escape(timeLabel(item.created_at))}</time></span><span class="ci-list-title">${escape(itemExcerpt(item))}</span><span class="ci-list-bottom">${escape(statuses[item.status]||'Сохранено')}${array(item.proposal?.changes).length?` · ${array(item.proposal.changes).length} изм.`:''}</span></button>`).join('')}</div></section>`).join('');
    const auth=`<div class="ci-message"><h2>Войдите, чтобы открыть входящие</h2><p>Здесь хранятся ваши сообщения и договорённости.</p><form action="/api/google-calendar/start" method="post" target="_blank" rel="noopener"><button type="submit" class="ci-button ci-primary">Войти через Google</button></form>${button('Я вошёл — обновить','reload')}</div>`;
    const error=state.error?`<div class="ci-alert" role="alert"><p>${escape(state.error)}</p>${button('Повторить','reload')}</div>`:'';
    const blank=state.loading?'<p class="ci-list-empty" role="status">Загружаю сообщения…</p>':`<div class="ci-list-empty"><p>${state.filter==='history'?'Разобранные сообщения появятся здесь.':state.filter==='deferred'?'Отложенных сообщений нет.':'Всё разобрано.'}</p>${state.filter==='pending'?'<p>Отправьте боту текст или голосовое после разговора.</p>':''}</div>`;
    return `<section class="ci-inbox" aria-label="Входящие коммуникации"><header class="ci-head"><div><span class="ci-eyebrow">Коммуникации</span><h1>Входящие</h1><p>Скажите или перешлите боту. Здесь — короткая проверка и следующий шаг.</p></div>${button('Обновить','reload',state.loading?'disabled':'')}</header>${state.authRequired?auth:`${error}<nav class="ci-tabs" aria-label="Фильтр сообщений">${tabs}</nav><div class="ci-layout"><aside class="ci-list" aria-label="Сообщения">${list||blank}${state.nextOffset!==null&&state.nextOffset!==undefined?button(state.loading?'Загружаю…':'Показать ещё','more',state.loading?'disabled':''):''}</aside><div class="ci-detail">${state.detailLoading?'<p class="ci-loading" role="status">Открываю сообщение…</p>':renderDetail(state.session,options)}</div></div>`}</section>`;
  }
  function errorMessage(error,action) {
    if (error?.status===401) return 'Войдите через Google и повторите действие. Правки остаются в этой вкладке.';
    if (error?.status===409) return error?.code==='source_archived'?'Исходная заметка архивирована. Сначала восстановите её в заметках.':'Запись или связанная задача изменились. Правки остались здесь. Загрузите актуальную версию перед подтверждением.';
    if (error?.status===404) return 'Сообщение не найдено. Обновите список.';
    if ([400,413,422].includes(error?.status)) return 'Изменения не приняты. Проверьте проекты, участников, текст и даты.';
    return action==='apply'||action==='defer'?'Сервер не подтвердил действие. Нажмите кнопку ещё раз: будет проверен тот же запрос без повторного применения.':'Не удалось получить результат. Исходник сохранён; попробуйте ещё раз.';
  }
  function mount(container, options = {}) {
    if (!container || typeof options.request!=='function') throw Error('Не задан источник входящих.');
    const doc=container.ownerDocument||globalThis.document,view=doc?.defaultView||globalThis;
    const scope=text(options.scope||'owner');
    let disposed=false,sequence=0,detailSequence=0,pollTimer=null;
    const state={items:[],filter:'pending',selectedId:text(options.selectedId),session:null,loading:false,detailLoading:false,error:'',authRequired:false,nextOffset:null};
    const uuid=()=>view.crypto.randomUUID();
    const ask=message=>typeof view.confirm==='function'&&view.confirm(message);
    const sessionKey=id=>scope+':'+id;
    function remember() {
      if (!state.session) return;
      const key=sessionKey(state.session.item.id);
      if (dirty(state.session)||state.session.conflict) memory.set(key,state.session); else memory.delete(key);
      // Drafts stay in this document session and are never written to browser storage.
      while(memory.size>30) memory.delete(memory.keys().next().value);
    }
    function draw() { if (!disposed) container.innerHTML=renderInbox(state,options); }
    function upsert(item) {
      const index=state.items.findIndex(row=>row.id===item.id);
      if(index<0)state.items.unshift(item);else state.items[index]=item;
    }
    function assertItem(result) {
      const item=result?.item;
      if(!item||!UUID.test(text(item.id))||!Number.isSafeInteger(item.revision)||item.revision<0) throw Error('Сервер не подтвердил состояние сообщения.');
      return item;
    }
    function accept(item,restore=true) {
      upsert(item);
      const cached=restore?memory.get(sessionKey(item.id)):null;
      state.session=cached||createSession(item);
      if(cached&&cached.item.revision!==item.revision&&!cached.pending){cached.conflict=true;cached.error='Сохранённые правки относятся к предыдущей версии. Загрузите актуальную версию перед подтверждением.';}
      state.selectedId=item.id;
      if(item.status==='applied')state.filter='history';else if(item.status==='deferred')state.filter='deferred';
      pollProcessing();
    }
    function pollProcessing() {
      if(pollTimer!==null){view.clearTimeout?.(pollTimer);pollTimer=null;}
      if(disposed||state.session?.item.status!=='processing'||typeof view.setTimeout!=='function')return;
      const id=state.session.item.id;
      pollTimer=view.setTimeout(async()=>{
        pollTimer=null;
        if(disposed||state.selectedId!==id||dirty(state.session)||state.session?.busy)return;
        try{
          const item=assertItem(await options.request(`/inbox/${encodeURIComponent(id)}`));
          if(disposed||state.selectedId!==id||dirty(state.session))return;
          accept(item,false);draw();
        }catch{pollProcessing();}
      },5000);
    }
    async function load(more=false) {
      if(disposed||state.loading)return;
      const n=++sequence;
      state.loading=true;state.error='';draw();
      try{
        const offset=more?state.nextOffset||0:0;
        const filter=state.filter==='history'?'applied':state.filter;
        const result=await options.request(`/inbox?status=${filter}&limit=50&offset=${offset}`);
        if(disposed||n!==sequence)return;
        if(!Array.isArray(result?.items))throw Error('Некорректный список сообщений.');
        const map=new Map((more?state.items:[]).map(i=>[i.id,i]));
        result.items.forEach(item=>{if(item&&UUID.test(text(item.id)))map.set(item.id,item);});
        state.items=[...map.values()];state.nextOffset=result.nextOffset??null;state.authRequired=false;
        if(state.selectedId&&!state.session)await select(state.selectedId,false);
      }catch(error){if(disposed||n!==sequence)return;state.authRequired=error?.status===401;state.error=errorMessage(error,'load');if(state.authRequired){state.items=[];state.session=null;}}
      finally{if(!disposed&&n===sequence){state.loading=false;draw();}}
    }
    async function select(id,notify=true) {
      if(disposed||!UUID.test(text(id))||state.session?.busy)return false;
      if(state.selectedId!==id&&dirty(state.session)&&!ask('В этом сообщении есть неподтверждённые правки. Перейти к другому? Правки останутся в этой вкладке.'))return false;
      remember();const n=++detailSequence;
      state.selectedId=id;state.detailLoading=true;draw();
      try{
        const item=assertItem(await options.request(`/inbox/${encodeURIComponent(id)}`));
        if(disposed||n!==detailSequence)return false;
        const previousFilter=state.filter;accept(item);
        if(state.filter!==previousFilter){state.loading=false;load();}
        if(notify)options.onSelect?.(id);
      }catch(error){if(disposed||n!==detailSequence)return false;state.error=errorMessage(error,'load');if(error?.status===401){state.authRequired=true;state.session=null;}}
      finally{if(!disposed&&n===detailSequence){state.detailLoading=false;draw();if(notify&&view.matchMedia?.('(max-width: 760px)').matches)container.querySelector?.('.ci-detail')?.scrollIntoView?.({block:'start',behavior:'smooth'});}}
      return true;
    }
    async function reloadDetail() {
      if(!state.session)return select(state.selectedId,false);
      if(dirty(state.session)&&!ask('Загрузить актуальную версию? Неподтверждённые правки этого сообщения будут заменены.'))return;
      memory.delete(sessionKey(state.selectedId));state.session=null;
      await select(state.selectedId,false);
    }
    async function mutate(action) {
      const session=state.session;
      if(!session||session.busy||disposed)return;
      if(session.pending&&session.pending.action!==action)return;
      if(action==='apply'&&(session.conflict||session.loadingProject))return;
      let body;
      try{
        if(action==='apply')body=prepareSubmission(session,uuid(),options);
        else if(action==='defer'){
          if(session.correction.trim()&&!session.pending&&!ask('Отложить сообщение? Правки предложений сохранятся, а уточнение для повторного разбора останется только в этой вкладке.'))return;
          if(!session.pending)session.pending={action,body:{revision:session.item.revision,request_id:uuid(),...(Array.isArray(session.item.proposal?.changes)?{proposal:{version:1,changes:clone(session.proposal.changes)}}:{})}};
          body=clone(session.pending.body);
        }else{
          if(JSON.stringify(session.proposal)!==JSON.stringify(session.base)&&!ask('Повторный разбор заменит текущие предложения и ваши правки. Продолжить?'))return;
          body={revision:session.item.revision,...(session.correction.trim()?{correction:session.correction.trim()}: {})};
        }
      }catch(error){session.error=error.message;session.editing=true;draw();return;}
      session.busy=true;session.error='';remember();draw();
      try{
        const result=await options.request(`/inbox/${encodeURIComponent(session.item.id)}/${action}`,{method:'POST',body});
        const item=assertItem(result);
        if(disposed)return;
        const previousFilter=state.filter;
        memory.delete(sessionKey(item.id));accept(item,false);
        if(state.filter!==previousFilter){state.loading=false;load();}
        if(action==='defer'&&session.correction.trim()){
          state.session.correction=session.correction;state.session.editing=session.editing;remember();
        }
        // A refresh failure must never make an already committed apply look unsuccessful.
        try{await options.onChanged?.(item,action);}catch{}
      }catch(error){
        if(disposed)return;
        session.error=errorMessage(error,action);
        session.conflict=error?.status===409;
        if([400,401,404,409,413,422].includes(error?.status))session.pending=null;
        if(error?.status===401)state.authRequired=true;
      }finally{session.busy=false;remember();draw();}
    }
    async function projectChanged(change) {
      if(!['project_state','project_entry'].includes(change.kind))return;
      const session=state.session,id=change.project_id;
      change.brief_revision=null;
      if(!id)return;
      session.loadingProject=change.id;draw();
      try{
        const brief=await options.request(`/projects/${encodeURIComponent(id)}/brief`);
        if(disposed||state.session!==session||change.project_id!==id)return;
        if(!Number.isSafeInteger(brief?.revision)||brief.revision<0)throw Error('Состояние проекта не получено.');
        session.briefs[id]=brief;
        // Every selected operation on one project must use the same observed version.
        session.proposal.changes.filter(c=>c.project_id===id&&['project_state','project_entry'].includes(c.kind)).forEach(c=>{c.brief_revision=brief.revision;});
        session.error='';
      }catch(error){if(!disposed&&state.session===session)session.error='Не удалось загрузить состояние выбранного проекта. Выберите проект повторно.';}
      finally{if(!disposed&&state.session===session){session.loadingProject=null;remember();draw();}}
    }
    async function click(event) {
      const target=event.target?.closest?.('[data-ci-action]');
      if(!target||!container.contains(target)||target.disabled)return;
      const action=target.dataset.ciAction,session=state.session;
      if(action==='select')return select(target.dataset.ciId);
      if(action==='filter'){if(state.filter===target.dataset.ciFilter)return;state.filter=target.dataset.ciFilter;state.items=[];state.nextOffset=null;state.loading=false;return load();}
      if(action==='reload')return load();
      if(action==='more')return load(true);
      if(action==='reload-detail')return reloadDetail();
      if(action==='edit'){if(session&&!session.busy&&!session.pending){session.editing=!session.editing;draw();}return;}
      if(action==='copy'){
        try{await view.navigator.clipboard.writeText(session.proposal.changes.filter(c=>c.selected!==false).map(c=>titleFor(c)+'\n'+c.text).join('\n\n'));session.error='Правки скопированы. Теперь можно загрузить актуальную версию.';}catch{session.error='Не удалось скопировать автоматически. Выделите и скопируйте текст правок вручную.';}draw();return;
      }
      if(['apply','defer','analyze'].includes(action))return mutate(action);
    }
    function input(event) {
      const target=event.target,session=state.session;
      if(!session||session.busy||session.pending||session.item.status==='applied'||!target?.dataset?.ciField)return;
      const key=target.dataset.ciField;
      if(key==='correction'){session.correction=text(target.value);remember();return;}
      const change=session.proposal.changes.find(c=>c.id===target.dataset.ciChange);
      if(!change)return;
      if(key==='selected')change.selected=!!target.checked;
      else if(['text','project_id','participant_id','direction','status','deadline','deadline_time','next_check_on','entry_kind'].includes(key))change[key]=['project_id','participant_id','deadline','deadline_time','next_check_on'].includes(key)?target.value||null:text(target.value);
      else return;
      if(key==='deadline'&&!change.deadline)change.deadline_time=null;
      remember();
      if(key==='project_id'){projectChanged(change);if(!['project_state','project_entry'].includes(change.kind))draw();}
      else if(key==='selected'||key==='direction'||key==='entry_kind')draw();
    }
    function beforeUnload(event){if(dirty(state.session)){event.preventDefault();event.returnValue='';}}
    container.onclick=click;container.oninput=input;
    view.addEventListener?.('beforeunload',beforeUnload);
    draw();load();
    return {
      dispose(){remember();disposed=true;sequence++;detailSequence++;if(pollTimer!==null)view.clearTimeout?.(pollTimer);container.onclick=null;container.oninput=null;view.removeEventListener?.('beforeunload',beforeUnload);container.querySelectorAll?.('audio').forEach(audio=>{audio.pause();audio.removeAttribute('src');audio.load();});},
      hasDraft:()=>dirty(state.session),
      isBusy:()=>!!state.session?.busy||!!state.session?.loadingProject,
      canLeave:()=>!state.session?.busy&&(!dirty(state.session)||ask('Есть неподтверждённые правки. Покинуть входящие? Они останутся в этой вкладке.')),
      select,
      reload:()=>load()
    };
  }
  return {mount,renderInbox,renderDetail,createSession,normalizedProposal,dirty,prepareSubmission,validateProposal,validDay,dayLabel,activeProjects,itemsForFilter,groupedItems,titleFor,errorMessage};
});
