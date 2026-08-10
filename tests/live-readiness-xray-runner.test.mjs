import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLiveEnvironment,
  publicRunnerSummary,
  validateXrayConfig,
} from '../scripts/live-readiness-xray-runner.mjs';

const ports = { auth: 10829, checkout: 10841, billing: 10879 };

function configFixture() {
  const stages = Object.entries(ports);
  return {
    inbounds: stages.map(([, port]) => ({ tag: `mixed${port}`, port, protocol: 'mixed' })),
    outbounds: stages.map(([, port]) => ({ tag: `proxy${port}`, protocol: 'vless' })),
    routing: {
      rules: stages.map(([, port]) => ({ inboundTag: [`mixed${port}`], outboundTag: `proxy${port}` })),
    },
  };
}

test('xray config validation requires all three routed stage ports', () => {
  assert.deepEqual(validateXrayConfig(configFixture(), ports), {
    inboundCount: 3,
    outboundCount: 3,
    routedStageCount: 3,
    stagePorts: ports,
  });
  const missing = configFixture();
  missing.routing.rules.pop();
  assert.throws(() => validateXrayConfig(missing, ports), /BILLING/);
});

test('runner builds explicit loopback stage proxies and a bounded probe plan', () => {
  const env = buildLiveEnvironment({}, ports);
  assert.equal(env.OPX_LIVE_AUTH_PROXY, 'socks5h://127.0.0.1:10829');
  assert.equal(env.OPX_LIVE_CHECKOUT_PROXY, 'socks5h://127.0.0.1:10841');
  assert.equal(env.OPX_LIVE_BILLING_PROXY, 'socks5h://127.0.0.1:10879');
  assert.equal(env.OPX_LIVE_COUNTRIES, 'JP,SG,US');
  assert.equal(env.OPX_LIVE_PAYMENT_METHODS, 'hosted,paypal');
  assert.equal(env.OPX_LIVE_CHECKOUT_UI_MODE, 'hosted');
});

test('runner summary excludes config paths, process output and credentials', () => {
  const summary = publicRunnerSummary({
    config: { inboundCount: 72, outboundCount: 72, routedStageCount: 3, stagePorts: ports },
    auditExitCode: 0,
    strictExitCode: 2,
    report: {
      gates: { fullLiveReady: false, identityReady: false, multiStageEgressReady: true },
      blockedReasons: ['identity-missing', 'saved-payment-preflight'],
      sanitized: true,
    },
    processExited: true,
    portsReleased: true,
    configPath: 'C:/secret/config.json',
    stderr: 'TOKEN',
  });
  assert.equal(summary.config.inboundCount, 72);
  assert.equal(summary.cleanup.portsReleased, true);
  assert.equal(JSON.stringify(summary).includes('configPath'), false);
  assert.equal(JSON.stringify(summary).includes('TOKEN'), false);
  assert.equal(JSON.stringify(summary).includes('secret'), false);
});
