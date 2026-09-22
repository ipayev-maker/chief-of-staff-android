// Portable Web APIs only: Supabase Edge (Deno) and Node.js 24.
export const APP_ORIGIN = 'https://chief-of-staff-v3-live.vercel.app';
export const CALLBACK_URL = `${APP_ORIGIN}/api/google-calendar/callback`;
export const GOOGLE_SCOPES = Object.freeze([
  'openid', 'email', 'https://www.googleapis.com/auth/calendar.app.created',
]);

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3/';
const MAX_TIMEOUT_MS = 12_000;
const SECRET_AAD = new TextEncoder().encode('cos-google-calendar:secret:v1');
const GOOGLE_REASONS = new Set([
  'invalid_grant', 'invalid_client', 'unauthorized_client', 'access_denied',
  'invalid_request', 'invalid_scope', 'unsupported_grant_type', 'server_error',
  'temporarily_unavailable', 'rateLimitExceeded', 'userRateLimitExceeded',
  'quotaExceeded', 'dailyLimitExceeded', 'limitExceeded', 'forbidden',
  'notFound', 'duplicate', 'conflict', 'conditionNotMet', 'deleted',
  'fullSyncRequired', 'updatedMinTooLongAgo', 'forbiddenForNonOrganizer',
  'requiredAccessLevel', 'insufficientPermissions', 'authError', 'backendError',
  'badRequest', 'invalid', 'UNAUTHENTICATED', 'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED', 'NOT_FOUND', 'INVALID_ARGUMENT', 'UNAVAILABLE',
  'INTERNAL', 'FAILED_PRECONDITION', 'ALREADY_EXISTS',
]);

// Never attach response bodies, request parameters, access tokens or causes.
export class GoogleError extends Error {
  constructor(status, reason) {
    super(`Google integration error (${status}; ${reason}).`);
    this.name = 'GoogleError';
    this.status = status;
    this.reason = reason;
  }
}

function fail(reason, status = 400) {
  throw new GoogleError(status, reason);
}

function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function bearer(value) {
  if (!nonempty(value) || /\s/.test(value)) fail('invalid_access_token');
  return `Bearer ${value}`;
}

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64(value, urlOnly = false) {
  if (typeof value !== 'string' || !value.length ||
      !(urlOnly ? /^[A-Za-z0-9_-]+$/ : /^[A-Za-z0-9+/_-]+={0,2}$/).test(value)) {
    throw new Error('Invalid encoding');
  }
  const unpadded = value.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) throw new Error('Invalid encoding');
  const normal = unpadded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normal + '='.repeat((4 - normal.length % 4) % 4));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  // Reject noncanonical encodings with unused nonzero trailing bits.
  if (base64url(bytes) !== unpadded.replace(/\+/g, '-').replace(/\//g, '_')) {
    throw new Error('Invalid encoding');
  }
  return bytes;
}

export function randomToken(bytes = 32) {
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > 65_536) {
    fail('invalid_random_length');
  }
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(text) {
  if (typeof text !== 'string') fail('invalid_hash_input');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

// A fixed-work comparison for equal-sized secrets, without an early mismatch
// exit. JS runtimes do not offer a portable hard constant-time guarantee.
export function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    mismatch |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return mismatch === 0;
}

async function secretKey(keyBase64) {
  try {
    const bytes = decodeBase64(keyBase64);
    if (bytes.length !== 32) throw new Error('Invalid key size');
    return await crypto.subtle.importKey('raw', bytes, {name: 'AES-GCM'}, false, ['encrypt', 'decrypt']);
  } catch {
    fail('invalid_encryption_key', 500);
  }
}

export async function encryptSecret(plaintext, keyBase64) {
  if (typeof plaintext !== 'string') fail('invalid_secret');
  const key = await secretKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {name: 'AES-GCM', iv, additionalData: SECRET_AAD, tagLength: 128},
    key,
    new TextEncoder().encode(plaintext),
  );
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(envelope, keyBase64) {
  const key = await secretKey(keyBase64);
  try {
    if (typeof envelope !== 'string') throw new Error('Invalid envelope');
    const parts = envelope.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('Invalid envelope');
    const iv = decodeBase64(parts[1], true);
    const ciphertext = decodeBase64(parts[2], true);
    if (iv.length !== 12 || ciphertext.length < 16) throw new Error('Invalid envelope');
    const plaintext = await crypto.subtle.decrypt(
      {name: 'AES-GCM', iv, additionalData: SECRET_AAD, tagLength: 128}, key, ciphertext,
    );
    return new TextDecoder('utf-8', {fatal: true}).decode(plaintext);
  } catch {
    fail('secret_decryption_failed', 500);
  }
}

function validateVerifier(verifier) {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
    fail('invalid_pkce_verifier');
  }
}

function validateScopes(scope) {
  if (!nonempty(scope)) fail('missing_required_scopes', 403);
  const granted = new Set(scope.trim().split(/\s+/).map(value =>
    value === 'https://www.googleapis.com/auth/userinfo.email' ? 'email' : value,
  ));
  if (!GOOGLE_SCOPES.every(value => granted.has(value))) {
    fail('missing_required_scopes', 403);
  }
}

function tokenResult(data, requireScopes) {
  if (!data || typeof data !== 'object' || !nonempty(data.access_token) ||
      /\s/.test(data.access_token) ||
      (data.token_type !== undefined && String(data.token_type).toLowerCase() !== 'bearer') ||
      !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0 ||
      (data.refresh_token !== undefined && !nonempty(data.refresh_token))) {
    fail('invalid_token_response', 502);
  }
  if (requireScopes || data.scope !== undefined) validateScopes(data.scope);
  // Return only the token fields the server needs; do not propagate ID tokens
  // that have not been independently verified.
  return {
    access_token: data.access_token,
    token_type: 'Bearer',
    expires_in: data.expires_in,
    ...(data.scope !== undefined ? {scope: data.scope} : {}),
    ...(data.refresh_token !== undefined ? {refresh_token: data.refresh_token} : {}),
  };
}

function errorReason(data) {
  const candidates = [
    typeof data?.error === 'string' ? data.error : null,
    data?.error?.errors?.[0]?.reason,
    data?.error?.status,
  ];
  return candidates.find(reason => GOOGLE_REASONS.has(reason)) || 'google_error';
}

function calendarUrl(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath ||
      /[\\#\u0000-\u0020\u007f]/.test(relativePath) || relativePath.startsWith('//')) {
    fail('invalid_calendar_path');
  }
  const path = relativePath.replace(/^\//, '');
  if (!path || path.startsWith('?') || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
    fail('invalid_calendar_path');
  }
  try {
    for (const segment of path.split('?')[0].split('/')) {
      const decoded = decodeURIComponent(segment);
      if (!decoded || decoded === '.' || decoded === '..' || /[%\\/\u0000-\u0020\u007f]/.test(decoded)) {
        throw new Error('Invalid path');
      }
    }
    const url = new URL(path, CALENDAR_BASE);
    if (url.origin !== 'https://www.googleapis.com' || !url.pathname.startsWith('/calendar/v3/')) {
      throw new Error('Invalid path');
    }
    return url.href;
  } catch {
    fail('invalid_calendar_path');
  }
}

export function createGoogle({config, fetchImpl = fetch}) {
  if (!config || !nonempty(config.clientId) || !nonempty(config.clientSecret) ||
      !nonempty(config.allowedEmail) || typeof fetchImpl !== 'function') {
    fail('google_configuration_missing', 500);
  }
  const clientId = config.clientId;
  const clientSecret = config.clientSecret;
  const allowedEmail = config.allowedEmail.trim().toLowerCase();

  async function requestJson(url, init = {}, timeoutMs = MAX_TIMEOUT_MS) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) fail('invalid_timeout');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(Math.floor(timeoutMs), MAX_TIMEOUT_MS));
    try {
      const response = await fetchImpl(url, {...init, signal: controller.signal, redirect: 'error'});
      const body = await response.text();
      let data = null;
      try { data = body ? JSON.parse(body) : null; } catch {
        if (response.ok) fail('invalid_google_response', 502);
      }
      if (!response.ok) throw new GoogleError(response.status, errorReason(data));
      if (response.status === 204) return null;
      if (data === null || typeof data !== 'object') fail('invalid_google_response', 502);
      return data;
    } catch (error) {
      if (error instanceof GoogleError) throw error;
      if (controller.signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        fail('google_timeout', 504);
      }
      fail('google_network_error', 502);
    } finally {
      clearTimeout(timer);
    }
  }

  async function tokenRequest(parameters) {
    return requestJson(TOKEN_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json'},
      body: new URLSearchParams({client_id: clientId, client_secret: clientSecret, ...parameters}).toString(),
    });
  }

  return {
    async authorizationUrl({state, verifier}) {
      if (typeof state !== 'string' || !/^[A-Za-z0-9._~-]{32,512}$/.test(state)) fail('invalid_oauth_state');
      validateVerifier(verifier);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({
        client_id: clientId, redirect_uri: CALLBACK_URL, response_type: 'code',
        scope: GOOGLE_SCOPES.join(' '), state, access_type: 'offline',
        prompt: 'consent select_account', code_challenge_method: 'S256',
        code_challenge: base64url(new Uint8Array(digest)),
      }).toString();
      return url.href;
    },

    async exchangeCode({code, verifier}) {
      if (!nonempty(code)) fail('invalid_authorization_code');
      validateVerifier(verifier);
      return tokenResult(await tokenRequest({
        grant_type: 'authorization_code', code, code_verifier: verifier,
        redirect_uri: CALLBACK_URL,
      }), true);
    },

    async userInfo(accessToken) {
      const data = await requestJson(USERINFO_URL, {
        method: 'GET', headers: {Authorization: bearer(accessToken), Accept: 'application/json'},
      });
      if (!nonempty(data.sub) || !nonempty(data.email) || data.email_verified !== true) {
        fail('google_identity_unverified', 403);
      }
      const email = data.email.trim().toLowerCase();
      if (!safeEqual(email, allowedEmail)) fail('google_owner_mismatch', 403);
      return {sub: data.sub, email, email_verified: true};
    },

    async refresh(refreshToken) {
      if (!nonempty(refreshToken)) fail('invalid_refresh_token');
      return tokenResult(await tokenRequest({
        grant_type: 'refresh_token', refresh_token: refreshToken,
      }), false);
    },

    calendar(accessToken) {
      const authorization = bearer(accessToken);
      return {
        async request(relativePath, {method = 'GET', body, headers, timeoutMs = MAX_TIMEOUT_MS} = {}) {
          const url = calendarUrl(relativePath);
          method = String(method).toUpperCase();
          if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) fail('invalid_calendar_method');
          if (method === 'GET' && body !== undefined) fail('invalid_calendar_body');
          let requestHeaders;
          try {
            requestHeaders = new Headers(headers);
            requestHeaders.set('Authorization', authorization);
            requestHeaders.set('Accept', 'application/json');
            if (body !== undefined) requestHeaders.set('Content-Type', 'application/json');
          } catch {
            fail('invalid_calendar_headers');
          }
          let serialized;
          try { serialized = body === undefined ? undefined : JSON.stringify(body); } catch {
            fail('invalid_calendar_body');
          }
          return requestJson(url, {method, headers: requestHeaders, body: serialized}, timeoutMs);
        },
      };
    },
  };
}
