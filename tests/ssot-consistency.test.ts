import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const ssotRoot = path.join(repoRoot, 'docs/ssot');
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};
const rootIndex = fs.readFileSync(path.join(ssotRoot, 'README.md'), 'utf8');
const savedPaymentVerify = fs.readFileSync(path.join(ssotRoot, 'saved-payment-methods/VERIFY.md'), 'utf8');
const eligibilityFactorsVerify = fs.readFileSync(path.join(ssotRoot, 'eligibility-factors/VERIFY.md'), 'utf8');
const multiFactorReadme = fs.readFileSync(path.join(ssotRoot, 'multi-factor-experiments/README.md'), 'utf8');
const qualityRemediationReadme = fs.readFileSync(path.join(ssotRoot, 'quality-remediation/README.md'), 'utf8');
const qualityRemediationTasks = fs.readFileSync(path.join(ssotRoot, 'quality-remediation/TASKS.md'), 'utf8');
const qualityRemediationVerify = fs.readFileSync(path.join(ssotRoot, 'quality-remediation/VERIFY.md'), 'utf8');

function listMarkdownFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    return entry.isDirectory()
      ? listMarkdownFiles(absolutePath)
      : entry.name.endsWith('.md') ? [absolutePath] : [];
  });
}

test('QR-13 every task SSOT has its contract and verification siblings', () => {
  const taskFiles = listMarkdownFiles(ssotRoot).filter((file) => path.basename(file) === 'TASKS.md');
  assert.ok(taskFiles.length > 0);
  for (const taskFile of taskFiles) {
    const directory = path.dirname(taskFile);
    assert.ok(fs.existsSync(path.join(directory, 'README.md')), `${taskFile} is missing README.md`);
    assert.ok(fs.existsSync(path.join(directory, 'VERIFY.md')), `${taskFile} is missing VERIFY.md`);
  }
});

test('QR-13 root index has an exact, non-duplicated incomplete-task summary', () => {
  const incompleteTaskIds = new Set<string>();
  const taskFiles = listMarkdownFiles(ssotRoot).filter((file) => path.basename(file) === 'TASKS.md');
  for (const taskFile of taskFiles) {
    for (const line of fs.readFileSync(taskFile, 'utf8').split(/\r?\n/)) {
      if (!line.startsWith('|')) continue;
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
      const taskId = cells[0];
      if (!/^[A-Z][A-Z0-9]*-\d+$/.test(taskId)) continue;
      if (cells.some((cell) => /^(部分完成|待|阻塞)/.test(cell))) incompleteTaskIds.add(taskId);
    }
  }

  assert.ok(incompleteTaskIds.size > 0);
  const externalInputsSection = rootIndex.match(/## 未完成任务的唯一汇总\s+([\s\S]*?)(?=\n## |$)/)?.[1];
  assert.ok(externalInputsSection, 'root index is missing the incomplete-task summary');
  const summarizedTaskIds = [...externalInputsSection.matchAll(/\b[A-Z][A-Z0-9]*-\d+\b/g)].map((match) => match[0]);
  assert.equal(new Set(summarizedTaskIds).size, summarizedTaskIds.length, 'root incomplete-task summary contains duplicate task IDs');
  assert.deepEqual(new Set(summarizedTaskIds), incompleteTaskIds, 'root incomplete-task summary differs from task SSOT state');
  for (const taskId of incompleteTaskIds) {
    assert.match(externalInputsSection, new RegExp(`\\b${taskId}\\b`), `${taskId} is absent from the root incomplete-task summary`);
  }
});

test('QR-13 unchecked verification items are limited to declared external gates', () => {
  const allowedUnchecked = new Map([
    ['multi-factor-experiments/VERIFY.md', 'MF-18'],
    ['saved-payment-methods/VERIFY.md', '上游交付'],
  ]);
  const unchecked = listMarkdownFiles(ssotRoot).flatMap((file) =>
    fs.readFileSync(file, 'utf8').split(/\r?\n/)
      .filter((line) => /^- \[ \]/.test(line))
      .map((line) => ({
        relativePath: path.relative(ssotRoot, file).replaceAll('\\', '/'),
        line,
      })),
  );

  assert.equal(unchecked.length, allowedUnchecked.size);
  for (const item of unchecked) {
    const marker = allowedUnchecked.get(item.relativePath);
    assert.ok(marker, `undeclared unchecked verification item: ${item.relativePath}`);
    assert.match(item.line, new RegExp(marker), `${item.relativePath} is missing external-gate marker ${marker}`);
  }
});

test('QR-13 root index names every Saved Payment live preflight input', () => {
  assert.match(
    rootIndex,
    /SPM_E2E_PROFILE_DIR[\s\S]*SPM_E2E_PUBLISHABLE_KEY[\s\S]*SPM_E2E_BILLING_NAME[\s\S]*SPM_E2E_CARD_NUMBER[\s\S]*SPM_E2E_CARD_EXPIRY[\s\S]*SPM_E2E_CARD_CVC[\s\S]*SPM_E2E_BACKEND_BASE_URL[\s\S]*SPM_E2E_STRIPE_SECRET_KEY/,
  );
});

test('QR-15 current external-gate evidence is dated and fail-closed', () => {
  assert.match(savedPaymentVerify, /2026-08-09 当前环境 preflight/);
  assert.match(savedPaymentVerify, /profileConfigured=false/);
  assert.match(savedPaymentVerify, /testBackendMode=missing/);
  assert.match(savedPaymentVerify, /历史隔离 profile.*直连与经当前 SG 出口.*session HTTP 均为 403/);
  assert.match(eligibilityFactorsVerify, /2026-08-09.*10808.*Cloudflare 与 ChatGPT trace 均为 HTTP 200.*SG/);
  assert.match(multiFactorReadme, /2026-08-09.*10808.*单一 SG 出口/);
  assert.match(savedPaymentVerify, /GraphQL.*REST.*403/);
  assert.doesNotMatch(savedPaymentVerify, /当前独立 profile/);
});

test('QR-16 and QR-17 structural baseline contract is consistent and executable', () => {
  for (const document of [rootIndex, qualityRemediationReadme, qualityRemediationTasks, qualityRemediationVerify]) {
    assert.match(document, /169 (?:个)?文件/);
    assert.match(document, /91 (?:个 )?finding/);
    assert.match(document, /0 blocker/);
  }
  assert.match(rootIndex, /84 advisory、7 baseline/);
  assert.match(qualityRemediationVerify, /runner-format\.ts.*(?:0 finding|告警为 0)/s);
  assert.equal(packageJson.scripts?.['test:structural-baseline'], 'tsx --test tests/structural-baseline.test.ts');
  assert.match(qualityRemediationTasks, /QR-17.*test:structural-baseline/);
  assert.doesNotMatch(rootIndex, /完整 184 文件迁移仍需/);
});

test('QR-19/QR-20 live stage, plan and stability contracts are explicit', () => {
  assert.match(rootIndex, /OPX_LIVE_AUTH_PROXY[\s\S]*OPX_LIVE_CHECKOUT_PROXY[\s\S]*OPX_LIVE_BILLING_PROXY/);
  assert.match(rootIndex, /OPX_LIVE_COUNTRIES[\s\S]*OPX_LIVE_PAYMENT_METHODS[\s\S]*OPX_LIVE_CHECKOUT_UI_MODE/);
  assert.match(qualityRemediationTasks, /QR-19.*三阶段出口与多方式 live 计划门/);
  assert.match(qualityRemediationTasks, /QR-20.*目标域稳定性历史门/);
  assert.match(rootIndex, /history\.jsonl.*最近 3 次窗口内至少连续 2 次/s);
  assert.match(rootIndex, /audit:live:strict/);
  assert.match(qualityRemediationVerify, /Live readiness 单元.*13\/13/);
});
