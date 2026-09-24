(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) root.CoSProjectBrief = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  const drafts = new Map();
  const DRAFT_PREFIX = 'cos-project-brief-draft-v1:';
  const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
  const labels = { goal: 'Результат проекта', current_state: 'Что происходит сейчас', next_step: 'Следующее действие', checkpoint_label: 'Ближайшая проверка', checkpoint_on: 'Дата проверки', entries: 'Ожидания, вопросы и решения' };
  const kinds = { waiting: 'Ожидания', question: 'Открытые вопросы', decision: 'Решения' };
  const limits = { goal: 2000, current_state: 4000, next_step: 2000, checkpoint_label: 500 };
  const array = value => Array.isArray(value) ? value : [];
  const text = value => value == null ? '' : String(value);
  const clone = value => JSON.parse(JSON.stringify(value));
  const escape = value => text(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const emptyDocument = () => ({ goal: '', current_state: '', next_step: '', checkpoint_label: '', checkpoint_on: null, entries: [] });
  function validDay(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T12:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && +value.slice(0, 4) > 0;
  }
  function dayLabel(value) {
    if (!validDay(value)) return '';
    const [year, month, day] = value.split('-');
    return `${+day} ${['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'][+month - 1]} ${year}`;
  }
  function timestamp(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) || !validDay(value.slice(0, 10))) return null;
    const result = Date.parse(value);
    return Number.isFinite(result) ? result : null;
  }
  function timeLabel(value) {
    const at = timestamp(value);
    return at === null ? '' : new Date(at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function normalizedDocument(source) {
    const result = emptyDocument();
    for (const key of Object.keys(limits)) result[key] = text(source?.[key]);
    result.checkpoint_on = validDay(source?.checkpoint_on) ? source.checkpoint_on : null;
    result.entries = array(source?.entries).filter(entry => entry && Object.hasOwn(kinds, entry.kind) && entry.id).map(entry => ({
      id: text(entry.id), kind: entry.kind, text: text(entry.text), person: text(entry.person),
      review_on: entry.kind !== 'decision' && validDay(entry.review_on) ? entry.review_on : null,
      source: text(entry.source), status: entry.status === 'resolved' ? 'resolved' : 'open'
    }));
    return result;
  }
  function validateDocument(document) {
    for (const [key, limit] of Object.entries(limits)) if (text(document[key]).length > limit) return `${labels[key]}: не более ${limit} символов.`;
    if (document.checkpoint_on && !validDay(document.checkpoint_on)) return 'Укажите корректную дату проверки.';
    if (document.checkpoint_on && !text(document.checkpoint_label).trim()) return 'Напишите, что нужно проверить в указанную дату.';
    if (array(document.entries).length > 60) return 'В одном проекте можно сохранить до 60 ожиданий, вопросов и решений.';
    const ids = new Set();
    for (const entry of array(document.entries)) {
      if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(entry.id) || ids.has(entry.id)) return 'Не удалось определить запись. Откройте редактор заново.';
      ids.add(entry.id);
      if (!Object.hasOwn(kinds, entry.kind) || !['open', 'resolved'].includes(entry.status)) return 'Проверьте тип и состояние записи.';
      if (!text(entry.text).trim() || text(entry.text).length > 2000) return 'Добавьте текст каждой записи: от 1 до 2000 символов.';
      if (text(entry.person).length > 300 || text(entry.source).length > 1000) return 'Участник: до 300 символов. Источник: до 1000 символов.';
      if (entry.review_on && (!validDay(entry.review_on) || entry.kind === 'decision')) return 'Проверьте дату возврата к вопросу.';
    }
    return '';
  }
  function projectRows(rows, projectId) {
    const seen = new Set();
    return array(rows).filter(row => {
      if (!row || !row.id || text(row.project_id) !== text(projectId) || row.deleted_at || seen.has(text(row.id))) return false;
      seen.add(text(row.id)); return true;
    });
  }
  function buildModel({ project = {}, tasks = [], notes = [], meetings = [], participants = [], now = Date.now() } = {}, snapshot = null) {
    const taskRows = projectRows(tasks, project.id), active = taskRows.filter(task => !['completed', 'cancelled'].includes(task.status));
    const noteRows = projectRows(array(notes).map(row => row?.note ? { ...row.note, kind: row.kind } : row), project.id).filter(note => !note.archived_at);
    const meetingRows = projectRows(meetings, project.id).filter(meeting => meeting.status !== 'cancelled');
    const people = new Map(array(participants).filter(Boolean).map(person => [text(person.id), text(person.name)]));
    const waiting = active.filter(task => task.direction === 'to_me').map(task => ({ ...task, person: people.get(text(task.participant_id)) || '' }));
    const history = array(snapshot?.history).filter(item => timestamp(item?.created_at) !== null).map(item => ({
      kind: 'brief', id: text(item.revision), at: item.created_at, label: 'Обзор проекта уточнён',
      detail: array(item.changed_fields).map(field => labels[field]).filter(Boolean).join(', ')
    }));
    for (const [kind, rows] of [['task', taskRows], ['note', noteRows], ['meeting', meetingRows]]) for (const row of rows) {
      const updated = timestamp(row.updated_at), created = timestamp(row.created_at);
      const useUpdate = updated !== null && (created === null || updated > created);
      const at = useUpdate ? row.updated_at : created !== null ? row.created_at : null;
      if (!at) continue;
      history.push({ kind, id: text(row.id), at, label: `${({ task: 'Задача', note: 'Заметка', meeting: 'Встреча' })[kind]} ${useUpdate ? 'обновлена' : 'создана'}`, detail: text(row.description || row.title || row.plain_text).slice(0, 160) || 'Без названия' });
    }
    history.sort((a, b) => timestamp(b.at) - timestamp(a.at) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
    const currentTime = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now);
    const scheduled = meetingRows.filter(meeting => { const start = timestamp(meeting.starts_at), end = timestamp(meeting.ends_at) ?? (start === null ? null : start + 3600000); return Number.isFinite(currentTime) && end !== null && end > currentTime; });
    return { project, tasks: taskRows, active, waiting, notes: noteRows, meetings: meetingRows, scheduled, history: history.slice(0, 12), document: normalizedDocument(snapshot?.document) };
  }
  function createSession(snapshot) {
    const document = normalizedDocument(snapshot.document);
    return { revision: snapshot.revision, base: clone(document), document, pending: null, conflict: false, error: '', busy: false };
  }
  function dirty(session) { return !!session && (!!session.pending || JSON.stringify(session.document) !== JSON.stringify(session.base)); }
  function prepareSubmission(session, requestId) {
    if (session.pending) return clone(session.pending);
    session.document.entries.forEach(entry => { entry.text = entry.text.trim(); });
    const error = validateDocument(session.document);
    if (error) throw Error(error);
    session.pending = { revision: session.revision, request_id: requestId, document: clone(session.document) };
    return clone(session.pending);
  }
  // Only the known project draft schema is restored; storage is never trusted as server data.
  function parseStoredSession(raw, projectId) {
    if (typeof raw !== 'string' || raw.length > 1000000) return null;
    try {
      const value = JSON.parse(raw);
      if (value.schema !== 1 || value.project_id !== projectId || !Number.isSafeInteger(value.revision) || value.revision < 0) return null;
      function restoreDocument(source, allowEmptyEntries) {
        if (!source || typeof source !== 'object' || !Array.isArray(source.entries) || source.entries.length > 60) throw Error('Invalid draft');
        for (const [key, max] of Object.entries(limits)) if (typeof source[key] !== 'string' || source[key].length > max) throw Error('Invalid field');
        if (source.checkpoint_on !== null && !validDay(source.checkpoint_on)) throw Error('Invalid date');
        const ids = new Set();
        for (const item of source.entries) {
          if (!item || !UUID.test(item.id) || ids.has(item.id) || !Object.hasOwn(kinds, item.kind) || !['open', 'resolved'].includes(item.status)) throw Error('Invalid entry');
          ids.add(item.id);
          for (const [key, max] of [['text', 2000], ['person', 300], ['source', 1000]]) if (typeof item[key] !== 'string' || item[key].length > max) throw Error('Invalid entry field');
          if (!allowEmptyEntries && !item.text.trim()) throw Error('Empty entry');
          if (item.review_on !== null && (!validDay(item.review_on) || item.kind === 'decision')) throw Error('Invalid entry date');
        }
        return normalizedDocument(source);
      }
      const base = restoreDocument(value.base, false), document = restoreDocument(value.document, true);
      let pending = null;
      if (value.pending != null) {
        if (!UUID.test(value.pending.request_id) || value.pending.revision !== value.revision) return null;
        const pendingDocument = restoreDocument(value.pending.document, false);
        if (validateDocument(pendingDocument)) return null;
        pending = { revision: value.revision, request_id: value.pending.request_id, document: pendingDocument };
      }
      return { revision: value.revision, base, document, pending, conflict: value.conflict === true, busy: false, error: '', restored: true };
    } catch { return null; }
  }
  function serializeSession(session, projectId) {
    const result = JSON.stringify({ schema: 1, project_id: projectId, revision: session.revision, base: session.base, document: session.document, pending: session.pending, conflict: session.conflict });
    if (result.length > 1000000) throw Error('Draft backup is too large');
    return result;
  }
  function assertSnapshot(value, projectId) {
    if (!value || value.project_id !== projectId || !Number.isSafeInteger(value.revision) || value.revision < 0 || !value.document || !Array.isArray(value.document.entries)) throw Error('Сервер не подтвердил состояние проекта. Повторите запрос.');
    return { ...value, document: normalizedDocument(value.document), history: array(value.history) };
  }
  function errorMessage(error) {
    if (error?.status === 401) return 'Войдите через Google, чтобы сохранить обзор проекта. Черновик остаётся в редакторе.';
    if (error?.status === 409) return 'Обзор изменился в другом окне. Ваш черновик сохранён здесь. Скопируйте его перед загрузкой актуальной версии.';
    if (error?.code === 'project_brief_too_large') return 'Обзор получился слишком большим. Сократите длинные записи или перенесите подробности в заметки.';
    if (error?.status === 404) return 'Проект не найден. Ваш черновик остаётся в редакторе.';
    if ([400, 413, 422].includes(error?.status)) return 'Сервер не принял запись. Проверьте поля и длину текста.';
    return 'Сохранение не подтверждено. Повторите отправку: будет проверен тот же запрос, без повторного изменения.';
  }
  function button(label, action, extra = '') { return `<button type="button" class="pb-link" data-pb-action="${action}" ${extra}>${label}</button>`; }
  function entryHTML(entry) {
    return `<li class="pb-entry ${entry.status === 'resolved' ? 'pb-resolved' : ''}"><p>${escape(entry.text)}</p>${entry.person ? `<span class="pb-person">${escape(entry.person)}</span>` : ''}${entry.review_on ? `<span class="pb-meta">Вернуться к вопросу: ${escape(dayLabel(entry.review_on))}</span>` : ''}${entry.source ? `<span class="pb-source">Основание: ${escape(entry.source)}</span>` : ''}${entry.status === 'resolved' ? '<span class="pb-meta">Закрыто вами</span>' : ''}</li>`;
  }
  function renderOverview(model, state = {}) {
    const doc = model.document, snapshot = state.snapshot;
    const editable = (!!snapshot || state.hasDraft) && !state.loading;
    const card = (key, placeholder, lead = false, details = '') => {
      const action = editable ? 'edit-field' : state.authRequired ? 'login' : 'reload';
      const hint = state.loading ? 'Загружаю…' : editable ? (doc[key] ? 'Изменить' : 'Заполнить') : state.authRequired ? 'Войти и заполнить' : 'Повторить загрузку';
      return `<button type="button" class="pb-card pb-summary-card ${lead ? 'pb-state' : ''}" data-pb-action="${action}" data-pb-edit-field="${key}" aria-label="${escape(labels[key] + ': ' + hint)}" ${state.loading ? 'disabled aria-busy="true"' : ''}><span class="pb-caption">${labels[key]}</span><span class="${doc[key] ? 'pb-value' : 'pb-placeholder'}">${escape(doc[key] || placeholder)}</span>${details}<span class="pb-card-action">${hint}<span aria-hidden="true"> ↗</span></span></button>`;
    };
    const status = state.loading ? '<span class="pb-status" role="status">Загружаю уточнения…</span>' : state.authRequired ? `<div class="pb-auth"><span>Личные уточнения доступны после входа.</span>${button('Войти через Google', 'login')}</div>` : state.error ? `<div class="pb-auth pb-error" role="alert"><span>${escape(state.error)}</span>${button('Повторить', 'reload')}</div>` : snapshot?.updated_at ? `<span class="pb-status">Уточнено вами · ${escape(timeLabel(snapshot.updated_at))}</span>` : '<span class="pb-status">Можно начать с одного поля; даты необязательны.</span>';
    const waiting = model.waiting.slice(0, 5).map(task => `<li class="pb-record">${button(escape(task.description || 'Задача без названия'), 'task', `data-pb-id="${escape(task.id)}"`)}<span class="pb-meta">Из задачи${task.person ? ' · ' + escape(task.person) : ''}${task.status === 'paused' ? ' · на паузе' : ''}</span></li>`).join('');
    const group = kind => {
      const open = doc.entries.filter(entry => entry.kind === kind && entry.status === 'open');
      const closed = doc.entries.filter(entry => entry.kind === kind && entry.status === 'resolved');
      const empty = { waiting: 'Уточните, от кого и какого результата ждёте.', question: 'Какие вопросы нужно решить, чтобы двигаться дальше?', decision: 'Зафиксируйте согласованное, когда появится первое решение.' };
      return `<section class="pb-card pb-entry-card"><div class="pb-card-head"><h3>${kinds[kind]}</h3><span class="pb-count">${open.length}${kind === 'waiting' && model.waiting.length ? ` + ${model.waiting.length} из задач` : ''}</span></div>${open.length ? `<ul class="pb-entries">${open.map(entryHTML).join('')}</ul>` : `<p class="pb-empty">${empty[kind]}</p>`}${kind === 'waiting' && waiting ? `<div class="pb-auto-label">Ожидания из задач</div><ul class="pb-records">${waiting}</ul>${model.waiting.length > 5 ? `<p class="pb-meta">Всего таких задач: ${model.waiting.length}. Полный список — во вкладке «Задачи».</p>` : ''}` : ''}${closed.length ? `<details class="pb-closed"><summary>Закрытые записи · ${closed.length}</summary><ul class="pb-entries">${closed.map(entryHTML).join('')}</ul></details>` : ''}${editable ? button(kind === 'waiting' ? '＋ Добавить ожидание' : kind === 'question' ? '＋ Добавить вопрос' : '＋ Зафиксировать решение', 'add', `data-pb-kind="${kind}"`) : ''}</section>`;
    };
    const recentNotes = [...model.notes].sort((a, b) => (timestamp(b.updated_at || b.created_at) || 0) - (timestamp(a.updated_at || a.created_at) || 0)).slice(0, 4);
    const upcoming = [...model.scheduled].sort((a, b) => (timestamp(a.starts_at) || Infinity) - (timestamp(b.starts_at) || Infinity)).slice(0, 4);
    const history = model.history.map(item => `<li><time>${escape(timeLabel(item.at))}</time><div><span class="pb-history-label">${item.label}</span>${item.kind === 'brief' ? `<p>${escape(item.detail || 'Уточнения проекта')}</p>` : button(escape(item.detail), item.kind, `data-pb-id="${escape(item.id)}"`)}</div></li>`).join('');
    return `<section class="pb-overview" aria-label="Состояние проекта"><header class="pb-head"><div><span class="pb-eyebrow">Рабочий обзор</span><h2>Проект в контексте</h2><p>Состояние, договорённости и ближайший шаг.</p></div>${editable ? `<button type="button" class="pb-button" data-pb-action="edit">${state.hasDraft ? 'Продолжить редактирование' : 'Уточнить проект'}</button>` : ''}</header><div class="pb-status-row">${status}</div><div class="pb-summary-grid">${card('current_state', 'Что сейчас происходит с проектом?', true)}${card('next_step', 'Какое действие продвинет проект?')}${card('goal', 'Какой результат нужен по проекту?')}${card('checkpoint_label', 'К какому вопросу нужно вернуться?', false, `${doc.checkpoint_on ? `<span class="pb-check-date">${escape(dayLabel(doc.checkpoint_on))}</span>` : '<span class="pb-meta">Дата не назначена</span>'}<span class="pb-meta">Дата возврата к вопросу; срок задачи задаётся в самой задаче.</span>`)}</div><div class="pb-facts" aria-label="Факты из записей проекта"><span><b>${model.active.length}</b> открытых задач</span><span><b>${model.waiting.length}</b> ожиданий в задачах</span><span><b>${model.notes.length}</b> заметок с медиа</span><span><b>${model.meetings.length}</b> встреч</span><span class="pb-facts-source">Из записей проекта</span></div>${!model.active.length ? '<p class="pb-no-tasks">Открытых задач нет. Состояние проекта можно уточнить отдельно — работа может продолжаться через ожидания и согласования.</p>' : ''}<div class="pb-body-grid"><div class="pb-main-column">${group('waiting')}${group('question')}${group('decision')}<div class="pb-bottom-action">${button('＋ Создать задачу', 'create-task')}</div></div><aside class="pb-side-column"><section class="pb-card"><div class="pb-card-head"><h3>Материалы и встречи</h3></div>${recentNotes.length ? `<ul class="pb-records">${recentNotes.map(note => `<li class="pb-record">${button(escape(note.title || text(note.plain_text).slice(0, 90) || 'Заметка без названия'), 'note', `data-pb-id="${escape(note.id)}"`)}<span class="pb-meta">${note.source === 'telegram' ? 'Заметка из Telegram' : 'Заметка с медиа'}${timeLabel(note.updated_at || note.created_at) ? ' · ' + escape(timeLabel(note.updated_at || note.created_at)) : ''}</span></li>`).join('')}</ul>` : '<p class="pb-empty">Заметок с медиа пока нет.</p>'}${upcoming.length ? `<div class="pb-auto-label">Встречи в расписании</div><ul class="pb-records">${upcoming.map(meeting => `<li class="pb-record">${button(escape(meeting.title || 'Встреча без названия'), 'meeting', `data-pb-id="${escape(meeting.id)}"`)}<span class="pb-meta">${escape(timeLabel(meeting.starts_at) || 'Время не указано')}</span></li>`).join('')}</ul>` : '<p class="pb-empty">Встреч в расписании нет.</p>'}</section><section class="pb-card"><div class="pb-card-head"><h3>Хронология записей</h3></div>${history ? `<ol class="pb-history">${history}</ol>` : '<p class="pb-empty">Здесь появятся изменения обзора, задач, заметок и встреч с известной датой.</p>'}<p class="pb-history-note">По доступным задачам, заметкам с медиа и встречам. Даты изменения записей не означают завершение работы.</p></section></aside></div></section>`;
  }
  function draftText(document, title) {
    return [`Проект: ${title}`, ...Object.keys(limits).map(key => `${labels[key]}\n${document[key] || '—'}`), `Дата проверки: ${document.checkpoint_on || 'не назначена'}`, ...array(document.entries).map(entry => `${kinds[entry.kind]}${entry.status === 'resolved' ? ' · закрыто' : ''}\n${entry.text}${entry.person ? '\nУчастник: ' + entry.person : ''}${entry.review_on ? '\nВернуться: ' + entry.review_on : ''}${entry.source ? '\nОснование: ' + entry.source : ''}`)].join('\n\n');
  }
  function mount(container, options = {}) {
    if (!container || !options.project?.id || typeof options.request !== 'function') throw Error('Не задан проект или источник обзора.');
    const projectId = text(options.project.id), documentNode = container.ownerDocument || globalThis.document;
    const view = documentNode?.defaultView || globalThis;
    let disposed = false, requestSequence = 0, snapshot = null, loading = false, loadError = '', authRequired = false;
    let session = drafts.get(projectId) || null, dialog = null;
    const storageKey = DRAFT_PREFIX + projectId;
    if (!session) { try { session = parseStoredSession(view.sessionStorage?.getItem(storageKey), projectId); } catch {} }
    const uuid = () => view.crypto.randomUUID();
    const confirm = message => typeof view.confirm === 'function' && view.confirm(message);
    const changed = () => dirty(session);
    function clearDraft() {
      drafts.delete(projectId);
      try { view.sessionStorage?.removeItem(storageKey); } catch {}
    }
    function remember() {
      if (session && (changed() || session.conflict)) {
        drafts.set(projectId, session);
        try { if (!view.sessionStorage) throw Error('Storage unavailable'); view.sessionStorage.setItem(storageKey, serializeSession(session, projectId)); session.backupFailed = false; }
        catch { session.backupFailed = true; }
      } else clearDraft();
    }
    function draw() {
      if (disposed) return;
      container.innerHTML = renderOverview(buildModel(options, snapshot), { snapshot, loading, error: loadError, authRequired, hasDraft: !!session && changed() });
    }
    async function load() {
      if (loading || disposed) return;
      const sequence = ++requestSequence; loading = true; loadError = ''; draw();
      try {
        const result = assertSnapshot(await options.request(), projectId);
        if (disposed || sequence !== requestSequence) return;
        snapshot = result; authRequired = false;
      } catch (error) {
        if (disposed || sequence !== requestSequence) return;
        authRequired = error?.status === 401;
        loadError = authRequired ? '' : 'Не удалось загрузить уточнения проекта. Записи ниже остаются доступны.';
      } finally { if (!disposed && sequence === requestSequence) { loading = false; draw(); } }
    }
    function syncInputs() {
      if (!dialog || !session || session.pending || session.conflict || session.busy) return;
      dialog.querySelectorAll('[data-pb-field]').forEach(input => { session.document[input.dataset.pbField] = input.dataset.pbField === 'checkpoint_on' ? input.value || null : input.value; });
      dialog.querySelectorAll('[data-pb-entry-field]').forEach(input => {
        const entry = session.document.entries.find(row => row.id === input.dataset.pbEntryId);
        if (entry) entry[input.dataset.pbEntryField] = input.dataset.pbEntryField === 'review_on' ? input.value || null : input.value;
      });
      remember();
    }
    function closeEditor(discard = false) {
      if (session?.busy) return false;
      syncInputs();
      if (!discard && changed() && !confirm(session.pending ? 'Сохранение ещё не подтверждено. Закрыть редактор? Черновик и запрос останутся здесь до следующего открытия.' : 'Закрыть редактор без сохранения изменений?')) return false;
      if (!session?.pending && !session?.conflict) { session = null; clearDraft(); }
      if (dialog) { dialog.close?.(); dialog.remove(); dialog = null; }
      draw(); return true;
    }
    function inputHTML(key, placeholder) {
      const isDate = key === 'checkpoint_on';
      return `<label class="pb-field">${labels[key]}${isDate ? `<input data-pb-field="${key}" type="date" value="${escape(session.document[key] || '')}">` : `<textarea data-pb-field="${key}" maxlength="${limits[key]}" rows="${key === 'current_state' ? 3 : 2}" placeholder="${escape(placeholder)}">${escape(session.document[key])}</textarea>`}</label>`;
    }
    function editorEntry(entry, index) {
      return `<section class="pb-edit-entry" data-pb-entry="${escape(entry.id)}"><div class="pb-edit-entry-head"><b>${kinds[entry.kind]} · ${index + 1}${entry.status === 'resolved' ? ' · закрыто' : ''}</b><div>${button(entry.status === 'resolved' ? 'Открыть снова' : 'Закрыть запись', 'resolve', `data-pb-id="${escape(entry.id)}"`)}${button('Удалить', 'remove', `data-pb-id="${escape(entry.id)}"`)}</div></div><label class="pb-field">${entry.kind === 'decision' ? 'Что согласовано' : entry.kind === 'waiting' ? 'Какого результата ждём' : 'Что нужно выяснить'}<textarea data-pb-entry-field="text" data-pb-entry-id="${escape(entry.id)}" rows="2" maxlength="2000" required>${escape(entry.text)}</textarea></label><div class="pb-editor-grid"><label class="pb-field">${entry.kind === 'decision' ? 'Кто согласовал' : 'Кто участвует'}<input data-pb-entry-field="person" data-pb-entry-id="${escape(entry.id)}" list="pb-people" maxlength="300" value="${escape(entry.person)}" placeholder="Необязательно"></label>${entry.kind !== 'decision' ? `<label class="pb-field">Когда вернуться к вопросу<input type="date" data-pb-entry-field="review_on" data-pb-entry-id="${escape(entry.id)}" value="${escape(entry.review_on || '')}"></label>` : ''}</div><label class="pb-field">Основание<input data-pb-entry-field="source" data-pb-entry-id="${escape(entry.id)}" maxlength="1000" value="${escape(entry.source)}" placeholder="Например, встреча или сообщение; необязательно"></label></section>`;
    }
    function drawEditor(focusEntry = null) {
      if (!dialog || !session) return;
      const locked = session.busy || !!session.pending || session.conflict;
      const activeElement = documentNode.activeElement;
      const focused = activeElement && dialog.contains(activeElement) ? { field: activeElement.dataset?.pbField, entry: activeElement.dataset?.pbEntryId, entryField: activeElement.dataset?.pbEntryField } : null;
      dialog.innerHTML = `<form class="pb-editor" novalidate><header class="pb-editor-head"><div><span class="pb-eyebrow">${escape(options.project.title || 'Проект')}</span><h2 id="pb-editor-title">Уточнить проект</h2><p>Заполните то, что уже известно. Остальное можно добавить позже.</p></div><button type="button" class="pb-close" data-pb-action="close" aria-label="Закрыть редактор" ${session.busy ? 'disabled' : ''}>×</button></header><div class="pb-editor-scroll"><fieldset ${locked ? 'disabled' : ''}>${inputHTML('current_state', 'Что сейчас происходит?')}${inputHTML('goal', 'Какой результат нужен?')}${inputHTML('next_step', 'Что продвинет работу?')}<div class="pb-editor-grid">${inputHTML('checkpoint_label', 'Что нужно проверить?')}${inputHTML('checkpoint_on')}</div><p class="pb-editor-hint">Даты необязательны. Проверка помогает вернуться к вопросу; она не создаёт событие в календаре и не меняет срок задачи.</p><div class="pb-edit-entries">${session.document.entries.map(editorEntry).join('')}</div><div class="pb-add-actions">${Object.entries(kinds).map(([kind, label]) => button('＋ ' + label, 'add-entry', `data-pb-kind="${kind}" ${session.document.entries.length >= 60 ? 'disabled' : ''}`)).join('')}</div></fieldset><datalist id="pb-people">${array(options.participants).filter(person => person?.name).map(person => `<option value="${escape(person.name)}"></option>`).join('')}</datalist><p class="pb-editor-error" role="alert">${escape(session.error)}</p>${session.conflict ? `<div class="pb-conflict-actions">${button('Скопировать черновик', 'copy')}${button('Загрузить актуальную версию', 'reload-editor')}</div>` : session.pending && !session.busy ? '<p class="pb-editor-hint">До подтверждения запроса поля временно заблокированы. Повторная отправка безопасна.</p>' : ''}${session.backupFailed ? '<p class="pb-editor-hint">Браузер не сохранил резервный черновик. Скачайте его перед входом или перезагрузкой страницы.</p>' : session.restored ? '<p class="pb-editor-hint">Восстановлен несохранённый черновик из этой вкладки браузера.</p>' : ''}${authRequired ? button('Войти через Google', 'login') : ''}</div><footer class="pb-editor-footer"><span class="pb-editor-hint" role="status">${session.busy ? 'Сохраняю…' : changed() ? 'Есть несохранённые изменения' : 'Изменения появятся в обзоре после сохранения'}</span><div>${button('Скачать черновик', 'download', session.busy ? 'disabled' : '')}<button type="button" class="pb-button pb-secondary" data-pb-action="close" ${session.busy ? 'disabled' : ''}>Отмена</button><button type="submit" class="pb-button" ${session.busy || session.conflict ? 'disabled' : ''}>${session.pending ? 'Повторить сохранение' : 'Сохранить'}</button></div></footer></form>`;
      const form = dialog.querySelector('form');
      form.onsubmit = event => { event.preventDefault(); save(); };
      form.oninput = () => { syncInputs(); const status = dialog.querySelector('.pb-editor-footer [role="status"]'); if (status) status.textContent = changed() ? 'Есть несохранённые изменения' : 'Изменения появятся в обзоре после сохранения'; };
      dialog.onclick = handleEditorClick;
      if (focusEntry) dialog.querySelector(`[data-pb-entry="${focusEntry}"] textarea`)?.focus();
      else if (focused?.field) dialog.querySelector(`[data-pb-field="${focused.field}"]`)?.focus();
      else if (focused?.entry) dialog.querySelector(`[data-pb-entry-id="${focused.entry}"][data-pb-entry-field="${focused.entryField}"]`)?.focus();
    }
    function openEditor(kind = null, focusField = 'current_state') {
      if ((!snapshot && !session) || disposed || loading) return;
      if (!session) session = createSession(snapshot);
      let entryId = null;
      if (kind && Object.hasOwn(kinds, kind) && !session.pending && !session.conflict && session.document.entries.length < 60) {
        entryId = uuid(); session.document.entries.push({ id: entryId, kind, text: '', person: '', review_on: null, source: '', status: 'open' }); remember();
      }
      if (!dialog) {
        dialog = documentNode.createElement('dialog'); dialog.className = 'pb-dialog'; dialog.setAttribute('aria-labelledby', 'pb-editor-title');
        dialog.addEventListener('cancel', event => { event.preventDefault(); closeEditor(); });
        documentNode.body.appendChild(dialog);
      }
      drawEditor(entryId); dialog.showModal();
      if (!entryId) dialog.querySelector(`[data-pb-field="${Object.hasOwn(limits, focusField) ? focusField : 'current_state'}"]`)?.focus();
    }
    async function save() {
      if (!session || session.busy || session.conflict) return;
      syncInputs();
      let body;
      try { body = prepareSubmission(session, session.pending?.request_id || uuid()); }
      catch (error) { session.error = error.message; drawEditor(); return; }
      const savingSession = session; savingSession.busy = true; savingSession.error = ''; remember(); drawEditor();
      try {
        const result = assertSnapshot(await options.request({ method: 'PATCH', body }), projectId);
        snapshot = result; authRequired = false; savingSession.pending = null; savingSession.busy = false;
        if (drafts.get(projectId) === savingSession) clearDraft();
        if (session === savingSession) { session = null; if (dialog) { dialog.close?.(); dialog.remove(); dialog = null; } }
        if (!disposed) draw();
      } catch (error) {
        savingSession.busy = false; savingSession.error = errorMessage(error);
        if (error?.status === 409) { savingSession.pending = null; savingSession.conflict = true; }
        else if (error?.status && error.status < 500 && error.status !== 408) savingSession.pending = null;
        authRequired = error?.status === 401;
        drafts.set(projectId, savingSession);
        try { view.sessionStorage?.setItem(storageKey, serializeSession(savingSession, projectId)); } catch { savingSession.backupFailed = true; }
        if (!disposed) drawEditor();
      }
    }
    async function copyDraft() {
      syncInputs();
      try { await view.navigator.clipboard.writeText(draftText(session.document, options.project.title)); session.error = 'Черновик скопирован. Можно загрузить актуальную версию.'; }
      catch { session.error = 'Не удалось скопировать. Используйте «Скачать черновик».'; }
      drawEditor();
    }
    function downloadDraft() {
      syncInputs();
      const blob = new view.Blob([draftText(session.document, options.project.title)], { type: 'text/plain;charset=utf-8' });
      const url = view.URL.createObjectURL(blob), link = documentNode.createElement('a');
      link.href = url; link.download = 'project-draft.txt'; documentNode.body.appendChild(link); link.click(); link.remove();
      view.setTimeout(() => view.URL.revokeObjectURL(url), 1000);
    }
    async function reloadEditor() {
      if (session?.busy || !confirm('Загрузить актуальную версию? Текст текущего черновика будет заменён. Сначала скопируйте или скачайте его, если он нужен.')) return;
      const previous = session; previous.busy = true; drawEditor();
      try { const result = assertSnapshot(await options.request(), projectId); snapshot = result; session = createSession(result); clearDraft(); authRequired = false; if (!disposed) { draw(); drawEditor(); } }
      catch (error) { previous.error = error.status === 401 ? 'Для загрузки актуальной версии нужен вход через Google.' : 'Не удалось загрузить актуальную версию. Черновик сохранён.'; }
      finally { previous.busy = false; if (!disposed) drawEditor(); }
    }
    function handleEditorClick(event) {
      const target = event.target.closest('[data-pb-action]');
      if (!target || !dialog?.contains(target) || target.disabled || session?.busy) return;
      const action = target.dataset.pbAction;
      if (action === 'close') return closeEditor();
      if (action === 'copy') return void copyDraft();
      if (action === 'download') return downloadDraft();
      if (action === 'reload-editor') return void reloadEditor();
      if (action === 'login') { syncInputs(); remember(); if (session.backupFailed && !confirm('Браузер не смог сохранить резервный черновик. Перед входом скачайте его, чтобы не потерять текст при переходе в Google. Продолжить вход?')) return; return options.onLogin?.(); }
      if (session.pending || session.conflict) return;
      syncInputs();
      if (action === 'add-entry' && Object.hasOwn(kinds, target.dataset.pbKind) && session.document.entries.length < 60) {
        const id = uuid(); session.document.entries.push({ id, kind: target.dataset.pbKind, text: '', person: '', review_on: null, source: '', status: 'open' }); remember(); drawEditor(id); return;
      }
      const entry = session.document.entries.find(row => row.id === target.dataset.pbId);
      if (!entry) return;
      if (action === 'remove' && confirm('Удалить запись из черновика? Изменение вступит в силу после сохранения.')) session.document.entries = session.document.entries.filter(row => row.id !== entry.id);
      if (action === 'resolve') entry.status = entry.status === 'resolved' ? 'open' : 'resolved';
      remember(); drawEditor();
    }
    container.onclick = event => {
      const target = event.target.closest('[data-pb-action]');
      if (!target || !container.contains(target) || disposed || target.disabled) return;
      const action = target.dataset.pbAction, id = target.dataset.pbId, model = buildModel(options, snapshot);
      if (action === 'edit') return openEditor();
      if (action === 'edit-field') return openEditor(null, target.dataset.pbEditField);
      if (action === 'add') return openEditor(target.dataset.pbKind);
      if (action === 'login') return options.onLogin?.();
      if (action === 'reload') return void load();
      if (action === 'create-task') return options.onCreateTask?.();
      const records = { task: model.tasks, note: model.notes, meeting: model.meetings };
      if (!records[action]?.some(row => text(row.id) === id)) return;
      ({ task: options.onTask, note: options.onNote, meeting: options.onMeeting })[action]?.(id);
    };
    const beforeUnload = event => { if (changed() || session?.busy) { event.preventDefault(); event.returnValue = ''; } };
    view.addEventListener?.('beforeunload', beforeUnload);
    draw(); void load();
    return {
      hasDraft: () => !!dialog && changed(), isBusy: () => !!session?.busy,
      canLeave() {
        if (session?.busy) { options.onError?.('Дождитесь завершения сохранения обзора.'); return false; }
        if (!dialog) return true;
        return closeEditor();
      },
      dispose() {
        if (disposed) return;
        syncInputs(); remember(); disposed = true; requestSequence++;
        if (dialog) { dialog.close?.(); dialog.remove(); dialog = null; }
        container.onclick = null; view.removeEventListener?.('beforeunload', beforeUnload);
      }
    };
  }
  return { mount, emptyDocument, validDay, dayLabel, normalizedDocument, validateDocument, buildModel, createSession, dirty, prepareSubmission, parseStoredSession, serializeSession, assertSnapshot, renderOverview, draftText };
});
