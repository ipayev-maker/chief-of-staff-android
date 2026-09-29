(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CoSNavigation = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const SECTIONS = new Set(['today', 'tasks', 'projects', 'notes', 'calendar', 'people', 'inbox']);
  const TABS = new Set(['overview', 'space', 'tasks', 'notes', 'meetings', 'time']);
  const KEY = 'cosNavigation';
  function normalize(route) {
    const section = SECTIONS.has(route?.section) ? route.section : 'today';
    const projectId = section !== 'inbox' && typeof route?.projectId === 'string' && /^[\w-]{1,128}$/.test(route.projectId) ? route.projectId : null;
    return {section, projectId, tab:projectId && TABS.has(route?.tab) ? route.tab : 'overview', calendarReturn:!!(projectId && route?.calendarReturn), ...(section === 'inbox' ? {inboxId:typeof route?.inboxId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(route.inboxId) ? route.inboxId.toLowerCase() : null} : {})};
  }
  const routeKey = route => JSON.stringify(normalize(route));
  function readRoute(location) {
    let parts;try { parts = String(location.hash || '').replace(/^#\//, '').split('/').map(decodeURIComponent); } catch { return null; }
    if (parts.length === 1 && SECTIONS.has(parts[0])) return normalize({section:parts[0]});
    if (parts.length === 2 && parts[0] === 'inbox' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parts[1])) return normalize({section:'inbox', inboxId:parts[1]});
    if (parts.length === 3 && parts[0] === 'projects' && /^[\w-]{1,128}$/.test(parts[1]) && TABS.has(parts[2])) return normalize({section:'projects', projectId:parts[1], tab:parts[2]});
    return null;
  }
  function routeURL(location, route) {
    const r = normalize(route);
    const hash = r.section === 'inbox' && r.inboxId ? `#/inbox/${r.inboxId}` : r.projectId ? `#/projects/${encodeURIComponent(r.projectId)}/${r.tab}` : `#/${r.section}`;
    return location.pathname + location.search + hash;
  }
  function resetScroll(win) {
    const doc = win.document;
    for (const node of [doc?.scrollingElement, doc?.documentElement, doc?.body, doc?.querySelector('#main'), doc?.querySelector('#wb')]) {
      if (node) { node.scrollTop = 0; node.scrollLeft = 0; }
    }
    win.scrollTo?.({top:0, left:0, behavior:'instant'});
  }
  function create(options) {
    const win = options.window || window, history = win.history;
    let disposed = false, serial = 0, pending = false, rollback = null, frame = null;
    const initialRoute = normalize(options.initialRoute || readRoute(win.location));
    const previous = history.state?.[KEY];
    const session = typeof previous?.session === 'string' && previous.session.length < 100 ? previous.session : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let current = {session, index:Number.isSafeInteger(previous?.index) && previous.index >= 0 ? previous.index : 0, route:initialRoute};
    const originalScrollRestoration = history.scrollRestoration;
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    function state(entry) { return {...history.state, [KEY]:entry}; }
    function scroll() {
      if (frame !== null) win.cancelAnimationFrame?.(frame);
      if (win.requestAnimationFrame) frame = win.requestAnimationFrame(() => {frame = null;if (!disposed) resetScroll(win);});
      else resetScroll(win);
    }
    history.replaceState(state(current), '', routeURL(win.location, initialRoute));
    function record(route) {
      if (disposed || pending) return false;
      const next = normalize(route);
      if (routeKey(next) === routeKey(current.route)) return false;
      current = {session, index:current.index + 1, route:next};
      history.pushState(state(current), '', routeURL(win.location, next));
      scroll();return true;
    }
    function replace(route) {
      current = {...current, route:normalize(route)};
      history.replaceState(state(current), '', routeURL(win.location, current.route));
    }
    function restorePosition(target) {
      const delta = current.index - target.index;
      if (delta) { rollback = current.index;history.go(delta); }
      else history.replaceState(state(current), '', routeURL(win.location, current.route));
    }
    async function pop(event) {
      if (disposed) return;
      const target = event.state?.[KEY];
      // Never trap the user at the boundary of this application's history.
      if (!target || target.session !== session || !Number.isSafeInteger(target.index) || target.index < 0) return;
      if (rollback !== null && target.index === rollback) {rollback = null;return;}
      rollback = null;
      const ticket = ++serial;pending = true;
      const isCurrent = () => !disposed && ticket === serial;
      try {
        options.onStart?.();
        if (options.canLeave && !await options.canLeave()) {if (isCurrent()) restorePosition(target);return;}
        if (!isCurrent()) return;
        const accepted = await options.apply(normalize(target.route), {isCurrent});
        if (!isCurrent()) return;
        if (accepted === false) {restorePosition(target);return;}
        current = {...target, route:normalize(target.route)};
        scroll();
      } catch (error) {
        if (isCurrent()) {restorePosition(target);options.onError?.(error);}
      } finally {if (isCurrent()) pending = false;}
    }
    win.addEventListener('popstate', pop);
    return {
      record, replace, resetScroll:scroll, getRoute:() => ({...current.route}), isNavigating:() => pending,
      dispose() {disposed = true;serial++;win.removeEventListener('popstate', pop);if (frame !== null) win.cancelAnimationFrame?.(frame);if ('scrollRestoration' in history) history.scrollRestoration = originalScrollRestoration;},
    };
  }
  return {normalize, readRoute, routeURL, resetScroll, create};
});
