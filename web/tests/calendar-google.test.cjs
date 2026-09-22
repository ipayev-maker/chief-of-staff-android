const {test} = require('node:test');
const assert = require('node:assert/strict');
const implementation = import('../../supabase/functions/cos-google-calendar/google.mjs');

const config = {
  clientId: 'synthetic-client.apps.googleusercontent.com',
  clientSecret: 'SYNTHETIC_CLIENT_SECRET', allowedEmail: 'owner@example.test',
};
const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const state = 'synthetic-browser-bound-state-0123456789';
const canonicalScopes = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.app.created';
const tokens = {access_token:'SYNTHETIC_ACCESS', token_type:'Bearer', expires_in:3600, scope:canonicalScopes};
const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json'}});
const expectReason = (reason, status) => error => {
  assert.equal(error.name, 'GoogleError');
  assert.equal(error.reason, reason);
  if (status !== undefined) assert.equal(error.status, status);
  return true;
};

test('authorization URL fixes production callback, offline access, exact scopes and RFC 7636 PKCE vector', async () => {
  const {createGoogle, CALLBACK_URL, GOOGLE_SCOPES} = await implementation;
  const google = createGoogle({config, fetchImpl: () => {throw new Error('No HTTP during authorization URL creation');}});
  const url = new URL(await google.authorizationUrl({state, verifier}));
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.pathname, '/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('redirect_uri'), CALLBACK_URL);
  assert.equal(CALLBACK_URL, 'https://chief-of-staff-v3-live.vercel.app/api/google-calendar/callback');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent select_account');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), GOOGLE_SCOPES.join(' '));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.equal(url.searchParams.get('state'), state);
  assert.ok(!url.href.includes(config.clientSecret));
  assert.ok(!url.href.includes(verifier));
});

test('code exchange sends exact callback and verifier in a form body, accepting canonical email scope', async () => {
  const {createGoogle, CALLBACK_URL} = await implementation;
  let request;
  const google = createGoogle({config, fetchImpl:async (url, init) => {
    request = {url, init};
    return json({...tokens, refresh_token:'SYNTHETIC_REFRESH', id_token:'UNVERIFIED_ID_TOKEN'});
  }});
  const result = await google.exchangeCode({code:'synthetic-code+&=', verifier});
  assert.equal(request.url, 'https://oauth2.googleapis.com/token');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.redirect, 'error');
  const body = new URLSearchParams(request.init.body);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('redirect_uri'), CALLBACK_URL);
  assert.equal(body.get('code_verifier'), verifier);
  assert.equal(body.get('code'), 'synthetic-code+&=');
  assert.equal(body.get('client_secret'), config.clientSecret);
  assert.equal(result.refresh_token, 'SYNTHETIC_REFRESH');
  assert.equal(result.id_token, undefined);
});

test('missing Calendar grant is rejected even if broader calendar scopes were returned', async () => {
  const {createGoogle} = await implementation;
  for (const scope of [undefined, '', 'openid email', 'openid email https://www.googleapis.com/auth/calendar']) {
    const google = createGoogle({config, fetchImpl:async () => json({...tokens, scope})});
    await assert.rejects(google.exchangeCode({code:'code', verifier}), expectReason('missing_required_scopes', 403));
  }
});

test('scope aliases do not bypass missing identity scopes', async () => {
  const {createGoogle} = await implementation;
  for (const scope of ['email https://www.googleapis.com/auth/calendar.app.created', 'openid https://www.googleapis.com/auth/calendar.app.created']) {
    const google = createGoogle({config, fetchImpl:async () => json({...tokens, scope})});
    await assert.rejects(google.exchangeCode({code:'code', verifier}), expectReason('missing_required_scopes', 403));
  }
});

test('token response must contain a token with positive finite expiry', async () => {
  const {createGoogle} = await implementation;
  for (const change of [{access_token:''}, {access_token:'has whitespace'}, {expires_in:-1}, {expires_in:'3600'}, {expires_in:0}, {token_type:'mac'}]) {
    const google = createGoogle({config, fetchImpl:async () => json({...tokens, ...change})});
    await assert.rejects(google.exchangeCode({code:'code', verifier}), expectReason('invalid_token_response', 502));
  }
});

test('refresh supports inherited scope and a rotated refresh token', async () => {
  const {createGoogle} = await implementation;
  let params;
  const google = createGoogle({config, fetchImpl:async (_url, init) => {
    params = new URLSearchParams(init.body);
    return json({access_token:'NEW_ACCESS', expires_in:3600, refresh_token:'ROTATED_REFRESH'});
  }});
  const result = await google.refresh('OLD_REFRESH');
  assert.equal(params.get('grant_type'), 'refresh_token');
  assert.equal(params.get('refresh_token'), 'OLD_REFRESH');
  assert.equal(params.has('redirect_uri'), false);
  assert.equal(result.refresh_token, 'ROTATED_REFRESH');
  assert.equal(result.access_token, 'NEW_ACCESS');
});

test('expired authorization error includes reason and status but no raw error description or token', async () => {
  const {createGoogle} = await implementation;
  const google = createGoogle({config, fetchImpl:async () => json({
    error:'invalid_grant', error_description:'EXPOSED_SECRET_TOKEN: refresh token expired',
  }, 400)});
  await assert.rejects(google.refresh('SYNTHETIC_REFRESH'), error => {
    assert.equal(error.reason, 'invalid_grant');
    assert.equal(error.status, 400);
    assert.ok(!error.stack.includes('EXPOSED_SECRET_TOKEN'));
    assert.ok(!JSON.stringify(error).includes('SYNTHETIC_REFRESH'));
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('userinfo rejects unverified or different owners and accepts verified normalized owner', async () => {
  const {createGoogle} = await implementation;
  for (const email_verified of [false, 'true', undefined]) {
    const google = createGoogle({config, fetchImpl:async () => json({sub:'stable-owner-id', email:config.allowedEmail, email_verified})});
    await assert.rejects(google.userInfo('ACCESS'), expectReason('google_identity_unverified', 403));
  }
  const other = createGoogle({config, fetchImpl:async () => json({sub:'other', email:'other@example.test', email_verified:true})});
  await assert.rejects(other.userInfo('ACCESS'), expectReason('google_owner_mismatch', 403));
  const owner = createGoogle({config, fetchImpl:async (url, init) => {
    assert.equal(url, 'https://openidconnect.googleapis.com/v1/userinfo');
    assert.equal(init.headers.Authorization, 'Bearer ACCESS');
    return json({sub:'stable-owner-id', email:' OWNER@EXAMPLE.TEST ', email_verified:true});
  }});
  assert.deepEqual(await owner.userInfo('ACCESS'), {sub:'stable-owner-id', email:'owner@example.test', email_verified:true});
});

test('calendar request stays within API prefix and protects bearer while preserving etag precondition', async () => {
  const {createGoogle} = await implementation;
  let request;
  const api = createGoogle({config, fetchImpl:async (url, init) => {
    request = {url, init};
    return json({id:'managed-event'});
  }}).calendar('ACCESS');
  const result = await api.request('/calendars/owner%40example.test/events/managed-event', {
    method:'PATCH', body:{summary:'Synthetic'}, headers:{'If-Match':'"revision-1"', Authorization:'WRONG'},
  });
  assert.equal(request.url, 'https://www.googleapis.com/calendar/v3/calendars/owner%40example.test/events/managed-event');
  assert.equal(request.init.headers.get('Authorization'), 'Bearer ACCESS');
  assert.equal(request.init.headers.get('If-Match'), '"revision-1"');
  assert.equal(request.init.headers.get('Content-Type'), 'application/json');
  assert.equal(request.init.body, JSON.stringify({summary:'Synthetic'}));
  assert.equal(request.init.redirect, 'error');
  assert.equal(result.id, 'managed-event');
});

test('calendar paths reject absolute URLs, traversal, encoded traversal and query-only paths before fetch', async () => {
  const {createGoogle} = await implementation;
  let calls = 0;
  const api = createGoogle({config, fetchImpl:async () => {calls++; return json({});}}).calendar('ACCESS');
  for (const path of [
    'https://attacker.example/steal', '//attacker.example', '../oauth2', '/../../token',
    'calendars/%2e%2e/%2e%2e/token', 'calendars/%2f..%2ftoken', 'calendars/%252e%252e/token',
    '\\attacker.example', 'calendars/test#fragment', '?access_token=bad', 'calendars/test\n',
  ]) await assert.rejects(api.request(path), expectReason('invalid_calendar_path', 400));
  assert.equal(calls, 0);
});

test('calendar deletion accepts empty 204 and exposes allowlisted API reasons only', async () => {
  const {createGoogle} = await implementation;
  const deletion = createGoogle({config, fetchImpl:async () => new Response(null, {status:204})}).calendar('ACCESS');
  assert.equal(await deletion.request('calendars/test/events/event', {method:'DELETE'}), null);
  for (const [reason, expected] of [['conditionNotMet','conditionNotMet'], ['SECRET_TOKEN','google_error']]) {
    const api = createGoogle({config, fetchImpl:async () => json({error:{errors:[{reason}], message:'SECRET_TOKEN'}}, 412)}).calendar('ACCESS');
    await assert.rejects(api.request('calendars/test'), error => {
      assert.equal(error.status, 412);
      assert.equal(error.reason, expected);
      assert.ok(!error.stack.includes('SECRET_TOKEN'));
      return true;
    });
  }
});

test('calendar requests abort within caller budget and sanitize network errors', async () => {
  const {createGoogle} = await implementation;
  const api = createGoogle({config, fetchImpl:async (_url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('SECRET', 'AbortError')), {once:true});
  })}).calendar('ACCESS');
  await assert.rejects(api.request('calendars/test', {timeoutMs:5}), expectReason('google_timeout', 504));
  const network = createGoogle({config, fetchImpl:async () => {throw new Error('URL CONTAINING SECRET');}}).calendar('ACCESS');
  await assert.rejects(network.request('calendars/test'), error => {
    assert.equal(error.reason, 'google_network_error');
    assert.ok(!error.stack.includes('URL CONTAINING SECRET'));
    return true;
  });
});

test('encryption uses random authenticated envelopes and rejects tampering, wrong keys and versions', async () => {
  const {encryptSecret, decryptSecret} = await implementation;
  const key = Buffer.alloc(32, 11).toString('base64');
  const otherKey = Buffer.alloc(32, 12).toString('base64');
  const plaintext = 'SYNTHETIC_REFRESH_ключ';
  const first = await encryptSecret(plaintext, key);
  const second = await encryptSecret(plaintext, key);
  assert.match(first, /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
  assert.notEqual(first, second);
  assert.ok(!first.includes(plaintext));
  assert.equal(await decryptSecret(first, key), plaintext);
  assert.equal(await decryptSecret(await encryptSecret('', key), key), '');
  const parts = first.split('.');
  parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
  await assert.rejects(decryptSecret(parts.join('.'), key), expectReason('secret_decryption_failed', 500));
  await assert.rejects(decryptSecret(first, otherKey), expectReason('secret_decryption_failed', 500));
  await assert.rejects(decryptSecret(first.replace(/^v1/, 'v2'), key), expectReason('secret_decryption_failed', 500));
  await assert.rejects(encryptSecret(plaintext, Buffer.alloc(16).toString('base64')), expectReason('invalid_encryption_key', 500));
});

test('crypto helpers produce strong URL-safe random values, SHA-256 vector and exact comparison', async () => {
  const {randomToken, sha256, safeEqual} = await implementation;
  const first = randomToken();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, randomToken());
  assert.equal(await sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(safeEqual('same', 'same'), true);
  assert.equal(safeEqual('', ''), true);
  for (const [left, right] of [['one', 'two'], ['x', 'x\0'], ['é','e'], [null,''], ['abc','abcd']]) {
    assert.equal(safeEqual(left, right), false);
  }
});
