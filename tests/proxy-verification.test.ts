import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeAutomationRouting } from '../src/features/proxy/state';
import { verifyCurrentExit } from '../src/features/proxy/service';
import {
  DEFAULT_PROXY_META_URL,
  DEFAULT_PROXY_TRACE_URL,
} from '../src/features/proxy/types';

test('出口校验端点默认安全回退并允许显式关闭 meta', () => {
  const defaults = normalizeAutomationRouting(undefined);
  assert.equal(defaults.verificationTraceUrl, DEFAULT_PROXY_TRACE_URL);
  assert.equal(defaults.verificationMetaUrl, DEFAULT_PROXY_META_URL);

  const normalized = normalizeAutomationRouting({
    verificationTraceUrl: 'file:///tmp/trace',
    verificationMetaUrl: '',
  });
  assert.equal(normalized.verificationTraceUrl, DEFAULT_PROXY_TRACE_URL);
  assert.equal(normalized.verificationMetaUrl, '');

  const credentialed = normalizeAutomationRouting({
    verificationTraceUrl: 'https://user:secret@example.test/trace',
  });
  assert.equal(credentialed.verificationTraceUrl, DEFAULT_PROXY_TRACE_URL);
});

test('出口校验消费自定义 trace/meta 端点并归一化网络元数据', async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith('/meta')) {
      return new Response(JSON.stringify({
        clientIp: '198.51.100.42',
        country: 'jp',
        colo: 'nrt',
        asn: 64542,
        asOrganization: 'OPX Fixture',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('ip=192.0.2.1\nloc=US\ncolo=SJC\n', { status: 200 });
  }) as typeof fetch;

  try {
    const result = await verifyCurrentExit(
      'http://opx-proxy-fixture.invalid/trace',
      'http://opx-proxy-fixture.invalid/meta',
    );
    assert.equal(result.verified, true);
    assert.equal(result.ip, '198.51.100.42');
    assert.equal(result.country, 'JP');
    assert.equal(result.colo, 'NRT');
    assert.equal(result.asn, 'AS64542');
    assert.equal(result.asOrganization, 'OPX Fixture');
    assert.equal(result.message, '出口 trace 已验证');
    assert.deepEqual(requested.sort(), [
      'http://opx-proxy-fixture.invalid/meta',
      'http://opx-proxy-fixture.invalid/trace',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
