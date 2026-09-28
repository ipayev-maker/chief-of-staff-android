(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CoSParticipants = api;
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  const RECENT_KEY = 'cos.participantSelections.v1';
  const normalize = value => String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  const key = value => normalize(value).toLocaleLowerCase('ru');
  function readRecent(storage, now = Date.now()) {
    try {
      const rows = JSON.parse(storage.getItem(RECENT_KEY) || '[]');
      if (!Array.isArray(rows)) return [];
      return rows.filter(row => row && typeof row.id === 'string' && row.id.length <= 64 && Number.isFinite(row.at) && row.at <= now && row.at > now - 90 * 86400000).slice(0, 100);
    } catch { return []; }
  }
  function remember(storage, id, now = Date.now()) {
    if (!id) return;
    try { storage.setItem(RECENT_KEY, JSON.stringify([{id, at: now}, ...readRecent(storage, now).filter(row => row.id !== id)].slice(0, 100))); } catch {}
  }
  function groups(people, tasks, projectId, recent = []) {
    const byId = new Map(people.filter(p => p?.id && normalize(p.name)).map(p => [p.id, p]));
    const project = new Set(tasks.filter(t => !t.deleted_at && projectId && t.project_id === projectId).map(t => t.participant_id));
    const timestamps = new Map(recent.map(row => [row.id, row.at]));
    const compare = (a, b) => (timestamps.get(b.id) || 0) - (timestamps.get(a.id) || 0) || normalize(a.name).localeCompare(normalize(b.name), 'ru') || a.id.localeCompare(b.id);
    const result = [{label:'В этом проекте', people:[]}, {label:'Недавно выбирали', people:[]}, {label:'Все участники', people:[]}];
    for (const p of byId.values()) result[project.has(p.id) ? 0 : timestamps.has(p.id) ? 1 : 2].people.push(p);
    return result.filter(g => g.people.length).map(g => ({...g, people:g.people.sort(compare)}));
  }
  function duplicate(people, name, exceptId) { return people.find(p => p.id !== exceptId && key(p.name) === key(name)); }
  return { normalize, key, readRecent, remember, groups, duplicate };
});
