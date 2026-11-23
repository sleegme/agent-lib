// Experiment definitions for the issue #1 shortlist: questions, tool hints,
// and answer-key checkers shared by the runner and the regrade script.
// The checkers accept natural model phrasings: a key failure in the first
// rep showed models answering correctly in substance ("Tests pass",
// "lint flags nothing") while a rigid "test: pass" pattern rejected them.
export const has = (hay, ...needles) => needles.every(n => hay.toLowerCase().includes(n));

export const TAIL = '\nDo not modify, create, or delete any files. End your reply with a final line: ANSWER: <answer>';

export const EXPS = {
  foreach: {
    fixture: 'foreach',
    q: 'Run a Python syntax check (python3 -m py_compile) on each .py file under src/ that differs from origin/main. Which of those files FAIL the check? Report the failing file paths only.',
    hint: 'A helper command is available on PATH:\n- foreach --base REF --glob G -- CMD {}   (runs CMD once per file that differs from REF and matches G; prints only the failures)',
    check: a => {
      const want = ['src/mod_02.py', 'src/mod_05.py', 'src/mod_08.py', 'src/mod_11.py', 'src/mod_14.py', 'src/mod_17.py'];
      const clean = ['mod_20', 'mod_22', 'mod_24', 'mod_26', 'mod_28', 'mod_30'];
      return want.every(f => a.includes(f)) && !clean.some(m => a.includes(m));
    },
  },
  run_cap: {
    fixture: 'hugeout',
    q: 'Run ./run-checks.sh in this repo (it executes a check suite). How many checks fail in total, and what is the id of the FIRST failing check?',
    hint: 'A helper command is available on PATH:\n- run-cap -- CMD ARGS   (runs the command, keeps the full log on disk, prints a bounded summary with failure excerpts; use it instead of running the command directly)',
    check: a => /check-?0?103\b/i.test(a) && /\b5\b/.test(a),
  },
  repo_map: {
    fixture: 'repomap',
    q: 'You are seeing this repository for the first time. Report: the primary language, the exact test command the repo declares, and the main entrypoint file.',
    hint: 'A helper command is available on PATH:\n- repo-map   (one-shot repo briefing: structure, languages, declared scripts, entrypoints)',
    check: a => /javascript/i.test(a) && a.includes('node --test tests/') && a.includes('src/index.js'),
  },
  git_review: {
    fixture: 'gitreview',
    q: 'Review the current git state of this repo. Report: the checked-out branch, how many commits it is ahead and behind origin/main, how many tracked files have uncommitted modifications, how many untracked files exist, and the subject of the latest commit.',
    hint: 'Helper commands are available on PATH:\n- git-snap   (branch, ahead/behind, status, recent commits in one call)\n- change-snap   (diff stat, name-status, staged/unstaged, bounded patch in one call)',
    check: a => has(a, 'feature/limits') && /\b2\b/.test(a) && /\b0\b/.test(a) && has(a, 'fix: adjust rate limits')
      && (a.match(/\bmodified\b[^.]*?\b2\b/i) || a.match(/\b2\b[^.]*?\bmodified\b/i)) !== null
      && (a.match(/\buntracked\b[^.]*?\b1\b/i) || a.match(/\b1\b[^.]*?\buntracked\b/i)) !== null,
  },
  verify: {
    fixture: 'verify',
    q: "Run this repo's test and lint checks. Do they pass? If not, name each FAILING test and each lint-failing file.",
    hint: 'A helper command is available on PATH:\n- verify   (discovers and runs the declared test/lint/build checks, prints one compact verdict with failing names)',
    check: a => ['multiplies numbers', 'parses config', 'appends file', 'src/debug.js'].every(s => a.includes(s)),
  },
  recipe: {
    fixture: 'recipe',
    q: "Produce a status report for the module named 'alpha': (1) do its tests pass? (2) does lint flag any of its files? (3) what is the subject line of its most recent commit?",
    hint: 'A helper command is available on PATH:\n- recipe run module-report module=NAME   (saved multi-step operation in .agent-lib/recipes/; runs the module test, lint, and last-commit lookup, prints compact results)',
    check: a => /tests?\b[^.|\n]{0,60}?\b(?:pass(?:ed|ing)?|2\s*\/\s*2|all\s+\S+\s+pass)/i.test(a)
      && /lint\b[^.|\n]{0,80}?\b(?:clean|pass(?:ed|ing)?|ok|flags?\s+(?:nothing|no)\b|no\s+(?:issues|lint\s+issues|files\s+flagged)|0\s+issues)/i.test(a)
      && a.includes('feat: add alpha module'),
  },
  ship_plan: {
    fixture: 'ship',
    q: 'Plan the release of the current version of this repo (dry-run only: do not tag, commit, publish or deploy anything). Check: (1) version consistency across the declared version files, (2) whether CHANGELOG.md has an entry for the current version, (3) whether tests pass, (4) whether the working tree is clean. Would you GO or NO-GO? List every failed check.',
    hint: 'A helper command is available on PATH:\n- ship --plan   (release preflight in one call: versions, changelog coverage, checks, tree cleanliness, GO/NO-GO; never mutates anything)',
    check: a => /no-go/i.test(a) && has(a, 'version', '2.4.1', '2.4.0') && /changelog/i.test(a) && /test/i.test(a) && /dirty|clean|tree/i.test(a),
  },
};
