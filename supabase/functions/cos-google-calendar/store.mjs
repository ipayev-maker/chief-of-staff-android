// Server-only PostgREST adapter. Node.js 24 / Deno; Web APIs, no dependencies.
// Do not include this file or the service key in a browser bundle.
const PAGE_SIZE = 500;
const REQUEST_TIMEOUT_MS = 8_000;
const LIST_TIMEOUT_MS = 45_000;
const ORDERS = Object.freeze({
  cos_calendar_connection: 'id.asc',
  cos_calendar_oauth_states: 'state_hash.asc',
  cos_calendar_sessions: 'token_hash.asc',
  cos_calendar_bindings: 'connection_key.asc,source_kind.asc,source_id.asc',
  cos_calendar_lock: 'id.asc',
});

export class CalendarStoreError extends Error {
  constructor(message, { status = 0, code = 'STORE_ERROR', operation = '' } = {}) {
    super(message);
    this.name = 'CalendarStoreError';
    this.status = status;
    this.code = code;
    this.operation = operation;
  }
}

function identifier(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new CalendarStoreError('Invalid database identifier.', { code: 'INVALID_INPUT' });
  }
  return value;
}

function parameters(query) {
  if (typeof query !== 'string' && !(query instanceof URLSearchParams)) {
    throw new CalendarStoreError('Invalid database query.', { code: 'INVALID_INPUT' });
  }
  return new URLSearchParams(typeof query === 'string' ? query.replace(/^\?/, '') : query);
}

function mutationParameters(query) {
  const params = parameters(query);
  // A token/state deletion must be a single DELETE ... RETURNING, never a
  // preceding SELECT. Reject accidental unfiltered destructive operations.
  const controls = new Set(['select', 'order', 'limit', 'offset', 'on_conflict']);
  if (![...params.keys()].some(key => !controls.has(key))) {
    throw new CalendarStoreError('A database mutation requires a row filter.', { code: 'INVALID_INPUT' });
  }
  return params;
}

function rowObject(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new CalendarStoreError('Expected a database row object.', { code: 'INVALID_INPUT' });
  }
  return row;
}

function callerBudget(options, maximum) {
  const supplied = options?.timeoutMs;
  if (supplied === undefined) return maximum;
  if (!Number.isFinite(supplied)) {
    throw new CalendarStoreError('Invalid database timeout budget.', { code: 'INVALID_INPUT' });
  }
  if (supplied <= 0) throw new CalendarStoreError('Database time budget expired.', { code: 'STORE_TIMEOUT' });
  return Math.min(supplied, maximum);
}

export function createStore({ url, serviceKey, fetchImpl = fetch,
  requestTimeoutMs = REQUEST_TIMEOUT_MS, listTimeoutMs = LIST_TIMEOUT_MS } = {}) {
  let base;
  try {
    base = new URL(url);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error();
    if (!['', '/'].includes(base.pathname)) throw new Error();
  } catch {
    throw new CalendarStoreError('A valid HTTPS database origin is required.', { code: 'INVALID_CONFIG' });
  }
  if (typeof serviceKey !== 'string' || !serviceKey.trim() || typeof fetchImpl !== 'function') {
    throw new CalendarStoreError('Server database credentials are not configured.', { code: 'INVALID_CONFIG' });
  }
  // Smaller budgets are useful in tests; callers cannot extend a database
  // request or full scan beyond the worker's finite lease safety budget.
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > REQUEST_TIMEOUT_MS ||
      !Number.isFinite(listTimeoutMs) || listTimeoutMs <= 0 || listTimeoutMs > LIST_TIMEOUT_MS) {
    throw new CalendarStoreError('Invalid database timeout configuration.', { code: 'INVALID_CONFIG' });
  }

  async function request(path, { method = 'GET', query = '', body, prefer = '', timeoutMs = requestTimeoutMs } = {}) {
    const target = new URL(`/rest/v1/${path}`, base);
    target.search = parameters(query).toString();
    let response, text, timeoutId;
    const operation = method;
    const controller = new AbortController();
    let timedOut = false;
    try {
      ({ response, text } = await Promise.race([
        (async () => {
          const response = await fetchImpl(target.toString(), {
            method,
            redirect: 'error',
            signal: controller.signal,
            headers: {
              apikey: serviceKey,
              Authorization: `Bearer ${serviceKey}`,
              'Content-Type': 'application/json',
              ...(prefer ? { Prefer: prefer } : {}),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          // Reading a stalled response body is covered by the same deadline.
          return { response, text: await response.text() };
        })(),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new CalendarStoreError('Database request timed out.', { code: 'STORE_TIMEOUT', operation }));
          }, Math.max(1, Math.min(requestTimeoutMs, timeoutMs)));
        }),
      ]));
    } catch {
      // Do not retain `cause`: fetch errors can contain a URL with an OAuth
      // verifier/token hash, credentials, or a database error's private data.
      throw new CalendarStoreError(timedOut ? 'Database request timed out.' : 'Database request could not be completed.', {
        code: timedOut ? 'STORE_TIMEOUT' : 'STORE_NETWORK', operation,
      });
    } finally { clearTimeout(timeoutId); }
    if (!response.ok) {
      let rawCode;
      try { rawCode = JSON.parse(text)?.code; } catch {}
      // PostgREST and SQLSTATE codes are useful for retry/conflict decisions;
      // message/details/hint/body/URL must never reach public error output.
      const code = typeof rawCode === 'string' && /^(?:[0-9A-Z]{5}|PGRST\d{3})$/.test(rawCode)
        ? rawCode : 'STORE_HTTP';
      throw new CalendarStoreError(`Database request failed (HTTP ${response.status}).`, {
        status: response.status, code, operation,
      });
    }
    let data = null;
    if (text) {
      try { data = JSON.parse(text); }
      catch { throw new CalendarStoreError('Database returned an invalid response.', { code: 'STORE_RESPONSE', operation }); }
    }
    return { data, range: response.headers?.get('content-range') || '' };
  }

  function arrayResult(data) {
    if (!Array.isArray(data)) throw new CalendarStoreError('Database did not return rows.', { code: 'STORE_RESPONSE' });
    return data;
  }

  async function list(table, query = '', options = {}) {
    const deadline = performance.now() + callerBudget(options, listTimeoutMs);
    identifier(table);
    const params = parameters(query);
    // limit is a page size, never a silent total-row cap. offset selects the
    // starting page; without one list/rows returns the complete matching set.
    const rawLimit = params.get('limit'), rawOffset = params.get('offset');
    if ((rawLimit !== null && !/^[1-9]\d*$/.test(rawLimit)) ||
        (rawOffset !== null && !/^\d+$/.test(rawOffset))) {
      throw new CalendarStoreError('Invalid pagination parameters.', { code: 'INVALID_INPUT' });
    }
    const limit = rawLimit === null ? PAGE_SIZE : Math.min(Number(rawLimit), PAGE_SIZE);
    let offset = rawOffset === null ? 0 : Number(rawOffset);
    if (!Number.isSafeInteger(offset)) throw new CalendarStoreError('Invalid pagination offset.', { code: 'INVALID_INPUT' });
    if (!params.has('order')) params.set('order', ORDERS[table] || 'id.asc');
    params.set('limit', String(limit));
    const result = [];
    for (;;) {
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) throw new CalendarStoreError('Database listing timed out.', { code: 'STORE_TIMEOUT', operation: 'GET' });
      params.set('offset', String(offset));
      const { data, range } = await request(table, { query: params, prefer: 'count=exact', timeoutMs: remainingMs });
      const page = arrayResult(data);
      if (!page.length) return result;
      const bounds = /^(\d+)-(\d+)\/(\d+|\*)$/.exec(range);
      if (bounds && (Number(bounds[1]) !== offset || Number(bounds[2]) - Number(bounds[1]) + 1 !== page.length)) {
        throw new CalendarStoreError('Database pagination returned an inconsistent range.', { code: 'STORE_PAGINATION' });
      }
      result.push(...page);
      offset += page.length; // A server may cap pages below the requested limit.
      if (bounds && bounds[3] !== '*' && offset >= Number(bounds[3])) return result;
      // Without Content-Range, continue until an empty page. A short page
      // alone cannot prove completeness when the server has its own row cap.
    }
  }

  async function insert(table, row, options = {}) {
    const timeoutMs = callerBudget(options, requestTimeoutMs);
    const { data } = await request(identifier(table), {
      method: 'POST', body: rowObject(row), prefer: 'return=representation', timeoutMs,
    });
    const rows = arrayResult(data);
    if (rows.length !== 1) throw new CalendarStoreError('Database did not confirm one inserted row.', { code: 'STORE_RESPONSE' });
    return rows[0];
  }

  // One bounded page for interactive UIs. Unlike list(), this deliberately
  // does not scan subsequent pages. The extra row may be used as a sentinel.
  async function page(table, query = '', options = {}) {
    const timeoutMs = callerBudget(options, requestTimeoutMs);
    identifier(table);
    const params = parameters(query);
    const rawLimit = params.get('limit') ?? '50';
    const rawOffset = params.get('offset') ?? '0';
    if (!/^[1-9]\d*$/.test(rawLimit) || Number(rawLimit) > 101 ||
        !/^\d+$/.test(rawOffset) || !Number.isSafeInteger(Number(rawOffset))) {
      throw new CalendarStoreError('Invalid bounded pagination parameters.', { code: 'INVALID_INPUT' });
    }
    params.set('limit', rawLimit);
    params.set('offset', rawOffset);
    if (!params.has('order')) params.set('order', ORDERS[table] || 'id.asc');
    const { data } = await request(table, { query: params, timeoutMs });
    const result = arrayResult(data);
    if (result.length > Number(rawLimit)) {
      throw new CalendarStoreError('Database exceeded requested page size.', { code: 'STORE_PAGINATION' });
    }
    return result;
  }

  async function upsert(table, row, onConflict) {
    if (typeof onConflict !== 'string' || !onConflict.split(',').every(part => /^[a-z][a-z0-9_]*$/.test(part))) {
      throw new CalendarStoreError('Explicit conflict columns are required.', { code: 'INVALID_INPUT' });
    }
    const { data } = await request(identifier(table), {
      method: 'POST', query: new URLSearchParams({ on_conflict: onConflict }), body: rowObject(row),
      prefer: 'resolution=merge-duplicates,return=representation',
    });
    const rows = arrayResult(data);
    if (rows.length !== 1) throw new CalendarStoreError('Database did not confirm one upserted row.', { code: 'STORE_RESPONSE' });
    return rows[0];
  }

  async function patch(table, query, values, options = {}) {
    const timeoutMs = callerBudget(options, requestTimeoutMs);
    const { data } = await request(identifier(table), {
      method: 'PATCH', query: mutationParameters(query), body: rowObject(values), prefer: 'return=representation', timeoutMs,
    });
    return arrayResult(data); // [] is an expected lost compare-and-swap.
  }

  async function remove(table, query) {
    const { data } = await request(identifier(table), {
      method: 'DELETE', query: mutationParameters(query), prefer: 'return=representation',
    });
    return arrayResult(data); // Atomic consume: only one concurrent DELETE wins.
  }

  async function rpc(name, args = {}) {
    const { data } = await request(`rpc/${identifier(name)}`, { method: 'POST', body: rowObject(args) });
    return data;
  }

  return Object.freeze({ list, rows: list, page, insert, upsert, patch, remove, rpc });
}
