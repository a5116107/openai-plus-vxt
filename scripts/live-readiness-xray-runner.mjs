import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUDIT_SCRIPT = path.join(ROOT, 'scripts', 'live-readiness-audit.mjs');
const STAGES = ['auth', 'checkout', 'billing'];
const DEFAULT_PORTS = { auth: 10829, checkout: 10841, billing: 10879 };

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback));
}

function errorWithCode(code) {
  return Object.assign(new Error(code), { code });
}

export function stagePortsFromEnvironment(env = {}) {
  const ports = Object.fromEntries(STAGES.map((stage) => [
    stage,
    boundedInteger(env[`OPX_LIVE_${stage.toUpperCase()}_PORT`], DEFAULT_PORTS[stage], 1, 65535),
  ]));
  if (new Set(Object.values(ports)).size !== STAGES.length) throw errorWithCode('STAGE_PORTS_NOT_DISTINCT');
  return ports;
}

export function validateXrayConfig(config, stagePorts) {
  if (!config || !Array.isArray(config.inbounds) || !Array.isArray(config.outbounds)) {
    throw errorWithCode('XRAY_CONFIG_SHAPE_INVALID');
  }
  const rules = Array.isArray(config.routing?.rules) ? config.routing.rules : [];
  const outboundTags = new Set(config.outbounds.map((item) => String(item?.tag || '')).filter(Boolean));
  for (const stage of STAGES) {
    const inbound = config.inbounds.find((item) => Number(item?.port) === stagePorts[stage]);
    if (!inbound?.tag) throw errorWithCode(`XRAY_STAGE_${stage.toUpperCase()}_INBOUND_MISSING`);
    const routed = rules.some((rule) => {
      const inboundTags = Array.isArray(rule?.inboundTag) ? rule.inboundTag : [rule?.inboundTag];
      return inboundTags.includes(inbound.tag) && outboundTags.has(String(rule?.outboundTag || ''));
    });
    if (!routed) throw errorWithCode(`XRAY_STAGE_${stage.toUpperCase()}_ROUTE_MISSING`);
  }
  return {
    inboundCount: config.inbounds.length,
    outboundCount: config.outbounds.length,
    routedStageCount: STAGES.length,
    stagePorts: { ...stagePorts },
  };
}

export function buildLiveEnvironment(baseEnv, stagePorts) {
  const proxy = (stage) => `socks5h://127.0.0.1:${stagePorts[stage]}`;
  return {
    ...baseEnv,
    OPX_LIVE_FRONT_PROXY: proxy('auth'),
    OPX_LIVE_EXIT_PROXIES: `${proxy('checkout')},${proxy('billing')}`,
    OPX_LIVE_AUTH_PROXY: proxy('auth'),
    OPX_LIVE_CHECKOUT_PROXY: proxy('checkout'),
    OPX_LIVE_BILLING_PROXY: proxy('billing'),
    OPX_LIVE_COUNTRIES: String(baseEnv.OPX_LIVE_COUNTRIES || 'JP,SG,US'),
    OPX_LIVE_PAYMENT_METHODS: String(baseEnv.OPX_LIVE_PAYMENT_METHODS || 'hosted,paypal'),
    OPX_LIVE_CHECKOUT_UI_MODE: String(baseEnv.OPX_LIVE_CHECKOUT_UI_MODE || 'hosted'),
  };
}

export function publicRunnerSummary(input) {
  const report = input.report || {};
  return {
    schemaVersion: 1,
    kind: 'live_readiness_xray_runner',
    ok: input.auditExitCode === 0
      && [0, 2].includes(input.strictExitCode)
      && Boolean(input.processExited && input.portsReleased),
    auditExitCode: Number(input.auditExitCode),
    strictExitCode: Number(input.strictExitCode),
    generatedAt: String(report.generatedAt || ''),
    config: {
      inboundCount: Number(input.config?.inboundCount || 0),
      outboundCount: Number(input.config?.outboundCount || 0),
      routedStageCount: Number(input.config?.routedStageCount || 0),
      stagePorts: { ...(input.config?.stagePorts || {}) },
    },
    gates: Object.fromEntries(Object.entries(report.gates || {}).map(([key, value]) => [key, Boolean(value)])),
    blockedReasons: Array.isArray(report.blockedReasons) ? report.blockedReasons.map(String) : [],
    sanitized: Boolean(report.sanitized),
    cleanup: {
      processExited: Boolean(input.processExited),
      portsReleased: Boolean(input.portsReleased),
    },
  };
}

async function readValidConfig(configPath, stagePorts) {
  const parsed = JSON.parse(await readFile(configPath, 'utf8'));
  return { path: configPath, publicConfig: validateXrayConfig(parsed, stagePorts) };
}

async function newestTestConfigs(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^configTest.*\.json$/i.test(entry.name)) continue;
    const candidatePath = path.join(directory, entry.name);
    candidates.push({ path: candidatePath, mtimeMs: (await stat(candidatePath)).mtimeMs });
  }
  return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

async function waitForConfig(env, stagePorts) {
  const explicit = String(env.OPX_XRAY_CONFIG || '').trim();
  if (explicit) {
    if (!existsSync(explicit)) throw errorWithCode('XRAY_CONFIG_MISSING');
    return readValidConfig(explicit, stagePorts);
  }

  const directory = String(env.OPX_V2RAYN_BIN_CONFIGS_DIR || path.join(os.homedir(), 'Downloads', 'v2rayN-windows-64', 'binConfigs'));
  const waitMs = boundedInteger(env.OPX_XRAY_CONFIG_WAIT_SECONDS, 120, 1, 900) * 1000;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try {
      for (const candidate of await newestTestConfigs(directory)) {
        try {
          return await readValidConfig(candidate.path, stagePorts);
        } catch {
          // v2rayN may still be writing the file; retry until the bounded deadline.
        }
      }
    } catch {
      // The directory can be temporarily absent during v2rayN startup.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw errorWithCode('XRAY_CONFIG_WAIT_TIMEOUT');
}

function portListening(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

async function waitForPortState(ports, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const states = await Promise.all(ports.map(portListening));
    if (states.every((state) => state === expected)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

async function stopOwnedProcess(child) {
  if (!child || child.exitCode !== null) return true;
  child.kill('SIGTERM');
  if (await waitForExit(child, 3_000)) return true;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    await waitForExit(killer, 5_000);
  } else {
    child.kill('SIGKILL');
  }
  return waitForExit(child, 5_000);
}

function runAudit(env, strict) {
  return new Promise((resolve, reject) => {
    const args = [AUDIT_SCRIPT, ...(strict ? ['--strict'] : [])];
    const child = spawn(process.execPath, args, { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 2 * 1024 * 1024) stdout += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (code) => {
      try {
        resolve({ exitCode: Number(code), report: JSON.parse(stdout) });
      } catch {
        reject(errorWithCode('LIVE_AUDIT_OUTPUT_INVALID'));
      }
    });
  });
}

async function main() {
  const env = process.env;
  const stagePorts = stagePortsFromEnvironment(env);
  const xrayPath = String(env.OPX_XRAY_BIN || path.join(os.homedir(), 'Downloads', 'v2rayN-windows-64', 'bin', 'xray', process.platform === 'win32' ? 'xray.exe' : 'xray'));
  let child = null;
  let publicConfig = null;
  let audit = null;
  let strict = null;
  let processExited = true;
  let portsReleased = true;
  let failureCode = '';
  try {
    if (!existsSync(xrayPath)) throw errorWithCode('XRAY_BINARY_MISSING');
    if (await waitForPortState(Object.values(stagePorts), false, 500) === false) throw errorWithCode('STAGE_PORT_ALREADY_IN_USE');
    const config = await waitForConfig(env, stagePorts);
    publicConfig = config.publicConfig;
    child = spawn(xrayPath, ['run', '-c', config.path], { stdio: 'ignore', windowsHide: true });
    if (!await waitForPortState(Object.values(stagePorts), true, 20_000)) throw errorWithCode('XRAY_STAGE_PORTS_NOT_READY');
    const liveEnv = buildLiveEnvironment(env, stagePorts);
    audit = await runAudit(liveEnv, false);
    strict = await runAudit(liveEnv, true);
  } catch (error) {
    failureCode = String(error?.code || 'XRAY_RUNNER_FAILED');
    process.exitCode = 1;
  } finally {
    processExited = await stopOwnedProcess(child);
    portsReleased = await waitForPortState(Object.values(stagePorts), false, 10_000);
  }

  if (failureCode || !audit || !strict) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      kind: 'live_readiness_xray_runner',
      ok: false,
      errorCode: failureCode || 'XRAY_RUNNER_INCOMPLETE',
      cleanup: { processExited, portsReleased },
    }, null, 2)}\n`);
    return;
  }
  const summary = publicRunnerSummary({
    config: publicConfig,
    auditExitCode: audit.exitCode,
    strictExitCode: strict.exitCode,
    report: strict.report,
    processExited,
    portsReleased,
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.ok) process.exitCode = 1;
  else if (strict.exitCode === 2) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
