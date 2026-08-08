import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyAuthOtpValidateResponse,
} from '../src/features/automation/auth-network-observer';
import { authCloudflareChallengeResult } from '../src/features/automation/runner-email-otp';
import { isAuthCloudflareChallengeResult } from '../src/features/automation/runner-errors';
import { assessAutomationExitCandidate } from '../src/features/proxy/service';

test('OTP validate 的 403 HTML 响应被分类为 Cloudflare challenge', () => {
  assert.deepEqual(classifyAuthOtpValidateResponse({
    status: 403,
    contentType: 'text/html; charset=UTF-8',
    server: 'cloudflare',
    cfRay: 'fixture-SIN',
  }), {
    classification: 'cloudflare-challenge',
    cloudflareChallenge: true,
  });
});

test('JSON 403 保留为普通 HTTP 错误，不误报 Cloudflare 页面挑战', () => {
  assert.deepEqual(classifyAuthOtpValidateResponse({
    status: 403,
    contentType: 'application/json',
  }), {
    classification: 'http-error',
    cloudflareChallenge: false,
  });
});

test('OTP send 的 HTML 403 生成可恢复的 Auth challenge 结果', () => {
  const result = authCloudflareChallengeResult({
    tabId: 7,
    requestId: 'fixture',
    url: 'https://auth.openai.com/api/accounts/email-otp/send',
    method: 'GET',
    status: 403,
    contentType: 'text/html; charset=UTF-8',
    server: 'cloudflare',
    cfRay: 'fixture-SIN',
    classification: 'cloudflare-challenge',
    cloudflareChallenge: true,
    observedAt: Date.now(),
  });
  assert.equal(result.code, 'AUTH_CF_CHALLENGE');
  assert.match(result.message, /OTP send/);
  assert.deepEqual(result.data && (result.data as Record<string, unknown>).authEndpoint, 'OTP send');
});

test('结构化 Auth challenge 优先由错误码和数据标记识别', () => {
  assert.equal(isAuthCloudflareChallengeResult({
    ok: false,
    code: 'AUTH_CF_CHALLENGE',
    message: 'fixture',
  }), true);
  assert.equal(isAuthCloudflareChallengeResult({
    ok: false,
    message: 'fixture',
    data: { authCloudflareChallenge: true },
  }), true);
});

test('Auth 换出口拒绝失败 IP，只有不同且已验证的 IP 才通过', () => {
  const repeated = assessAutomationExitCandidate({
    verified: true,
    ip: '13.250.103.251',
    excludeIps: ['13.250.103.251'],
    distinct: true,
    requireDistinct: false,
    requireDifferentIp: true,
    requireVerified: true,
  });
  assert.deepEqual(repeated, { accepted: false, excludedIp: true });

  const fresh = assessAutomationExitCandidate({
    verified: true,
    ip: '198.51.100.24',
    excludeIps: ['13.250.103.251'],
    distinct: true,
    requireDistinct: false,
    requireDifferentIp: true,
    requireVerified: true,
  });
  assert.deepEqual(fresh, { accepted: true, excludedIp: false });
});

test('未开启出口验证的普通阶段保持原有候选行为', () => {
  assert.deepEqual(assessAutomationExitCandidate({
    verified: false,
    ip: '',
    excludeIps: [],
    distinct: true,
    requireDistinct: false,
    requireDifferentIp: false,
    requireVerified: false,
  }), { accepted: true, excludedIp: false });
});
