const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const modulePath = '../../supabase/functions/cos-google-calendar/store.mjs';
const config = { url: 'https://example.supabase.co', serviceKey: 'test-server-key' };
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', ...headers },
});

test('list fully paginates even when the server returns fewer rows than requested', async () => {
  const { createStore } = await import(modulePath);
  const rows = Array.from({ length: 7 }, (_, id) => ({ id }));
  const requests = [];
  const store = createStore({ ...config, fetchImpl: async (url, options) => {
    const q = new URL(url).searchParams, offset = Number(q.get('offset'));
    requests.push({ q, options });
    const page = rows.slice(offset, offset + 2);
    return json(page, 206, { 'content-range': `${offset}-${offset + page.length - 1}/${rows.length}` });
  } });
  assert.deepEqual(await store.list('commitments', 'status=neq.cancelled&select=id'), rows);
  assert.deepEqual(requests.map(r => r.q.get('offset')), ['0', '2', '4', '6']);
  for (const request of requests) {
    assert.equal(request.q.get('status'), 'neq.cancelled');
    assert.equal(request.q.get('select'), 'id');
    assert.equal(request.q.get('order'), 'id.asc');
    assert.equal(request.options.headers.Prefer, 'count=exact');
    assert.equal(request.options.headers.Authorization, 'Bearer test-server-key');
    assert.equal(request.options.redirect, 'error');
  }
});

test('rows alias continues past short pages without Content-Range and honors compound ordering', async () => {
  const { createStore } = await import(modulePath);
  const offsets = [], results = [{ source_id: 'a' }, { source_id: 'b' }, { source_id: 'c' }];
  const store = createStore({ ...config, fetchImpl: async url => {
    const q = new URL(url).searchParams, offset = Number(q.get('offset'));
    offsets.push(offset);
    assert.equal(q.get('limit'), '1');
    assert.equal(q.get('order'), 'connection_key.asc,source_kind.asc,source_id.asc');
    return json(results.slice(offset, offset + 1));
  } });
  assert.deepEqual(await store.rows('cos_calendar_bindings', 'limit=1&connection_key=eq.owner'), results);
  assert.deepEqual(offsets, [0, 1, 2, 3]);
});

test('page performs one bounded request, preserving offset and filters without changing full-list behavior', async () => {
  const {createStore} = await import(modulePath);
  let calls = 0;
  const store = createStore({...config, fetchImpl:async url => {
    calls++;
    const params = new URL(url).searchParams;
    assert.equal(params.get('limit'), '51');
    assert.equal(params.get('offset'), '50');
    assert.equal(params.get('archived_at'), 'is.null');
    assert.equal(params.get('order'), 'created_at.desc,id.desc');
    return json([{id:'one'}]);
  }});
  assert.deepEqual(await store.page('quick_notes', 'limit=51&offset=50&archived_at=is.null&order=created_at.desc,id.desc'), [{id:'one'}]);
  assert.equal(calls, 1);
  for (const query of ['limit=102', 'limit=0', 'offset=-1', 'offset=9007199254740992']) {
    await assert.rejects(store.page('quick_notes', query), error => error.code === 'INVALID_INPUT');
  }
  assert.equal(calls, 1);
  const overrun = createStore({...config, fetchImpl:async () => json([{id:1},{id:2}])});
  await assert.rejects(overrun.page('quick_notes', 'limit=1'), error => error.code === 'STORE_PAGINATION');
});

test('pagination refuses inconsistent ranges instead of treating a partial snapshot as complete', async () => {
  const { createStore } = await import(modulePath);
  const store = createStore({ ...config, fetchImpl: async () => json([{ id: 1 }], 206, { 'content-range': '7-7/20' }) });
  await assert.rejects(store.list('meetings'), error => error.code === 'STORE_PAGINATION');
});

test('state consumption is one atomic DELETE RETURNING and a second consumer sees no rows', async () => {
  const { createStore } = await import(modulePath);
  let state = { state_hash: 'test-hash', verifier: 'private-test-verifier' };
  const calls = [];
  const store = createStore({ ...config, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    const removed = state; state = null;
    return json(removed ? [removed] : []);
  } });
  const [first, second] = await Promise.all([
    store.remove('cos_calendar_oauth_states', 'state_hash=eq.test-hash&browser_hash=eq.bound-browser'),
    store.remove('cos_calendar_oauth_states', 'state_hash=eq.test-hash&browser_hash=eq.bound-browser'),
  ]);
  assert.equal(first.length + second.length, 1);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.method, 'DELETE');
    assert.equal(call.options.headers.Prefer, 'return=representation');
    assert.equal(new URL(call.url).searchParams.get('browser_hash'), 'eq.bound-browser');
  }
});

test('insert/upsert return one confirmed row; CAS patch returns an empty array on lost race', async () => {
  const { createStore } = await import(modulePath);
  const calls = [];
  const store = createStore({ ...config, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return options.method === 'PATCH' ? json([]) : json([JSON.parse(options.body)]);
  } });
  assert.deepEqual(await store.insert('cos_calendar_sessions', { token_hash: 'hash' }), { token_hash: 'hash' });
  const binding = { connection_key: 'connection', source_kind: 'task', source_id: 'source', generation: 1 };
  assert.deepEqual(await store.upsert('cos_calendar_bindings', binding, 'connection_key,source_kind,source_id'), binding);
  assert.equal(new URL(calls[1].url).searchParams.get('on_conflict'), 'connection_key,source_kind,source_id');
  assert.match(calls[1].options.headers.Prefer, /resolution=merge-duplicates/);
  assert.deepEqual(await store.patch('cos_calendar_bindings', 'generation=eq.0&state=eq.deleted&source_id=eq.source', { generation: 1 }), []);
  const empty = createStore({ ...config, fetchImpl: async () => json([]) });
  await assert.rejects(empty.insert('cos_calendar_sessions', {}), error => error.code === 'STORE_RESPONSE');
});

test('errors preserve safe status/code but never response bodies, query data, key, or causes', async () => {
  const { createStore, CalendarStoreError } = await import(modulePath);
  const secret = 'private-refresh-token-SHOULD-NOT-APPEAR';
  const store = createStore({ ...config, fetchImpl: async () => json({
    code: '23505', message: secret, details: config.serviceKey, hint: 'verifier=' + secret,
  }, 409) });
  await assert.rejects(store.remove('cos_calendar_oauth_states', `state_hash=eq.${secret}`), error => {
    assert.ok(error instanceof CalendarStoreError);
    assert.equal(error.code, '23505'); assert.equal(error.status, 409);
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(JSON.stringify(error) + error.stack, new RegExp(`${secret}|${config.serviceKey}`));
    return true;
  });
  const network = createStore({ ...config, fetchImpl: async () => { throw new Error(secret + config.serviceKey); } });
  await assert.rejects(network.rpc('cos_calendar_get_config'), error => {
    assert.equal(error.code, 'STORE_NETWORK');
    assert.doesNotMatch(JSON.stringify(error) + error.stack, new RegExp(`${secret}|${config.serviceKey}`));
    return true;
  });
  const badCode = createStore({ ...config, fetchImpl: async () => json({ code: secret }, 500) });
  await assert.rejects(badCode.list('projects'), error => error.code === 'STORE_HTTP');
});

test('RPC preserves booleans/objects, rejects dangerous paths and unfiltered mutations', async () => {
  const { createStore } = await import(modulePath);
  let calls = 0;
  const store = createStore({ ...config, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(new URL(url).pathname, '/rest/v1/rpc/cos_calendar_claim_lock');
    assert.deepEqual(JSON.parse(options.body), { p_holder: 'holder', p_seconds: 120 });
    return json(true);
  } });
  assert.equal(await store.rpc('cos_calendar_claim_lock', { p_holder: 'holder', p_seconds: 120 }), true);
  await assert.rejects(store.list('../rpc/cos_calendar_get_config'), /identifier/);
  await assert.rejects(store.list('projects', 'offset=-1'), /pagination/);
  await assert.rejects(store.remove('cos_calendar_connection', ''), /filter/);
  await assert.rejects(store.patch('cos_calendar_bindings', 'select=*', {}), /filter/);
  assert.equal(calls, 1);
  assert.throws(() => createStore({ ...config, url: 'https://example.com/rest/v1/?key=secret' }), /origin/);
});

test('request timeout aborts both stalled fetch and stalled response body without leaking errors', async () => {
  const { createStore } = await import(modulePath);
  for (const stallBody of [false, true]) {
    let signal;
    const store = createStore({ ...config, requestTimeoutMs: 15, fetchImpl: async (_, options) => {
      signal = options.signal;
      // Ignore abort deliberately: the store's own deadline must still settle.
      if (!stallBody) return new Promise(() => {});
      return { ok: true, status: 200, text: () => new Promise(() => {}) };
    } });
    await assert.rejects(store.rpc('cos_calendar_get_config'), error => {
      assert.equal(error.code, 'STORE_TIMEOUT');
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(JSON.stringify(error), /test-server-key/);
      return true;
    });
    assert.equal(signal.aborted, true);
  }
});

test('full list has a shared total deadline and never returns a timed-out partial snapshot', async () => {
  const { createStore } = await import(modulePath);
  let calls = 0;
  const store = createStore({ ...config, requestTimeoutMs: 20, listTimeoutMs: 25,
    fetchImpl: async url => {
      const offset = Number(new URL(url).searchParams.get('offset'));
      calls++;
      await new Promise(resolve => setTimeout(resolve, 8));
      return json([{ id: offset }], 206, { 'content-range': `${offset}-${offset}/1000` });
    },
  });
  await assert.rejects(store.list('commitments'), error => error.code === 'STORE_TIMEOUT');
  assert.ok(calls >= 2 && calls <= 4);
  assert.throws(() => createStore({ ...config, requestTimeoutMs: 8001 }), /timeout/);
  assert.throws(() => createStore({ ...config, listTimeoutMs: 45001 }), /timeout/);
});

test('per-call list/insert/patch budgets respect the worker deadline and reject expired work before fetch', async () => {
  const { createStore } = await import(modulePath);
  let calls = 0;
  const store = createStore({ ...config, fetchImpl: async () => {
    calls++;
    return new Promise(() => {});
  } });
  const operations = [
    options => store.list('commitments', '', options),
    options => store.insert('cos_calendar_bindings', { source_id: 'source' }, options),
    options => store.patch('cos_calendar_bindings', 'source_id=eq.source', { state: 'active' }, options),
  ];
  for (const operation of operations) {
    const before = calls;
    await assert.rejects(operation({ timeoutMs: 0 }), error => error.code === 'STORE_TIMEOUT');
    await assert.rejects(operation({ timeoutMs: -1 }), error => error.code === 'STORE_TIMEOUT');
    assert.equal(calls, before);
    await assert.rejects(operation({ timeoutMs: 5 }), error => error.code === 'STORE_TIMEOUT');
    assert.equal(calls, before + 1);
  }
});

test('schema includes service-only privileges, RLS assertions, guarded Vault access and atomic locks', () => {
  const sql = fs.readFileSync(path.resolve(__dirname, '../../supabase/calendar-schema.sql'), 'utf8');
  for (const table of ['connection', 'oauth_states', 'sessions', 'bindings', 'lock']) {
    assert.match(sql, new RegExp(`alter table public\\.cos_calendar_${table} enable row level security;`, 'i'));
    assert.match(sql, new RegExp(`alter table public\\.cos_calendar_${table} force row level security;`, 'i'));
  }
  for (const fn of ['get_config', 'claim_lock', 'release_lock', 'touch_updated_at']) {
    assert.match(sql, new RegExp(`revoke all privileges on function public\\.cos_calendar_${fn}\\([^;]*from public, anon, authenticated;`, 'i'));
    assert.match(sql, new RegExp(`grant execute on function public\\.cos_calendar_${fn}\\([^;]*to service_role;`, 'i'));
  }
  const getter = sql.split('create or replace function cos_calendar_private.get_config()')[1].split('$function$;')[0];
  assert.match(getter, /security definer\s+set search_path = ''/i);
  assert.match(getter, /request_role <> 'service_role'/);
  assert.match(getter, /where name = 'cos_calendar_config'/);
  assert.match(sql, /on conflict \(id\) do update[\s\S]*?where existing\.expires_at <= claim_time;/);
  assert.match(sql, /delete from public\.cos_calendar_lock where id = 'owner' and holder = p_holder;/);
  assert.match(sql, /has_any_column_privilege/);
  assert.match(sql, /revoke all privileges on schema cos_calendar_private from public, anon, authenticated;/);
  assert.match(sql, /revoke all privileges on function cos_calendar_private\.get_config\(\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function cos_calendar_private\.get_config\(\) to service_role;/);
  const publicGetter = sql.split('create or replace function public.cos_calendar_get_config()')[1].split('$function$;')[0];
  assert.match(publicGetter, /security invoker\s+set search_path = ''/i);
  assert.match(publicGetter, /select cos_calendar_private\.get_config\(\)/);
  assert.match(sql, /has_schema_privilege/);
  assert.doesNotMatch(sql, /cron\.schedule|grant[^;]*vault\.decrypted_secrets/i);
});
