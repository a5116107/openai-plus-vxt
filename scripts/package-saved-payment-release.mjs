import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const skipBuild = process.argv.includes('--skip-build');
const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
const version = String(packageJson.version || '0.0.0');
const outputDir = path.join(repoRoot, '.output');
const distDir = path.join(repoRoot, 'dist');
const chromeBuild = path.join(outputDir, 'chrome-mv3');
const firefoxBuild = path.join(outputDir, 'firefox-mv2');

if (!skipBuild) {
  run('pnpm', ['zip']);
  run('pnpm', ['zip:firefox']);
}

const chromeSource = path.join(outputDir, `openai-plus-vxt-${version}-chrome.zip`);
const firefoxSource = path.join(outputDir, `openai-plus-vxt-${version}-firefox.zip`);
for (const required of [chromeSource, firefoxSource, chromeBuild, firefoxBuild]) {
  if (!existsSync(required)) throw new Error(`required build output is missing: ${path.relative(repoRoot, required)}`);
}

await mkdir(distDir, { recursive: true });
const chromeArtifact = path.join(distDir, `openai-plus-vxt-${version}-chrome.zip`);
const firefoxArtifact = path.join(distDir, `openai-plus-vxt-${version}-firefox.xpi`);
await copyFile(chromeSource, chromeArtifact);
await copyFile(firefoxSource, firefoxArtifact);

const chromeManifest = JSON.parse(await readFile(path.join(chromeBuild, 'manifest.json'), 'utf8'));
const firefoxManifest = JSON.parse(await readFile(path.join(firefoxBuild, 'manifest.json'), 'utf8'));
const manifestChecks = [
  check(chromeManifest.manifest_version === 3, 'Chrome manifest is MV3'),
  check(firefoxManifest.manifest_version === 2, 'Firefox manifest is MV2'),
  check(hasSavedPaymentBridge(chromeManifest), 'Chrome contains the MAIN-world saved payment bridge'),
  check(hasSavedPaymentBridge(firefoxManifest), 'Firefox contains the MAIN-world saved payment bridge'),
  check(chromeManifest.version === version, 'Chrome version matches package.json'),
  check(firefoxManifest.version === version, 'Firefox version matches package.json'),
];
const failedManifestChecks = manifestChecks.filter((item) => !item.ok);
if (failedManifestChecks.length) {
  throw new Error(`manifest validation failed: ${failedManifestChecks.map((item) => item.label).join('; ')}`);
}

const auditRoots = [
  path.join(repoRoot, 'src', 'features', 'saved-payment-methods'),
  path.join(repoRoot, 'src', 'features', 'payment', 'panel.ts'),
  path.join(repoRoot, 'entrypoints', 'content.ts'),
  path.join(repoRoot, 'scripts', 'e2e-saved-payment-live.mjs'),
  path.join(repoRoot, 'tests', 'support', 'saved-payment-live-e2e-runner.mjs'),
  path.join(repoRoot, 'tests', 'support', 'saved-payment-stripe-test-support.mjs'),
  chromeBuild,
  firefoxBuild,
];
const sensitiveFindings = await scanSensitiveShapes(auditRoots);
if (sensitiveFindings.length) {
  throw new Error(`sensitive-shaped content found in ${sensitiveFindings.map((item) => item.file).join(', ')}`);
}

const previousFirefox = await findPreviousFirefoxArtifact(distDir, version);
const artifacts = await Promise.all([chromeArtifact, firefoxArtifact].map(async (file) => ({
  file: relative(file),
  bytes: (await stat(file)).size,
  sha256: await sha256(file),
})));
const evidence = {
  schemaVersion: 1,
  kind: 'saved_payment_release_evidence',
  generatedAt: new Date().toISOString(),
  version,
  rollout: {
    defaultEnabled: false,
    environment: 'test',
    allowedMethods: ['card'],
    storageKey: 'opx.savedPaymentMethods.feature',
    testBackendModes: ['embedded-stripe', 'external'],
  },
  artifacts,
  manifestChecks,
  sensitiveShapeScan: { roots: auditRoots.map(relative), findings: [] },
  rollback: {
    firstAction: 'Disable opx.savedPaymentMethods.feature.enabled before replacing the extension package.',
    previousFirefoxArtifact: previousFirefox ? relative(previousFirefox) : null,
  },
};

const evidencePath = path.join(distDir, `saved-payment-release-${version}.json`);
const rollbackPath = path.join(distDir, `saved-payment-rollback-${version}.md`);
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
await writeFile(rollbackPath, rollbackMarkdown(evidence), 'utf8');

process.stdout.write(`${JSON.stringify({
  ok: true,
  version,
  artifacts,
  evidence: relative(evidencePath),
  rollback: relative(rollbackPath),
}, null, 2)}\n`);

function run(command, args) {
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-Command', command, ...args], {
        cwd: repoRoot,
        stdio: 'inherit',
        shell: false,
      })
    : spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit', shell: false });
  if (result.status !== 0) {
    const detail = result.error ? ` (${result.error.code || 'spawn-error'}: ${result.error.message})` : '';
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}${detail}`);
  }
}

function hasSavedPaymentBridge(manifest) {
  return Array.isArray(manifest.content_scripts) && manifest.content_scripts.some((entry) =>
    entry.run_at === 'document_start' && entry.world === 'MAIN' &&
    Array.isArray(entry.js) && entry.js.includes('content-scripts/saved-payment-elements.js'));
}

function check(ok, label) {
  return { ok: Boolean(ok), label };
}

async function scanSensitiveShapes(roots) {
  const findings = [];
  for (const root of roots) {
    for (const file of await listTextFiles(root)) {
      const content = await readFile(file, 'utf8');
      const kinds = [];
      if (/sk_(?:live|test)_[A-Za-z0-9_-]{16,}/.test(content)) kinds.push('secret-key');
      if (/pk_(?:live|test)_[A-Za-z0-9_-]{20,}/.test(content)) kinds.push('publishable-key');
      if (/seti_[A-Za-z0-9]{8,}_secret_[A-Za-z0-9]{8,}/.test(content)) kinds.push('setup-secret');
      if (findLuhnCandidate(content)) kinds.push('card-number');
      if (kinds.length) findings.push({ file: relative(file), kinds });
    }
  }
  return findings;
}

async function listTextFiles(target) {
  const info = await stat(target);
  if (info.isFile()) return [target];
  const output = [];
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) output.push(...await listTextFiles(child));
    else if (/\.(?:js|mjs|ts|json|html|css|md)$/i.test(entry.name)) output.push(child);
  }
  return output;
}

function findLuhnCandidate(content) {
  for (const match of content.matchAll(/(?<!\d)\d{13,19}(?!\d)/g)) {
    if (luhn(match[0])) return true;
  }
  return false;
}

function luhn(value) {
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

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function findPreviousFirefoxArtifact(directory, currentVersion) {
  const candidates = (await readdir(directory))
    .map((name) => ({ name, match: /^openai-plus-vxt-(\d+\.\d+\.\d+)-firefox\.xpi$/.exec(name) }))
    .filter((item) => item.match && compareVersions(item.match[1], currentVersion) < 0)
    .sort((left, right) => compareVersions(right.match[1], left.match[1]));
  return candidates[0] ? path.join(directory, candidates[0].name) : null;
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function rollbackMarkdown(value) {
  const previous = value.rollback.previousFirefoxArtifact || 'previous signed/tested artifact backup';
  return `# Saved Payment Rollback ${value.version}\n\n` +
    `1. Set \`opx.savedPaymentMethods.feature.enabled\` to \`false\`.\n` +
    `2. Confirm the payment panel disables Card submission and existing audit data remains readable.\n` +
    `3. Reinstall \`${previous}\` when package rollback is required.\n` +
    `4. Re-run \`pnpm test:saved-payment-methods\` and inspect the server payment-method list read-only.\n`;
}

function relative(file) {
  return path.relative(repoRoot, file).replaceAll('\\', '/');
}
