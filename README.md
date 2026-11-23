# agent-lib

Bundled tools that cut agent token use: each tool does in one call what an
agent usually spends several round-trips on.

| Tool | Replaces |
|---|---|
| `bin/ctx <file>... [file:A-B]` | several `view_file` calls; prints files with line numbers, bounded |
| `bin/git-snap [dir]` | `git status` / `branch` / `log` / ahead-behind reconnaissance |
| `bin/git-snap [dir] --worktrees` | `git worktree list` / per-worktree branch or detached HEAD / dirty-state reconnaissance |
| `bin/change-snap [repo] [--base REF] [--patch-lines N]` | diff stat / name-status / whitespace check / staged and unstaged files / bounded patch |
| `bin/pr-snap [repo] <pr-number|branch> [--patch-lines N]` | `gh pr view` / checks / reviews / changed files / bounded PR diff |
| `bin/runtime-snap <cmd>...` | PATH lookup / resolved symlinks / bounded `--version` probes |
| `bin/service-snap [--user] <unit> [--since TIME] [--lines N]` | `systemctl show` / status / recent journal; read-only, bounded |
| `bin/log-triage <dir-or-glob> [--grep RE] [--fields a,b]` | `ls` → `head` → `python -c` log probing |
| `bin/logscan <file|dir|glob>... [--where k=v] [--count k] [--fields a,b] [--grep RE]` | chains of `python3 -c` JSONL/transcript extraction one-liners |
| `bin/gate-preflight [repo]` | `cat VERSION` / `jq .version` / `git log -1` / tag checks; prints every declared version, MATCH or MISMATCH (exit 1), and git state |
| `bin/test-map-snap [repo] [--base REF] [--files a,b] [--lines N]` | `ls`/`find` test globs / `grep` for test references / bounded test-name excerpts; static and read-only, never runs tests |
| `bin/run-cap [--tail N] [--dir PATH] [--] cmd args...` | large test/build/log output in the conversation; saves the full combined log and prints a bounded summary, preserving the command's exit code |

`run-cap` executes arguments directly (use `sh -c` explicitly for shell syntax).
Logs go to `--dir`, then `$RUN_CAP_DIR`, then `./.cap/` in the current directory.
Add `.cap/` to your own repo's `.gitignore`. Each log has a UTC timestamp,
sanitized command name and unique suffix; existing logs are never overwritten.
Python 3 is required. The default summary is at most 19 lines: status/duration/
line count, recognized test results, up to five deduplicated failure excerpts
(each joined with two following context lines), an omitted-match count, the last
10 lines and the full log path. `--tail 0` disables the tail; larger values expand
it. Summary lines are clipped to 240 characters (960 for the combined result
line); only the first 4096 non-NUL bytes of each physical line are scanned.
The on-disk log is always byte-exact, including binary output and missing final
newlines. Signals are forwarded to the command's process group and reported;
signal termination exits with `128 + signal`.

## Install

This is release 0.1.0 of @sleegme/agent-lib (MIT).

Runtime requirements: bash and coreutils everywhere; git for `git-snap`,
`change-snap`, `pr-snap` and `test-map-snap`; python3 for `logscan`,
`gate-preflight` and `run-cap`; the GitHub CLI (`gh`) for `pr-snap`;
systemd (`systemctl`, `journalctl`) for `service-snap`.

npm:

    npm i -g @sleegme/agent-lib

bun:

    bun add -g @sleegme/agent-lib

One-off, no global install (once the package is published):

    npx -p @sleegme/agent-lib git-snap
    bunx --package @sleegme/agent-lib git-snap

From a checkout:

    git clone https://github.com/sleegme/agent-lib
    export PATH="$PWD/agent-lib/bin:$PATH"

Every command lands on PATH (`ctx`, `git-snap`, `change-snap`, ...). See
[docs/integrations.md](docs/integrations.md) for ready-to-paste instruction
snippets for Claude Code, Codex CLI, OpenCode and any shell-capable agent.

## Why

The 128-run A/B study on gemini-3.8-flash-medium measured 20.7% fewer mean
tokens with these tools hinted, or 27.5% fewer with rtk as well. Factual
accuracy was equal across arms; final-answer completeness improved.
One model and one fixture: directional evidence, not a universal saving.
See [bench/RESULTS.md](bench/RESULTS.md) for task-level exceptions and raw data.

The unused calculator and thin Python subprocess wrapper were removed.
The study measured the five commands that existed at the time (`ctx`,
`git-snap`, `log-triage`, `logscan`, `gate-preflight`); all five were
actually used by the model in the study runs. The newer tools
(`change-snap`, `pr-snap`, `runtime-snap`, `service-snap`, `test-map-snap`,
`run-cap`, `git-snap --worktrees`) were added afterwards and are covered by
the regression suite instead. Historical calculator measurements remain in
`bench/results/` as evidence.

## Tests

    bash tests/test.sh
    node --test tests/

The node command runs every suite in tests/ (`benchmark.test.mjs`,
`hints.test.mjs`, `hint-pilot.test.mjs`).

## License

MIT. See the [LICENSE](LICENSE) file.
