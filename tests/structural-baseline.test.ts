import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const resultPath = path.join(repoRoot, '.context-snapshots/structural-quality.test.latest.json');
const sourcePattern = /^(src|entrypoints|scripts|tests\/support)\/.*\.(ts|tsx|js|jsx|mjs|cjs|py)$/;

interface StructuralFinding {
  severity?: string;
  file?: string;
}

interface StructuralResult {
  ok: boolean;
  blockers: string[];
  warnings: string[];
  outputs: {
    files: string[];
    findings: StructuralFinding[];
  };
}

test('QR-17 strict structural baseline does not regress', () => {
  const trackedFiles = execFileSync('git', ['ls-files'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).split(/\r?\n/).filter((file) => sourcePattern.test(file));

  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  execFileSync(process.execPath, [
    path.join(repoRoot, 'scripts/workflow/structural-quality.mjs'),
    '--files', trackedFiles.join(','),
    '--strict',
    '--cache-mode', 'repo',
    '--format', 'ai',
    '--out-json', '.context-snapshots/structural-quality.test.latest.json',
    '--no-stdout',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
  });

  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as StructuralResult;
  const findings = result.outputs.findings;
  assert.equal(trackedFiles.length, 169, 'explicit structural scan coverage changed');
  assert.deepEqual(result.outputs.files, trackedFiles, 'scanner file scope differs from git-derived scope');
  assert.equal(result.ok, true);
  assert.equal(result.blockers.length, 0);
  assert.ok(findings.length <= 91, `structural findings increased to ${findings.length}`);
  assert.ok(findings.filter((finding) => finding.severity === 'advisory').length <= 84);
  assert.ok(findings.filter((finding) => finding.severity === 'baseline').length <= 7);
  assert.equal(result.warnings.some((warning) => warning.includes('runner-format.ts')), false);
});
