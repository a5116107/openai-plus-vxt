import os from 'os';
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { getArgValue, hasFlag } from './repo.mjs';

export const HOST_RUNTIME_PROFILE_REL = '.context-snapshots/host.runtime-profile.latest.json';
export const HOST_MODE_POLICY_REL = '.context-snapshots/host.mode-policy.latest.json';

const HOST_ALIASES = new Map([
  ['codex-cli', 'codex'],
  ['openai-codex', 'codex'],
  ['claude', 'claude-code'],
  ['claude_code', 'claude-code'],
  ['claudecode', 'claude-code'],
  ['open-code', 'opencode'],
  ['open_code', 'opencode'],
  ['cursor-mcp', 'cursor'],
  ['gemini', 'gemini-cli'],
  ['droid', 'droid-cli'],
  ['factory', 'droid-cli'],
]);

const VALID_HOSTS = new Set([
  'generic',
  'codex',
  'claude-code',
  'opencode',
  'cursor',
  'cline',
  'gemini-cli',
  'droid-cli',
  'mcp-assisted',
]);

const VALID_MODES = new Set([
  'interactive',
  'goal',
  'resume',
  'plan-only',
  'ci',
  'hook',
  'plugin-event',
  'mcp-assisted',
  'manual',
]);

function normalizeLower(value) {
  return String(value || '').trim().toLowerCase();
}

export function normalizeHost(value) {
  const raw = normalizeLower(value).replace(/\s+/g, '-');
  if (!raw) return '';
  const aliased = HOST_ALIASES.get(raw) || raw;
  return VALID_HOSTS.has(aliased) ? aliased : aliased;
}

export function normalizeMode(value) {
  const raw = normalizeLower(value).replace(/\s+/g, '-').replace(/_/g, '-');
  if (!raw) return '';
  if (raw === 'goals') return 'goal';
  if (raw === 'continue' || raw === 'continuation') return 'resume';
  if (raw === 'planonly') return 'plan-only';
  if (raw === 'non-interactive' || raw === 'noninteractive') return 'ci';
  if (raw === 'plugin' || raw === 'event') return 'plugin-event';
  if (raw === 'mcp') return 'mcp-assisted';
  return VALID_MODES.has(raw) ? raw : raw;
}

function envTruthy(value) {
  const v = normalizeLower(value);
  return v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on' || v === 'enabled';
}

function resolveHome(env = process.env) {
  const home = String(env.USERPROFILE || env.HOME || '').trim();
  if (home) return home;
  try {
    return os.homedir();
  } catch {
    return '';
  }
}

function stripTomlComments(line) {
  let inQuote = false;
  let quote = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if ((ch === '"' || ch === "'") && line[i - 1] !== '\\') {
      if (!inQuote) {
        inQuote = true;
        quote = ch;
      } else if (quote === ch) {
        inQuote = false;
        quote = '';
      }
    }
    if (ch === '#' && !inQuote) return line.slice(0, i);
  }
  return line;
}

export function readCodexGoalConfig({ env = process.env } = {}) {
  const codexHome = String(env.CODEX_HOME || '').trim() || path.join(resolveHome(env), '.codex');
  const configPath = path.join(codexHome, 'config.toml');
  if (!existsSync(configPath)) {
    return { exists: false, configPath, goalsEnabled: null, source: null };
  }

  let text = '';
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (err) {
    return {
      exists: true,
      configPath,
      goalsEnabled: null,
      source: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let section = '';
  let rootGoals = null;
  let featureGoals = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComments(rawLine).trim();
    if (!line) continue;
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      section = normalizeLower(sectionMatch[1]);
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = normalizeLower(kv[1]);
    const rawValue = normalizeLower(kv[2]).replace(/^['"]|['"]$/g, '');
    if (key !== 'goals') continue;
    const parsed = rawValue === 'true' ? true : rawValue === 'false' ? false : null;
    if (section === 'features') featureGoals = parsed;
    if (!section) rootGoals = parsed;
  }

  const goalsEnabled = featureGoals ?? rootGoals;
  const source = featureGoals !== null ? 'codex.config.toml:[features].goals' : rootGoals !== null ? 'codex.config.toml:goals' : null;
  return { exists: true, configPath, goalsEnabled, source };
}

export function detectHost({ argv = process.argv.slice(2), env = process.env, platform = null } = {}) {
  const explicitRaw =
    getArgValue(argv, '--host') ||
    getArgValue(argv, '--platform') ||
    env.SKILLS_HOST ||
    env.SKILLS_PLATFORM ||
    '';
  const explicit = normalizeHost(explicitRaw);
  if (String(explicitRaw || '').trim()) return { host: explicit || 'generic', source: 'explicit' };

  const platformHint = normalizeHost(platform || '');
  if (platformHint && platformHint !== 'generic') return { host: platformHint, source: 'platform-hint' };

  if (env.CODEX_THREAD_ID || env.CODEX_MANAGED_BY_NPM || env.CODEX_MANAGED_PACKAGE_ROOT || env.CODEX_HOME) {
    return { host: 'codex', source: 'env.CODEX_*' };
  }
  if (env.CLAUDECODE || env.CLAUDE_CODE || env.CLAUDE_SESSION_ID || env.CLAUDE_PROJECT_DIR) {
    return { host: 'claude-code', source: 'env.CLAUDE_*' };
  }
  if (env.OPENCODE || env.OPENCODE_SESSION_ID || env.OPENCODE_CONFIG_DIR) {
    return { host: 'opencode', source: 'env.OPENCODE_*' };
  }
  if (env.CURSOR_TRACE_ID || env.CURSOR_AGENT || env.CURSOR_SESSION_ID) {
    return { host: 'cursor', source: 'env.CURSOR_*' };
  }
  if (env.CLINE_SESSION_ID || env.CLINE_MCP_SETTINGS) {
    return { host: 'cline', source: 'env.CLINE_*' };
  }
  if (env.GEMINI_CLI || env.GEMINI_CLI_SESSION || env.GEMINI_API_KEY) {
    return { host: 'gemini-cli', source: 'env.GEMINI_*' };
  }
  if (env.FACTORY_SESSION_ID || env.DROID_CLI || env.DROID_AGENT) {
    return { host: 'droid-cli', source: 'env.DROID/FACTORY_*' };
  }
  if (env.MCP_SERVER_NAME || env.MCP_SESSION_ID) {
    return { host: 'mcp-assisted', source: 'env.MCP_*' };
  }
  return { host: 'generic', source: 'default' };
}

export function detectHostMode({ argv = process.argv.slice(2), env = process.env, host = 'generic' } = {}) {
  const explicit = normalizeMode(
    getArgValue(argv, '--host-mode') ||
      getArgValue(argv, '--runtime-mode') ||
      getArgValue(argv, '--mode-policy') ||
      env.SKILLS_HOST_MODE ||
      env.SKILLS_RUNTIME_MODE ||
      ''
  );
  if (explicit) return { mode: explicit, source: 'explicit' };

  if (hasFlag(argv, '--ci') || envTruthy(env.CI) || envTruthy(env.SKILLS_CI)) return { mode: 'ci', source: 'ci-env-or-flag' };
  if (hasFlag(argv, '--plan-only') || envTruthy(env.SKILLS_PLAN_ONLY)) return { mode: 'plan-only', source: 'plan-only-flag' };
  if (hasFlag(argv, '--resume') || envTruthy(env.SKILLS_RESUME_MODE)) return { mode: 'resume', source: 'resume-flag' };
  if (hasFlag(argv, '--hook') || envTruthy(env.SKILLS_HOOK_MODE)) return { mode: 'hook', source: 'hook-flag' };
  if (hasFlag(argv, '--plugin-event') || envTruthy(env.SKILLS_PLUGIN_EVENT_MODE)) return { mode: 'plugin-event', source: 'plugin-event-flag' };
  if (hasFlag(argv, '--mcp-assisted') || envTruthy(env.SKILLS_MCP_ASSISTED)) return { mode: 'mcp-assisted', source: 'mcp-flag' };

  if (host === 'claude-code' && envTruthy(env.SKILLS_CLAUDE_HOOK_ACTIVE)) return { mode: 'hook', source: 'env.SKILLS_CLAUDE_HOOK_ACTIVE' };
  if (host === 'opencode' && (env.OPENCODE_EVENT || envTruthy(env.SKILLS_OPENCODE_PLUGIN_ACTIVE))) return { mode: 'plugin-event', source: 'env.OPENCODE_EVENT' };
  return { mode: 'interactive', source: 'default' };
}

function hostMatrixKey(host) {
  if (host === 'cursor' || host === 'cline' || host === 'gemini-cli' || host === 'droid-cli') return 'cursor-cline-gemini-droid';
  if (host === 'mcp-assisted') return 'cursor-cline-gemini-droid';
  return host || 'generic';
}

export function buildModePolicy({ host = 'generic', mode = 'interactive', codexGoalConfig = {} } = {}) {
  const h = normalizeHost(host) || 'generic';
  const m = normalizeMode(mode) || 'interactive';
  const base = {
    schemaVersion: 1,
    kind: 'host_mode_policy',
    host: h,
    mode: m,
    matrixKey: hostMatrixKey(h),
    outerLoopOwner: 'agent-turn',
    localLoopAutoRun: false,
    localLoopAllowed: true,
    maxBatchesPerTurn: 1,
    recoverFirst: false,
    allowInteractiveQuestions: true,
    taskListRequired: true,
    taskListDrivesExecution: false,
    mustEndWithGoalState: false,
    completionStateRequired: false,
    hostHookMayAdvance: false,
    mcpMayAssist: false,
    defaultCacheMode: 'global',
    stopRule: 'one bounded batch, then answer with evidence and Task List when applicable',
    cautions: [],
    recommendations: [],
  };

  if (m === 'goal') {
    Object.assign(base, {
      outerLoopOwner: h === 'codex' ? 'host-goal' : 'host-goal-or-user-loop',
      localLoopAutoRun: false,
      localLoopAllowed: false,
      maxBatchesPerTurn: 1,
      allowInteractiveQuestions: false,
      mustEndWithGoalState: h === 'codex',
      completionStateRequired: h === 'codex',
      stopRule: 'run one bounded phase batch, then complete/blocked/budget-pause instead of re-arming local loop-state',
    });
    base.cautions.push('Native/host goal loop owns continuation; local loop-state/loop-runner must not auto re-arm.');
    base.recommendations.push('Use SKILLS_HOST_MODE=goal (or --host-mode goal) when the host does not expose goal state in env.');
  }

  if (m === 'resume') {
    Object.assign(base, {
      outerLoopOwner: 'artifact-recovery',
      recoverFirst: true,
      localLoopAutoRun: false,
      stopRule: 'run recover-phase first; continue only through explicit bounded route truth',
    });
  }

  if (m === 'plan-only') {
    Object.assign(base, {
      outerLoopOwner: 'planner',
      localLoopAllowed: false,
      allowInteractiveQuestions: true,
      stopRule: 'emit clarify/plan/prepare truth only; do not enter execute without explicit implementation wording',
    });
  }

  if (m === 'ci') {
    Object.assign(base, {
      outerLoopOwner: 'ci-runner',
      localLoopAllowed: false,
      allowInteractiveQuestions: false,
      taskListRequired: false,
      stopRule: 'non-interactive fail/pass with artifacts; never ask questions',
    });
  }

  if (m === 'hook') {
    Object.assign(base, {
      outerLoopOwner: 'host-hook',
      hostHookMayAdvance: true,
      localLoopAutoRun: false,
      stopRule: 'respect hook payload and phase artifacts; wrapper must not overrule gate truth',
    });
  }

  if (m === 'plugin-event') {
    Object.assign(base, {
      outerLoopOwner: 'host-plugin-event',
      hostHookMayAdvance: true,
      localLoopAutoRun: false,
      stopRule: 'process one event and emit artifacts; plugin event model owns re-entry',
    });
  }

  if (m === 'mcp-assisted') {
    Object.assign(base, {
      outerLoopOwner: 'manual-with-mcp',
      mcpMayAssist: true,
      localLoopAutoRun: false,
      stopRule: 'MCP tools assist execution, but repo-local artifacts remain phase truth',
    });
  }

  if (h === 'codex') {
    base.hostTruth = 'repo-local/manual by default; no native hook/plugin surface detected';
    base.codexGoalsEnabled = codexGoalConfig?.goalsEnabled ?? null;
    if (codexGoalConfig?.goalsEnabled === true && m !== 'goal') {
      base.cautions.push('Codex goals are enabled in config, but current host mode is not goal; use SKILLS_HOST_MODE=goal for goal turns.');
    }
  } else if (h === 'claude-code') {
    base.hostTruth = 'hook-assisted when settings hooks are installed; otherwise manual/degraded';
  } else if (h === 'opencode') {
    base.hostTruth = 'plugin/event-assisted when plugin is installed; otherwise manual/degraded';
  } else if (['cursor', 'cline', 'gemini-cli', 'droid-cli', 'mcp-assisted'].includes(h)) {
    base.hostTruth = 'MCP-assisted/manual; host owns approval and process lifecycle';
    base.mcpMayAssist = true;
  } else {
    base.hostTruth = 'generic manual/degraded';
  }

  base.decision = 'pass';
  base.safeLocalLoop = !(base.outerLoopOwner === 'host-goal' && base.localLoopAutoRun);
  return base;
}

export function buildRuntimeProfile({ argv = process.argv.slice(2), env = process.env, repoRoot = process.cwd(), contextDir = null, platform = null, cache = null } = {}) {
  const hostDetection = detectHost({ argv, env, platform });
  const modeDetection = detectHostMode({ argv, env, host: hostDetection.host });
  const codexGoalConfig = hostDetection.host === 'codex' ? readCodexGoalConfig({ env }) : null;
  const policy = buildModePolicy({ host: hostDetection.host, mode: modeDetection.mode, codexGoalConfig });
  const generatedAt = new Date().toISOString();
  const signals = {
    env: {
      CODEX_THREAD_ID: Boolean(env.CODEX_THREAD_ID),
      CODEX_MANAGED_BY_NPM: Boolean(env.CODEX_MANAGED_BY_NPM),
      CLAUDE_CODE: Boolean(env.CLAUDE_CODE || env.CLAUDECODE),
      OPENCODE: Boolean(env.OPENCODE || env.OPENCODE_SESSION_ID),
      CI: Boolean(env.CI),
      SKILLS_HOST_MODE: String(env.SKILLS_HOST_MODE || '').trim() || null,
    },
    argv: {
      host: getArgValue(argv, '--host') || getArgValue(argv, '--platform') || null,
      hostMode: getArgValue(argv, '--host-mode') || getArgValue(argv, '--runtime-mode') || null,
    },
  };

  return {
    schemaVersion: 1,
    kind: 'host_runtime_profile',
    tool: 'host-runtime-profile',
    ok: true,
    generatedAt,
    repoRoot: String(repoRoot || '').replace(/\\/g, '/'),
    contextDir: contextDir ? String(contextDir).replace(/\\/g, '/') : null,
    cacheMode: cache?.mode || null,
    host: {
      platform: hostDetection.host,
      source: hostDetection.source,
      matrixKey: policy.matrixKey,
    },
    mode: {
      id: modeDetection.mode,
      source: modeDetection.source,
    },
    codex: codexGoalConfig
      ? {
          threadIdPresent: Boolean(env.CODEX_THREAD_ID),
          goalsEnabled: codexGoalConfig.goalsEnabled,
          goalsSource: codexGoalConfig.source,
          configPath: codexGoalConfig.configPath ? String(codexGoalConfig.configPath).replace(/\\/g, '/') : null,
        }
      : null,
    policy,
    signals,
    truth: 'Host Runtime Profile is the single runtime-mode truth consumed by bootstrap/router/loop/reporting. Task List is display-only and never authorizes continuation.',
    outputs: {
      runtimeProfile: HOST_RUNTIME_PROFILE_REL,
      modePolicy: HOST_MODE_POLICY_REL,
    },
  };
}

export function renderRuntimeProfileSummary(profile, { compact = false } = {}) {
  const p = profile || {};
  const policy = p.policy || {};
  const lines = [];
  lines.push('Host runtime profile:');
  lines.push(`- host=${p.host?.platform || 'unknown'} mode=${p.mode?.id || 'unknown'} outerLoopOwner=${policy.outerLoopOwner || 'unknown'}`);
  lines.push(`- localLoopAutoRun=${String(Boolean(policy.localLoopAutoRun))} maxBatchesPerTurn=${policy.maxBatchesPerTurn ?? 'n/a'} taskListDrivesExecution=${String(Boolean(policy.taskListDrivesExecution))}`);
  if (!compact) {
    lines.push(`- recoverFirst=${String(Boolean(policy.recoverFirst))} mustEndWithGoalState=${String(Boolean(policy.mustEndWithGoalState))} hostTruth=${policy.hostTruth || 'unknown'}`);
    if (Array.isArray(policy.cautions) && policy.cautions.length) lines.push(`- cautions=${policy.cautions.slice(0, 2).join(' | ')}`);
  }
  return lines.join('\n');
}
