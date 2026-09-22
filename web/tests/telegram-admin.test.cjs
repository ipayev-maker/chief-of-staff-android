// Node.js 24 built-ins only. All credentials, RPC responses and Telegram calls are synthetic.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const implementation = import('../../supabase/functions/cos-telegram-admin/handler.mjs');
const BASE = 'https://synthetic-project.example.invalid';
const EXPECTED_URL = BASE + '/functions/v1/telegram-webhook';
const SERVICE_KEY = 'SYNTHETIC_SERVICE_KEY';
const BOT_TOKEN = '123456:SYNTHETIC_BOT_TOKEN';
const CRON_SECRET = 'SYNTHETIC_EXISTING_CALENDAR_CRON_SECRET';
const WEBHOOK_SECRET = 'SYNTHETIC_STORED_WEBHOOK_SECRET_0123456789';
const secrets = [SERVICE_KEY, BOT_TOKEN, CRON_SECRET, WEBHOOK_SECRET];
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers:{'Content-Type':'application/json'},
});

async function fixture(options = {}) {
  const {createTelegramAdmin} = await implementation;
  const calls = [];
  const f = {
    calls,
    calendarConfig:{cronSecret:CRON_SECRET},
    notesConfig:{webhookSecret:WEBHOOK_SECRET, telegramOwnerUserId:'12345678', telegramOwnerChatId:'12345678'},
    info:{url:EXPECTED_URL, pending_update_count:7, max_connections:23,
      allowed_updates:['message','edited_message'], has_custom_certificate:false},
    onFetch:null,
  };
  const fetchImpl = async (target, init) => {
    const url = String(target);
    const headers = new Headers(init.headers);
    const body = JSON.parse(init.body);
    const call = {url, method:init.method, headers, body};
    calls.push(call);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(headers.get('Content-Type'), 'application/json');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    const custom = await f.onFetch?.(call);
    if (custom !== undefined) return custom;
    if (url.startsWith(BASE + '/rest/v1/rpc/')) {
      assert.equal(headers.get('apikey'), SERVICE_KEY);
      assert.equal(headers.get('Authorization'), 'Bearer ' + SERVICE_KEY);
      assert.deepEqual(body, {});
      if (url.endsWith('/cos_calendar_get_config')) return json(f.calendarConfig);
      if (url.endsWith('/cos_notes_get_config')) return json(f.notesConfig);
    }
    if (url === 'https://api.telegram.org/bot' + BOT_TOKEN + '/getWebhookInfo') {
      assert.equal(headers.has('Authorization'), false);
      assert.equal(headers.has('apikey'), false);
      assert.deepEqual(body, {});
      return json({ok:true, result:f.info});
    }
    if (url === 'https://api.telegram.org/bot' + BOT_TOKEN + '/setWebhook') {
      assert.equal(headers.has('Authorization'), false);
      assert.equal(headers.has('apikey'), false);
      return json({ok:true, result:true});
    }
    assert.fail('Unexpected outbound operation; the fixture performs no network calls: ' + new URL(url).pathname.split('/').at(-1));
  };
  f.handler = createTelegramAdmin({url:BASE, serviceKey:SERVICE_KEY, botToken:BOT_TOKEN, ...options, fetchImpl});
  f.invoke = async (action = 'getInfo', {authorization = 'Bearer ' + CRON_SECRET, body, method = 'POST'} = {}) => {
    const headers = {'Content-Type':'application/json'};
    if (authorization !== null) headers.Authorization = authorization;
    const request = new Request(BASE + '/functions/v1/cos-telegram-admin', {
      method, headers, ...(method === 'POST' ? {body:body ?? JSON.stringify({action})} : {}),
    });
    const response = await f.handler(request);
    const text = await response.text();
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    for (const secret of secrets) assert.ok(!text.includes(secret), 'response must not disclose credentials');
    return {response, body:JSON.parse(text), text};
  };
  f.methods = () => calls.filter(call => call.url.startsWith('https://api.telegram.org/'))
    .map(call => new URL(call.url).pathname.split('/').at(-1));
  return f;
}

test('getInfo authorizes with the existing calendar cron secret and never sends a message or changes the webhook', async () => {
  const f = await fixture();
  const {response, body} = await f.invoke();
  assert.equal(response.status, 200);
  assert.deepEqual(body, {ok:true, url:EXPECTED_URL, matches_expected:true, has_query:false,
    has_custom_certificate:false, pending_update_count:7, max_connections:23,
    allowed_updates:['message','edited_message'], last_error_date:null});
  assert.equal(f.calls[0].url, BASE + '/rest/v1/rpc/cos_calendar_get_config');
  assert.deepEqual(f.methods(), ['getWebhookInfo']);
  assert.equal(f.calls.some(call => call.url.endsWith('/cos_notes_get_config')), false);
});

test('missing or malformed authorization stops before any upstream request', async () => {
  for (const authorization of [null, 'Basic anything', 'Bearer one two', 'Bearer', 'Bearer ']) {
    const f = await fixture();
    const {response, body} = await f.invoke('configure', {authorization});
    assert.equal(response.status, 401);
    assert.deepEqual(body, {error:'unauthorized'});
    assert.equal(f.calls.length, 0);
  }
});

test('wrong bearer, service key and webhook secret cannot administer Telegram', async () => {
  for (const value of ['wrong', SERVICE_KEY, WEBHOOK_SECRET, CRON_SECRET + 'x', CRON_SECRET.slice(0,-1)]) {
    const f = await fixture();
    const {response, body} = await f.invoke('configure', {authorization:'Bearer ' + value});
    assert.equal(response.status, 401);
    assert.deepEqual(body, {error:'unauthorized'});
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, BASE + '/rest/v1/rpc/cos_calendar_get_config');
    assert.deepEqual(f.methods(), []);
  }
});

test('missing stored calendar cron secret cannot be supplied through the request body', async () => {
  const f = await fixture();
  f.calendarConfig = {};
  const {response} = await f.invoke('configure', {body:JSON.stringify({action:'configure', cronSecret:CRON_SECRET})});
  assert.equal(response.status, 401);
  assert.deepEqual(f.methods(), []);
});

test('configure uses the stored secret and preserves the exact existing URL, update selection and connection limit', async () => {
  const f = await fixture({url:BASE + '/'});
  const {response, body} = await f.invoke('configure', {body:JSON.stringify({
    action:'configure', url:'https://attacker.example.invalid/collect',
    secret_token:'UNTRUSTED_REQUEST_SECRET', drop_pending_updates:true, max_connections:100,
    allowed_updates:['callback_query'],
  })});
  assert.equal(response.status, 200);
  assert.equal(body.configured, true);
  assert.equal(body.matches_expected, true);
  assert.deepEqual(f.methods(), ['getWebhookInfo','setWebhook','getWebhookInfo']);
  const setting = f.calls.find(call => call.url.endsWith('/setWebhook'));
  assert.deepEqual(setting.body, {url:EXPECTED_URL, secret_token:WEBHOOK_SECRET,
    drop_pending_updates:false, max_connections:23, allowed_updates:['message','edited_message']});
  assert.equal(f.calls.findIndex(call => call.url.endsWith('/cos_notes_get_config')),
    f.calls.findIndex(call => call.url.endsWith('/setWebhook')) - 1);
  assert.equal(body.secret_token, undefined);
  assert.equal(body.webhookSecret, undefined);
});

test('configure rejects unset, foreign and almost-matching webhook URLs before reading or sending the notes secret', async () => {
  for (const url of ['', 'https://other.example.invalid/functions/v1/telegram-webhook',
    BASE + '/functions/v1/other-webhook', EXPECTED_URL + '/',
    EXPECTED_URL + '?secret=' + WEBHOOK_SECRET, EXPECTED_URL + '#fragment',
    EXPECTED_URL.replace('https:', 'http:')]) {
    const f = await fixture();
    f.info.url = url;
    const {response, body} = await f.invoke('configure');
    assert.equal(response.status, 409);
    assert.equal(body.error, 'unexpected_webhook_url');
    assert.equal(body.matches_expected, false);
    assert.deepEqual(f.methods(), ['getWebhookInfo']);
    assert.equal(f.calls.some(call => call.url.endsWith('/cos_notes_get_config')), false);
  }
});

test('getInfo strips query credentials and does not echo raw Telegram errors or endpoint credentials', async () => {
  const f = await fixture();
  f.info.url = BASE + '/functions/v1/telegram-webhook?token=' + WEBHOOK_SECRET;
  f.info.last_error_message = 'Sensitive upstream error ' + BOT_TOKEN;
  f.info.ip_address = '192.0.2.7';
  f.info.last_error_date = 1234567890;
  const {response, body} = await f.invoke();
  assert.equal(response.status, 200);
  assert.equal(body.url, EXPECTED_URL);
  assert.equal(body.has_query, true);
  assert.equal(body.matches_expected, false);
  assert.equal(body.last_error_date, 1234567890);
  assert.equal(body.last_error_message, undefined);
  assert.equal(body.ip_address, undefined);
});

test('configure refuses an invalid stored webhook secret or an unbound owner chat', async () => {
  for (const patch of [{webhookSecret:''}, {webhookSecret:'short'}, {webhookSecret:'x'.repeat(257)},
    {webhookSecret:'x'.repeat(32) + '!'}, {telegramOwnerUserId:''},
    {telegramOwnerUserId:'not-a-user'}, {telegramOwnerChatId:'87654321'}]) {
    const f = await fixture();
    Object.assign(f.notesConfig, patch);
    const {response, body} = await f.invoke('configure');
    assert.equal(response.status, 502);
    assert.deepEqual(body, {error:'notes_not_configured'});
    assert.deepEqual(f.methods(), ['getWebhookInfo']);
  }
});

test('configure never discards pending updates when optional existing settings are empty', async () => {
  const f = await fixture();
  f.info.allowed_updates = [];
  delete f.info.max_connections;
  const {response} = await f.invoke('configure');
  assert.equal(response.status, 200);
  const body = f.calls.find(call => call.url.endsWith('/setWebhook')).body;
  assert.deepEqual(body, {url:EXPECTED_URL, secret_token:WEBHOOK_SECRET, drop_pending_updates:false});
});

test('unsupported method, incomplete deployment, malformed JSON and unknown actions cannot modify Telegram', async () => {
  const method = await fixture();
  assert.equal((await method.invoke('configure', {method:'GET'})).response.status, 405);
  assert.equal(method.calls.length, 0);
  for (const option of [{url:''}, {serviceKey:''}, {botToken:''}]) {
    const f = await fixture(option);
    assert.deepEqual((await f.invoke('configure')).body, {error:'admin_not_configured'});
    assert.equal(f.calls.length, 0);
  }
  for (const [body, code] of [['{','invalid_json'], ['{}','invalid_action'],
    [JSON.stringify({action:'sendMessage', text:'Synthetic'}),'invalid_action']]) {
    const f = await fixture();
    const result = await f.invoke('configure', {body});
    assert.equal(result.response.status, 400);
    assert.deepEqual(result.body, {error:code});
    assert.deepEqual(f.methods(), []);
  }
});

test('upstream transport, HTTP and Telegram API failures return only safe error codes', async () => {
  for (const [mode, code] of [['network','upstream_unavailable'], ['invalid_json','upstream_unavailable'],
    ['http','upstream_rejected'], ['telegram','telegram_rejected']]) {
    const f = await fixture();
    f.onFetch = call => {
      if (!call.url.endsWith('/getWebhookInfo')) return;
      if (mode === 'network') throw new Error('RAW_ERROR_' + SERVICE_KEY);
      if (mode === 'invalid_json') return new Response('RAW_ERROR_' + BOT_TOKEN);
      if (mode === 'http') return json({description:WEBHOOK_SECRET}, 500);
      return json({ok:false, description:CRON_SECRET});
    };
    const {response, body} = await f.invoke('configure');
    assert.equal(response.status, 502);
    assert.deepEqual(body, {error:code});
    assert.deepEqual(f.methods(), ['getWebhookInfo']);
  }
});

test('a rejected setWebhook is not reported as configured and sends no Telegram messages', async () => {
  const f = await fixture();
  f.onFetch = call => call.url.endsWith('/setWebhook')
    ? json({ok:false, description:'REJECTED_SECRET_' + WEBHOOK_SECRET}) : undefined;
  const {response, body} = await f.invoke('configure');
  assert.equal(response.status, 502);
  assert.deepEqual(body, {error:'telegram_rejected'});
  assert.deepEqual(f.methods(), ['getWebhookInfo','setWebhook']);
});
