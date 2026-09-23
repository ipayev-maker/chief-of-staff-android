(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) root.CoSDatePicker = api.mount(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // Calendar arithmetic uses date parts only; timezone offsets never enter stored values.
  const pad = number => String(number).padStart(2, '0');
  const leap = year => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = (year, month) => month === 2 ? (leap(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  function parse(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
    if (!match) return null;
    const [year, month, day] = match.slice(1).map(Number);
    return year >= 1 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month) ? { year, month, day } : null;
  }
  const iso = ({ year, month, day }) => `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
  function arithmeticDate(value) {
    const parts = typeof value === 'string' ? parse(value) : value;
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
    const year = date.getUTCFullYear();
    return year >= 1 && year <= 9999 ? iso({ year, month: date.getUTCMonth() + 1, day: date.getUTCDate() }) : null;
  }
  function addMonths(value, amount) {
    const parts = parse(value);
    if (!parts || !Number.isInteger(amount)) return null;
    const monthIndex = (parts.year - 1) * 12 + parts.month - 1 + amount;
    if (monthIndex < 0 || monthIndex >= 9999 * 12) return null;
    const year = Math.floor(monthIndex / 12) + 1, month = monthIndex % 12 + 1;
    return iso({ year, month, day: Math.min(parts.day, daysInMonth(year, month)) });
  }
  const weekday = value => { const date = arithmeticDate(value); return date ? (date.getUTCDay() + 6) % 7 : null; };
  function monthGrid(value) {
    const parts = parse(value);
    if (!parts) return [];
    const first = iso({ ...parts, day: 1 }), offset = weekday(first);
    return Array.from({ length: 42 }, (_, index) => addDays(first, index - offset));
  }
  function allowed(value, min = '', max = '') {
    return !!parse(value) && (!parse(min) || value >= min) && (!parse(max) || value <= max);
  }
  function clamp(value, min = '', max = '') {
    if (!parse(value) || parse(min) && parse(max) && min > max) return null;
    if (parse(min) && value < min) return min;
    if (parse(max) && value > max) return max;
    return value;
  }
  const localToday = (date = new Date()) => iso({ year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() });

  function mount(win) {
    const doc = win.document, records = new WeakMap(), tracked = new Set();
    const months = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
    const monthForms = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    const weekNames = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
    const calendarIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 3v4m8-4v4M4 10h16"/></svg>';
    const chevron = direction => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="${direction < 0 ? 'm12 5-5 5 5 5' : 'm8 5 5 5-5 5'}"/></svg>`;
    const popup = doc.createElement('div');
    popup.id = 'cos-date-picker'; popup.className = 'cos-date-popup'; popup.hidden = true;
    popup.setAttribute('role', 'dialog'); popup.setAttribute('aria-modal', 'false');
    popup.setAttribute('aria-labelledby', 'cos-date-heading');
    let active = null, shownMonth = '', focusedDate = '', sequence = 0, frame = null;
    const longDate = value => { const parts = parse(value); return parts ? `${parts.day} ${monthForms[parts.month - 1]} ${parts.year}` : ''; };
    const displayDate = value => { const parts = parse(value); return parts ? `${pad(parts.day)}.${pad(parts.month)}.${parts.year}` : 'Выбрать дату'; };
    const blocked = input => input.disabled || input.readOnly || input.matches(':disabled');
    function fieldLabel(input) {
      const direct = input.getAttribute('aria-label');
      if (direct) return direct;
      const ids = input.getAttribute('aria-labelledby');
      if (ids) {
        const text = ids.split(/\s+/).map(id => doc.getElementById(id)?.textContent || '').join(' ').trim();
        if (text) return text;
      }
      const label = input.labels?.[0];
      if (label) {
        const copy = label.cloneNode(true);
        copy.querySelectorAll('input,button,select,textarea,.cos-date-field').forEach(node => node.remove());
        const text = copy.textContent.trim();
        if (text) return text;
      }
      return input.classList.contains('cd-deadline') ? 'Крайний срок' : 'Дата';
    }
    function sync(record) {
      const { input, trigger, valueLabel } = record;
      const signature = [input.value, input.min, input.max, input.required, blocked(input)].join('|');
      const value = displayDate(input.value), label = `${fieldLabel(input)}: ${longDate(input.value) || 'не выбрана'}${input.required ? ', обязательное поле' : ''}`;
      if (valueLabel.textContent !== value) valueLabel.textContent = value;
      if (trigger.getAttribute('aria-label') !== label) trigger.setAttribute('aria-label', label);
      if (trigger.disabled !== blocked(input)) trigger.disabled = blocked(input);
      record.wrapper.classList.toggle('cos-date-empty', !input.value);
      if (active === record && (!input.isConnected || blocked(input))) close(false);
      if (active === record && signature !== record.signature) {
        const hadFocus = popup.contains(doc.activeElement);
        focusedDate = clamp(parse(input.value) ? input.value : focusedDate, input.min, input.max) || localToday();
        shownMonth = focusedDate.slice(0, 7) + '-01';
        draw(); place(); if (hadFocus) focusDay();
      }
      record.signature = signature;
    }
    function enhance(input) {
      if (records.has(input) || input.dataset.nativeDate !== undefined || input.type !== 'date') return;
      const wrapper = doc.createElement('span'), trigger = doc.createElement('button'), valueLabel = doc.createElement('span');
      wrapper.className = 'cos-date-field'; trigger.className = 'cos-date-trigger'; trigger.type = 'button';
      trigger.id = `cos-date-trigger-${++sequence}`;
      trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', popup.id);
      valueLabel.className = 'cos-date-value'; trigger.append(valueLabel); trigger.insertAdjacentHTML('beforeend', calendarIcon);
      input.before(wrapper); wrapper.append(input, trigger);
      const record = { input, wrapper, trigger, valueLabel };
      records.set(input, record); tracked.add(record);
      input.classList.add('cos-date-native'); input.tabIndex = -1; input.setAttribute('aria-hidden', 'true');
      trigger.addEventListener('click', event => { event.preventDefault(); active === record ? close() : open(record); });
      trigger.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(record); }
      });
      input.addEventListener('input', () => sync(record)); input.addEventListener('change', () => sync(record));
      input.addEventListener('focus', () => { if (!blocked(input)) trigger.focus(); });
      input.addEventListener('invalid', event => { if (!blocked(input)) { event.preventDefault(); open(record); } });
      // Existing code assigns .value directly. Preserve the native setter and mirror only this input.
      for (const name of ['value', 'valueAsDate', 'valueAsNumber']) {
        const descriptor = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, name);
        if (!descriptor?.get || !descriptor?.set || Object.hasOwn(input, name)) continue;
        Object.defineProperty(input, name, { configurable: true, get() { return descriptor.get.call(this); }, set(value) { descriptor.set.call(this, value); sync(record); } });
      }
      sync(record);
    }
    function refresh(node = doc) {
      if (node.matches?.('input[type="date"]')) enhance(node);
      node.querySelectorAll?.('input[type="date"]').forEach(enhance);
      for (const record of tracked) {
        if (!record.input.isConnected) { if (active === record) close(false); tracked.delete(record); }
        else sync(record);
      }
    }
    function close(restore = true) {
      if (!active) return;
      const previous = active; active = null; popup.hidden = true;
      previous.trigger.setAttribute('aria-expanded', 'false');
      if (restore && previous.trigger.isConnected && !previous.trigger.disabled) previous.trigger.focus({ preventScroll: true });
    }
    function open(record) {
      if (blocked(record.input) || !record.input.isConnected) return;
      if (active) close(false);
      active = record;
      focusedDate = clamp(parse(record.input.value) ? record.input.value : localToday(), record.input.min, record.input.max) || localToday();
      shownMonth = focusedDate.slice(0, 7) + '-01';
      record.trigger.setAttribute('aria-expanded', 'true');
      // Stay inside an existing native dialog's top layer, otherwise portal outside scrolling panels.
      (record.input.closest('dialog[open]') || doc.body).append(popup);
      popup.hidden = false; draw(); place(); focusDay();
    }
    function focusDay() {
      const day = popup.querySelector(`[data-date="${focusedDate}"]:not(:disabled)`);
      (day || popup.querySelector('[data-action="close"]')).focus({ preventScroll: true });
    }
    function monthAllowed(value) {
      const parts = parse(value); if (!parts || !active) return false;
      const first = iso({ ...parts, day: 1 }), last = iso({ ...parts, day: daysInMonth(parts.year, parts.month) });
      return (!parse(active.input.min) || last >= active.input.min) && (!parse(active.input.max) || first <= active.input.max);
    }
    function draw() {
      if (!active) return;
      const { input } = active, parts = parse(shownMonth), today = localToday(), tomorrow = addDays(today, 1);
      const before = addMonths(shownMonth, -1), after = addMonths(shownMonth, 1);
      const cells = monthGrid(shownMonth).map(value => {
        if (!value) return '<span class="cos-date-blank" role="gridcell"></span>';
        const day = parse(value), isSelected = input.value === value, isToday = today === value;
        return `<span role="gridcell" aria-selected="${isSelected}"><button type="button" class="cos-date-day${value.slice(0, 7) !== shownMonth.slice(0, 7) ? ' is-outside' : ''}${isSelected ? ' is-selected' : ''}${isToday ? ' is-today' : ''}" data-date="${value}" tabindex="${value === focusedDate ? '0' : '-1'}" aria-label="${longDate(value)}${isToday ? ', сегодня' : ''}"${isToday ? ' aria-current="date"' : ''}${allowed(value, input.min, input.max) ? '' : ' disabled'}>${day.day}</button></span>`;
      });
      const rows = Array.from({ length: 6 }, (_, index) => `<div class="cos-date-week" role="row">${cells.slice(index * 7, index * 7 + 7).join('')}</div>`).join('');
      popup.innerHTML = `<div class="cos-date-top"><span class="cos-date-caption">${escapeText(fieldLabel(input))}</span><button class="cos-date-close" type="button" data-action="close" aria-label="Закрыть календарь">×</button></div><div class="cos-date-month"><button class="cos-date-arrow" type="button" data-step="-1" aria-label="Предыдущий месяц"${monthAllowed(before) ? '' : ' disabled'}>${chevron(-1)}</button><h2 id="cos-date-heading" aria-live="polite">${months[parts.month - 1]} <span>${parts.year}</span></h2><button class="cos-date-arrow" type="button" data-step="1" aria-label="Следующий месяц"${monthAllowed(after) ? '' : ' disabled'}>${chevron(1)}</button></div><div class="cos-date-grid" role="grid" aria-labelledby="cos-date-heading"><div class="cos-date-week cos-date-weekdays" role="row">${['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((name, index) => `<span role="columnheader" aria-label="${weekNames[index]}">${name}</span>`).join('')}</div>${rows}</div><div class="cos-date-shortcuts"><button type="button" data-date="${today}"${allowed(today, input.min, input.max) ? '' : ' disabled'}>Сегодня</button><button type="button" data-date="${tomorrow}"${allowed(tomorrow, input.min, input.max) ? '' : ' disabled'}>Завтра</button><button type="button" class="cos-date-clear" data-action="clear"${input.required || !input.value ? ' disabled' : ''}>Без даты</button></div><p class="cos-date-help">Стрелки — выбрать · Enter — подтвердить</p>`;
    }
    function escapeText(value) { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
    function place() {
      if (!active || popup.hidden) return;
      const anchor = active.trigger.getBoundingClientRect(), viewport = win.visualViewport;
      const width = viewport?.width || win.innerWidth, height = viewport?.height || win.innerHeight;
      const leftEdge = viewport?.offsetLeft || 0, topEdge = viewport?.offsetTop || 0, margin = 10;
      popup.style.maxHeight = `${Math.max(160, height - margin * 2)}px`;
      const bounds = popup.getBoundingClientRect();
      const left = Math.max(leftEdge + margin, Math.min(anchor.left, leftEdge + width - bounds.width - margin));
      let top = anchor.bottom + 7;
      if (top + bounds.height > topEdge + height - margin) top = anchor.top - bounds.height - 7;
      top = Math.max(topEdge + margin, Math.min(top, topEdge + height - bounds.height - margin));
      popup.style.left = `${left}px`; popup.style.top = `${top}px`;
    }
    function choose(value) {
      if (!active || blocked(active.input) || !active.input.isConnected) return close(false);
      const { input } = active;
      if (value ? !allowed(value, input.min, input.max) : input.required) return;
      const changed = input.value !== value;
      input.value = value;
      close();
      if (changed) {
        input.dispatchEvent(new win.Event('input', { bubbles: true }));
        input.dispatchEvent(new win.Event('change', { bubbles: true }));
      }
    }
    function shiftMonth(amount, focus = true) {
      const next = addMonths(shownMonth, amount);
      if (!monthAllowed(next)) return;
      shownMonth = next;
      const nextDay = addMonths(focusedDate, amount);
      focusedDate = clamp(nextDay, active.input.min, active.input.max) || next;
      draw(); place();
      if (focus) focusDay();
    }
    popup.addEventListener('click', event => {
      const button = event.target.closest('button'); if (!button || button.disabled || !active) return;
      if (button.dataset.date) choose(button.dataset.date);
      else if (button.dataset.action === 'clear') choose('');
      else if (button.dataset.action === 'close') close();
      else if (button.dataset.step) shiftMonth(Number(button.dataset.step));
    });
    popup.addEventListener('keydown', event => {
      if (!active) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key === 'Tab') {
        const controls = [...popup.querySelectorAll('button:not(:disabled)')].filter(button => button.tabIndex >= 0);
        if (event.shiftKey && event.target === controls[0] || !event.shiftKey && event.target === controls.at(-1)) {
          event.preventDefault(); const trigger = active.trigger;
          close(false);
          const pageControls = [...doc.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')].filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length && !el.closest('[hidden]'));
          const index = pageControls.indexOf(trigger), next = pageControls[index + (event.shiftKey ? -1 : 1)];
          (next || trigger).focus({ preventScroll: true });
        }
        return;
      }
      if (!event.target.matches('.cos-date-day')) return;
      let next = null;
      if (event.key === 'ArrowLeft') next = addDays(focusedDate, -1);
      else if (event.key === 'ArrowRight') next = addDays(focusedDate, 1);
      else if (event.key === 'ArrowUp') next = addDays(focusedDate, -7);
      else if (event.key === 'ArrowDown') next = addDays(focusedDate, 7);
      else if (event.key === 'Home') next = addDays(focusedDate, -weekday(focusedDate));
      else if (event.key === 'End') next = addDays(focusedDate, 6 - weekday(focusedDate));
      else if (event.key === 'PageUp' || event.key === 'PageDown') { event.preventDefault(); shiftMonth((event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1)); return; }
      else return;
      event.preventDefault();
      next = clamp(next, active.input.min, active.input.max);
      if (!next) return;
      focusedDate = next; shownMonth = next.slice(0, 7) + '-01'; draw(); focusDay();
    });
    function schedulePlace() {
      if (frame !== null || !active) return;
      frame = win.requestAnimationFrame(() => { frame = null; place(); });
    }
    doc.addEventListener('pointerdown', event => { if (active && !popup.contains(event.target) && !active.wrapper.contains(event.target)) close(false); }, true);
    doc.addEventListener('focusin', event => { if (active && !popup.contains(event.target) && !active.wrapper.contains(event.target)) close(false); });
    doc.addEventListener('reset', () => win.setTimeout(() => refresh(), 0), true);
    win.addEventListener('resize', schedulePlace); doc.addEventListener('scroll', schedulePlace, true);
    win.visualViewport?.addEventListener('resize', schedulePlace); win.visualViewport?.addEventListener('scroll', schedulePlace);
    const observer = new win.MutationObserver(mutations => {
      let touched = false;
      for (const mutation of mutations) {
        if (popup.contains(mutation.target)) continue;
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach(node => { if (node.nodeType === 1 && node !== popup) { if (node.matches?.('input[type="date"]')) enhance(node); node.querySelectorAll?.('input[type="date"]').forEach(enhance); } });
          if (mutation.removedNodes.length) touched = true;
        } else if (mutation.target.matches?.('input[type="date"],fieldset')) touched = true;
      }
      if (touched) { for (const record of tracked) { if (!record.input.isConnected) { if (active === record) close(false); tracked.delete(record); } else sync(record); } }
      if (active) schedulePlace();
    });
    function start() { refresh(); observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'readonly', 'value', 'min', 'max', 'required'] }); }
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start, { once: true }); else start();
    return { refresh, close };
  }
  return { parse, iso, leap, daysInMonth, addDays, addMonths, weekday, monthGrid, allowed, clamp, localToday, mount };
});
