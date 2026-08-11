import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createSavedPaymentLiveE2eRuntime } from '../tests/support/saved-payment-live-e2e-runner.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRACE_TARGETS = {
  cloudflare: 'https://www.cloudflare.com/cdn-cgi/trace',
  chatgpt: 'https://chatgpt.com/cdn-cgi/trace',
};
const IDENTITY_TARGET = 'https://chatgpt.com/backend-api/me';
const DEFAULT_PROXY = 'socks5h://127.0.0.1:10808';
const LIVE_STAGES = ['auth', 'checkout', 'billing'];
const LIVE_PAYMENT_METHODS = new Set(['hosted', 'paypal', 'momo', 'gopay', 'ideal', 'upi', 'pix', 'blik', 'twint', 'kakao']);

export function inspectJwt(value, now = Math.floor(Date.now() / 1000)) {
  const raw = String(value || '').trim();
  if (!raw) return { present: false, shapeValid: false, expired: false, valid: false };
  const parts = raw.split('.');
  if (parts.length !== 3) return { present: true, shapeValid: false, expired: false, valid: false };
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const exp = Number(payload.exp || 0);
    const expired = Boolean(exp && exp <= now);
    return { present: true, shapeValid: true, expired, valid: !expired };
  } catch {
    return { present: true, shapeValid: false, expired: false, valid: false };
  }
}

export function parseProxyDescriptor(value) {
  const raw = String(value || '').trim();
  if (!raw) return { configured: false, accepted: false, scheme: '', port: 0, loopback: false, hasCredentials: false };
  try {
    const parsed = new URL(raw.includes('://') ? raw : `http://${raw}`);
    const accepted = ['http:', 'https:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'].includes(parsed.protocol)
      && Boolean(parsed.hostname && parsed.port);
    return {
      configured: true,
      accepted,
      scheme: parsed.protocol.replace(':', ''),
      port: Number(parsed.port || 0),
      loopback: ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname),
      hasCredentials: Boolean(parsed.username || parsed.password),
      raw: accepted ? raw : '',
    };
  } catch {
    return { configured: true, accepted: false, scheme: '', port: 0, loopback: false, hasCredentials: false, raw: '' };
  }
}

export function parseTraceOutput(stdout, httpStatus = 0) {
  const fields = {};
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0) fields[line.slice(0, index)] = line.slice(index + 1).trim();
  }
  return {
    ok: Number(httpStatus) >= 200 && Number(httpStatus) < 400 && Boolean(fields.ip && fields.loc),
    httpStatus: Number(httpStatus) || 0,
    country: String(fields.loc || '').toUpperCase().slice(0, 2),
    colo: String(fields.colo || '').toUpperCase().slice(0, 12),
    ip: String(fields.ip || '').slice(0, 80),
  };
}

export function publicTrace(trace) {
  return {
    ok: Boolean(trace?.ok),
    httpStatus: Number(trace?.httpStatus || 0),
    country: String(trace?.country || ''),
    colo: String(trace?.colo || ''),
  };
}

export async function validateIdentityToken(value, options = {}) {
  const now = Number(options.now ?? Math.floor(Date.now() / 1000));
  const inspected = inspectJwt(value, now);
  const base = {
    present: inspected.present,
    shapeValid: inspected.shapeValid,
    expired: inspected.expired,
    locallyValid: inspected.valid,
    serverAttempted: false,
    serverAccepted: false,
    status: inspected.expired ? 'expired' : 'invalid',
    httpStatus: 0,
    valid: false,
  };
  if (!inspected.valid) return base;

  const request = options.request || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs || 15_000));
  try {
    const response = await request(IDENTITY_TARGET, {
      method: 'GET',
      headers: { Authorization: `Bearer ${String(value).trim()}`, Accept: 'application/json' },
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    });
    const httpStatus = Number(response?.status || 0);
    const serverAccepted = Boolean(response?.ok && httpStatus >= 200 && httpStatus < 300);
    const status = serverAccepted
      ? 'accepted'
      : [401, 403].includes(httpStatus) ? 'rejected' : 'unaccepted';
    await Promise.resolve(response?.body?.cancel?.()).catch(() => {});
    return { ...base, serverAttempted: true, serverAccepted, status, httpStatus, valid: serverAccepted };
  } catch {
    return { ...base, serverAttempted: true, status: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

function liveTargetIp(observation) {
  if (observation?.target !== 'chatgpt' || !observation.trace?.ok) return '';
  return String(observation.trace.ip || '');
}

function uniqueList(value, normalize) {
  return [...new Set(String(value || '').split(',').map((item) => normalize(item.trim())).filter(Boolean))];
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback));
}

export function parseLiveProbePlan(env = {}) {
  const countries = uniqueList(env.OPX_LIVE_COUNTRIES, (item) => (/^[A-Za-z]{2}$/.test(item) ? item.toUpperCase() : ''));
  const requested = uniqueList(env.OPX_LIVE_PAYMENT_METHODS, (item) => item.toLowerCase());
  const paymentMethods = requested.filter((item) => LIVE_PAYMENT_METHODS.has(item));
  const checkoutUiMode = ['hosted', 'custom', 'both'].includes(String(env.OPX_LIVE_CHECKOUT_UI_MODE || '').toLowerCase())
    ? String(env.OPX_LIVE_CHECKOUT_UI_MODE).toLowerCase()
    : '';
  return {
    ready: countries.length > 0 && paymentMethods.length >= 2 && Boolean(checkoutUiMode),
    countries,
    paymentMethods,
    invalidPaymentMethodCount: requested.length - paymentMethods.length,
    checkoutUiMode,
    sampleCount: boundedInteger(env.OPX_LIVE_SAMPLE_COUNT, 8, 1, 20),
    rounds: boundedInteger(env.OPX_LIVE_ROUNDS, 1, 1, 10),
    requireZero: !['0', 'false', 'off', 'no'].includes(String(env.OPX_LIVE_REQUIRE_ZERO || '1').toLowerCase()),
  };
}

export function buildLiveStageProxyEnvironment(env = {}) {
  const host = String(env.OPX_LIVE_PROXY_HOST ?? '').trim();
  const account = String(env.OPX_LIVE_PROXY_ACCOUNT ?? '').trim();
  const password = String(env.OPX_LIVE_PROXY_PASSWORD ?? '').trim();
  const countries = uniqueList(env.OPX_LIVE_PROXY_COUNTRIES ?? env.OPX_LIVE_COUNTRIES, (item) => item.toUpperCase())
    .filter((item) => /^[A-Z]{2}$/.test(item));
  const sessionIds = uniqueList(env.OPX_LIVE_PROXY_SESSION_IDS, (item) => item);
  const minutes = boundedInteger(env.OPX_LIVE_PROXY_SESSION_MINUTES, 5, 1, 120);
  const componentCount = [host, account, password, ...countries.slice(0, 3), ...sessionIds.slice(0, 3)].filter(Boolean).length;
  const stageUrls = LIVE_STAGES.map((_, index) => {
    const username = `${account}-region-${countries[index]}-sid-${sessionIds[index]}-t-${minutes}`;
    return `socks5://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}`;
  });
  const generated = {
    OPX_LIVE_AUTH_PROXY: stageUrls[0],
    OPX_LIVE_CHECKOUT_PROXY: stageUrls[1],
    OPX_LIVE_BILLING_PROXY: stageUrls[2],
    OPX_LIVE_FRONT_PROXY: stageUrls[0],
    OPX_LIVE_EXIT_PROXIES: `${stageUrls[1]},${stageUrls[2]}`,
  };
  return componentCount === 9 ? { ...generated, ...env } : { ...env };
}

export function buildStageEgressSummary(traces = []) {
  const stages = LIVE_STAGES.map((stage) => {
    const observation = traces.find((item) => item.stage === stage && item.target === 'chatgpt');
    return {
      stage,
      configured: Boolean(observation?.proxy?.configured && observation.proxy.accepted),
      reachable: Boolean(observation?.trace?.ok),
      trace: publicTrace(observation?.trace),
    };
  });
  const stageIps = new Set(traces.filter((item) => LIVE_STAGES.includes(item.stage)).map(liveTargetIp).filter(Boolean));
  return {
    ready: stages.every((item) => item.configured && item.reachable) && stageIps.size === LIVE_STAGES.length,
    uniqueEgressCount: stageIps.size,
    stages,
  };
}

export function publicPaymentPreflight(runtime) {
  return { ok: Boolean(runtime?.preflightOk), ...(runtime?.preflight || {}) };
}

export function evaluateTargetStability(previousEntries, currentReachable) {
  if (!Array.isArray(previousEntries)) throw new TypeError('target stability history must be an array');
  const samples = [...previousEntries.map((item) => Boolean(item?.targetReachable)), Boolean(currentReachable)].slice(-3);
  let trailingSuccesses = 0;
  for (const reachable of [...samples].reverse()) {
    if (!reachable) break;
    trailingSuccesses += 1;
  }
  return {
    ready: trailingSuccesses >= 2,
    sampleCount: samples.length,
    successCount: samples.filter(Boolean).length,
    trailingSuccesses,
    requiredTrailingSuccesses: 2,
    windowSize: 3,
  };
}

export function publicHistoryEntry(report) {
  if (!report || typeof report !== 'object' || !report.gates || !report.egress || !Array.isArray(report.blockedReasons)) {
    throw new TypeError('readiness report shape is incomplete');
  }
  return {
    generatedAt: report.generatedAt,
    targetReachable: Boolean(report.gates?.targetReachable),
    targetStabilityReady: Boolean(report.gates?.targetStabilityReady),
    identityReady: Boolean(report.gates?.identityReady),
    multiStageEgressReady: Boolean(report.gates?.multiStageEgressReady),
    paymentReady: Boolean(report.gates?.paymentReady),
    probePlanReady: Boolean(report.gates?.probePlanReady),
    fullLiveReady: Boolean(report.gates?.fullLiveReady),
    uniqueEgressCount: Number(report.egress.uniqueEgressCount),
    stageUniqueEgressCount: Number(report.egress.stageEgress?.uniqueEgressCount),
    blockedReasons: report.blockedReasons,
  };
}

function buildReadinessGates(input, traces, stageEgress, uniqueEgressCount) {
  const targetReachable = traces.some((item) => item.target === 'chatgpt' && item.trace.ok);
  const identityReady = Boolean(input.token?.serverAccepted || Number(input.sessions?.valid || 0) > 0);
  const gates = {
    targetReachable,
    targetStabilityReady: Boolean(input.targetStability?.ready),
    identityReady,
    exitDiversityReady: uniqueEgressCount >= 3,
    multiStageEgressReady: stageEgress.ready,
    paymentReady: Boolean(input.payment?.ok),
    probePlanReady: Boolean(input.probePlan?.ready),
  };
  return { ...gates, fullLiveReady: Object.values(gates).every(Boolean) };
}

function blockedReasonsFor(gates) {
  return [
    ['targetReachable', 'target-unreachable'],
    ['identityReady', 'identity-missing'],
    ['targetStabilityReady', 'target-stability-missing'],
    ['exitDiversityReady', 'fewer-than-three-unique-egresses'],
    ['multiStageEgressReady', 'multi-stage-egress-missing'],
    ['paymentReady', 'saved-payment-preflight'],
    ['probePlanReady', 'probe-plan-missing'],
  ].filter(([gate]) => !gates[gate]).map(([, reason]) => reason);
}

function publicIdentity(input) {
  return {
    tokenConfigured: Boolean(input.token?.present),
    tokenShapeValid: Boolean(input.token?.shapeValid),
    tokenServerAttempted: Boolean(input.token?.serverAttempted),
    tokenServerAccepted: Boolean(input.token?.serverAccepted),
    tokenStatus: String(input.token?.status || 'invalid'),
    tokenHttpStatus: Number(input.token?.httpStatus || 0),
    tokenValid: Boolean(input.token?.serverAccepted),
    sessionFiles: Number(input.sessions?.files || 0),
    sessionCandidates: Number(input.sessions?.candidates || 0),
    checkedSessions: Number(input.sessions?.checked || 0),
    validSessions: Number(input.sessions?.valid || 0),
  };
}

function publicObservation(item) {
  return {
    target: item.target,
    plane: item.plane,
    stage: item.stage || '',
    proxy: item.proxy,
    trace: publicTrace(item.trace),
  };
}

export function buildReadinessReport(input) {
  const traces = input.traces || [];
  const egresses = new Set(traces.map(liveTargetIp).filter(Boolean));
  const uniqueEgressCount = egresses.size;
  const stageEgress = buildStageEgressSummary(traces);
  const gates = buildReadinessGates(input, traces, stageEgress, uniqueEgressCount);
  return {
    schemaVersion: 1,
    kind: 'live_readiness_audit',
    generatedAt: input.generatedAt || new Date().toISOString(),
    gates,
    identity: publicIdentity(input),
    stability: input.targetStability,
    egress: {
      uniqueEgressCount,
      stageEgress,
      observations: traces.map(publicObservation),
    },
    payment: input.payment,
    probePlan: input.probePlan,
    blockedReasons: blockedReasonsFor(gates),
  };
}

export function containsSensitiveShapes(value) {
  const text = JSON.stringify(value);
  return /(?:eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]{12,}|(?:authorization|cookie)\s*[:=]|\b\d{12,19}\b)/i.test(text);
}

async function readLiveHistory(historyPath) {
  if (!existsSync(historyPath)) return [];
  const lines = (await readFile(historyPath, 'utf8')).split(/\r?\n/).filter(Boolean).slice(-99);
  const entries = lines.map((line) => JSON.parse(line));
  if (entries.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new TypeError('live readiness history contains a non-object entry');
  }
  return entries;
}

async function writeLiveEvidence(evidenceDir, report, previousEntries) {
  const entries = [...previousEntries, publicHistoryEntry(report)].slice(-100);
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(path.join(evidenceDir, 'history.jsonl'), `${entries.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8');
}

export async function inspectSessions(directory, options = {}) {
  const now = Number(options.now ?? Math.floor(Date.now() / 1000));
  const validateToken = options.validateToken || ((token) => validateIdentityToken(token, { now }));
  const result = {
    configured: Boolean(directory),
    exists: Boolean(directory && existsSync(directory)),
    files: 0,
    candidates: 0,
    checked: 0,
    valid: 0,
    invalid: 0,
  };
  if (!result.exists) return result;
  for (const name of await readdir(directory)) {
    if (!name.toLowerCase().endsWith('.json')) continue;
    result.files += 1;
    try {
      const item = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
      const candidate = inspectJwt(item.access_token, now);
      if (!candidate.valid) {
        result.invalid += 1;
        continue;
      }
      result.candidates += 1;
      const validation = await validateToken(item.access_token);
      if (validation.serverAttempted) result.checked += 1;
      if (validation.serverAccepted) result.valid += 1;
      else result.invalid += 1;
    } catch {
      result.invalid += 1;
    }
  }
  return result;
}

async function probeTrace(target, proxy, plane, stage = '') {
  const args = ['-sS', '--max-time', '15'];
  if (proxy) args.push('--proxy', proxy);
  args.push('-w', '__HTTP__:%{http_code}', TRACE_TARGETS[target]);
  try {
    const { stdout } = await execFileAsync(process.platform === 'win32' ? 'curl.exe' : 'curl', args, { maxBuffer: 512 * 1024 });
    const marker = String(stdout).match(/__HTTP__:(\d{3})/);
    const trace = parseTraceOutput(String(stdout).replace(/__HTTP__:\d{3}/, ''), marker ? Number(marker[1]) : 0);
    return { target, plane, stage, proxy: publicProxy(proxy), trace };
  } catch (error) {
    const stdout = String(error?.stdout || '');
    const marker = stdout.match(/__HTTP__:(\d{3})/);
    return { target, plane, stage, proxy: publicProxy(proxy), trace: parseTraceOutput(stdout, marker ? Number(marker[1]) : 0) };
  }
}

function publicProxy(value) {
  const descriptor = parseProxyDescriptor(value);
  return {
    configured: descriptor.configured,
    accepted: descriptor.accepted,
    scheme: descriptor.scheme,
    port: descriptor.port,
    loopback: descriptor.loopback,
    hasCredentials: descriptor.hasCredentials,
  };
}

async function canListen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(800, () => finish(false));
  });
}

async function main() {
  const env = buildLiveStageProxyEnvironment(process.env);
  const sessionsDir = env.OPX_LIVE_SESSIONS_DIR || path.join(ROOT, '.context-snapshots', 'live-accounts');
  const token = await validateIdentityToken(env.OPX_LIVE_TOKEN);
  const sessions = await inspectSessions(sessionsDir);
  const runtime = createSavedPaymentLiveE2eRuntime({ repoRoot: ROOT, env });
  const frontProxy = env.OPX_LIVE_FRONT_PROXY || DEFAULT_PROXY;
  const extraProxies = String(env.OPX_LIVE_EXIT_PROXIES || '').split(',').map((item) => item.trim()).filter(Boolean);
  const proxies = [...new Set([frontProxy, ...extraProxies])];
  const stageProxies = LIVE_STAGES.map((stage) => ({ stage, proxy: String(env[`OPX_LIVE_${stage.toUpperCase()}_PROXY`] || '').trim() }));
  const traces = [];
  for (const target of Object.keys(TRACE_TARGETS)) {
    traces.push(await probeTrace(target, '', 'direct'));
    for (const proxy of proxies) traces.push(await probeTrace(target, proxy, 'proxy'));
  }
  for (const item of stageProxies) {
    if (item.proxy) traces.push(await probeTrace('chatgpt', item.proxy, 'stage', item.stage));
  }
  const ports = {};
  for (const port of [10808, 7890, 18090]) ports[String(port)] = await canListen(port);
  const evidenceDir = path.join(ROOT, '.context-snapshots', 'live-readiness');
  const previousEntries = await readLiveHistory(path.join(evidenceDir, 'history.jsonl'));
  const targetReachable = traces.some((item) => item.target === 'chatgpt' && item.trace.ok);
  const report = buildReadinessReport({
    token,
    sessions,
    payment: publicPaymentPreflight(runtime),
    probePlan: parseLiveProbePlan(env),
    targetStability: evaluateTargetStability(previousEntries, targetReachable),
    traces,
    generatedAt: new Date().toISOString(),
  });
  report.environment = {
    browserProfileConfigured: Boolean(env.OPX_LIVE_BROWSER_PROFILE),
    browserProfileExists: Boolean(env.OPX_LIVE_BROWSER_PROFILE && existsSync(env.OPX_LIVE_BROWSER_PROFILE)),
    ports,
  };
  report.sanitized = !containsSensitiveShapes(report);
  await writeLiveEvidence(evidenceDir, report, previousEntries);
  process.stdout.write(`${JSON.stringify({ ...report, evidence: '.context-snapshots/live-readiness/latest.json' }, null, 2)}\n`);
  if (process.argv.includes('--strict') && !report.gates.fullLiveReady) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
