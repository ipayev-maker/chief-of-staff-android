(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) root.CoSCalendarView = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const pad = value => String(value).padStart(2, '0');
  const leap = year => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = (year, month) => month === 2 ? (leap(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  function parseDay(value) {
    const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    const [year, month, day] = match.slice(1).map(Number);
    return year > 0 && month > 0 && month <= 12 && day > 0 && day <= daysInMonth(year, month) ? { year, month, day } : null;
  }
  const isoDay = ({ year, month, day }) => `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
  function arithmeticDate(value) {
    const parts = parseDay(value);
    if (!parts) return null;
    const date = new Date(0);
    date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
    date.setUTCHours(0, 0, 0, 0);
    return date;
  }
  function addDays(value, amount) {
    const date = arithmeticDate(value);
    if (!date || !Number.isInteger(amount)) return null;
    date.setUTCDate(date.getUTCDate() + amount);
    return date.getUTCFullYear() > 0 && date.getUTCFullYear() <= 9999 ? isoDay({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }) : null;
  }
  function addMonths(value, amount) {
    const parts = parseDay(value);
    if (!parts || !Number.isInteger(amount)) return null;
    const index = (parts.year - 1) * 12 + parts.month - 1 + amount;
    if (index < 0 || index >= 9999 * 12) return null;
    const year = Math.floor(index / 12) + 1, month = index % 12 + 1;
    return isoDay({ year, month, day: Math.min(parts.day, daysInMonth(year, month)) });
  }
  function monthGrid(value) {
    const parts = parseDay(value);
    if (!parts) return [];
    const first = isoDay({ ...parts, day: 1 });
    const offset = (arithmeticDate(first).getUTCDay() + 6) % 7;
    return Array.from({ length: 42 }, (_, index) => addDays(first, index - offset));
  }
  // Date-only values stay as date parts. Only timestamp values enter the local timezone.
  function localDay(date = new Date()) {
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
    const value = isoDay({ year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() });
    return parseDay(value) ? value : null;
  }
  function instant(value) {
    if (typeof value !== 'string') return null;
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
    if (!match || !parseDay(match[1]) || +match[2] > 23 || +match[3] > 59 || +(match[4] || 0) > 59) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && localDay(date) ? date : null;
  }
  function taskDeadline(task) {
    if (task.deadline_at) {
      const start = instant(task.deadline_at);
      return start ? { day: localDay(start), start } : null;
    }
    return parseDay(task.deadline) ? { day: task.deadline, start: null } : null;
  }
  function projectRecords({ tasks = [], meetings = [], projects = [] } = {}, filters = {}) {
    const records = [], seen = new Set(), titles = new Map(projects.map(project => [String(project.id), String(project.title || 'Без названия')]));
    let undatedTasks = 0, invalidDates = 0;
    function base(source, kind) {
      if (!source || source.id == null || source.id === '') return null;
      const id = String(source.id), key = `${kind}:${id}`, projectId = source.project_id ? String(source.project_id) : '';
      if (seen.has(key)) return null;
      seen.add(key);
      if (source.status === 'cancelled' || kind === 'task' && source.status === 'completed' && !filters.completed) return null;
      if (filters.projectId && (filters.projectId === '__none__' ? !!projectId : projectId !== filters.projectId)) return null;
      return { key, id, kind, projectId, projectTitle: projectId ? titles.get(projectId) || 'Проект' : 'Без проекта', status: source.status || '', title: String((kind === 'task' ? source.description : source.title) || (kind === 'task' ? 'Задача без названия' : 'Встреча без названия')) };
    }
    if (filters.tasks !== false) for (const task of tasks) {
      const record = base(task, 'task');
      if (!record) continue;
      const deadline = taskDeadline(task);
      if (!deadline) { if (task.deadline_at || task.deadline) invalidDates++; else undatedTasks++; continue; }
      records.push({ ...record, ...deadline, lastDay: deadline.day, end: null });
    }
    if (filters.meetings !== false) for (const meeting of meetings) {
      const record = base(meeting, 'meeting'), start = meeting && instant(meeting.starts_at);
      if (!record) continue;
      if (!start) { invalidDates++; continue; }
      const candidateEnd = instant(meeting.ends_at), end = candidateEnd && candidateEnd > start ? candidateEnd : null;
      const day = localDay(start);
      // End is exclusive: a meeting ending at midnight is not shown on the next day.
      const lastDay = end ? localDay(new Date(end.getTime() - 1)) : day;
      records.push({ ...record, day, lastDay, start, end });
    }
    return { records, undatedTasks, invalidDates };
  }
  function recordsForDay(records, day) {
    if (!parseDay(day)) return [];
    return records.filter(record => record.day <= day && record.lastDay >= day).sort((a, b) => {
      // Date-only deadlines lead the day; timed records follow chronologically.
      const aTime = a.start ? (a.day < day ? -Infinity : a.start.getTime()) : -Infinity;
      const bTime = b.start ? (b.day < day ? -Infinity : b.start.getTime()) : -Infinity;
      return (aTime === bTime ? 0 : aTime < bTime ? -1 : 1) || a.title.localeCompare(b.title, 'ru');
    });
  }

  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const months = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  const monthForms = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const weekNames = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
  const dateLabel = day => { const parts = parseDay(day); return parts ? `${parts.day} ${monthForms[parts.month - 1]} ${parts.year}` : ''; };
  const timeLabel = date => date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const shortDate = day => { const parts = parseDay(day); return `${parts.day} ${monthForms[parts.month - 1]}`; };
  function recordTime(record) {
    if (record.kind === 'task') return record.start ? `Срок ${timeLabel(record.start)}` : 'Срок без времени';
    if (!record.end) return `${timeLabel(record.start)} · конец не задан`;
    const endDay = localDay(record.end);
    return record.day === endDay ? `${timeLabel(record.start)}–${timeLabel(record.end)}` : `${shortDate(record.day)}, ${timeLabel(record.start)} → ${shortDate(endDay)}, ${timeLabel(record.end)}`;
  }
  const chevron = direction => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="${direction < 0 ? 'm12 5-5 5 5 5' : 'm8 5 5 5-5 5'}"/></svg>`;
  const calendarIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 3v4m8-4v4M4 10h16m4 4h3m2 0h3m-8 3h3"/></svg>';
  // Deliberately survives parent redraws when a task drawer is opened or saved.
  const state = { month: '', selected: '', tasks: true, meetings: true, completed: false, projectId: '' };
  function render(container, options = {}) {
    if (!container || typeof container.querySelector !== 'function') return;
    let today = localDay();
    if (!parseDay(state.selected)) state.selected = today;
    if (!parseDay(state.month)) state.month = state.selected.slice(0, 7) + '-01';
    const projects = Array.isArray(options.projects) ? options.projects : [];
    if (state.projectId && state.projectId !== '__none__' && !projects.some(project => String(project.id) === state.projectId)) state.projectId = '';
    function draw(focusSelector) {
      today = localDay();
      const { records, undatedTasks, invalidDates } = projectRecords(options, state), parts = parseDay(state.month);
      const first = state.month, last = isoDay({ ...parts, day: daysInMonth(parts.year, parts.month) });
      const monthRecords = records.filter(record => record.day <= last && record.lastDay >= first);
      const selectedRecords = recordsForDay(records, state.selected);
      const previous = addMonths(state.month, -1), next = addMonths(state.month, 1);
      const cells = monthGrid(state.month).map(day => {
        if (!day) return '<div class="cv-cell cv-blank" role="gridcell"></div>';
        const items = recordsForDay(records, day), selected = day === state.selected, isToday = day === today;
        const taskCount = items.filter(item => item.kind === 'task').length, meetingCount = items.length - taskCount;
        const description = items.length ? `, сроки задач: ${taskCount}, встречи: ${meetingCount}` : ', нет записей';
        return `<div class="cv-cell" role="gridcell" aria-selected="${selected}"><button type="button" class="cv-day${day.slice(0, 7) !== state.month.slice(0, 7) ? ' is-outside' : ''}${selected ? ' is-selected' : ''}${isToday ? ' is-today' : ''}" data-cv-day="${day}" tabindex="${selected ? 0 : -1}" aria-label="${dateLabel(day)}${isToday ? ', сегодня' : ''}${description}"${isToday ? ' aria-current="date"' : ''}><span class="cv-day-top"><span class="cv-number">${parseDay(day).day}</span>${items.length ? `<span class="cv-count">${items.length}</span>` : ''}</span><span class="cv-chips" aria-hidden="true">${items.slice(0, 2).map(item => `<span class="cv-chip cv-${item.kind}${item.status === 'completed' ? ' is-completed' : ''}">${item.start && item.day === day ? `<span class="cv-chip-time">${timeLabel(item.start)}</span>` : ''}${escape(item.title)}</span>`).join('')}${items.length > 2 ? `<span class="cv-more">Ещё ${items.length - 2}</span>` : ''}</span><span class="cv-dots" aria-hidden="true">${taskCount ? '<i class="cv-dot cv-task"></i>' : ''}${meetingCount ? '<i class="cv-dot cv-meeting"></i>' : ''}</span></button></div>`;
      });
      const rows = Array.from({ length: 6 }, (_, row) => `<div class="cv-week" role="row">${cells.slice(row * 7, row * 7 + 7).join('')}</div>`).join('');
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'местное время';
      const taskMonthCount = monthRecords.filter(record => record.kind === 'task').length;
      container.innerHTML = `<section class="page cv-page"><header class="cv-header"><div><div class="eyebrow">ПЛАНИРОВАНИЕ</div><h1>Календарь</h1><p>Сроки задач и встречи в одном месте.</p></div><button type="button" class="btn cv-google" data-cv-action="connect">${calendarIcon}<span>Google Календарь</span></button></header><div class="cv-toolbar"><div class="cv-month-nav"><h2 id="cv-month-heading" aria-live="polite">${months[parts.month - 1]} <span>${parts.year}</span></h2><div class="cv-nav-buttons"><button type="button" class="cv-arrow" data-cv-step="-1" aria-label="Предыдущий месяц"${previous ? '' : ' disabled'}>${chevron(-1)}</button><button type="button" class="cv-today" data-cv-action="today">Сегодня</button><button type="button" class="cv-arrow" data-cv-step="1" aria-label="Следующий месяц"${next ? '' : ' disabled'}>${chevron(1)}</button></div></div><label class="cv-project-label"><span class="cv-sr-only">Проект в календаре</span><select data-cv-filter="projectId" aria-label="Проект в календаре"><option value="">Все проекты</option><option value="__none__"${state.projectId === '__none__' ? ' selected' : ''}>Без проекта</option>${projects.map(project => `<option value="${escape(project.id)}"${state.projectId === String(project.id) ? ' selected' : ''}>${escape(project.title || 'Без названия')}</option>`).join('')}</select></label></div><div class="cv-filters" aria-label="Показывать в календаре"><label><input type="checkbox" data-cv-filter="tasks"${state.tasks ? ' checked' : ''}><span class="cv-dot cv-task" aria-hidden="true"></span>Сроки задач</label><label><input type="checkbox" data-cv-filter="meetings"${state.meetings ? ' checked' : ''}><span class="cv-dot cv-meeting" aria-hidden="true"></span>Встречи</label><label class="cv-completed-filter"><input type="checkbox" data-cv-filter="completed"${state.completed ? ' checked' : ''}>Завершённые задачи</label></div><div class="cv-layout"><div class="cv-month-panel"><div class="cv-grid" role="grid" aria-labelledby="cv-month-heading"><div class="cv-week cv-weekdays" role="row">${['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((name, index) => `<span role="columnheader" aria-label="${weekNames[index]}">${name}</span>`).join('')}</div>${rows}</div><div class="cv-month-footer"><span>${monthRecords.length ? `В этом месяце: сроки задач — ${taskMonthCount}, встречи — ${monthRecords.length - taskMonthCount}` : 'В этом месяце нет записей по выбранным фильтрам.'}</span>${undatedTasks ? `<span>Задачи без срока: ${undatedTasks}</span>` : ''}${invalidDates ? `<span>Записей с некорректной датой: ${invalidDates}</span>` : ''}</div></div><aside class="cv-agenda" aria-labelledby="cv-agenda-heading"><header><p>${weekNames[(arithmeticDate(state.selected).getUTCDay() + 6) % 7]}${state.selected === today ? ' · сегодня' : ''}</p><h2 id="cv-agenda-heading">${shortDate(state.selected)}${state.selected.slice(0, 4) !== today.slice(0, 4) ? ` ${state.selected.slice(0, 4)}` : ''}</h2><span>${selectedRecords.length ? `Записей: ${selectedRecords.length}` : 'Нет записей'}</span></header><div class="cv-agenda-list">${selectedRecords.length ? selectedRecords.map(record => `<button type="button" class="cv-agenda-item cv-${record.kind}${record.status === 'completed' ? ' is-completed' : ''}" data-cv-open="${record.kind}" data-cv-id="${escape(record.id)}"><span class="cv-item-time">${escape(recordTime(record))}</span><strong>${escape(record.title)}</strong><span class="cv-item-project">${escape(record.projectTitle)}</span>${record.status === 'paused' ? '<span class="cv-item-status">На паузе</span>' : record.status === 'completed' ? '<span class="cv-item-status">Завершено</span>' : ''}</button>`).join('') : `<div class="cv-empty">${calendarIcon}<p>Нет сроков и встреч<br>по выбранным фильтрам.</p></div>`}</div><button type="button" class="cv-create" data-cv-action="create"><span aria-hidden="true">＋</span> Задача к этой дате</button></aside></div><p class="cv-timezone">Время на устройстве · ${escape(zone)}. Срок без времени не занимает часы дня.</p></section>`;
      if (focusSelector) container.querySelector(focusSelector)?.focus({ preventScroll: true });
    }
    function selectDay(day, focus = false) {
      if (!parseDay(day)) return;
      options.onViewChange?.();
      state.selected = day; state.month = day.slice(0, 7) + '-01';
      draw(focus ? `[data-cv-day="${day}"]` : null);
    }
    container.onclick = event => {
      const target = event.target.closest('button');
      if (!target || !container.contains(target)) return;
      if (target.dataset.cvDay) return selectDay(target.dataset.cvDay, true);
      if (target.dataset.cvStep) {
        const day = addMonths(state.selected, +target.dataset.cvStep);
        if (day) { options.onViewChange?.(); state.selected = day; state.month = day.slice(0, 7) + '-01'; draw(`[data-cv-step="${target.dataset.cvStep}"]`); }
        return;
      }
      if (target.dataset.cvOpen) return options[target.dataset.cvOpen === 'task' ? 'onOpenTask' : 'onOpenMeeting']?.(target.dataset.cvId);
      if (target.dataset.cvAction === 'today') return selectDay(localDay(), true);
      if (target.dataset.cvAction === 'connect') return options.onConnect?.();
      if (target.dataset.cvAction === 'create') return options.onCreateTask?.(state.selected);
    };
    container.onchange = event => {
      const field = event.target.dataset.cvFilter;
      if (!['tasks', 'meetings', 'completed', 'projectId'].includes(field)) return;
      options.onViewChange?.();
      state[field] = field === 'projectId' ? event.target.value : event.target.checked;
      draw(`[data-cv-filter="${field}"]`);
    };
    container.onkeydown = event => {
      const day = event.target.dataset.cvDay;
      if (!day || event.altKey || event.ctrlKey || event.metaKey) return;
      const increments = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
      let next = Object.hasOwn(increments, event.key) ? addDays(day, increments[event.key]) : null;
      if (event.key === 'Home') next = addDays(day, -(arithmeticDate(day).getUTCDay() + 6) % 7);
      if (event.key === 'End') next = addDays(day, 6 - (arithmeticDate(day).getUTCDay() + 6) % 7);
      if (event.key === 'PageUp' || event.key === 'PageDown') next = addMonths(day, (event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1));
      if (next) { event.preventDefault(); selectDay(next, true); }
    };
    draw();
  }
  return { parseDay, addDays, addMonths, monthGrid, localDay, taskDeadline, projectRecords, recordsForDay, render };
});
