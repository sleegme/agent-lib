import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BM25_PARAMS,
  CATALOG,
  QUESTIONS,
  calculateTokens,
  checkFactual,
  formatTokens,
  idf,
  parseAnswer,
  pickTop,
  scoreBm25,
  scoreResponse,
  selectBm25,
  selectHints,
  selectRules,
  tokenize,
} from '../bench/hints.mjs';

test('rules selector: 0, 1, 2 selections, rule precedence, ctx fallback, and no task-ID/answer dependency', () => {
  // 0 selections on empty or unrelated text
  assert.deepEqual(selectRules(''), []);
  assert.deepEqual(selectRules('What is the weather today in Tokyo?'), []);

  // 1 selection for each rule
  // Rule 1: version/versions with match/compare/same/mismatch/declared/release/package -> gate-preflight
  assert.deepEqual(selectRules('Does the version match what is declared in package?'), ['gate-preflight']);
  // Rule 2: branch/ahead/behind/commit/commits/tracked/uncommitted/status -> git-snap
  assert.deepEqual(selectRules('Show the current branch and status'), ['git-snap']);
  // Rule 3: jsonl, or field/fields with count/common/filter/extract -> logscan
  assert.deepEqual(selectRules('Parse the jsonl event dump'), ['logscan']);
  assert.deepEqual(selectRules('Find the most common field value'), ['logscan']);
  // Rule 4: log/logs with newest/recent/modified/error/errors/grep -> log-triage
  assert.deepEqual(selectRules('Search logs for recent errors'), ['log-triage']);

  // 2 selections: rule 1 and rule 2
  assert.deepEqual(
    selectRules('Compare declared version match and check git branch commits status'),
    ['gate-preflight', 'git-snap']
  );

  // Rule precedence: when rules 1, 2, 3, 4 all trigger, keep first 2 in order
  const allFour = 'Compare version mismatch, inspect branch status, filter jsonl records, and grep recent log errors';
  assert.deepEqual(selectRules(allFour), ['gate-preflight', 'git-snap']);

  // Ctx fallback: only when NO specialty matches, and any ctx keyword is present
  assert.deepEqual(selectRules('Follow the code in src/a.py and read the configuration file'), ['ctx']);

  // Specialty matches take precedence over ctx keywords (no fallback if specialty matches)
  assert.deepEqual(selectRules('Check git branch status in src/ file'), ['git-snap']);

  // No task-ID or answer dependency
  assert.deepEqual(selectRules('Task F1 or F2 about 8750 or 2.4.0 and 2.4.1'), []);

  // Real question wording
  assert.deepEqual(selectRules(QUESTIONS.F1), ['ctx']);
  assert.deepEqual(selectRules(QUESTIONS.F2), ['gate-preflight']);
});

test('BM25 selector: term extraction, stopwords, IDF calculation, numeric scores, top 2 thresholding, tie-breaking by catalog order', () => {
  // Term extraction: lowercases, splits on punctuation and underscores
  const tokens = tokenize('Foo_Bar, baz-qux! 123');
  assert.deepEqual(tokens, ['foo', 'bar', 'baz', 'qux', '123']);

  // Stopwords removal
  const stopTokens = tokenize('What is the code under this repo with file');
  assert.deepEqual(stopTokens, ['code', 'file']);

  // IDF calculation
  // N=5. If term appears in 1 document: Math.log(1 + (5 - 1 + 0.5) / (1 + 0.5)) = Math.log(4)
  const codeIdf = idf('code');
  assert.ok(Math.abs(codeIdf - Math.log(4)) < 1e-6);

  // Term in all 5 documents (df=5): Math.log(1 + 0.5 / 5.5)
  // If term not present (df=0): Math.log(1 + 5.5 / 0.5) = Math.log(12)
  const unknownIdf = idf('nonexistentwordxyz');
  assert.ok(Math.abs(unknownIdf - Math.log(12)) < 1e-6);

  // Independent BM25 arithmetic: single term 'code' (df=1, tf=1) against the
  // ctx document (16 tokens) with N=5 documents, avgdl 20.4, k1=1.2, b=0.75:
  // idf * tf*(k1+1) / (tf + k1*(1 - b + b*dl/avgdl))
  const expectedCodeScore =
    Math.log(1 + (5 - 1 + 0.5) / (1 + 0.5)) * (1 * (1.2 + 1)) / (1 + 1.2 * (0.25 + 0.75 * (16 / 20.4)));
  const scoresCode = scoreBm25('code');
  assert.ok(Math.abs(scoresCode.ctx - expectedCodeScore) < 1e-9);
  assert.equal(scoresCode['git-snap'], 0);
  assert.equal(scoresCode['gate-preflight'], 0);
  assert.equal(scoresCode['log-triage'], 0);
  assert.equal(scoresCode.logscan, 0);

  // F1 query: matching document positive, non-matching exactly zero
  const scoresF1 = scoreBm25(QUESTIONS.F1);
  assert.ok(scoresF1.ctx > 4.0);
  assert.equal(scoresF1['git-snap'], 0);
  assert.equal(scoresF1['gate-preflight'], 0);

  // Thresholding: keep score >= 1.0 and >= 0.5 * maxScore, at most 2
  const selF1 = selectBm25(QUESTIONS.F1);
  assert.deepEqual(selF1.selected, ['ctx']);

  const selF2 = selectBm25(QUESTIONS.F2);
  assert.deepEqual(selF2.selected, ['gate-preflight']);

  // Empty or unrelated query selects 0
  const selEmpty = selectBm25('random unrelated gibberish');
  assert.deepEqual(selEmpty.selected, []);

  // Deterministic real-query ordering: 'latest summary' scores log-triage
  // above git-snap (different document lengths), both above the threshold.
  const latestSummary = selectBm25('latest summary');
  assert.deepEqual(latestSummary.selected, ['log-triage', 'git-snap']);
  assert.ok(latestSummary.scores['log-triage'] - latestSummary.scores['git-snap'] > 1e-9);

  // selectHints dispatch
  assert.deepEqual(selectHints('all', QUESTIONS.F1), ['ctx', 'git-snap', 'gate-preflight', 'log-triage', 'logscan']);
  assert.deepEqual(selectHints('rules', QUESTIONS.F1), ['ctx']);
  assert.deepEqual(selectHints('bm25', QUESTIONS.F1), ['ctx']);
  assert.throws(() => selectHints('invalid-mode', QUESTIONS.F1), /Unknown hints selection mode/);
});

test('BM25 ranking: constructed exact tie breaks by catalog order, near-ties within epsilon keep catalog order, threshold rules hold', () => {
  // Constructed exact tie: three documents share the identical maximum score.
  // max=2, threshold=max(1.0, 0.5*2)=1.0; all three qualify, the top two must
  // be chosen in catalog order ctx < git-snap < gate-preflight < log-triage < logscan.
  assert.deepEqual(
    pickTop({ ctx: 2, 'git-snap': 2, 'gate-preflight': 2, 'log-triage': 0.4, logscan: 0 }),
    ['ctx', 'git-snap']
  );

  // Two-way exact tie among later catalog entries
  assert.deepEqual(
    pickTop({ 'gate-preflight': 3, 'log-triage': 3, ctx: 3 }),
    ['ctx', 'gate-preflight']
  );

  // Near tie inside the 1e-9 epsilon: git-snap scores infinitesimally higher
  // than ctx, but the difference is within tieEpsilon so catalog order wins.
  assert.deepEqual(
    pickTop({ ctx: 2, 'git-snap': 2 + 5e-10, 'log-triage': 2 - 5e-10 }),
    ['ctx', 'git-snap']
  );

  // A difference above the epsilon must follow the score, not catalog order
  assert.deepEqual(
    pickTop({ ctx: 2, 'git-snap': 2 + 1e-8 }),
    ['git-snap', 'ctx']
  );

  // Relative threshold: only scores >= 0.5 * max are kept
  assert.deepEqual(pickTop({ 'log-triage': 3, ctx: 1.4, 'git-snap': 0.9 }), ['log-triage']);

  // Absolute floor: scores below 1.0 never qualify, even as the maximum
  assert.deepEqual(pickTop({ ctx: 0.9, 'git-snap': 0.2 }), []);

  // At most two selections
  assert.deepEqual(pickTop({ ctx: 5, 'git-snap': 4, 'gate-preflight': 3 }), ['ctx', 'git-snap']);

  // All-zero scores select nothing
  assert.deepEqual(pickTop({ ctx: 0, logscan: 0 }), []);

  // The ranking parameters are the frozen protocol values
  assert.equal(BM25_PARAMS.k1, 1.2);
  assert.equal(BM25_PARAMS.b, 0.75);
  assert.equal(BM25_PARAMS.minScore, 1.0);
  assert.equal(BM25_PARAMS.relativeMinScore, 0.5);
  assert.equal(BM25_PARAMS.maxSelected, 2);
});

test('scoring: factual in body with incomplete final line, correct final line, absent final line, process failure, token arithmetic, budget formatting', () => {
  // F1 correct final line
  const resF1Good = scoreResponse('F1', 'The result of plan_budget is 8750.\nANSWER: 8750', { status: 'SUCCESS' });
  assert.equal(resF1Good.factualCorrect, true);
  assert.equal(resF1Good.strictCorrect, true);
  assert.equal(resF1Good.finalLineCompliant, true);
  assert.equal(resF1Good.answer, '8750');

  // F1 with comma format
  const resF1Comma = scoreResponse('F1', 'ANSWER: 8,750', { status: 'SUCCESS' });
  assert.equal(resF1Comma.factualCorrect, true);
  assert.equal(resF1Comma.strictCorrect, true);

  // F2 factual in body with incomplete final line (e.g. ANSWER: no)
  const resF2Incomplete = scoreResponse(
    'F2',
    'package.json has version 2.4.1 while VERSION has 2.4.0. No they do not match.\nANSWER: no',
    { status: 'SUCCESS' }
  );
  assert.equal(resF2Incomplete.factualCorrect, true);
  assert.equal(resF2Incomplete.strictCorrect, false, 'strict correctness fails when final line content lacks full factual content');
  assert.equal(resF2Incomplete.finalLineCompliant, true);
  assert.equal(resF2Incomplete.answer, 'no');

  // F2 correct complete final line
  const resF2Complete = scoreResponse(
    'F2',
    'Versions differ.\nANSWER: No, package.json has 2.4.1 and VERSION has 2.4.0',
    { status: 'SUCCESS' }
  );
  assert.equal(resF2Complete.factualCorrect, true);
  assert.equal(resF2Complete.strictCorrect, true);

  // Absent final line
  const resNoFinal = scoreResponse('F1', 'The answer is 8750.', { status: 'SUCCESS' });
  assert.equal(resNoFinal.factualCorrect, true);
  assert.equal(resNoFinal.strictCorrect, false);
  assert.equal(resNoFinal.finalLineCompliant, false);
  assert.equal(resNoFinal.answer, '');

  // Process and envelope failures never pass either score
  const resProcFail = scoreResponse('F1', 'ANSWER: 8750', { exitCode: 1, status: 'SUCCESS' });
  assert.equal(resProcFail.factualCorrect, false);
  assert.equal(resProcFail.strictCorrect, false);

  const resStatusFail = scoreResponse('F1', 'ANSWER: 8750', { exitCode: 0, status: 'PARSE_FAIL' });
  assert.equal(resStatusFail.factualCorrect, false);
  assert.equal(resStatusFail.strictCorrect, false);

  // Missing envelope status must never score as success, even on exit 0 with a correct answer
  const resMissingStatus = scoreResponse('F1', 'ANSWER: 8750', { exitCode: 0 });
  assert.equal(resMissingStatus.factualCorrect, false);
  assert.equal(resMissingStatus.strictCorrect, false);
  assert.equal(resMissingStatus.finalLineCompliant, false);

  // Signal or spawn error also fails a SUCCESS envelope
  const resSignal = scoreResponse('F1', 'ANSWER: 8750', { exitCode: 0, status: 'SUCCESS', signal: 'SIGKILL' });
  assert.equal(resSignal.factualCorrect, false);
  assert.equal(resSignal.strictCorrect, false);
  const resError = scoreResponse('F1', 'ANSWER: 8750', { exitCode: 0, status: 'SUCCESS', error: 'spawn ENOENT' });
  assert.equal(resError.factualCorrect, false);
  assert.equal(resError.strictCorrect, false);

  // Token arithmetic
  assert.equal(calculateTokens({ input_tokens: 100, cache_read_tokens: 20, output_tokens: 30 }), 150);
  assert.equal(calculateTokens(null), null);
  assert.equal(calculateTokens({ input_tokens: 100, output_tokens: 30 }), null);
  assert.equal(calculateTokens({ input_tokens: 100, cache_read_tokens: -5, output_tokens: 30 }), null);
  assert.equal(calculateTokens({ input_tokens: 100, cache_read_tokens: '20', output_tokens: 30 }), null);

  // Budget formatting
  assert.equal(formatTokens(1500), '1.5k');
  assert.equal(formatTokens(95805), '95.8k');
  assert.equal(formatTokens(null), '-');
  assert.equal(formatTokens(undefined), '-');
});
