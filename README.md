# agent-lib

Bundled tools that cut agent token use: each tool does in one call what an
agent usually spends several round-trips on.

| Tool | Replaces |
|---|---|
| `bin/ctx <file>... [file:A-B]` | several `view_file` calls; prints files with line numbers, bounded |
| `bin/git-snap [dir]` | `git status` / `branch` / `log` / ahead-behind reconnaissance |
| `bin/log-triage <dir-or-glob> [--grep RE] [--fields a,b]` | `ls` → `head` → `python -c` log probing |
| `bin/logscan <file|dir|glob>... [--where k=v] [--count k] [--fields a,b] [--grep RE]` | chains of `python3 -c` JSONL/transcript extraction one-liners |
| `calc/ntg-calc 'x=...; y=...; x+y'` | exact arithmetic in one call (`make -C calc`) |
| `python/wf.py` | call the tools above from one Python script |

## Why

From the NTG calculator experiment (agy, gemini-3.8-flash-medium, Oct 2026):
the model rarely computed anything itself; the gains came from bundling.
With these tools hinted in the prompt, a two-file version check went from
wrong in every run to 4/4 correct, and several tasks used 20-40% fewer
input+cache tokens. Small sample, one model: directional evidence.

## Tests

    bash tests/test.sh      # ctx, git-snap, log-triage (97 assertions)
    make -C calc test       # calculator (90 assertions)
