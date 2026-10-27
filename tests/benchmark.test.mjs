import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const summarize = new URL('../bench/summarize.mjs', import.meta.url).pathname;
const row = (rep, tokens, extra = {}) => ({
  rep, id: 'F2', arm: 'A', status: 'SUCCESS', correct: false,
  factualCorrect: true, usage: { input_tokens: tokens, output_tokens: 0, cache_read_tokens: 0 },
  tokens, tools: {}, ...extra,
});
const run = async rows => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-lib-analysis-'));
  try {
    const path = join(dir, 'measurements.jsonl');
    await writeFile(path, rows.map(value => JSON.stringify(value)).join('\n'));
    const { stdout } = await execute(process.execPath, [summarize, path, '--json'], { timeout: 10_000 });
    return JSON.parse(stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('even medians, total tokens and factual scoring are independent of final-line compliance', async () => {
  const result = await run([row(0, 10), row(1, 20), row(2, 30), row(3, 100)]);
  assert.equal(result.arms.A.medianTokens, 25);
  assert.equal(result.arms.A.meanTokens, 40);
  assert.equal(result.arms.A.totalTokens, 160);
  assert.equal(result.arms.A.factualPasses, 4);
  assert.equal(result.arms.A.strictPasses, 0);
});

test('failed attempts remain in accuracy denominators and missing usage is not measured as zero', async () => {
  const result = await run([
    row(0, 10, { correct: true }),
    row(1, 0, { status: 'PARSE_FAIL', correct: false, factualCorrect: false, usage: null, tools: null }),
  ]);
  assert.equal(result.arms.A.attempts, 2);
  assert.equal(result.arms.A.failures, 1);
  assert.equal(result.arms.A.factualPasses, 1);
  assert.equal(result.arms.A.usageMeasured, 1);
  assert.equal(result.arms.A.meanTokens, 10);
  assert.equal(result.arms.A.toolsMeasured, 1);
});

test('duplicate cells, token inconsistencies and mixed studies fail rather than silently aggregate', async () => {
  await assert.rejects(run([row(0, 10), row(0, 10)]), { code: 1 });
  await assert.rejects(run([row(0, 10, { tokens: 11 })]), { code: 1 });
  await assert.rejects(run([row(0, 10), row(1, 20, { study: 'calculator-calibration' })]), { code: 1 });
});
