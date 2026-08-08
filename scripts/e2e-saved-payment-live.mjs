import {
  assertSavedPaymentLiveE2eReady,
  createSavedPaymentLiveE2eRuntime,
  createSavedPaymentPreflightEvidence,
  probeSavedPaymentProfile,
  runSavedPaymentLiveE2e,
  writeSavedPaymentE2eEvidence,
} from '../tests/support/saved-payment-live-e2e-runner.mjs';

const runtime = createSavedPaymentLiveE2eRuntime();
const checkOnly = process.argv.includes('--check');
const probeOnly = process.argv.includes('--probe-profile');

let evidence;
let evidenceFile;

if (checkOnly) {
  evidence = createSavedPaymentPreflightEvidence(runtime);
  evidenceFile = 'preflight.latest.json';
} else if (probeOnly) {
  evidence = await probeSavedPaymentProfile(runtime);
  evidenceFile = 'profile-probe.latest.json';
} else {
  assertSavedPaymentLiveE2eReady(runtime);
  evidence = await runSavedPaymentLiveE2e(runtime);
  evidenceFile = 'latest.json';
}

const evidencePath = await writeSavedPaymentE2eEvidence(runtime, evidenceFile, evidence);
process.stdout.write(`${JSON.stringify({ ...evidence, evidence: evidencePath }, null, 2)}\n`);

if (!checkOnly && !evidence.ok) process.exitCode = 1;
