(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) root.CoSAttention = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  const STORAGE_KEY = 'cos-attention-deferrals-v1';
  const MAX_DEFERRALS = 100;
  const pad = value => String(value).padStart(2, '0');
  const array = value => Array.isArray(value) ? value : [];
  const text = value => value == null ? '' : String(value);
  const escape = value => text(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  function parseDay(value) {
    const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    const [year, month, day] = match.slice(1).map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const length = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
    return year > 0 && month > 0 && month <= 12 && day > 0 && day <= length ? { year, month, day } : null;
  }
  function localDay(date) {
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
    const value = `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    return parseDay(value) ? value : null;
  }
  // Date parts are calendar values: advancing a day never assumes 24 local hours.
  function addDays(day, amount) {
    const parts = parseDay(day);
    if (!parts || !Number.isInteger(amount)) return null;
    const date = new Date(0);
    date.setUTCFullYear(parts.year, parts.month - 1, parts.day + amount);
    date.setUTCHours(0, 0, 0, 0);
    const value = `${String(date.getUTCFullYear()).padStart(4, '0')}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    return parseDay(value) ? value : null;
  }
  function instant(value) {
    const match = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
    if (!match || !parseDay(match[1]) || +match[2] > 23 || +match[3] > 59 || +(match[4] || 0) > 59) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && localDay(date) ? date : null;
  }
  function dateValue(source, timestampKey, dayKey) {
    if (source[timestampKey]) {
      const date = instant(source[timestampKey]);
      return date ? { day: localDay(date), at: date.getTime() } : null;
    }
    return parseDay(source[dayKey]) ? { day: source[dayKey], at: null } : null;
  }
  function currentDate(now) {
    if (now === undefined) return new Date();
    if (now instanceof Date) return new Date(now.getTime());
    if (typeof now === 'number') return new Date(now);
    return instant(now) || new Date(NaN);
  }
  const finished = task => ['completed', 'cancelled'].includes(task.status);
  const activeProject = project => !project.status || project.status === 'active';
  function unique(rows) {
    const seen = new Set();
    return array(rows).filter(row => {
      if (!row || row.id == null || row.id === '') return false;
      const id = text(row.id);
      if (seen.has(id)) return false;
      seen.add(id); return true;
    });
  }
  function fingerprint(value) {
    // A compact, deterministic change marker, never an authentication primitive.
    const input = JSON.stringify(value);
    let left = 2166136261, right = 5381;
    for (let index = 0; index < input.length; index++) {
      left = Math.imul(left ^ input.charCodeAt(index), 16777619);
      right = Math.imul(right, 33) ^ input.charCodeAt(index);
    }
    return `${(left >>> 0).toString(36)}-${(right >>> 0).toString(36)}-${input.length}`;
  }
  function projectFingerprint(project, tasks) {
    const fields = ['id', 'status', 'description', 'details', 'direction', 'participant_id', 'deadline', 'deadline_at', 'next_check_on', 'next_check_at', 'planned_on', 'planned_start_at', 'planned_end_at', 'cos_version', 'updated_at'];
    const rows = tasks.map(task => fields.map(field => text(task[field]))).sort((a, b) => a[0].localeCompare(b[0]));
    return fingerprint([[project.id, project.title, project.status, project.risk_level, project.cos_version, project.updated_at].map(text), rows]);
  }
  function dayLabel(day) {
    const parts = parseDay(day);
    return parts ? `${parts.day} ${['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'][parts.month - 1]}` : '';
  }
  function dueLabel(value, today) {
    const day = value.day === today ? 'сегодня' : `${dayLabel(value.day)}${value.day.slice(0, 4) !== today.slice(0, 4) ? ` ${value.day.slice(0, 4)}` : ''}`;
    return value.at === null ? day : `${day}, ${new Date(value.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
  }
  function buildSignals({ tasks = [], projects = [], now } = {}) {
    const date = currentDate(now), today = localDay(date);
    if (!today) return [];
    const allTasks = unique(tasks), allProjects = unique(projects);
    const projectMap = new Map(allProjects.map(project => [text(project.id), project]));
    const byProject = new Map(), signals = [];
    for (const task of allTasks) {
      const projectId = text(task.project_id), project = projectMap.get(projectId);
      if (projectId) {
        if (!byProject.has(projectId)) byProject.set(projectId, []);
        byProject.get(projectId).push(task);
      }
      if (finished(task) || task.status === 'paused' || project && !activeProject(project)) continue;
      const deadline = dateValue(task, 'deadline_at', 'deadline');
      const check = dateValue(task, 'next_check_at', 'next_check_on');
      const overdue = deadline && (deadline.at === null ? deadline.day < today : deadline.at < date.getTime());
      const checkDue = check && (check.at === null ? check.day <= today : check.at <= date.getTime());
      let reason, detail, actionLabel, priority, due;
      if (overdue) {
        reason = 'overdue'; priority = 0; due = deadline;
        detail = `Срок прошёл: ${dueLabel(deadline, today)}. Уточните результат или новый срок.`;
        actionLabel = 'Разобрать срок';
      } else if (checkDue) {
        reason = 'check_due'; priority = 1; due = check;
        detail = `Проверка назначена на ${dueLabel(check, today)}. Уточните состояние задачи.`;
        actionLabel = 'Проверить';
      } else if (task.direction === 'to_me' && !check) {
        reason = 'waiting_no_check'; priority = 2;
        detail = task.next_check_at || task.next_check_on ? 'Дата проверки некорректна. Уточните, когда вернуться к ожиданию.' : 'Ждём результат от другого человека. Когда нужно вернуться к вопросу?';
        actionLabel = 'Назначить проверку';
      } else continue;
      signals.push({ key: `task:${task.id}`, kind: 'task', reason, id: text(task.id), projectId,
        title: text(task.description) || 'Задача без названия', projectTitle: project ? text(project.title) || 'Проект без названия' : projectId ? 'Проект' : 'Без проекта',
        detail, actionLabel, priority, dueDay: due?.day || '', dueAt: due?.at ?? null,
        fingerprint: fingerprint([task.id, reason, task.status, task.description, task.deadline, task.deadline_at, task.next_check_on, task.next_check_at]) });
    }
    for (const project of allProjects) {
      if (!activeProject(project)) continue;
      const rows = byProject.get(text(project.id)) || [];
      if (rows.some(task => !finished(task))) continue;
      const completed = rows.some(task => task.status === 'completed');
      signals.push({ key: `project:${project.id}`, kind: 'project', reason: completed ? 'project_next_step' : 'project_state', id: text(project.id), projectId: text(project.id),
        title: text(project.title) || 'Проект без названия', projectTitle: '', priority: 3,
        detail: completed ? 'Задачи завершены, новых действий нет. Что дальше: следующий шаг или ожидание?' : 'Проект активен, открытых задач нет. Что сейчас происходит и чего ждём?',
        actionLabel: completed ? 'Определить следующий шаг' : 'Уточнить состояние',
        fingerprint: projectFingerprint(project, rows) });
    }
    return signals.sort((a, b) => a.priority - b.priority || text(a.dueDay).localeCompare(text(b.dueDay)) || (a.dueAt ?? -Infinity) - (b.dueAt ?? -Infinity) || a.title.localeCompare(b.title, 'ru') || a.key.localeCompare(b.key));
  }
  function createDeferralStore(storage) {
    let entries = new Map(), sessionOnly = false;
    if (storage === undefined) {
      try { storage = typeof globalThis.localStorage === 'object' ? globalThis.localStorage : null; } catch { storage = null; }
    }
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') sessionOnly = true;
    else try {
      const raw = storage.getItem(STORAGE_KEY);
      if (typeof raw === 'string' && raw.length <= 64000) {
        const saved = JSON.parse(raw);
        if (saved && saved.version === 1 && Array.isArray(saved.entries)) for (const entry of saved.entries.slice(-MAX_DEFERRALS)) {
          if (!entry || typeof entry.key !== 'string' || !entry.key.startsWith('project:') || entry.key.length > 250 || typeof entry.fingerprint !== 'string' || !/^[a-z0-9]+-[a-z0-9]+-\d+$/.test(entry.fingerprint) || entry.fingerprint.length > 70 || !parseDay(entry.untilDay)) continue;
          entries.set(entry.key, { key: entry.key, fingerprint: entry.fingerprint, untilDay: entry.untilDay });
        }
      }
    } catch (error) {
      // Malformed content is ignored; inability to read storage means session-only use.
      if (!(error instanceof SyntaxError)) sessionOnly = true;
    }
    function save() {
      while (entries.size > MAX_DEFERRALS) entries.delete(entries.keys().next().value);
      if (!sessionOnly) try { storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, entries: [...entries.values()] })); } catch { sessionOnly = true; }
    }
    return {
      get sessionOnly() { return sessionOnly; },
      defer(signal, now) {
        const today = localDay(currentDate(now)), untilDay = today && addDays(today, 7);
        if (!untilDay || signal?.kind !== 'project' || !signal.key?.startsWith('project:') || signal.key.length > 250 || typeof signal.fingerprint !== 'string') return false;
        entries.delete(signal.key);
        entries.set(signal.key, { key: signal.key, fingerprint: signal.fingerprint, untilDay });
        save(); return true;
      },
      restore(key) { if (entries.delete(key)) save(); },
      partition(signals, now) {
        const today = localDay(currentDate(now)), limit = today && addDays(today, 7);
        const map = new Map(signals.filter(signal => signal.kind === 'project').map(signal => [signal.key, signal]));
        let changed = false;
        for (const [key, entry] of entries) {
          if (!today || !limit || !map.has(key) || map.get(key).fingerprint !== entry.fingerprint || entry.untilDay <= today || entry.untilDay > limit) { entries.delete(key); changed = true; }
        }
        if (changed) save();
        const visible = [], deferred = [];
        for (const signal of signals) {
          const entry = signal.kind === 'project' && entries.get(signal.key);
          if (entry) deferred.push({ ...signal, untilDay: entry.untilDay }); else visible.push(signal);
        }
        return { visible, deferred };
      }
    };
  }
  let defaultStore;
  const view = { expanded: false, showDeferred: false };
  function render(container, options = {}) {
    if (!container || typeof container.querySelector !== 'function') return;
    const store = options.deferralStore || (defaultStore ||= createDeferralStore());
    let signals = [], visible = [], deferred = [];
    function draw(focusSelector) {
      const now = options.now === undefined ? new Date() : options.now;
      signals = buildSignals({ ...options, now });
      ({ visible, deferred } = store.partition(signals, now));
      const shown = view.expanded ? visible : visible.slice(0, 5);
      const row = (signal, postponed = false) => `<li class="attention-item${signal.reason === 'overdue' ? ' attention-overdue' : ''}"><span class="attention-mark" aria-hidden="true">${signal.kind === 'project' ? '○' : signal.reason === 'overdue' ? '!' : '·'}</span><div class="attention-copy"><button class="attention-title" type="button" data-attention-open="${escape(signal.key)}">${escape(signal.title)}</button>${signal.projectTitle ? `<span class="attention-project">${escape(signal.projectTitle)}</span>` : ''}<p>${escape(signal.detail)}</p>${postponed ? `<span class="attention-return">Вернуться ${dayLabel(signal.untilDay)}</span>` : ''}<div class="attention-actions"><button class="attention-action" type="button" data-attention-open="${escape(signal.key)}">${escape(signal.actionLabel)} <span aria-hidden="true">→</span></button>${postponed ? `<button class="attention-defer" type="button" data-attention-restore="${escape(signal.key)}">Вернуть сейчас</button>` : signal.kind === 'project' ? `<button class="attention-defer" type="button" data-attention-defer="${escape(signal.key)}" aria-label="Вернуться к проекту ${escape(signal.title)} через 7 дней">Через неделю</button>` : ''}</div></div></li>`;
      container.innerHTML = `<section class="attention-panel" aria-labelledby="attention-heading"><header class="attention-head"><div><h2 id="attention-heading">Требует внимания <span class="attention-count">${visible.length}</span></h2><p>Сроки, проверки и следующий шаг проекта</p></div></header>${shown.length ? `<ul class="attention-list">${shown.map(signal => row(signal)).join('')}</ul>` : `<div class="attention-empty">${deferred.length ? 'Найденные вопросы отложены. Они вернутся в назначенный день.' : 'Сейчас нет вопросов по срокам, проверкам и следующим шагам.'}</div>`}${visible.length > 5 ? `<button class="attention-show" type="button" data-attention-action="expand" aria-expanded="${view.expanded}">${view.expanded ? 'Свернуть список' : `Показать все (${visible.length})`}</button>` : ''}${deferred.length ? `<button class="attention-show attention-deferred-toggle" type="button" data-attention-action="deferred" aria-expanded="${view.showDeferred}">${view.showDeferred ? 'Скрыть отложенные' : `Отложено (${deferred.length})`}</button>${view.showDeferred ? `<ul class="attention-list attention-deferred">${deferred.map(signal => row(signal, true)).join('')}</ul>` : ''}` : ''}<p class="attention-footnote">${store.sessionOnly ? 'Отложенные вопросы сохраняются до перезагрузки страницы: сохранение на устройстве недоступно.' : '«Через неделю» скрывает вопрос о проекте только на этом устройстве.'}</p></section>`;
      if (focusSelector) container.querySelector(focusSelector)?.focus({ preventScroll: true });
    }
    container.onclick = event => {
      const target = event.target.closest('button');
      if (!target || target.disabled || !container.contains(target)) return;
      const dataset = target.dataset;
      if (dataset.attentionAction === 'expand') { view.expanded = !view.expanded; draw('[data-attention-action="expand"]'); return; }
      if (dataset.attentionAction === 'deferred') { view.showDeferred = !view.showDeferred; draw('[data-attention-action="deferred"]'); return; }
      if (dataset.attentionOpen) {
        const signal = signals.find(item => item.key === dataset.attentionOpen);
        if (signal) options[signal.kind === 'task' ? 'onOpenTask' : 'onOpenProject']?.(signal.id, signal.reason);
        return;
      }
      if (dataset.attentionDefer) {
        const signal = visible.find(item => item.key === dataset.attentionDefer);
        if (signal && store.defer(signal, options.now)) draw('[data-attention-action="deferred"]');
        return;
      }
      if (dataset.attentionRestore && deferred.some(item => item.key === dataset.attentionRestore)) {
        store.restore(dataset.attentionRestore); draw('[data-attention-action="deferred"]');
      }
    };
    draw();
  }
  return { buildSignals, render, createDeferralStore, parseDay, addDays, localDay };
});
