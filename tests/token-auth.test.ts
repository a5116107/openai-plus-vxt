import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyTokenAuthFailure,
  cookieHeaderFromSnapshot,
  createCheckoutLinkDirect,
} from '../src/features/link-extractor/checkout';
import type { CheckoutIdentitySnapshot } from '../src/features/link-extractor/types';

const TOKEN = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0b2tlbiJ9.sig';
const IDENTITY: CheckoutIdentitySnapshot = {
  deviceId: 'dev-123',
  sessionId: 'sess-456',
  capturedAt: Date.now(),
  cookies: [
    { name: '__Secure-next-auth.session-token', value: 'tok-abc', domain: '.chatgpt.com', path: '/', secure: true, httpOnly: true },
    { name: '__Secure-next-auth.session-token', value: 'dup', domain: '.chatgpt.com', path: '/', secure: true, httpOnly: true },
    { name: 'oai-did', value: 'dev-123', domain: '.chatgpt.com', path: '/', secure: true, httpOnly: false },
    { name: '', value: 'empty-name-should-skip', domain: '.chatgpt.com', path: '/', secure: true, httpOnly: false },
  ],
};

test('classifyTokenAuthFailure 细分 invalid_jwt / token_rejected / cloudflare', () => {
  assert.equal(classifyTokenAuthFailure(401, '{"error":{"code":"invalid_jwt"}}'), 'invalid_jwt');
  assert.equal(classifyTokenAuthFailure(401, '{"error":{"message":"Could not parse your authentication token.","code":"unauthorized_unknown"}}'), 'token_rejected');
  assert.equal(classifyTokenAuthFailure(401, '{"detail":"Unauthorized"}'), 'token_rejected');
  assert.equal(classifyTokenAuthFailure(403, '<html>Just a moment... Cloudflare challenge</html>'), 'cloudflare');
  assert.equal(classifyTokenAuthFailure(403, '<html>Attention Required! | Cloudflare</html>'), 'cloudflare');
  assert.equal(classifyTokenAuthFailure(200, '{"ok":true}'), 'unknown');
  assert.equal(classifyTokenAuthFailure(500, 'boom'), 'unknown');
});

test('cookieHeaderFromSnapshot 去重并跳过空名', () => {
  const header = cookieHeaderFromSnapshot(IDENTITY);
  assert.equal(header, '__Secure-next-auth.session-token=tok-abc; oai-did=dev-123');
  assert.equal(cookieHeaderFromSnapshot(undefined), '');
  assert.equal(cookieHeaderFromSnapshot({ ...IDENTITY, cookies: [] }), '');
});

test('createCheckoutLinkDirect 携带 Cookie+Bearer+oai-device-id，401 invalid_jwt 标记 credentialInvalid', async (context) => {
  const calls: Array<{ headers: Record<string, string> }> = [];
  const originalFetch = globalThis.fetch;
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ headers });
    const body = JSON.stringify({ error: { code: 'invalid_jwt' } });
    return new Response(body, { status: 401, headers: { 'content-type': 'application/json' } });
  };
  globalThis.fetch = fakeFetch as typeof fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const result = await createCheckoutLinkDirect(TOKEN, { planName: 'chatgptplusplan', region: 'PH' }, { identitySnapshot: IDENTITY });
  assert.equal(result.ok, false);
  assert.equal(result.tokenAuthStatus, 'invalid_jwt');
  assert.equal(result.credentialInvalid, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['authorization'], `Bearer ${TOKEN}`);
  assert.equal(calls[0].headers['cookie'], '__Secure-next-auth.session-token=tok-abc; oai-did=dev-123');
  assert.equal(calls[0].headers['oai-device-id'], 'dev-123');
  assert.equal(calls[0].headers['x-openai-target-path'], '/backend-api/payments/checkout');
});

test('createCheckoutLinkDirect CF 403 不标记 credentialInvalid', async (context) => {
  const originalFetch = globalThis.fetch;
  const fakeFetch = async (): Promise<Response> => new Response('<html>Just a moment... Cloudflare</html>', { status: 403, headers: { 'content-type': 'text/html' } });
  globalThis.fetch = fakeFetch as typeof fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const result = await createCheckoutLinkDirect(TOKEN, { planName: 'chatgptplusplan', region: 'PH' });
  assert.equal(result.ok, false);
  assert.equal(result.tokenAuthStatus, 'cloudflare');
  assert.equal(result.credentialInvalid, false);
});
