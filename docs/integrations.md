# Integrating agent-lib with agents

The tools are plain CLIs: no daemon, no config, read-only apart from
run-cap's log directory. To make an agent prefer them over multi-step shell
probing, paste a short block into its instruction file and trim the list to
the tools you actually install.

## Claude Code

Append to `CLAUDE.md` (repo root, or `~/.claude/CLAUDE.md` for global):

```markdown
## One-call snapshot tools (prefer over multi-step shell probing)

- `git-snap [dir] [--worktrees]` — branch/ahead-behind/status/recent commits/stash in one call
- `change-snap [repo] [--base REF]` — diff stat, name-status, whitespace check, staged/unstaged, bounded patch
- `pr-snap [repo] <pr|branch>` — PR checks/reviews/changed files plus a bounded diff
- `runtime-snap <cmd>...` — PATH resolution, symlink targets, bounded --version probes
- `service-snap [--user] <unit>` — systemd unit state and recent journal, read-only
- `log-triage <dir-or-glob> [--grep RE] [--fields k]` — newest log summary and JSONL field counts
- `logscan <file|dir|glob>...` — filter/count/extract JSONL in one call
- `gate-preflight [repo]` — every declared version with MATCH/MISMATCH plus git state
- `test-map-snap [repo]` — tests related to changed files; static, never runs them
- `run-cap [--] cmd args...` — capture long output, print a bounded summary, keep the full log
- `ctx <file>... [file:A-B]` — several files with line numbers, bounded

All are read-only except run-cap's log dir. Prefer them over chained
ls/head/git/gh round-trips.
```

The same body works as a skill: save it as
`.claude/skills/agent-lib/SKILL.md` with YAML front matter:

```markdown
---
name: agent-lib
description: One-call snapshot tools (git-snap, change-snap, pr-snap, run-cap, ...) that replace multi-step shell probing
---
```

followed by the tool list above.

## OpenAI Codex CLI

Append to `AGENTS.md` in the repo root:

```markdown
## Shell tool policy

Prefer the one-call snapshot tools over multi-step probing: git-snap,
change-snap, pr-snap, runtime-snap, service-snap, log-triage, logscan,
gate-preflight, test-map-snap, run-cap, ctx. Each prints a bounded,
sectioned summary and is read-only (except run-cap's log dir). Run
`<tool> --help` once for exact flags.
```

## OpenCode

Put the same `AGENTS.md` block in the repo root, or globally in
`~/.config/opencode/AGENTS.md`. As a project rule, create
`.opencode/rule/agent-lib.md`:

```markdown
Prefer the agent-lib one-call tools (git-snap, change-snap, pr-snap,
log-triage, logscan, run-cap, ...) over chained shell round-trips; each is
read-only, bounded and safe to run without confirmation.
```

## Any agent with a shell

Paste into the system prompt or instruction file:

```text
When you need repository, PR, log or environment state, prefer these
one-call tools over multiple shell round-trips. They print bounded,
sectioned output and change nothing (except run-cap, which writes a log
dir): git-snap, change-snap, pr-snap, runtime-snap, service-snap,
log-triage, logscan, gate-preflight, test-map-snap, ctx. For long test or
build output: run-cap -- <command>. Run <tool> --help for exact usage.
```
