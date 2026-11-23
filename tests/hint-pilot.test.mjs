import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { QUESTIONS, renderHints, selectHints } from '../bench/hints.mjs';
import { attemptFailed, computePairs, formatMarkdown, summarizeResults } from '../bench/hint-summary.mjs';

const execute = promisify(execFile);
const pilotPath = new URL('../bench/hint-pilot.mjs', import.meta.url).pathname;
const binDir = join(dirname(pilotPath), '..', 'bin');
const TAIL = '\nDo not modify any files. End your reply with a final line: ANSWER: <answer>';
const PROTOCOL_STOPWORDS =
  'a an and are as at be by do does for from given how in is it of on or repo s that the this to under what when which with you your'.split(' ');

// Golden hint renderings, independent of renderHints itself: the heading and
// every tool line are literals, with the checkout-specific binDir masked as
// <BIN> so the expectations hold at any clone path while a renderer that
// returns empty or malformed text still fails the assertions below.
const GOLDEN_HEADING = '\nHelpful commands you can run with your command tool (each does in ONE call what usually takes several):\n';
const GOLDEN_LINE = {
  ctx: '- <BIN>/ctx <file>...  show several files with line numbers at once',
  'git-snap': '- <BIN>/git-snap  branch, ahead/behind, status, recent commits at once',
  'gate-preflight': '- <BIN>/gate-preflight  every declared version (VERSION, package.json, ...) with MATCH/MISMATCH, plus git state',
  'log-triage': '- <BIN>/log-triage <dir-or-glob> [--grep RE] [--fields key]  newest log summary, grep count, JSONL field counts',
  logscan: '- <BIN>/logscan <file|dir|glob> [--where k=v] [--count key] [--fields a,b] [--grep RE]  filter/count/extract JSONL in one call',
};
const GOLDEN_HINTS = {
  all: GOLDEN_HEADING + ['ctx', 'git-snap', 'gate-preflight', 'log-triage', 'logscan'].map(id => GOLDEN_LINE[id]).join('\n'),
  'rules:F1': GOLDEN_HEADING + GOLDEN_LINE.ctx,
  'rules:F2': GOLDEN_HEADING + GOLDEN_LINE['gate-preflight'],
  'bm25:F1': GOLDEN_HEADING + GOLDEN_LINE.ctx,
  'bm25:F2': GOLDEN_HEADING + GOLDEN_LINE['gate-preflight'],
};

test('dry-run: 18 rotated entries, full prompt text and selector settings in manifest, agy version null, no spawned process', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hint-pilot-dryrun-'));
  try {
    // Tripwire executable: records any invocation (including --version).
    const tripwirePath = join(tmp, 'agy-tripwire.mjs');
    const spawnLogPath = join(tmp, 'spawned.log');
    writeFileSync(
      tripwirePath,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(spawnLogPath)}, process.argv.join(' ') + '\\n');
if (process.argv.includes('--version')) {
  process.stdout.write('tripwire 0.0.0\\n');
}
process.exit(0);
`,
      { mode: 0o755 }
    );
    chmodSync(tripwirePath, 0o755);

    const { stdout, stderr } = await execute(
      process.execPath,
      [pilotPath, '--dry-run', '--agy', tripwirePath],
      { timeout: 10_000 }
    );
    assert.equal(stderr, '');

    // The executable existed and was selected via --agy, yet dry-run must not
    // spawn it at all - not even for --version.
    assert.equal(existsSync(spawnLogPath), false, 'dry-run must not spawn any process, including agy --version');

    const manifest = JSON.parse(stdout);
    assert.equal(manifest.protocol, 'Selective-hint pilot v1 (predeclared 2026-10-27)');
    // No version evidence is available without probing; it must be recorded honestly.
    assert.equal(manifest.agyVersion, null);
    assert.equal(manifest.matrix.length, 18);

    const baseModes = ['all', 'rules', 'bm25'];
    const tasks = ['F1', 'F2'];

    let entryIndex = 0;
    for (let r = 0; r < 3; r++) {
      for (let t = 0; t < tasks.length; t++) {
        const k = (r + t) % 3;
        const expectedModes = baseModes.slice(k).concat(baseModes.slice(0, k));
        for (const expectedMode of expectedModes) {
          const m = manifest.matrix[entryIndex++];
          assert.equal(m.rep, r, `entry ${entryIndex} rep mismatch`);
          assert.equal(m.id, tasks[t], `entry ${entryIndex} task mismatch`);
          assert.equal(m.mode, expectedMode, `entry ${entryIndex} mode mismatch`);

          // Full prompt and hint text with byte counts that agree with them
          assert.equal(typeof m.prompt, 'string', `entry ${entryIndex} must carry the full prompt text`);
          assert.ok(m.prompt.length > 0);
          assert.equal(typeof m.hints, 'string', `entry ${entryIndex} must carry the full hint text`);
          assert.equal(Buffer.byteLength(m.prompt, 'utf8'), m.promptBytes);
          assert.equal(Buffer.byteLength(m.hints, 'utf8'), m.hintBytes);
          assert.ok(m.promptBytes > m.hintBytes, 'promptBytes must exceed hintBytes');
          // Structural assertions plus the literal goldens above: the oracle
          // is no longer recomputed through the selectHints+renderHints chain
          // the CLI uses, so a rendering regression fails here.
          const expectedIds = selectHints(m.mode, QUESTIONS[m.id]);
          assert.ok(m.hints.length > 0, `entry ${entryIndex} hints non-empty`);
          assert.ok(m.hintBytes > 0, `entry ${entryIndex} hintBytes positive`);
          assert.ok(m.hints.startsWith(GOLDEN_HEADING), `entry ${entryIndex} hints start with the golden heading`);
          for (const id of expectedIds) {
            assert.ok(m.hints.includes(`${binDir}/${id}`), `entry ${entryIndex} hints contain ${id} under binDir`);
          }
          const goldenKey = m.mode === 'all' ? 'all' : `${m.mode}:${m.id}`;
          assert.equal(m.hints.split(binDir).join('<BIN>'), GOLDEN_HINTS[goldenKey], `entry ${entryIndex} golden hint rendering`);
        }
      }
    }
    assert.equal(entryIndex, 18);

    // Entry 0 is F1/all: its prompt must be the question plus the complete
    // all-hints rendering plus the tail, byte for byte.
    const allIds = ['ctx', 'git-snap', 'gate-preflight', 'log-triage', 'logscan'];
    assert.equal(manifest.matrix[0].prompt, QUESTIONS.F1 + renderHints(allIds, binDir) + TAIL);

    // Selector settings are recorded before any call
    const sel = manifest.settings.selector;
    assert.deepEqual(sel.catalogOrder, allIds);
    assert.deepEqual(sel.rules.map(rule => rule.id), ['gate-preflight', 'git-snap', 'logscan', 'log-triage']);
    assert.equal(sel.maxSpecialty, 2);
    assert.equal(sel.ctxFallback.id, 'ctx');
    assert.equal(sel.ctxFallback.appliesOnlyWhenNoSpecialtyMatches, true);
    assert.equal(sel.bm25.k1, 1.2);
    assert.equal(sel.bm25.b, 0.75);
    assert.equal(sel.bm25.minScore, 1.0);
    assert.equal(sel.bm25.relativeMinScore, 0.5);
    assert.equal(sel.bm25.maxSelected, 2);
    assert.equal(sel.bm25.tieEpsilon, 1e-9);
    assert.deepEqual(sel.bm25.stopwords, PROTOCOL_STOPWORDS);
    assert.ok(typeof sel.bm25.tokenizer === 'string' && sel.bm25.tokenizer.includes('alphanumeric'));
    assert.ok(typeof sel.bm25.idfFormula === 'string' && sel.bm25.idfFormula.includes('log'));
    assert.equal(manifest.settings.process.timeoutMs, 300000);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('fake agy CLI integration: manifest before first call, prompts match manifest, raw stdout/stderr byte-for-byte, all failures recorded', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hint-pilot-integration-'));
  try {
    const mockAgyPath = join(tmp, 'mock-agy.mjs');
    const statePath = join(tmp, 'call-state.json');
    const manifestPath = join(tmp, 'results.manifest.json');
    const captureDir = join(tmp, 'captured');
    writeFileSync(statePath, JSON.stringify({ count: 0 }));

    // Deterministic fake agy. It refuses to answer (exit 3) unless the pre-call
    // manifest already exists, captures every received prompt, and records the
    // exact stdout/stderr bytes it emits so the test can compare raw logs.
    const mockAgyCode = `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

if (process.argv.includes('--version')) {
  process.stdout.write('agy mock 9.9.9\\n');
  process.exit(0);
}

// The pre-call manifest must already be on disk when the first prompt call runs.
if (!existsSync(${JSON.stringify(manifestPath)})) {
  process.stderr.write('manifest missing before first call\\n');
  process.exit(3);
}

const stateFile = ${JSON.stringify(statePath)};
const state = JSON.parse(readFileSync(stateFile, 'utf8'));
state.count++;
writeFileSync(stateFile, JSON.stringify(state));
const callNum = state.count;

// Capture the exact prompt bytes received.
const promptArg = process.argv[process.argv.indexOf('-p') + 1] || '';
mkdirSync(${JSON.stringify(captureDir)}, { recursive: true });
writeFileSync(${JSON.stringify(captureDir)} + '/prompt-' + callNum, promptArg, 'utf8');

let out = '';
let err = 'mock-agy note ' + callNum + '\\n';

if (callNum === 3) {
  // JSON null envelope: parsable, but not an object.
  out = 'null\\n';
} else if (callNum === 5) {
  // Unparsable stdout.
  out = 'CRITICAL: Internal service unreachable\\n';
} else if (callNum === 6) {
  // Object envelope with NO status field, but a fully correct F2 answer and usage.
  out = JSON.stringify({
    response: 'package.json has 2.4.1 and VERSION has 2.4.0.\\nANSWER: No, package.json has 2.4.1 and VERSION has 2.4.0',
    usage: { input_tokens: 600, cache_read_tokens: 20, output_tokens: 30 },
    conversation_id: 'conv-' + callNum
  }) + '\\n';
} else if (callNum === 7) {
  // SUCCESS envelope with missing usage.
  out = JSON.stringify({
    status: 'SUCCESS',
    response: 'Here is the answer.\\nANSWER: 8750',
    usage: null,
    conversation_id: 'conv-' + callNum
  }) + '\\n';
} else if (callNum === 10) {
  // Nonzero exit with empty stdout.
  out = '';
  err = 'fatal: model timeout\\n';
} else if (callNum === 12) {
  // JSON number envelope: parsable, but not an object.
  out = '42\\n';
} else {
  let ans = 'ANSWER: 8750';
  if (promptArg.includes('package.json')) {
    ans = 'ANSWER: No, package.json has 2.4.1 and VERSION has 2.4.0';
  }
  out = JSON.stringify({
    status: 'SUCCESS',
    response: 'Working through repository details.\\n' + ans,
    usage: { input_tokens: 1000 + callNum * 10, cache_read_tokens: 200, output_tokens: 50 },
    conversation_id: 'conv-' + callNum
  }) + '\\n';
}

// Record exactly what this process emits, then emit it.
writeFileSync(${JSON.stringify(captureDir)} + '/stdout-' + callNum, out, 'utf8');
writeFileSync(${JSON.stringify(captureDir)} + '/stderr-' + callNum, err, 'utf8');
process.stdout.write(out);
process.stderr.write(err);
if (callNum === 10) {
  process.exit(1);
}
`;
    writeFileSync(mockAgyPath, mockAgyCode, { mode: 0o755 });
    chmodSync(mockAgyPath, 0o755);

    const outPath = join(tmp, 'results.jsonl');
    const rawDir = join(tmp, 'results.raw');
    const benchDir = join(tmp, 'bench');
    mkdirSync(join(benchDir, 'plain'), { recursive: true });

    await execute(
      process.execPath,
      [pilotPath, '--out', outPath, '--agy', mockAgyPath, '--bench', benchDir, '--model', 'mock-gemini'],
      { timeout: 30_000 }
    );

    // Manifest on disk with the recorded version and matrix
    assert.ok(existsSync(manifestPath), 'manifest file must exist');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.requestedModel, 'mock-gemini');
    assert.equal(manifest.agyVersion, 'agy mock 9.9.9');
    assert.equal(manifest.matrix.length, 18);
    for (const entry of manifest.matrix) {
      assert.equal(typeof entry.prompt, 'string');
      assert.ok(entry.prompt.length > 0);
    }

    // All 18 attempts recorded. Call 1 exited 3 with no output had the manifest
    // been missing, so 18 rows with a clean first row prove manifest-before-call.
    const rows = readFileSync(outPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(rows.length, 18, 'all 18 attempts must be recorded, including failures');
    assert.equal(rows[0].exitCode, 0);
    assert.equal(rows[0].status, 'SUCCESS');

    // Every prompt sent to agy is byte-identical to the recorded manifest prompt
    for (let i = 0; i < 18; i++) {
      const captured = readFileSync(join(captureDir, `prompt-${i + 1}`));
      assert.ok(
        captured.equals(Buffer.from(manifest.matrix[i].prompt, 'utf8')),
        `prompt ${i + 1} sent to agy must equal the manifest prompt`
      );
    }

    // Raw stdout/stderr preserved byte-for-byte with what the fake agy emitted
    const rawFiles = readdirSync(rawDir);
    assert.equal(rawFiles.filter(f => f.endsWith('.stdout.log')).length, 18);
    assert.equal(rawFiles.filter(f => f.endsWith('.stderr.log')).length, 18);
    for (let i = 0; i < 18; i++) {
      const rec = rows[i];
      const rawBase = `r${rec.rep}_${rec.id}_${rec.mode}`;
      const rawOut = readFileSync(join(rawDir, `${rawBase}.stdout.log`));
      const rawErr = readFileSync(join(rawDir, `${rawBase}.stderr.log`));
      assert.ok(rawOut.equals(readFileSync(join(captureDir, `stdout-${i + 1}`))), `stdout of call ${i + 1} must be byte-identical`);
      assert.ok(rawErr.equals(readFileSync(join(captureDir, `stderr-${i + 1}`))), `stderr of call ${i + 1} must be byte-identical`);
    }

    // Call 3: JSON null last line -> recorded envelope failure, never a crash, never success
    const nullRow = rows[2];
    assert.equal(nullRow.id, 'F1');
    assert.equal(nullRow.mode, 'bm25');
    assert.equal(nullRow.status, 'ENVELOPE_NOT_OBJECT');
    assert.equal(nullRow.exitCode, 0);
    assert.equal(nullRow.factualCorrect, false);
    assert.equal(nullRow.strictCorrect, false);
    assert.equal(nullRow.usage, null);
    assert.equal(nullRow.tokens, null);
    assert.equal(nullRow.actualModel, 'unknown');

    // Call 12: JSON number last line -> same non-object failure path
    assert.equal(rows[11].status, 'ENVELOPE_NOT_OBJECT');
    assert.equal(rows[11].factualCorrect, false);

    // Call 5: unparsable stdout -> PARSE_FAIL
    assert.equal(rows[4].status, 'PARSE_FAIL');
    assert.equal(rows[4].correct, false);
    assert.equal(rows[4].factualCorrect, false);

    // Call 6: envelope without status must never score success, even with a
    // fully correct F2 answer and complete usage
    const missingStatusRow = rows[5];
    assert.equal(missingStatusRow.status, 'MISSING_STATUS');
    assert.equal(missingStatusRow.exitCode, 0);
    assert.equal(missingStatusRow.factualCorrect, false);
    assert.equal(missingStatusRow.strictCorrect, false);
    assert.equal(missingStatusRow.finalLineCompliant, false);
    assert.equal(typeof missingStatusRow.usage, 'object');

    // Call 7: missing usage stays unknown (null), never zero
    assert.equal(rows[6].usage, null);
    assert.equal(rows[6].tokens, null);

    // Call 10: nonzero exit with empty stdout -> recorded, still appended
    const procFailRow = rows[9];
    assert.equal(procFailRow.exitCode, 1);
    assert.equal(procFailRow.status, 'EMPTY_STDOUT');
    assert.equal(procFailRow.correct, false);
    assert.equal(procFailRow.factualCorrect, false);

    // Actual model unknown everywhere; requested model recorded
    for (const r of rows) {
      assert.equal(r.actualModel, 'unknown', 'omitted model in envelope must be recorded as unknown');
      assert.equal(r.model, 'mock-gemini');
    }

    // Refusal when --out points to an existing nonempty file
    await assert.rejects(
      execute(
        process.execPath,
        [pilotPath, '--out', outPath, '--agy', mockAgyPath, '--bench', benchDir],
        { timeout: 10_000 }
      ),
      err => {
        assert.equal(err.code, 1);
        assert.ok(err.stderr.includes('Refusing nonempty output file'));
        return true;
      }
    );

    // Summary over the real run: failures and pair exclusions reflect process
    // and envelope outcomes, with counted reasons; coverage is explicit.
    const summary = summarizeResults(rows);
    assert.equal(summary.modes.all.failures, 1);
    assert.equal(summary.modes.rules.failures, 1);
    assert.equal(summary.modes.bm25.failures, 3);

    assert.equal(summary.pairs.rules.validPairs, 3);
    assert.equal(summary.pairs.rules.excludedCount, 3);
    assert.equal(summary.pairs.rules.excludedReasonCounts['rules:usage_missing'], 2);
    assert.equal(summary.pairs.rules.excludedReasonCounts['all:status=MISSING_STATUS'], 1);
    assert.equal(summary.pairs.rules.excludedReasonCounts['rules:status=ENVELOPE_NOT_OBJECT'], 1);

    assert.equal(summary.pairs.bm25.validPairs, 3);
    assert.equal(summary.pairs.bm25.excludedCount, 3);
    assert.equal(summary.pairs.bm25.excludedReasonCounts['bm25:exit_code_1'], 1);
    const exitExcluded = summary.pairs.bm25.excluded.find(e => e.cmpExitCode === 1);
    assert.ok(exitExcluded, 'the nonzero-exit attempt must appear in the exclusion records');
    assert.equal(exitExcluded.cmpStatus, 'EMPTY_STDOUT');
    assert.equal(exitExcluded.cmpTokens, null, 'unknown usage stays unknown in the exclusion record');
    // the failed all-side attempt's own cost is preserved, not erased
    const allFailedExcluded = summary.pairs.bm25.excluded.find(e => e.allStatus === 'MISSING_STATUS');
    assert.equal(allFailedExcluded.allTokens, 650);

    assert.equal(summary.coverage.usage.measured, 13);
    assert.equal(summary.coverage.usage.unknown, 5);
    assert.equal(summary.coverage.tools.measured, 0);
    assert.equal(summary.coverage.tools.null, 18);
    assert.equal(summary.coverage.actualModel.known, 0);
    assert.equal(summary.coverage.actualModel.unknown, 18);
    assert.ok(summary.coverage.contamination.disclosure.length > 20);

    const md = formatMarkdown(summary);
    assert.ok(md.includes('## Coverage and contamination'));
    assert.ok(md.includes('excluded F1/rep1: rules:usage_missing'));
    assert.ok(md.includes('bm25:exit_code_1'));
    assert.ok(md.includes('- pair F1/rep0:'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('summary: pair matching, failure exclusions with counted reasons, coverage, token consistency, duplicate rejection, mode/task summaries', () => {
  const row = (rep, id, mode, tokens, extra = {}) => ({
    rep,
    id,
    mode,
    study: 'hints-pilot-v1',
    status: 'SUCCESS',
    exitCode: 0,
    signal: null,
    error: null,
    correct: true,
    strictCorrect: true,
    factualCorrect: true,
    actualModel: 'unknown',
    tools: null,
    promptBytes: 1500,
    hintBytes: 300,
    usage: { input_tokens: tokens - 20, cache_read_tokens: 10, output_tokens: 10 },
    tokens,
    ms: 100,
    ...extra,
  });

  // Construct complete 18 rows
  const rows = [];
  for (let r = 0; r < 3; r++) {
    for (const id of ['F1', 'F2']) {
      rows.push(row(r, id, 'all', 1000));
      rows.push(row(r, id, 'rules', 800));
      rows.push(row(r, id, 'bm25', 850));
    }
  }
  assert.equal(rows.length, 18);

  const summary = summarizeResults(rows);
  assert.equal(summary.study, 'hints-pilot-v1');
  assert.equal(summary.runs, 18);

  // Mode summaries
  assert.equal(summary.modes.all.attempts, 6);
  assert.equal(summary.modes.all.failures, 0);
  assert.equal(summary.modes.all.meanTokens, 1000);
  assert.equal(summary.modes.all.totalElapsedMs, 600);
  assert.equal(summary.modes.all.medianElapsedMs, 100);
  assert.equal(summary.modes.all.totalPromptBytes, 9000);
  assert.equal(summary.modes.all.meanHintBytes, 300);
  assert.equal(summary.modes.rules.attempts, 6);
  assert.equal(summary.modes.rules.meanTokens, 800);
  assert.equal(summary.modes.bm25.attempts, 6);
  assert.equal(summary.modes.bm25.meanTokens, 850);

  // Pair matching: 6 pairs each
  const pairs = computePairs(rows);
  assert.equal(pairs.rules.validPairs, 6);
  assert.equal(pairs.rules.excludedCount, 0);
  assert.equal(pairs.rules.meanDeltaTokens, -200);
  assert.equal(pairs.rules.meanPercentDelta, -20);

  assert.equal(pairs.bm25.validPairs, 6);
  assert.equal(pairs.bm25.excludedCount, 0);
  assert.equal(pairs.bm25.meanDeltaTokens, -150);
  assert.equal(pairs.bm25.meanPercentDelta, -15);

  // Missing usage exclusion
  const rowsWithMissing = rows.map(r => {
    if (r.id === 'F1' && r.rep === 0 && r.mode === 'rules') {
      return { ...r, usage: null, tokens: null };
    }
    return r;
  });
  const pairsMissing = computePairs(rowsWithMissing);
  assert.equal(pairsMissing.rules.validPairs, 5);
  assert.equal(pairsMissing.rules.excludedCount, 1);
  assert.equal(pairsMissing.rules.excluded[0].id, 'F1');
  assert.equal(pairsMissing.rules.excluded[0].rep, 0);
  assert.ok(pairsMissing.rules.excluded[0].reasons.includes('rules:usage_missing'));
  assert.equal(pairsMissing.rules.excludedReasonCounts['rules:usage_missing'], 1);

  // Process failure exclusion: nonzero exit with a SUCCESS envelope must count
  // as a failure and stay out of cost pairs, with its cost preserved
  const rowsProcFail = rows.map(r =>
    r.id === 'F1' && r.rep === 1 && r.mode === 'rules' ? { ...r, exitCode: 1 } : r
  );
  const sumProcFail = summarizeResults(rowsProcFail);
  assert.equal(sumProcFail.modes.rules.failures, 1);
  assert.equal(sumProcFail.modes.rules.factualPasses, 5);
  assert.equal(sumProcFail.modes.rules.strictPasses, 5);
  assert.equal(sumProcFail.pairs.rules.validPairs, 5);
  assert.equal(sumProcFail.pairs.rules.excludedCount, 1);
  assert.equal(sumProcFail.pairs.rules.excludedReasonCounts['rules:exit_code_1'], 1);
  assert.equal(sumProcFail.pairs.rules.excluded[0].cmpExitCode, 1);
  assert.equal(sumProcFail.pairs.rules.excluded[0].cmpStatus, 'SUCCESS');
  assert.equal(sumProcFail.pairs.rules.excluded[0].cmpTokens, 800);
  const mdProcFail = formatMarkdown(sumProcFail);
  assert.ok(mdProcFail.includes('rules:exit_code_1'));

  // Missing/unknown status never passes even with correctness flags set
  const rowsStatusFail = rows.map(r =>
    r.id === 'F2' && r.rep === 2 && r.mode === 'bm25' ? { ...r, status: 'MISSING_STATUS' } : r
  );
  const sumStatusFail = summarizeResults(rowsStatusFail);
  assert.equal(sumStatusFail.modes.bm25.failures, 1);
  assert.equal(sumStatusFail.modes.bm25.strictPasses, 5);
  assert.equal(sumStatusFail.modes.bm25.factualPasses, 5);
  assert.equal(sumStatusFail.pairs.bm25.validPairs, 5);
  assert.equal(sumStatusFail.pairs.bm25.excludedReasonCounts['bm25:status=MISSING_STATUS'], 1);

  // attemptFailed predicate: signal and spawn error also fail a SUCCESS row
  assert.equal(attemptFailed({ status: 'SUCCESS', exitCode: 0, signal: 'SIGTERM', error: null }), true);
  assert.equal(attemptFailed({ status: 'SUCCESS', exitCode: 0, signal: null, error: 'spawn ENOENT' }), true);
  assert.equal(attemptFailed({ status: 'SUCCESS', exitCode: 0, signal: null, error: null }), false);

  // Coverage and contamination disclosure are explicit
  const rowsCov = rows.map((r, i) => ({
    ...r,
    actualModel: i < 4 ? 'gemini-mock' : 'unknown',
    tools: i < 2 ? { 'tool:ctx': 1 } : null,
  }));
  const sumCov = summarizeResults(rowsCov);
  assert.equal(sumCov.coverage.actualModel.known, 4);
  assert.equal(sumCov.coverage.actualModel.unknown, 14);
  assert.equal(sumCov.coverage.tools.measured, 2);
  assert.equal(sumCov.coverage.tools.null, 16);
  assert.equal(sumCov.coverage.usage.measured, 18);
  assert.equal(sumCov.coverage.usage.unknown, 0);
  assert.equal(sumCov.modes.all.toolsMeasured, 1);
  assert.equal(sumCov.modes.all.toolsNull, 5);
  assert.equal(sumCov.modes.all.modelKnown, 2);
  assert.equal(sumCov.modes.all.modelUnknown, 4);
  assert.equal(typeof sumCov.coverage.contamination.disclosure, 'string');
  assert.ok(sumCov.coverage.contamination.disclosure.length > 20);

  // Markdown exposes individual pair records, exclusions, and missing cells
  const md = formatMarkdown(summary);
  assert.ok(md.includes('## Coverage and contamination'));
  assert.ok(md.includes('- pair F1/rep0: all 1000 vs rules 800 tokens'));
  assert.ok(md.includes('- pair F2/rep2: all 1000 vs bm25 850 tokens'));
  const rowsMissingCell = rows.filter(r => !(r.id === 'F1' && r.rep === 0 && r.mode === 'all'));
  const sumMissingCell = summarizeResults(rowsMissingCell);
  const mdMissingCell = formatMarkdown(sumMissingCell);
  assert.ok(mdMissingCell.includes('- missing F1/rep0: all attempt absent'));

  // Duplicate cell rejection
  assert.throws(
    () => summarizeResults([...rows, row(0, 'F1', 'all', 1000)]),
    /Duplicate cell: F1:all:0/
  );

  // Unknown mode rejection
  assert.throws(
    () => summarizeResults([row(0, 'F1', 'unknown-mode', 1000)]),
    /Unknown mode: unknown-mode/
  );

  // Mixed studies rejection
  assert.throws(
    () => summarizeResults([rows[0], { ...rows[1], study: 'other-study' }]),
    /Summarize separate studies separately/
  );

  // Token mismatch rejection
  assert.throws(
    () => summarizeResults([row(0, 'F1', 'all', 1000, { tokens: 999 })]),
    /Token mismatch/
  );
});
