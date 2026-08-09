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
const DEFAULT_PROXY = 'socks5h://127.0.0.1:10808';

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

export function buildReadinessReport(input) {
  const traces = input.traces || [];
  const targetReachable = traces.some((item) => item.target === 'chatgpt' && item.trace.ok);
  const identityReady = Boolean(input.token?.valid || Number(input.sessions?.valid || 0) > 0);
  const egresses = new Set(traces.map((item) => item.trace.ip).filter(Boolean));
  const uniqueEgressCount = egresses.size;
  const exitDiversityReady = uniqueEgressCount >= 3;
  const paymentReady = Boolean(input.payment?.ok);
  const fullLiveReady = Boolean(targetReachable && identityReady && exitDiversityReady && paymentReady);
  const blockedReasons = [];
  if (!targetReachable) blockedReasons.push('target-unreachable');
  if (!identityReady) blockedReasons.push('identity-missing');
  if (!exitDiversityReady) blockedReasons.push('fewer-than-three-unique-egresses');
  if (!paymentReady) blockedReasons.push('saved-payment-preflight');
  return {
    schemaVersion: 1,
    kind: 'live_readiness_audit',
    generatedAt: input.generatedAt || new Date().toISOString(),
    gates: {
      targetReachable,
      identityReady,
      exitDiversityReady,
      paymentReady,
      fullLiveReady,
    },
    identity: {
      tokenConfigured: Boolean(input.token?.present),
      tokenValid: Boolean(input.token?.valid),
      sessionFiles: Number(input.sessions?.files || 0),
      validSessions: Number(input.sessions?.valid || 0),
    },
    egress: {
      uniqueEgressCount,
      observations: traces.map((item) => ({
        target: item.target,
        plane: item.plane,
        proxy: item.proxy,
        trace: publicTrace(item.trace),
      })),
    },
    payment: input.payment,
    blockedReasons,
  };
}

export function containsSensitiveShapes(value) {
  const text = JSON.stringify(value);
  return /(?:eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]{12,}|(?:authorization|cookie)\s*[:=]|\b\d{12,19}\b)/i.test(text);
}

async function inspectSessions(directory, now = Math.floor(Date.now() / 1000)) {
  const result = { configured: Boolean(directory), exists: Boolean(directory && existsSync(directory)), files: 0, valid: 0, invalid: 0 };
  if (!result.exists) return result;
  for (const name of await readdir(directory)) {
    if (!name.toLowerCase().endsWith('.json')) continue;
    result.files += 1;
    try {
      const item = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
      if (inspectJwt(item.access_token, now).valid) result.valid += 1;
      else result.invalid += 1;
    } catch {
      result.invalid += 1;
    }
  }
  return result;
}

async function probeTrace(target, proxy, plane) {
  const args = ['-sS', '--max-time', '15'];
  if (proxy) args.push('--proxy', proxy);
  args.push('-w', '__HTTP__:%{http_code}', TRACE_TARGETS[target]);
  try {
    const { stdout } = await execFileAsync(process.platform === 'win32' ? 'curl.exe' : 'curl', args, { maxBuffer: 512 * 1024 });
    const marker = String(stdout).match(/__HTTP__:(\d{3})/);
    const trace = parseTraceOutput(String(stdout).replace(/__HTTP__:\d{3}/, ''), marker ? Number(marker[1]) : 0);
    return { target, plane, proxy: publicProxy(proxy), trace };
  } catch (error) {
    const stdout = String(error?.stdout || '');
    const marker = stdout.match(/__HTTP__:(\d{3})/);
    return { target, plane, proxy: publicProxy(proxy), trace: parseTraceOutput(stdout, marker ? Number(marker[1]) : 0) };
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
  const env = process.env;
  const sessionsDir = env.OPX_LIVE_SESSIONS_DIR || path.join(ROOT, '.context-snapshots', 'live-accounts');
  const token = inspectJwt(env.OPX_LIVE_TOKEN);
  const sessions = await inspectSessions(sessionsDir);
  const runtime = createSavedPaymentLiveE2eRuntime({ repoRoot: ROOT, env });
  const frontProxy = env.OPX_LIVE_FRONT_PROXY || DEFAULT_PROXY;
  const extraProxies = String(env.OPX_LIVE_EXIT_PROXIES || '').split(',').map((item) => item.trim()).filter(Boolean);
  const proxies = [...new Set([frontProxy, ...extraProxies])];
  const traces = [];
  for (const target of Object.keys(TRACE_TARGETS)) {
    traces.push(await probeTrace(target, '', 'direct'));
    for (const proxy of proxies) traces.push(await probeTrace(target, proxy, 'proxy'));
  }
  const ports = {};
  for (const port of [10808, 7890, 18090]) ports[String(port)] = await canListen(port);
  const report = buildReadinessReport({
    token,
    sessions,
    payment: runtime.preflight,
    traces,
    generatedAt: new Date().toISOString(),
  });
  report.environment = {
    browserProfileConfigured: Boolean(env.OPX_LIVE_BROWSER_PROFILE),
    browserProfileExists: Boolean(env.OPX_LIVE_BROWSER_PROFILE && existsSync(env.OPX_LIVE_BROWSER_PROFILE)),
    ports,
  };
  report.sanitized = !containsSensitiveShapes(report);
  const evidenceDir = path.join(ROOT, '.context-snapshots', 'live-readiness');
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ ...report, evidence: '.context-snapshots/live-readiness/latest.json' }, null, 2)}\n`);
  if (process.argv.includes('--strict') && !report.gates.fullLiveReady) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
