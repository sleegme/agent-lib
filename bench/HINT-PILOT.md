# Selective-hint pilot v1 (predeclared 2026-10-27)

Approved in Discord message 1564498365474013326. This protocol is fixed
before any pilot model calls. No tuning against the observed responses.
Selection relevance is not evidence of token utility.

## Scope and controls

- Compare `all`, `rules`, `bm25`; selection consumes only task wording.
- Same existing plain fixture at `~/work/agent-lib-bench/plain`, model
  `gemini-3.8-flash-medium`, agy JSON print interface and permission flag as
  `bench/ab.mjs`. No rtk, new fixtures, model comparison or extra baseline.
- F1 and F2 retain their existing question text; 3 repetitions each,
  3 modes, exactly 18 attempted calls. No automatic retries.
- For repetition r and task index t, rotate `[all,rules,bm25]` by
  `(r+t)%3`, to avoid always running one mode first.
- Read-only task suffix and final `ANSWER: <answer>` requirement unchanged.
- Existing cleanup and historical data are preserved, without commit/push.

## Catalog and selectors

The five command descriptions are the existing hint text in `ab.mjs`,
unchanged in meaning and order: ctx, git-snap, gate-preflight, log-triage,
logscan. Render absolute paths only after selection. Search documents
contain the description plus these fixed generic terms:

| ID | Additional retrieval terms |
|---|---|
| ctx | code source files read inspect function imports configuration config |
| git-snap | git branch ahead behind status tracked modified commits latest subject |
| gate-preflight | compare version versions package release declared match mismatch |
| log-triage | logs newest recent modified error errors summary grep count |
| logscan | jsonl events field fields type filter extract occurrences frequency |

No task IDs, answers, fixture paths, budget values or version values in
the catalog or selector logic.

Rules use lowercase word tokens, with no access to scoring:

1. `version` or `versions` with any of `match`, `compare`, `same`,
   `mismatch`, `declared`, `release`, `package` selects gate-preflight.
2. Any of `branch`, `ahead`, `behind`, `commit`, `commits`, `tracked`,
   `uncommitted`, `status` selects git-snap.
3. `jsonl`, or `field`/`fields` with `count`/`common`/`filter`/`extract`,
   selects logscan.
4. `log`/`logs` with `newest`/`recent`/`modified`/`error`/`errors`/`grep`
   selects log-triage.
5. Keep the first two specialty matches in that order. Only if none
   matches, `file`/`files`/`src`/`code`/`config`/`configuration`/`import`/
   `imports`/`function`/`read` selects ctx. Otherwise select nothing.

BM25: lowercase ASCII alphanumeric tokens; split punctuation/underscores,
no stemming; remove stopwords `a an and are as at be by do does for from
given how in is it of on or repo s that the this to under what when which
with you your`. Deduplicate query terms. k1=1.2, b=0.75; IDF is
`log(1+(N-df+0.5)/(df+0.5))`. Score the five fixed documents. Keep at
most two with score >=1.0 and >=0.5 times the highest score; break ties
by catalog order. Empty/unrelated input may select zero. `all` always
renders all five descriptions with the existing hint heading.

## Records and scoring

Before calls, save a machine-readable manifest of protocol/catalog,
settings, prompts, selected IDs/scores, runner/code hashes, fixture hashes,
requested model, agy version and matrix. Refuse a nonempty result output.
Preserve stdout and stderr verbatim per attempt, not just extracted answers.
Record process exit/signal/error, envelope status/model/conversation,
complete response, usage (including missing fields), hint bytes and UTF-8
prompt bytes, selected IDs, elapsed time and observed transcript tool counts.
If actual model metadata cannot be observed, label it unknown; requested
model alone is not proof of the serving model.

Factual scoring inspects the complete response, independently of final-line
format. F1 requires the expected integer 8750 (also accept 8,750).
F2 requires a negative comparison and both 2.4.1 and 2.4.0.
Final-line compliance means the last nonempty line starts `ANSWER:` with
nonempty content. Strict correctness applies the factual predicate to that
line's content as well. Process/envelope failures never pass either score.
These are predeclared lexical predicates, not a semantic judge.

Primary cost matches the old study: input + cache-read + output tokens;
missing usage is unknown, never zero. Preserve cache-write separately if
reported. Usage already includes hint overhead: do not add estimated hint
tokens a second time. Report exact prompt/hint bytes, not fake token counts.
Report factual and strict passes, failures, usage/tool coverage, total/mean/
median tokens and elapsed time by mode and task. Pair rules/all and
bm25/all within task/repetition, reporting all six pairs and exclusions.
No success claim from cost alone if accuracy declines. No significance or
generalization claims from six attempts per mode; no estimated dollar
savings without a billing observation. Fixture/plugin contamination and
unknown model/usage coverage must be explicit.

## Gate and execution

Dependency-free ESM consistent with the existing scripts. Focused tests
cover zero/one/two selections, BM25 math/order, lack of ID/answer lookup,
independent scoring, failed/missing usage, paired analysis, and the actual
runner CLI through a deterministic fake agy executable that writes a
faithful JSON envelope. No timed sleeps or real calls in tests.

Lead runs syntax diagnostics, retained CLI tests, analyzer tests and new
tests; inspect the real dry-run surface. One independent implementation
gate must pass before model calls. Check RAM and live agy quota. Run the
18-call pilot under a completion monitor, then publish the paired report
and complete raw artifacts. Update the work ledger, pinned status and
readback before the originating-thread report.
