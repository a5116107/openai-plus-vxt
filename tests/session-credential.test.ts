import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSessionAccessTokenResponse } from '../src/features/probe/session-credential';
import { parseProbeAccounts } from '../src/features/probe/state';

function jwt(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp, email: 'fixture@example.com' })).toString('base64url');
  return `${header}.${payload}.fixture-signature`;
}

test('session response carrying RefreshAccessTokenError is rejected before checkout', () => {
  const now = Date.UTC(2026, 7, 2);
  const result = parseSessionAccessTokenResponse({
    accessToken: jwt(Math.floor(now / 1000) + 3600),
    error: 'RefreshAccessTokenError',
  }, now);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'session_refresh_error');
});

test('session response carrying an expired access token is rejected', () => {
  const now = Date.UTC(2026, 7, 2);
  const result = parseSessionAccessTokenResponse({
    accessToken: jwt(Math.floor(now / 1000) - 60),
  }, now);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'access_token_expired');
});

test('session response carrying a fresh JWT is accepted', () => {
  const now = Date.UTC(2026, 7, 2);
  const accessToken = jwt(Math.floor(now / 1000) + 3600);
  const result = parseSessionAccessTokenResponse({
    accessToken,
    sessionToken: 'rotated-session-token',
    user: { email: 'fixture@example.com' },
  }, now);

  assert.equal(result.ok, true);
  assert.equal(result.accessToken, accessToken);
  assert.equal(result.sessionToken, 'rotated-session-token');
  assert.equal(result.userEmail, 'fixture@example.com');
});

test('structured account JSON imports session_token as a restorable identity cookie', () => {
  const accessToken = jwt(Math.floor(Date.now() / 1000) + 3600);
  const raw = JSON.stringify({
    accounts: [{
      credentials: {
        email: 'fixture@example.com',
        chatgpt_account_id: 'account-fixture',
        access_token: accessToken,
        session_token: 'session-cookie-fixture',
      },
    }],
  });
  const parsed = parseProbeAccounts(raw);

  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.accounts.length, 1);
  assert.equal(parsed.accounts[0].email, 'fixture@example.com');
  assert.equal(parsed.accounts[0].chatgptAccountId, 'account-fixture');
  assert.equal(parsed.accounts[0].tokenRaw, accessToken);
  assert.equal(parsed.accounts[0].identitySnapshot.cookies.length, 1);
  assert.equal(parsed.accounts[0].identitySnapshot.cookies[0].name, '__Secure-next-auth.session-token');
  assert.equal(parsed.accounts[0].identitySnapshot.cookies[0].value, 'session-cookie-fixture');
  assert.equal(parsed.accounts[0].identitySnapshot.cookies[0].domain, '.chatgpt.com');
});
