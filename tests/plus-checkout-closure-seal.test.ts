import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('seal uses immutable run evidence after mutable latest pointers change', async () => {
  const projectRoot = process.cwd();
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'opx-pcc-seal-'));
  const runId = 'pcc-live-11111111-1111-4111-8111-111111111111';
  const savedDir = path.join(fixtureRoot, '.context-snapshots', 'saved-payment-live-e2e');
  const closureDir = path.join(fixtureRoot, '.context-snapshots', 'plus-checkout-closure');

  try {
    await Promise.all([
      mkdir(savedDir, { recursive: true }),
      mkdir(closureDir, { recursive: true }),
    ]);
    const saved = { schemaVersion: 1, closureRunId: runId, ok: true };
    const browser = { schemaVersion: 1, closureRunId: runId, ok: true };
    const live = {
      schemaVersion: 1,
      closureRunId: runId,
      ok: true,
      run: { id: runId },
      sourceEvidence: {},
    };
    const changedLatest = { schemaVersion: 1, closureRunId: 'closure-fixture', ok: true };
    await Promise.all([
      writeJson(path.join(savedDir, `${runId}.json`), saved),
      writeJson(path.join(savedDir, 'latest.json'), changedLatest),
      writeJson(path.join(closureDir, `${runId}.browser.json`), browser),
      writeJson(path.join(closureDir, 'browser-fixture.latest.json'), changedLatest),
      writeJson(path.join(closureDir, 'live.latest.json'), live),
    ]);

    const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const liveScript = path.join(projectRoot, 'scripts', 'e2e-plus-checkout-closure-live.ts');
    const { stdout } = await execFileAsync(process.execPath, [tsxCli, liveScript, '--seal-existing'], {
      cwd: fixtureRoot,
      timeout: 30_000,
    });
    assert.match(stdout, new RegExp(runId));

    const sealed = JSON.parse(await readFile(path.join(closureDir, `${runId}.live.json`), 'utf8'));
    assert.equal(sealed.sourceEvidence.savedPayment, `.context-snapshots/saved-payment-live-e2e/${runId}.json`);
    assert.equal(sealed.sourceEvidence.browser, `.context-snapshots/plus-checkout-closure/${runId}.browser.json`);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
