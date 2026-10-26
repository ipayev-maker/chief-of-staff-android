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
  const kinds = {task_create:'Новая задача',task_update:'Обновление задачи',meeting_create:'Встреча в календаре',project_state:'Состояние проекта',project_entry:'Запись в обзоре проекта'};
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
    return {item:clone(item),base:clone(proposal),proposal,correction:'',editing:item.status!=='applied',pending:null,busy:false,error:'',conflict:false,briefs,loadingProject:null,participantDraft:null};
  }
  function dirty(session) {
    return !!session && (!!session.pending || !!session.correction.trim() || !!session.participantDraft?.name.trim() || !!session.participantDraft?.pending || JSON.stringify(session.proposal)!==JSON.stringify(session.base));
  }
  function titleFor(change) {
    if (change.kind === 'task_create' && change.direction === 'to_me') return 'Ожидание от участника';
    if (change.kind === 'project_entry') return change.entry_kind === 'question' ? 'Открытый вопрос' : 'Решение';
    return kinds[change.kind] || 'Предложение';
  }
  function validateProposal(proposal, options = {}, baseProposal = null) {
    const projects = new Set(activeProjects(options.getProjects?.()||options.projects).map(p=>p.id));
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
      if (change.kind==='meeting_create' && (!validDay(change.meeting_date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(change.meeting_time||'')||!Number.isInteger(change.duration_minutes)||change.duration_minutes<1||change.duration_minutes>1440)) return 'Укажите дату, время начала и длительность встречи.';
      if(change.planned_on&&!validDay(change.planned_on))return 'Укажите корректную дату работы.';
      if(change.planned_time&&(!/^([01]\d|2[0-3]):[0-5]\d$/.test(change.planned_time)||!change.planned_on))return 'Время работы должно быть указано вместе с датой.';
      if (change.deadline && !validDay(change.deadline)) return 'Укажите корректную дату срока.';
      if (change.next_check_on && !validDay(change.next_check_on)) return 'Укажите корректную дату проверки.';
      if (change.deadline_time && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(change.deadline_time) || !change.deadline)) return 'Время срока должно быть указано вместе с датой.';
    }
    return '';
  }
  function prepareSubmission(session, requestId, options) {
    if(session.participantDraft)throw Error('Сначала сохраните участника или закройте форму его добавления.');
    if (session.pending) return clone(session.pending.body);
    if(JSON.stringify(session.proposal.owner_context)!==JSON.stringify(session.base.owner_context))throw Error('Сначала нажмите «Сохранить связи».');
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
  function itemExcerpt(item) { const subject=item.source_meta?.type==='gmail'?(item.source_meta.subject||item.source_text?.match(/^Тема: (.+)$/m)?.[1]):null;return text(subject || item.proposal?.summary || item.transcript || item.source_text || (isVoice(item)?'Голосовое сообщение':'Сообщение')).replace(/\s+/g,' ').slice(0,180); }
  function isVoice(item) { return item.source_meta?.type==='voice' || item.source_meta?.voice === true || !!item.source_meta?.voice || !!item.source_meta?.audio_path; }
  function button(label,action,attrs='',primary=false) { return `<button type="button" class="ci-button${primary?' ci-primary':''}" data-ci-action="${action}" ${attrs}>${label}</button>`; }
  function option(value,label,selected,disabled=false) { return `<option value="${escape(value)}"${value===selected?' selected':''}${disabled?' disabled':''}>${escape(label)}</option>`; }
  function field(label,html) { return `<label class="ci-field"><span>${label}</span>${html}</label>`; }
  function zoneLabel(zone) { return ({'Europe/Berlin':'Берлин','Europe/Moscow':'Москва','Etc/UTC':'UTC','UTC':'UTC'})[zone]||text(zone)||'часовой пояс проекта'; }
  function authTimeZone(value) {
    try { const zone=value||Intl.DateTimeFormat().resolvedOptions().timeZone;new Intl.DateTimeFormat('en',{timeZone:zone});return zone; } catch { return 'UTC'; }
  }
  function participantHTML(change,session) {
    const draft=session.participantDraft;
    if(!draft||draft.changeId!==change.id)return '';
    const locked=draft.busy||!!draft.pending;
    return `<div class="ci-participant-create" aria-label="Новый участник">${field('Имя участника',`<input type="text" data-ci-field="participant_name" value="${escape(draft.name)}" maxlength="200" autocomplete="off" placeholder="Имя или имя и компания"${locked?' disabled':''}>`)}<p class="ci-hint">Участник сохранится в общем справочнике и будет выбран в этом предложении. Задача появится после подтверждения карточки.</p>${draft.error?`<p class="ci-participant-error" role="alert">${escape(draft.error)}</p>`:''}<div class="ci-participant-actions">${button(draft.busy?'Сохраняю…':draft.pending?'Проверить сохранение':'Создать участника','participant-save',draft.busy?'disabled':'',true)}${draft.existing?button('Выбрать существующего: '+escape(draft.existing.name),'participant-existing',draft.busy?'disabled':''):''}${button('Отмена','participant-cancel',draft.busy?'disabled':'')}</div></div>`;
  }
  function changeHTML(change,index,session,options) {
    const locked = session.busy || !!session.pending || !!session.loadingProject || !!session.participantDraft?.busy || !!session.participantDraft?.pending || ['applied','processing'].includes(session.item.status);
    const attrs = `data-ci-change="${escape(change.id)}"`;
    const disabled = locked?' disabled':'';
    const project = array(options.projects).find(p=>p.id===change.project_id);
    const person = array(options.participants).find(p=>p.id===change.participant_id);
    const target = array(options.tasks).find(t=>t.id===change.task_id);
    const isTask = change.kind==='task_create'||change.kind==='task_update';
    const isMeeting = change.kind==='meeting_create';
    const editing = session.editing && session.item.status!=='applied';
    const select = (key,rows) => `<select ${attrs} data-ci-field="${key}"${disabled}>${rows}</select>`;
    const input = (key,type,value,extra='') => `<input type="${type}" ${attrs} data-ci-field="${key}" value="${escape(value)}" ${extra}${disabled}>`;
    const summary = [isMeeting&&change.meeting_date?'Начало: '+dayLabel(change.meeting_date)+' в '+(change.meeting_time||'—')+' · '+zoneLabel(session.proposal.time_zone):'',isMeeting?change.duration_minutes+' мин'+(change.duration_estimated?' · по умолчанию':''):'',`${project?'Проект: '+(project.title||project.name):'Без проекта'}`,person?'Участник: '+person.name:'',isTask&&change.planned_on?'Работа: '+dayLabel(change.planned_on)+(change.planned_time?' в '+change.planned_time+' · '+zoneLabel(session.proposal.time_zone):''):'',isTask&&change.deadline?'Срок: '+dayLabel(change.deadline)+(change.deadline_time?' в '+change.deadline_time+' · '+zoneLabel(session.proposal.time_zone):''):'',isTask&&change.next_check_on?'Проверить: '+dayLabel(change.next_check_on):'',change.kind==='task_update'&&change.status?'Статус: '+(taskStatuses[change.status]||change.status):''].filter(Boolean);
    const personOptions = option('','Не указан',change.participant_id||'')+array(options.participants).filter(p=>p.id&&!p.deleted_at&&!p.archived_at).sort((a,b)=>text(a.name).localeCompare(text(b.name),'ru')).map(p=>option(p.id,p.name,change.participant_id)).join('');
    const projectOptions = option('','Выберите проект',change.project_id||'')+activeProjects(options.getProjects?.()||options.projects).map(p=>option(p.id,p.title||p.name||'Проект',change.project_id)).join('');
    const participantControl=field('Участник',select('participant_id',personOptions))+button('＋ Добавить участника','participant-new',attrs+disabled);
    const editor = editing ? `<div class="ci-change-editor">${['task_create','meeting_create'].includes(change.kind)?field('Действие',select('kind',option('task_create','Задача',change.kind)+option('meeting_create','Встреча',change.kind))):''}${field('Текст',`<textarea rows="3" maxlength="2000" ${attrs} data-ci-field="text"${disabled}>${escape(change.text)}</textarea>`)}<div class="ci-fields-grid">${field('Проект',select('project_id',projectOptions))}${isTask||isMeeting||change.kind==='project_entry'?`<div class="ci-participant-control">${participantControl}</div>`:''}${isTask?field('Кто действует',select('direction',Object.entries({internal:'Моя задача',from_me:'Обещал другому',to_me:'Жду от другого'}).map(([id,label])=>option(id,label,change.direction||'internal')).join(''))):''}${change.kind==='task_update'?field('Статус',select('status',Object.entries(taskStatuses).map(([id,label])=>option(id,label,change.status||'open')).join(''))):''}${isMeeting?field('Дата встречи',input('meeting_date','date',change.meeting_date||''))+field('Начало · '+escape(zoneLabel(session.proposal.time_zone)),input('meeting_time','time',change.meeting_time||''))+field('Длительность, минут',input('duration_minutes','number',change.duration_minutes||30,'min="1" max="1440"')):''}${isTask&&Object.hasOwn(change,'planned_on')?field('Дата работы',input('planned_on','date',change.planned_on||''))+field('Время работы · '+escape(zoneLabel(session.proposal.time_zone)),input('planned_time','time',change.planned_time||'')):''}${isTask?field('Срок',input('deadline','date',change.deadline||''))+field('Время срока · '+escape(zoneLabel(session.proposal.time_zone)),input('deadline_time','time',change.deadline_time||''))+field('Вернуться и проверить',input('next_check_on','date',change.next_check_on||'')):''}${change.kind==='project_entry'?field('Тип записи',select('entry_kind',option('decision','Решение',change.entry_kind)+option('question','Открытый вопрос',change.entry_kind))):''}</div>${isMeeting&&change.duration_estimated?'<p class="ci-hint">Длительность в сообщении не указана: предложено 30 минут. Её можно изменить перед подтверждением.</p>':''}${isTask?'<p class="ci-hint">Работа — когда заняться задачей. Срок — когда нужен результат. Проверка — когда уточнить. Заполняйте только нужные даты.</p>':''}${session.loadingProject===change.id?'<p class="ci-hint" role="status">Загружаю состояние проекта…</p>':''}</div>` : `<p class="ci-change-text">${escape(change.text)}</p><p class="ci-change-meta">${summary.map(escape).join('<span aria-hidden="true"> · </span>')}</p>`;
    const suggestion=change.participant_suggestion;
    const candidates=array(suggestion?.existing_ids).map(id=>array(options.participants).find(p=>p.id===id)).filter(Boolean);
    const offer=!change.participant_id&&suggestion&&!session.participantDraft&&editableStatuses.includes(session.item.status)?`<div class="ci-person-offer"><span>${candidates.length?'Кто из участников?':'Новый участник'}: <b>${escape(suggestion.name)}</b></span><div>${candidates.length?candidates.map(p=>button(escape(p.name),'participant-select',attrs+` data-ci-person="${escape(p.id)}"`+disabled)).join(''):button('＋ Добавить в справочник','participant-new',attrs+disabled)}</div></div>`:'';
    const before = session.briefs[change.project_id]?.document?.current_state || session.briefs[change.project_id]?.current_state || (change.kind==='project_state'?change.before?.text:'');
    return `<article class="ci-change${change.selected===false?' ci-unselected':''}"><div class="ci-change-head"><label class="ci-check"><input type="checkbox" ${attrs} data-ci-field="selected"${change.selected!==false?' checked':''}${disabled}><span>${escape(titleFor(change))}</span></label><span class="ci-change-number">${index+1}</span></div>${change.kind==='task_update'?`<p class="ci-target">Изменение существующей задачи: ${escape(target?.description||change.text)}</p>`:''}${change.kind==='project_state'&&before?`<p class="ci-before">Сейчас: ${escape(before)}</p>`:''}${editing?`<p class="ci-change-meta">${summary.map(escape).join(" · ")}</p>`:""}${editor}${offer}${!offer&&!session.participantDraft&&!editing&&!change.participant_id&&(isTask||isMeeting||change.kind==='project_entry')&&editableStatuses.includes(session.item.status)?button('＋ Добавить участника','participant-new',attrs+disabled):''}${participantHTML(change,session)}${change.evidence_restored?'<p class="ci-hint">В цитату возвращены пропущенные фразы. Проверьте смысл предложения перед выбором.</p>':''}${change.evidence?`<details class="ci-evidence"><summary>Основание в сообщении</summary><blockquote>${escape(change.evidence)}</blockquote>${change.source_message_id?`<a href="https://mail.google.com/mail/?authuser=${encodeURIComponent(session.item.source_meta?.owner_email||'')}#all/${encodeURIComponent(change.source_message_id)}" target="_blank" rel="noopener noreferrer">Открыть письмо-основание</a>`:''}</details>`:''}</article>`;
  }
  function renderDetail(session, options = {}) {
    if (!session) return '<div class="ci-empty-detail"><span class="ci-empty-symbol" aria-hidden="true">↗</span><h2>Выберите сообщение</h2><p>Исходник и предложения будут рядом. Проверьте их и подтвердите одной кнопкой.</p></div>';
    const item = session.item, proposal=session.proposal;
    const finished = item.status==='applied'||item.source_meta?.superseded===true;
    const busy = session.busy||!!session.participantDraft?.busy, locked=busy||item.status==='processing'||!!session.pending||!!session.participantDraft;
    const changes=array(proposal.changes), selected=changes.filter(c=>c.selected!==false);
    const source=text(item.source_text), transcript=text(item.transcript);
    const sourceBody=source||(transcript?'':isVoice(item)?'Голосовое сообщение сохранено. Текст появится после распознавания.':'Исходный текст пока недоступен.');
    const processing=item.status==='processing';
    const failed=item.status==='error';
    const actionable=editableStatuses.includes(item.status)&&Array.isArray(item.proposal?.changes)&&!session.loadingProject;
    const heading=finished?'Изменения применены':processing?'Разбираю сообщение':failed?'Исходник сохранён':changes.length?'Проверьте и сохраните':'Сообщение и контекст';
    const feedback=session.error?`<div class="ci-alert" role="alert"><p>${escape(session.error)}</p>${session.conflict?button('Загрузить актуальную версию','reload-detail')+button('Скопировать правки','copy'):''}</div>`:'';
    const audioSource=typeof options.audioSource==='function'?options.audioSource(item):`/api/notes/inbox/${encodeURIComponent(item.id)}/audio`;
    const mail=item.source_meta?.type==='gmail'?item.source_meta:null;
    const mailContext=mail?`<div class="ci-mail-context"><p>В этой цепочке прочитано ${array(mail.messages).length} из ${Number(mail.total_messages)||array(mail.messages).length} писем · глубина ${Number(mail.context_days)||90} дней.${mail.omitted_messages>0?' Есть более ранние письма за пределами выбранной глубины.':mail.partial?' Длинный текст письма сокращён; полный текст доступен в Gmail.':''}</p><a href="https://mail.google.com/mail/?authuser=${encodeURIComponent(mail.owner_email||'')}#all/${encodeURIComponent(mail.thread_id||'')}" target="_blank" rel="noopener noreferrer">Открыть цепочку в Gmail</a> · ${button('Настройки Gmail','gmail-settings')}${!finished&&mail.delivery!=='tasks'&&Number(mail.context_days)!==7&&Number(mail.omitted_messages)>0?`<div>${Number(mail.message_limit)<50?button('Добавить 10 писем','gmail-expand',locked?'disabled':''):''}${Number(mail.context_days)<180?button('Посмотреть до 180 дней','gmail-expand-older',locked?'disabled':''):''}</div>`:''}${mail.superseded?'<p>Для этой цепочки запрошен расширенный разбор. Новая карточка появится во «Входящих».</p>':''}</div>`:'';
    const addLocked=busy||processing||session.conflict||!!session.participantDraft||!!session.loadingProject||!!session.pending&&session.pending.action!=='addAction';
    const createActions=!finished?`<div class="ci-manual-actions" aria-label="Действия из сообщения">${['task_create','meeting_create'].map(kind=>button(session.pending?.action==='addAction'&&session.pending.body.kind===kind?'Проверить добавление':kind==='task_create'?'＋ Создать задачу':'＋ Назначить встречу','add-action',`data-ci-kind="${kind}" ${addLocked||session.pending?.action==='addAction'&&session.pending.body.kind!==kind?'disabled':''}`)).join('')}<p class="ci-hint">Можно создать действие вручную, даже если автоматический разбор ничего не предложил.</p></div>`:'';
    const sourceHTML=`<details class="ci-source"${!changes.length||failed?' open':''}><summary>Исходное сообщение${isVoice(item)?' · голосовое':''}</summary>${isVoice(item)?`<audio controls preload="none" src="${escape(audioSource)}" aria-label="Исходное голосовое сообщение"></audio>`:''}${sourceBody?`<p>${escape(sourceBody)}</p>`:''}${transcript&&transcript!==source?`<div class="ci-transcript"><span>Расшифровка</span><p>${escape(transcript)}</p></div>`:''}</details>`;
    const questions=array(proposal.questions).length?`<div class="ci-questions"><span>Проверьте детали</span><ul>${proposal.questions.map(q=>`<li>${escape(q)}</li>`).join('')}</ul></div>`:'';
    const context=proposal.owner_context||{project_id:null,participant_ids:[]};
    const contextHTML=!finished?`<div class="ci-fields-grid ci-owner-context">${field('Проект сообщения',`<select data-ci-field="context_project" ${locked?'disabled':''}>${option('','Без проекта',context.project_id||'')}${activeProjects(options.getProjects?.()||options.projects).map(p=>option(p.id,p.title,context.project_id)).join('')}</select>`)}${field('Участники сообщения',`<select data-ci-field="context_people" multiple size="3" ${locked?'disabled':''}>${array(options.participants).filter(p=>!p.archived_at&&!p.deleted_at).map(p=>`<option value="${escape(p.id)}" ${context.participant_ids.includes(p.id)?'selected':''}>${escape(p.name)}</option>`).join('')}</select>`)}${button('Сохранить связи','save-context',locked?'disabled':'')}</div>`:'';
    const correction=!finished?`<div class="ci-correction">${field('Уточнение для повторного разбора',`<textarea rows="3" maxlength="4000" data-ci-field="correction" placeholder="Например: это относится к другому проекту; срок пока не согласован"${locked?' disabled':''}>${escape(session.correction)}</textarea>`)}${button('Повторить разбор','analyze',locked?'disabled':'')}<p class="ci-hint">Предложения будут составлены заново с учётом уточнения. Исходное сообщение сохранится.</p></div>`:'';
    const applyLabel=session.pending?.action==='apply'?'Проверить сохранение':selected.length===0?'Готово — оставить заметкой':selected.length===1&&selected[0].kind==='task_create'?'Создать задачу':selected.length===1&&selected[0].kind==='meeting_create'?'Создать встречу':selected.length===changes.length?'Применить всё':`Применить выбранное · ${selected.length}`;
    const createdRecords=finished?array(item.applied_result?.changes).filter(c=>['task_create','meeting_create'].includes(c.kind)):[];
    const createdHTML=createdRecords.length?`<div class="ci-created-records">${createdRecords.map(c=>`<section class="ci-change"><h3>${escape(c.after?.description||c.after?.title||'Созданная запись')}</h3><div class="ci-action-bar">${button('Открыть / изменить','open-created',`data-ci-change="${escape(c.id)}" ${busy?'disabled':''}`)}${array(item.applied_result?.cancelled_ids).includes(c.id)?'<span>Отменено</span>':button('Отменить','cancel-created',`data-ci-change="${escape(c.id)}" ${busy?'disabled':''}`)}</div></section>`).join('')}</div>`:'';
    const actions=finished?`<p class="ci-done">Разобрано ${escape(timeLabel(item.applied_at||item.updated_at))}. Исходник сохранён в заметках.</p>`:`<div class="ci-action-bar">${actionable||session.pending?.action==='apply'?button(applyLabel,'apply',(busy||session.participantDraft||session.conflict||session.loadingProject||session.pending&&session.pending.action!=='apply'?'disabled ':'')+(busy?'aria-busy="true"':''),true):button(processing?'Проверить результат':failed?'Повторить обработку':'Разобрать сообщение',processing?'reload-detail':'analyze',locked?'disabled':'',true)}${button(session.editing?'Свернуть редактор':'Исправить','edit',locked?'disabled':'')}${item.status!=='deferred'?button(session.pending?.action==='defer'?'Проверить перенос':'Разобрать позже','defer',busy||session.participantDraft||!!session.pending&&session.pending.action!=='defer'?'disabled':''):''}</div><p class="ci-confirm-hint">${actionable?selected.length?'Задачи и состояние проекта изменятся после подтверждения.':'Заметка сохранится без создания задач.':processing?'Сообщение уже сохранено. Можно вернуться к нему позже.':'Задачи пока не изменены.'}</p>`;
    return `<section class="ci-review" aria-label="Разбор сообщения"><header class="ci-review-head"><div><span class="ci-eyebrow">${mail?'Переписка Gmail':isVoice(item)?'Голосовое в Telegram':'Сообщение в Telegram'}${timeLabel(item.created_at)?' · '+escape(timeLabel(item.created_at)):''}</span><h2>${heading}</h2></div><span class="ci-status ci-status-${escape(item.status)}">${escape(statuses[item.status]||'Сохранено')}</span></header>${proposal.summary&&(!changes.length||mail)?`<p class="ci-summary">${escape(proposal.summary)}</p>`:''}${createActions}${mailContext}${contextHTML}${sourceHTML}${feedback}${failed?'<p class="ci-notice">Не удалось закончить обработку. Исходное сообщение доступно; повторите попытку или добавьте уточнение.</p>':''}${questions}${changes.length?`<div class="ci-changes">${changes.map((c,i)=>changeHTML(c,i,session,options)).join('')}</div>`:actionable?'<p class="ci-note-only">Задач и изменений проекта не предложено. Сообщение можно оставить самостоятельной заметкой.</p>':''}${finished&&mail?.superseded?'':correction+actions+createdHTML}</section>`;
  }
  function renderInbox(state, options = {}) {
    const items=array(state.items), filtered=itemsForFilter(items,state.filter||'pending');
    const groups=groupedItems(filtered,options.projects);
    const tabs=[['pending','Входящие'],['deferred','Отложено'],['history','История']].map(([key,label])=>`<button type="button" class="ci-tab${state.filter===key?' ci-active':''}" data-ci-action="filter" data-ci-filter="${key}" aria-pressed="${state.filter===key}">${label}${state.filter===key&&!state.loading?`<span>${filtered.length}${state.nextOffset!=null?'+':''}</span>`:''}</button>`).join('');
    const list=groups.map(group=>`<section class="ci-group"><h3>${escape(group.title)}<span>${group.items.length}</span></h3><div>${group.items.map(item=>`<button type="button" class="ci-list-item${state.selectedId===item.id?' ci-selected':''}" data-ci-action="select" data-ci-id="${escape(item.id)}"${state.selectedId===item.id?' aria-current="true"':''}><span class="ci-list-top"><span>${item.source_meta?.type==='gmail'?'Gmail':isVoice(item)?'Голосовое':'Сообщение'}</span><time>${escape(timeLabel(item.created_at))}</time></span><span class="ci-list-title">${escape(itemExcerpt(item))}</span><span class="ci-list-bottom">${escape(statuses[item.status]||'Сохранено')}${array(item.proposal?.changes).length?` · ${array(item.proposal.changes).length} изм.`:''}</span></button>`).join('')}</div></section>`).join('');
    const hasDraft=dirty(state.session),returnTo='/#/inbox'+(UUID.test(text(state.selectedId))?'/'+state.selectedId:'');
    const auth=`<div class="ci-message"><h2>Войдите, чтобы открыть входящие</h2><p>Здесь хранятся ваши сообщения и договорённости.</p>${hasDraft?'<p>Правки сохранены в этой вкладке. Вход откроется в новой: затем вернитесь сюда и нажмите «Я вошёл — обновить».</p>':'<p>После входа откроется выбранное сообщение.</p>'}<form action="/api/google-calendar/start" method="post"${hasDraft?' target="_blank" rel="noopener"':''}><input type="hidden" name="time_zone" value="${escape(authTimeZone(options.timeZone))}"><input type="hidden" name="return_to" value="${escape(returnTo)}"><button type="submit" class="ci-button ci-primary">Войти через Google</button></form>${hasDraft?button('Я вошёл — обновить','reload'):''}</div>`;
    const gp=state.gmail?.progress;
    const gmailProgress=gp?`<p class="ci-notice" role="status">Gmail: найдено ${Number(gp.found)||0} цепочек · загружено ${Number(gp.imported)||0} · готовы ${Number(gp.ready)||0} · в очереди ${Number(gp.queued)||0} · ожидают разбора ${Number(gp.analyzing)||0}${gp.errors?' · ошибок '+Number(gp.errors):''}${state.gmail.settings?.enabled?'':'. Импорт на паузе.'}</p>`:'';
    const error=state.error?`<div class="ci-alert" role="alert"><p>${escape(state.error)}</p>${button('Повторить','reload')}</div>`:'';
    const blank=state.loading?'<p class="ci-list-empty" role="status">Загружаю сообщения…</p>':`<div class="ci-list-empty"><p>${state.filter==='history'?'Разобранные сообщения появятся здесь.':state.filter==='deferred'?'Отложенных сообщений нет.':'Всё разобрано.'}</p>${state.filter==='pending'?'<p>Отправьте боту текст или голосовое после разговора.</p>':''}</div>`;
    return `<section class="ci-inbox" aria-label="Входящие коммуникации"><header class="ci-head"><div><span class="ci-eyebrow">Коммуникации</span><h1>Входящие</h1><p>Сообщения, которым нужна ваша проверка. Поручения из почты появляются сразу в задачах.</p></div>${button('Обновить','reload',state.loading?'disabled':'')}</header>${state.authRequired?auth:`${error}${gmailProgress}<nav class="ci-tabs" aria-label="Фильтр сообщений">${tabs}</nav><div class="ci-layout${state.selectedId?' ci-has-selection':''}"><aside class="ci-list" aria-label="Сообщения">${list||blank}${state.nextOffset!==null&&state.nextOffset!==undefined?button(state.loading?'Загружаю…':'Показать ещё','more',state.loading?'disabled':''):''}</aside><div class="ci-detail">${state.detailLoading?'<p class="ci-loading" role="status">Открываю сообщение…</p>':renderDetail(state.session,options)}</div></div>`}</section>`;
  }
  function errorMessage(error,action) {
    if(error?.code==='analysis_consent_required')return 'Разрешите разбор писем в настройках Gmail. До этого текст остаётся только в приложении.';
    if(error?.code==='source_superseded')return 'Для этой цепочки запрошен расширенный разбор. Обновите список входящих.';
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
    const state={items:[],filter:'pending',selectedId:text(options.selectedId),session:null,loading:false,detailLoading:UUID.test(text(options.selectedId)),error:'',authRequired:false,nextOffset:null};
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
        state.items=[...map.values()];state.nextOffset=result.nextOffset??null;
        if(state.authRequired&&state.session){state.session.error='';if(state.session.participantDraft)state.session.participantDraft.error='';}
        state.authRequired=false;
        if(view.CoSGmail?.request)state.gmail=await view.CoSGmail.request('status').catch(()=>state.gmail);
        if(disposed||n!==sequence)return;
        const selected=state.items.find(item=>item.id===state.selectedId);
        if(selected&&state.session&&selected.revision>state.session.item.revision&&!dirty(state.session)&&!state.session.busy&&!state.session.editing)accept(selected,false);
        if(state.selectedId&&(!state.session||state.session.item.id!==state.selectedId))await select(state.selectedId,false);
      }catch(error){if(disposed||n!==sequence)return;state.authRequired=error?.status===401;state.error=errorMessage(error,'load');if(state.authRequired){remember();state.items=[];}}
      finally{if(!disposed&&n===sequence){state.loading=false;draw();}}
    }
    async function select(id,notify=true) {
      if(disposed||!UUID.test(text(id))||state.session?.busy||state.session?.participantDraft?.busy)return false;
      if(state.selectedId!==id&&dirty(state.session)&&!ask('В этом сообщении есть неподтверждённые правки. Перейти к другому? Правки останутся в этой вкладке.'))return false;
      remember();const n=++detailSequence;
      state.selectedId=id;state.detailLoading=true;draw();
      try{
        const item=assertItem(await options.request(`/inbox/${encodeURIComponent(id)}`));
        if(disposed||n!==detailSequence)return false;
        const previousFilter=state.filter;accept(item);
        if(state.filter!==previousFilter){state.loading=false;load();}
        if(notify)options.onSelect?.(id);
      }catch(error){if(disposed||n!==detailSequence)return false;state.error=errorMessage(error,'load');if(error?.status===401){remember();state.authRequired=true;}}
      finally{if(!disposed&&n===detailSequence){state.detailLoading=false;draw();if(notify&&view.matchMedia?.('(max-width: 760px)').matches)container.querySelector?.('.ci-detail')?.scrollIntoView?.({block:'start',behavior:'smooth'});}}
      return true;
    }
    async function reloadDetail() {
      if(state.session?.busy||state.session?.participantDraft?.busy)return;
      if(!state.session)return select(state.selectedId,false);
      if(dirty(state.session)&&!ask('Загрузить актуальную версию? Неподтверждённые правки этого сообщения будут заменены.'))return;
      memory.delete(sessionKey(state.selectedId));state.session=null;
      await select(state.selectedId,false);
    }
    function restoreEdits(previous,item){
      accept(item,false);
      const next=state.session;next.correction=previous.correction;next.editing=previous.editing;
      for(const change of previous.proposal.changes){
        const before=previous.base.changes.find(c=>c.id===change.id),current=next.proposal.changes.find(c=>c.id===change.id);
        if(before&&current)for(const key of Object.keys(change))if(JSON.stringify(change[key])!==JSON.stringify(before[key]))current[key]=change[key]===undefined?undefined:clone(change[key]);
      }
      remember();return next;
    }
    async function persistContext(session){
      if(JSON.stringify(session.proposal.owner_context)===JSON.stringify(session.base.owner_context))return session;
      const result=await options.request('/inbox/'+session.item.id+'/setContext',{method:'POST',body:{revision:session.item.revision,...(session.proposal.owner_context||{project_id:null,participant_ids:[]})}});
      return restoreEdits(session,assertItem(result));
    }
    async function contextBeforeAction(session){
      session.busy=true;session.error='';draw();
      try{return await persistContext(session)}catch(error){session.error=errorMessage(error,'setContext');session.conflict=error?.status===409;return null}
      finally{session.busy=false;if(state.session)state.session.busy=false;remember();draw()}
    }
    async function addAction(kind){
      let session=state.session;
      if(!session||session.busy||session.participantDraft||session.loadingProject||session.conflict||['processing','applied'].includes(session.item.status)||disposed)return;
      if(session.pending&&(session.pending.action!=='addAction'||session.pending.body.kind!==kind))return;
      if(!session.pending){session=await contextBeforeAction(session);if(!session)return;session.pending={action:'addAction',body:{revision:session.item.revision,request_id:uuid(),kind}};}
      session.busy=true;session.error='';remember();draw();
      try{
        const item=assertItem(await options.request('/inbox/'+session.item.id+'/addAction',{method:'POST',body:clone(session.pending.body)}));
        if(disposed)return;const next=restoreEdits(session,item);next.editing=true;next.pending=null;next.busy=false;
        draw();container.querySelector?.('[data-ci-change="'+session.pending.body.request_id+'"][data-ci-field="text"]')?.focus?.();
      }catch(error){session.error=errorMessage(error,'addAction');session.conflict=error?.status===409;if([400,401,404,409,413,422].includes(error?.status))session.pending=null;}
      finally{session.busy=false;remember();draw()}
    }
    async function mutate(action) {
      let session=state.session;
      if(!session||session.busy||session.participantDraft||disposed)return;
      if(session.pending&&session.pending.action!==action)return;
      if(action==='apply'&&(session.conflict||session.loadingProject))return;
      if(!session.pending){session=await contextBeforeAction(session);if(!session)return;}
      let body;
      try{
        if(action==='apply')body=prepareSubmission(session,uuid(),options);
        else if(action==='defer'){
          if(session.correction.trim()&&!session.pending&&!ask('Отложить сообщение? Правки предложений сохранятся, а уточнение для повторного разбора останется только в этой вкладке.'))return;
          if(!session.pending)session.pending={action,body:{revision:session.item.revision,request_id:uuid(),...(Array.isArray(session.item.proposal?.changes)?{proposal:{version:1,changes:clone(session.proposal.changes)}}:{})}};
          body=clone(session.pending.body);
        }else{
          if(JSON.stringify(session.proposal.owner_context)!==JSON.stringify(session.base.owner_context))throw Error('Сначала нажмите «Сохранить связи».');
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
        memory.delete(sessionKey(item.id));accept(item,false);if(action==='analyze'&&item.status==='error'){state.session.editing=true;state.session.error=item.error_code==='invalid_analysis'?'Разбор не прошёл проверку. Уточнение сохранено. Попробуйте указать действие и срок одной фразой.':'Не удалось выполнить разбор. Уточнение сохранено; можно повторить попытку.';}
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
    function chooseParticipant(person,session=state.session) {
      const draft=session?.participantDraft;
      if(!draft||!person||!UUID.test(text(person.id))||typeof person.name!=='string'||!person.name.trim())throw Error('Сервер не подтвердил сохранение участника.');
      const change=session.proposal.changes.find(c=>c.id===draft.changeId);
      if(!change)throw Error('Предложение изменилось. Откройте карточку повторно.');
      if(!Array.isArray(options.participants))options.participants=[];
      const existing=options.participants.find(p=>p.id===person.id);
      if(existing)Object.assign(existing,person);else options.participants.push(person);
      change.participant_id=person.id;
      session.participantDraft=null;session.error='';remember();draw();
    }
    async function saveParticipant() {
      const session=state.session,draft=session?.participantDraft;
      if(!draft||draft.busy||session.busy||session.pending||disposed)return;
      draft.error='';draft.existing=null;
      if(!draft.pending){
        const name=draft.name.normalize('NFC').trim().replace(/\s+/gu,' ');
        if(!name||[...name].length>200||/[\u0000-\u001f\u007f-\u009f\p{Cs}]/u.test(draft.name)){draft.error='Укажите имя участника — от 1 до 200 символов.';draw();return;}
        const key=name.toLocaleLowerCase('ru');
        const duplicate=array(options.participants).find(p=>!p.deleted_at&&text(p.name).normalize('NFC').trim().replace(/\s+/gu,' ').toLocaleLowerCase('ru')===key);
        if(duplicate){draft.existing=duplicate;draft.error='Участник с таким именем уже есть. Выберите его или уточните имя, например добавьте компанию.';draw();return;}
        draft.name=name;draft.pending={id:uuid(),name};
      }
      draft.busy=true;remember();draw();
      try{
        const result=await options.request('/participants',{method:'POST',body:clone(draft.pending)});
        if(disposed||state.session!==session)return;
        const person=result?.participant;
        if(!person||person.id!==draft.pending.id||person.name!==draft.pending.name)throw Error('Сервер не подтвердил сохранение участника.');
        chooseParticipant(person,session);
      }catch(error){
        if(disposed||state.session!==session)return;
        const uncertain=error?.uncertain||!error?.status||error.status>=500||error.status===408;
        if(!uncertain)draft.pending=null;
        if(error?.code==='participant_exists'&&UUID.test(text(error.participant?.id))&&typeof error.participant?.name==='string')draft.existing=error.participant;
        draft.error=uncertain?'Сохранение пока не подтверждено. Нажмите «Проверить сохранение»: будет отправлен тот же запрос без создания копии.':error?.status===401?'Войдите через Google, затем вернитесь сюда и сохраните участника. Имя и правки остаются в этой вкладке.':({participant_exists:'Участник с таким именем уже есть. Выберите его или уточните имя.',invalid_participant:'Укажите имя участника — от 1 до 200 символов.',participant_request_conflict:'Запрос относится к другому участнику. Закройте форму и проверьте справочник.'})[error?.code]||'Не удалось сохранить участника. Проверьте имя и повторите попытку.';
        if(error?.status===401)state.authRequired=true;
      }finally{draft.busy=false;remember();draw();}
    }
    async function click(event) {
      const target=event.target?.closest?.('[data-ci-action]');
      if(!target||!container.contains(target)||target.disabled)return;
      const action=target.dataset.ciAction,session=state.session;
      if(action==='open-created'||action==='cancel-created'){
        if(!session||session.busy||session.item.status!=='applied')return;
        const change=array(session.item.applied_result?.changes).find(c=>c.id===target.dataset.ciChange&&['task_create','meeting_create'].includes(c.kind));
        if(!change||!UUID.test(change.after?.id||''))return;
        if(action==='open-created'){
          try{await options.onOpenRecord?.({kind:change.kind,id:change.after.id});}catch(error){session.error=error.message;draw();}return;
        }
        session.busy=true;session.error='';draw();
        try{const result=await options.request(`/inbox/${encodeURIComponent(session.item.id)}/cancel`,{method:'POST',body:{change_id:change.id}});if(disposed)return;accept(assertItem(result),false);try{await options.onChanged?.(state.session.item,'cancel');}catch{}}
        catch(error){if(!disposed){session.error=error?.status===409?'Запись уже изменена. Откройте её и отмените в карточке.':'Не удалось подтвердить отмену. Повторите попытку.';}}
        finally{session.busy=false;if(!disposed)draw();}return;
      }
      if(action==='add-action')return addAction(target.dataset.ciKind);
      if(action==='save-context'){
        if(!session||session.busy||session.pending)return;
        await contextBeforeAction(session);return;
      }
      if(action==='gmail-settings'){if(typeof window!=='undefined')window.CoSGmail?.open();return;}
      if(action==='gmail-expand'||action==='gmail-expand-older'){
        if(!session||session.busy||session.pending)return;
        if(dirty(session)){session.error='Сначала сохраните правки через «Разобрать позже» или завершите разбор.';draw();return;}
        const meta=session.item.source_meta;if(meta?.type!=='gmail')return;
        session.busy=true;draw();
        try{await window.CoSGmail.request('expand',{thread_id:meta.thread_id,revision:session.item.revision,context_days:action==='gmail-expand-older'?180:Number(meta.context_days)||90,message_limit:Math.min(50,(Number(meta.message_limit)||10)+10)});await reloadDetail();await window.CoSGmail.request('sync',{});await load();}
        catch(error){session.error=error.message;}finally{session.busy=false;draw();}return;
      }
      if(action==='select')return select(target.dataset.ciId);
      if(action==='filter'){if(state.filter===target.dataset.ciFilter)return;state.filter=target.dataset.ciFilter;state.items=[];state.nextOffset=null;state.loading=false;return load();}
      if(action==='reload')return load();
      if(action==='more')return load(true);
      if(action==='reload-detail')return reloadDetail();
      if(action==='participant-select'){
        if(!session||session.busy||session.pending||session.participantDraft||!editableStatuses.includes(session.item.status))return;
        const change=session.proposal.changes.find(c=>c.id===target.dataset.ciChange);
        const person=array(options.participants).find(p=>p.id===target.dataset.ciPerson);
        if(change&&person&&array(change.participant_suggestion?.existing_ids).includes(person.id)){change.participant_id=person.id;remember();draw();}return;
      }
      if(action==='participant-new'){
        if(!session||session.busy||session.pending||session.loadingProject||session.participantDraft?.busy||session.participantDraft?.pending||!editableStatuses.includes(session.item.status))return;
        const change=session.proposal.changes.find(c=>c.id===target.dataset.ciChange);
        if(!change||!['task_create','task_update','meeting_create','project_entry'].includes(change.kind))return;
        if(session.participantDraft?.changeId===change.id)return;
        if(session.participantDraft?.name.trim()&&!ask('Заменить несохранённое имя участника?'))return;
        if(!change.participant_suggestion)session.editing=true;
        session.participantDraft={changeId:change.id,name:change.participant_suggestion?.name||'',pending:null,busy:false,error:'',existing:null};remember();draw();
        container.querySelector?.('[data-ci-field="participant_name"]')?.focus?.();return;
      }
      if(action==='participant-save')return saveParticipant();
      if(action==='participant-existing'){if(session?.participantDraft?.existing&&!session.participantDraft.busy)chooseParticipant(session.participantDraft.existing);return;}
      if(action==='participant-cancel'){if(session?.participantDraft&&!session.participantDraft.busy){if(session.participantDraft.pending&&!ask('Сервер мог уже сохранить участника. Закрыть форму? Перед повторным созданием проверьте список участников.'))return;session.participantDraft=null;remember();draw();}return;}
      if(action==='edit'){if(session&&!session.busy&&!session.pending&&!session.participantDraft){session.editing=!session.editing;draw();}return;}
      if(action==='copy'){
        try{await view.navigator.clipboard.writeText(session.proposal.changes.filter(c=>c.selected!==false).map(c=>titleFor(c)+'\n'+c.text).join('\n\n'));session.error='Правки скопированы. Теперь можно загрузить актуальную версию.';}catch{session.error='Не удалось скопировать автоматически. Выделите и скопируйте текст правок вручную.';}draw();return;
      }
      if(['apply','defer','analyze'].includes(action))return mutate(action);
    }
    function input(event) {
      const target=event.target,session=state.session;
      if(!session||session.busy||session.pending||session.participantDraft?.busy||session.participantDraft?.pending||['applied','processing'].includes(session.item.status)||!target?.dataset?.ciField)return;
      const key=target.dataset.ciField;
      if(key==='context_project'||key==='context_people'){session.proposal.owner_context??={project_id:null,participant_ids:[]};if(key==='context_project')session.proposal.owner_context.project_id=target.value||null;else session.proposal.owner_context.participant_ids=[...target.selectedOptions].map(o=>o.value);remember();return;}
      if(key==='participant_name'){if(session.participantDraft){session.participantDraft.name=text(target.value);session.participantDraft.existing=null;remember();}return;}
      if(key==='correction'){session.correction=text(target.value);remember();return;}
      const change=session.proposal.changes.find(c=>c.id===target.dataset.ciChange);
      if(!change)return;
      if(key==='kind'){
        if(!['task_create','meeting_create'].includes(change.kind)||!['task_create','meeting_create'].includes(target.value))return;
        change.kind=target.value;
        if(change.kind==='meeting_create'){change.meeting_date??=change.planned_on||change.deadline||null;change.meeting_time??=change.planned_time||change.deadline_time||null;change.duration_minutes??=30;change.duration_estimated??=true;change.status=null;}
        else{change.status='open';change.planned_on??=change.meeting_date||null;change.planned_time??=change.meeting_time||null;}
        remember();draw();return;
      }
      if(key==='selected')change.selected=!!target.checked;
      else if(key==='duration_minutes'){change.duration_minutes=Number(target.value);change.duration_estimated=false;}
      else if(['text','project_id','participant_id','direction','status','deadline','deadline_time','next_check_on','planned_on','planned_time','entry_kind','meeting_date','meeting_time'].includes(key))change[key]=['project_id','participant_id','deadline','deadline_time','next_check_on','planned_on','planned_time','meeting_date','meeting_time'].includes(key)?target.value||null:text(target.value);
      else return;
      if(key==='planned_on'&&!change.planned_on)change.planned_time=null;
      if(key==='deadline'&&!change.deadline)change.deadline_time=null;
      remember();
      if(key==='project_id'){projectChanged(change);if(!['project_state','project_entry'].includes(change.kind))draw();}
      else if(key==='selected'||key==='direction'||key==='entry_kind')draw();
    }
    function beforeUnload(event){if(dirty(state.session)){event.preventDefault();event.returnValue='';}}
    container.onclick=click;container.oninput=input;
    view.addEventListener?.('beforeunload',beforeUnload);
    const refreshMail=()=>{if(!disposed&&!state.loading&&!state.detailLoading&&!dirty(state.session)&&!state.session?.busy&&!state.session?.editing)load()};
    view.addEventListener?.('cos-gmail-updated',refreshMail);
    const mailTimer=view.setInterval?.(()=>{if(state.gmail?.settings?.enabled&&(!view.document||view.document.visibilityState!=='hidden'))refreshMail()},15000);
    draw();load();
    return {
      dispose(){remember();disposed=true;sequence++;detailSequence++;if(pollTimer!==null)view.clearTimeout?.(pollTimer);container.onclick=null;container.oninput=null;view.removeEventListener?.('beforeunload',beforeUnload);view.removeEventListener?.('cos-gmail-updated',refreshMail);if(mailTimer!=null)view.clearInterval?.(mailTimer);container.querySelectorAll?.('audio').forEach(audio=>{audio.pause();audio.removeAttribute('src');audio.load();});},
      hasDraft:()=>dirty(state.session),
      isBusy:()=>!!state.session?.busy||!!state.session?.loadingProject||!!state.session?.participantDraft?.busy,
      canLeave:()=>!state.session?.busy&&!state.session?.participantDraft?.busy&&(!dirty(state.session)||ask('Есть неподтверждённые правки. Покинуть входящие? Они останутся в этой вкладке.')),
      select,
      reload:()=>load()
    };
  }
  return {mount,renderInbox,renderDetail,createSession,normalizedProposal,dirty,prepareSubmission,validateProposal,validDay,dayLabel,activeProjects,itemsForFilter,groupedItems,titleFor,errorMessage};
});
