import assert from 'node:assert/strict';
import test from 'node:test';
import { extractMailboxUrlOtp } from '../src/features/mailbox/acica';

test('extractMailboxUrlOtp reports an empty HTML mailbox', () => {
  const result = extractMailboxUrlOtp(
    '<div class="count">本页显示 0 封。</div><div class="empty">暂无邮件</div>',
    'text/html',
  );
  assert.equal(result.ok, false);
  assert.equal(result.failureKind, 'mail_not_arrived');
  assert.equal(result.messageCount, 0);
});

test('extractMailboxUrlOtp extracts a ChatGPT code from HTML', () => {
  const result = extractMailboxUrlOtp(
    '<article><h2>OpenAI verification code</h2><pre>Your ChatGPT verification code is 482 913</pre></article>',
    'text/html',
  );
  assert.equal(result.ok, true);
  assert.equal(result.code, '482913');
});

test('extractMailboxUrlOtp extracts a ChatGPT code from JSON message lists', () => {
  const result = extractMailboxUrlOtp(
    JSON.stringify({ messages: [{ from: 'noreply@tm.openai.com', subject: 'ChatGPT code', body: 'Security code: 731204' }] }),
    'application/json',
  );
  assert.equal(result.ok, true);
  assert.equal(result.code, '731204');
  assert.equal(result.messageCount, 1);
});
