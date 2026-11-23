# A/B measurement: agent-lib bundled tools on agy

Two studies on `agy -p` with `gemini-3.8-flash-medium`, October 27 2026, host `archlinux`.
Arms: **A** baseline · **R** rtk hook only (rtk-oss 1.1.0, project-scoped in the fixture
copy, no global config touched) · **T** agent-lib tools hinted in the prompt · **RT** both.
Fixture: `~/work/agent-lib-bench/{plain,rtk}`, an 8-file repo plus logs, git history
`feature/limits` 2 ahead of `origin/main`, deliberate version mismatch
(package.json 2.4.1 vs VERSION 2.4.0).

## Main study — 8 tasks x 4 arms x 4 reps = 128 runs

Integrity: 128 unique task/arm/rep cells, 0 non-SUCCESS runs, 0 token-sum mismatches,
128 distinct conversation ids. Tokens = input + cache_read + output (cache_read was 0
throughout: one-shot agy sessions don't build a cache).

| arm | factual correct | strict final-line passes | median tokens | mean tokens | tool calls/run |
|---|---:|---:|---:|---:|---:|
| A  | 32/32* | 28/32 | 53.1k | 63.8k      | 3.75 |
| R  | 32/32* | 28/32 | 54.1k | 62.8k (-1.7%) | 3.69 |
| T  | 32/32* | 32/32 | 54.0k | 50.6k (-20.7%) | 2.72 |
| RT | 32/32* | 32/32 | 54.4k | 46.3k (-27.5%) | 2.34 |

*Factual correctness rescored from full final responses (recorded in
`bench/results/main-f2-rescore.json`): every F2 "wrong" mark in A/R was a grading artifact
— the final `ANSWER: no` line omitted the versions the body had already stated correctly.
Strict passes differ only in final-line completeness, not factual accuracy.

Per-task medians (A → T): F1 125.5k→63.2k (RT 56.0k), F3 80.1k→53.9k, G1 52.7k→26.6k,
G2 66.4k→54.3k, L1 103.2k→82.1k (RT 75.6k), L2 40.1k→54.0k (RT 34.1k). Exceptions:
F2 cost MORE with tools (A 32.7k → T 54.0k; a two-file question is cheaper to answer by
just reading both files than by running gate-preflight); X1 (trivial PONG) parity
12.7k–13.1k, i.e. hint overhead ≤ ~0.4k tokens.

Bundled tool usage: T/RT actually called the tools (T: ctx 8, git-snap 8, log-triage 8,
logscan 4, gate-preflight 4 across 32 runs).

## Calculator calibration — N1/N5 x 4 arms x 2 reps = 16 runs

All arms 4/4 correct at ~26.3k–27.4k median tokens. Nobody called `calc` even when
hinted; the model delegated arithmetic to a single `python3 -c` instead. On this model
the calculator hint is pure overhead (~+0.5–1.1k): drop it from the default hint set.

The calculator and unused Python wrapper were subsequently removed from the
toolkit. Calibration records remain historical evidence; reproducing the
calculator-specific harness requires the pre-cleanup revision `d971013`.
The current harness runs the eight main-study tasks only.

## Caveats

- One model, one fixture, 4 reps: directional only. Means are dominated by the heavy
  tasks; medians across arms are flat (~53–54k).
- rtk's savings are measured at their floor here: the fixture's command outputs are tiny
  (rtk gain reported ~6.8% on intercepted commands), so R-arm deltas are uninformative,
  not negative evidence about rtk on large outputs.
- The global `native-gravity` agy plugin was installed for all arms alike.
- Tool hints contain absolute paths to this checkout; the prompt delta itself costs
  tokens (see X1), included in T/RT totals.
- Correctness on these 8 tasks does not measure judgment; tool-value here is round-trip
  and token reduction plus final-answer completeness.

## Reproduce

    ARMS=A,R,T,RT REPS=4 OUTF=results.jsonl node bench/ab.mjs
    node bench/summarize.mjs results.jsonl            # or --json
    node --test tests/benchmark.test.mjs              # analyzer invariants

Raw runs: `bench/results/main-results.jsonl`, `bench/results/calc-results.jsonl`.
