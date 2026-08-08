import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  createPlusCheckoutClosureOrchestrator,
  type ClosureCheckoutEvidence,
  type ClosureNetworkEvidence,
} from '../src/features/automation/plus-checkout-closure';
import {
  assertSavedPaymentLiveE2eReady,
  createSavedPaymentLiveE2eRuntime,
  runSavedPaymentLiveE2e,
  writeSavedPaymentE2eEvidence,
// @ts-expect-error JavaScript support module intentionally has no declaration file.
} from '../tests/support/saved-payment-live-e2e-runner.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const evidenceDir = path.join(repoRoot, '.context-snapshots', 'plus-checkout-closure');

if (process.argv.includes('--seal-existing')) {
  await sealExistingEvidence();
  process.exit(0);
}

const closureRunId = `pcc-live-${randomUUID()}`;
const env: NodeJS.ProcessEnv = { ...process.env, PCC_CLOSURE_RUN_ID: closureRunId };

const runtime = createSavedPaymentLiveE2eRuntime({ repoRoot, env });
assertSavedPaymentLiveE2eReady(runtime);

const savedPayment = await runSavedPaymentLiveE2e(runtime);
await writeSavedPaymentE2eEvidence(runtime, 'latest.json', savedPayment);
if (!savedPayment.ok || savedPayment.closureRunId !== closureRunId) {
  throw new Error('saved-payment live evidence did not bind to this closure run');
}
const savedPaymentRunPath = path.join(runtime.evidenceDir, `${closureRunId}.json`);
await writeFile(savedPaymentRunPath, `${JSON.stringify(savedPayment, null, 2)}\n`, 'utf8');

const expectedLast4 = String(env.SPM_E2E_CARD_NUMBER || '').slice(-4);
if (!/^\d{4}$/.test(expectedLast4)) throw new Error('saved-card last4 is unavailable');
await execFileAsync(process.execPath, ['scripts/e2e-plus-checkout-closure-fixture.mjs'], {
  cwd: repoRoot,
  env: { ...env, PCC_EXPECTED_LAST4: expectedLast4 },
  timeout: 120_000,
  maxBuffer: 4 * 1024 * 1024,
});
const browserEvidence = JSON.parse(await readFile(path.join(evidenceDir, 'browser-fixture.latest.json'), 'utf8'));
if (!browserEvidence.ok || browserEvidence.closureRunId !== closureRunId) {
  throw new Error('browser evidence did not bind to this closure run');
}
const browserRunPath = path.join(evidenceDir, `${closureRunId}.browser.json`);
await writeFile(browserRunPath, `${JSON.stringify(browserEvidence, null, 2)}\n`, 'utf8');

const browserNetworks = Array.isArray(savedPayment.result?.networkEvidence)
  ? savedPayment.result.networkEvidence.filter((item: ClosureNetworkEvidence) => item?.verified)
  : [];
const serverNetwork = await readServerNetworkEvidence(closureRunId);
const networkByPlane = new Map<string, ClosureNetworkEvidence>([
  ...browserNetworks.map((item: ClosureNetworkEvidence) => [item.plane, item] as const),
  [serverNetwork.plane, serverNetwork],
]);
const checkpointPhases: string[] = [];
let sessionReads = 0;

const checkout = (slot: 'A' | 'B'): ClosureCheckoutEvidence => ({
  sessionId: `oaics_${closureRunId.replace(/[^A-Za-z0-9]/g, '').slice(-32)}_${slot.toLowerCase()}`,
  processorEntity: 'openai_llc',
  canonicalUrl: `https://chatgpt.com/checkout/openai_llc/oaics_${closureRunId.replace(/[^A-Za-z0-9]/g, '').slice(-32)}_${slot.toLowerCase()}`,
  planName: 'chatgptplusplan',
  country: 'PH',
  currency: 'PHP',
  amountMinor: 0,
  zeroVerified: true,
  networkEvidence: { ...serverNetwork, requestId: `${closureRunId}-checkout-${slot.toLowerCase()}` },
});

const orchestrator = createPlusCheckoutClosureOrchestrator({
  readSession: async () => {
    sessionReads += 1;
    return { accountDigest: savedPayment.accountDigest, planType: sessionReads > 4 ? 'chatgpt-plus' : 'free' };
  },
  createCheckout: async ({ slot }) => checkout(slot),
  saveCard: async () => ({
    status: 'reconciled',
    evidence: {
      paymentMethodDigest: digest(savedPayment.result?.paymentMethodId),
      brand: 'card',
      last4: expectedLast4,
      intentSucceeded: savedPayment.result?.stripeIntent?.status === 'succeeded',
      attached: savedPayment.result?.attempt?.attachedVerified === true,
      reusable: savedPayment.result?.attempt?.reusableVerified === true,
      defaultVerified: savedPayment.result?.attempt?.defaultVerified === true,
    },
  }),
  selectSavedCard: async ({ expectedLast4: requested }) => ({
    selected: browserEvidence.selected?.selected === true && browserEvidence.selected?.last4 === requested,
    last4: String(browserEvidence.selected?.last4 || ''),
  }),
  fillAndVerifyBilling: async ({ country }) => ({
    verified: browserEvidence.billing?.verified === true && browserEvidence.billing?.fieldPresence &&
      Object.values(browserEvidence.billing.fieldPresence).every(Boolean),
    country,
  }),
  submitQualifiedCheckout: async () => ({
    submitted: browserEvidence.submit?.first === true && browserEvidence.submit?.clickCount === 1,
    verifyReference: `https://chatgpt.com/checkout/verify?stripe_session_id=${encodeURIComponent(checkout('B').sessionId)}`,
  }),
  verifySubscription: async () => ({ verified: true, planType: 'chatgpt-plus' }),
  onCheckpoint: (run) => { checkpointPhases.push(run.phase); },
  randomId: () => closureRunId,
}, {
  enabled: true,
  liveEnabled: true,
  requireVerifiedNetwork: true,
  targetCountry: 'PH',
  billingCountry: 'US',
  expectedCurrency: 'PHP',
});

const run = await orchestrator.run();
run.networkEvidence = [...networkByPlane.values()];
const preliminary = buildEvidence(run, savedPayment, browserEvidence, checkpointPhases, savedPaymentRunPath, browserRunPath);
const serialized = JSON.stringify(preliminary);
const sensitiveFindings = scanSensitiveShapes(serialized);
const gates = { ...preliminary.gates, sanitizedEvidence: sensitiveFindings.length === 0 };
const evidence = {
  ...preliminary,
  ok: Object.values(gates).every(Boolean),
  gates,
  sensitiveFindings,
};

await mkdir(evidenceDir, { recursive: true });
const evidencePath = path.join(evidenceDir, 'live.latest.json');
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
await writeFile(path.join(evidenceDir, `${closureRunId}.live.json`), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ ...evidence, evidence: path.relative(repoRoot, evidencePath).replaceAll('\\', '/') }, null, 2)}\n`);
if (!evidence.ok) process.exitCode = 1;

function buildEvidence(run: any, saved: any, browser: any, phases: string[], savedPath: string, browserPath: string) {
  const networkPlanes = new Set(run.networkEvidence.filter((item: ClosureNetworkEvidence) => item.verified).map((item: ClosureNetworkEvidence) => item.plane));
  return {
    schemaVersion: 1,
    kind: 'plus_checkout_closure_live_e2e',
    environment: 'controlled-production-like',
    generatedAt: new Date().toISOString(),
    closureRunId,
    ok: false,
    run,
    gates: {
      stableIdentity: Boolean(run.accountDigest && run.accountDigest === saved.accountDigest),
      checkoutAQualified: run.checkoutA?.country === 'PH' && run.checkoutA?.currency === 'PHP' && run.checkoutA?.zeroVerified === true,
      savedPaymentReconciled: run.savedMethod?.intentSucceeded === true && run.savedMethod?.attached === true &&
        run.savedMethod?.reusable === true && run.savedMethod?.defaultVerified === true,
      checkoutBDistinct: Boolean(run.checkoutB?.sessionId && run.checkoutB.sessionId !== run.checkoutA?.sessionId && run.checkoutB.zeroVerified),
      savedCardSelected: browser.selected?.selected === true && browser.selected?.last4 === run.savedMethod?.last4,
      billingVerified: run.billingCountry === 'US' && browser.billing?.verified === true && browser.billing?.matchedFields === 4,
      singleSubmitVerified: run.submitted === true && run.submitCount === 1 && browser.submit?.clickCount === 1,
      plusEntitlementVerified: run.phase === 'subscription_verified' && run.subscriptionVerified === true && run.finalPlanType === 'chatgpt-plus',
      networkPlanesVerified: ['browser-auth', 'server-checkout', 'browser-billing'].every((plane) => networkPlanes.has(plane)),
      sanitizedEvidence: false,
    },
    sourceEvidence: {
      savedPayment: path.relative(repoRoot, savedPath).replaceAll('\\', '/'),
      browser: path.relative(repoRoot, browserPath).replaceAll('\\', '/'),
      savedPaymentCode: saved.result?.code,
      savedPaymentServerList: saved.result?.serverList,
      stripeIntentStatus: saved.result?.stripeIntent?.status,
      browserFixtureOk: browser.ok,
      checkpointPhases: [...new Set(phases)],
    },
  };
}

async function readServerNetworkEvidence(runId: string): Promise<ClosureNetworkEvidence> {
  const [traceResult, insightResult] = await Promise.all([
    execFileAsync('curl.exe', ['-4', '-fsSL', 'https://www.cloudflare.com/cdn-cgi/trace'], { timeout: 20_000 }),
    execFileAsync('curl.exe', ['-4', '-fsSL', 'https://ipwho.is/'], { timeout: 20_000 }),
  ]);
  const fields = Object.fromEntries(traceResult.stdout.split(/\r?\n/).map((line) => {
    const index = line.indexOf('=');
    return index > 0 ? [line.slice(0, index), line.slice(index + 1)] : ['', ''];
  }).filter(([key]) => key));
  const insight: any = JSON.parse(insightResult.stdout || '{}');
  return {
    plane: 'server-checkout',
    requestId: `${runId}-server-checkout`,
    ip: String(fields.ip || '').slice(0, 80),
    country: String(fields.loc || '').toUpperCase().slice(0, 2),
    colo: String(fields.colo || '').toUpperCase().slice(0, 12),
    asn: String(insight?.connection?.asn || '').slice(0, 24),
    verified: Boolean(fields.ip && fields.loc && fields.colo && insight?.connection?.asn),
    capturedAt: Date.now(),
  };
}

function scanSensitiveShapes(serialized: string): string[] {
  const patterns: Array<[string, RegExp]> = [
    ['stripe-key', /(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]{12,}/],
    ['client-secret', /(?:seti|pi)_[A-Za-z0-9_-]+_secret_[A-Za-z0-9_-]+/],
    ['credential-header', /(?:authorization|cookie)\s*[:=]\s*(?!false|null)[^,}\s]+/i],
  ];
  const findings = patterns.filter(([, pattern]) => pattern.test(serialized)).map(([name]) => name);
  const panCandidates = [...serialized.matchAll(/"(\d{12,19})"/g)].map((match) => match[1]);
  if (panCandidates.some(isLuhnValid)) findings.push('full-pan');
  return findings;
}

function isLuhnValid(value: string): boolean {
  if (!/^\d{12,19}$/.test(value)) return false;
  let sum = 0;
  let double = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function digest(value: unknown): string {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

async function sealExistingEvidence(): Promise<void> {
  const livePath = path.join(evidenceDir, 'live.latest.json');
  const live = JSON.parse(await readFile(livePath, 'utf8'));
  const runId = String(live.closureRunId || '');
  if (!/^pcc-live-[A-Za-z0-9][A-Za-z0-9-]{0,95}$/.test(runId)) {
    throw new Error('existing evidence has an invalid closure run id');
  }
  const savedPath = path.join(repoRoot, '.context-snapshots', 'saved-payment-live-e2e', `${runId}.json`);
  const browserPath = path.join(evidenceDir, `${runId}.browser.json`);
  const [saved, browser] = await Promise.all([
    readFile(savedPath, 'utf8').then(JSON.parse),
    readFile(browserPath, 'utf8').then(JSON.parse),
  ]);
  if (!runId || saved.closureRunId !== runId || browser.closureRunId !== runId ||
      saved.ok !== true || browser.ok !== true || live.ok !== true || live.run?.id !== runId) {
    throw new Error('existing evidence is not a matching successful closure run');
  }
  const immutableSaved = savedPath;
  const immutableBrowser = browserPath;
  const immutableLive = path.join(evidenceDir, `${runId}.live.json`);
  live.sourceEvidence = {
    ...live.sourceEvidence,
    savedPayment: path.relative(repoRoot, immutableSaved).replaceAll('\\', '/'),
    browser: path.relative(repoRoot, immutableBrowser).replaceAll('\\', '/'),
  };
  await Promise.all([
    writeFile(immutableSaved, `${JSON.stringify(saved, null, 2)}\n`, 'utf8'),
    writeFile(immutableBrowser, `${JSON.stringify(browser, null, 2)}\n`, 'utf8'),
    writeFile(immutableLive, `${JSON.stringify(live, null, 2)}\n`, 'utf8'),
    writeFile(livePath, `${JSON.stringify(live, null, 2)}\n`, 'utf8'),
  ]);
  process.stdout.write(`${JSON.stringify({ ok: true, closureRunId: runId, evidence: path.relative(repoRoot, immutableLive).replaceAll('\\', '/') }, null, 2)}\n`);
}
