import { readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = process.cwd();
const evidencePath = path.join(repoRoot, '.context-snapshots/e2e-extension/chrome-e2e-result.json');
rmSync(evidencePath, { force: true });
const startedAt = Date.now();
const child = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/e2e-extension.mjs')], {
  cwd: repoRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    OPX_E2E_SKIP_ACICA_SYNC: '1',
    OPX_E2E_EMAIL: 'fixture@example.test',
    OPX_E2E_MAILBOX_URL: 'http://127.0.0.1:9/messages/fixture@example.test',
    OPX_E2E_FORCE_MISSING_CLEANUP_TARGET: '1',
    OPX_E2E_AUTH_PORT: '9',
    OPX_E2E_CHECKOUT_PORT: '9',
    OPX_E2E_BILLING_PORT: '9',
    OPX_FULL_FLOW_TIMEOUT_MS: '30000',
  },
});

const result = JSON.parse(readFileSync(evidencePath, 'utf8'));
const elapsedMs = Date.now() - startedAt;
const checks = {
  childReportedExpectedFailure: child.status === 1,
  noHarnessFatalError: !result.fatalError,
  failedTerminalObserved: result.runtime?.fullFlowOutcome === 'failed',
  terminalCheckRecorded: result.checks?.fullAutomationReachedTerminal === true,
  failedAtCleanup: result.runtime?.finalCurrentStepId === 'cleanup-environment',
  returnedWithinBoundary: elapsedMs < 60_000,
};
const output = {
  ok: Object.values(checks).every(Boolean),
  elapsedMs,
  checks,
  outcome: result.runtime?.fullFlowOutcome || '',
  message: result.runtime?.fullFlowMessage || '',
  childStderr: child.stderr.trim(),
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
if (!output.ok) process.exitCode = 1;
