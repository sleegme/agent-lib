#!/usr/bin/env bash
# test.sh -- exercise ctx, git-snap, log-triage on fixtures under a temp dir.
# Usage: ./test.sh
set -u
cd "$(dirname "$0")/../bin"

pass=0
fail=0

has() { # has <label> <haystack> <needle>
    if [[ $2 == *"$3"* ]]; then
        pass=$((pass + 1)); printf 'ok   %s\n' "$1"
    else
        fail=$((fail + 1)); printf 'FAIL %s -- missing: [%s]\n' "$1" "$3"
    fi
}

hasnt() { # hasnt <label> <haystack> <needle>
    if [[ $2 != *"$3"* ]]; then
        pass=$((pass + 1)); printf 'ok   %s\n' "$1"
    else
        fail=$((fail + 1)); printf 'FAIL %s -- unexpected: [%s]\n' "$1" "$3"
    fi
}

eq() { # eq <label> <actual> <expected>
    if [ "$2" = "$3" ]; then
        pass=$((pass + 1)); printf 'ok   %s\n' "$1"
    else
        fail=$((fail + 1)); printf 'FAIL %s -- got [%s] want [%s]\n' "$1" "$2" "$3"
    fi
}

for s in ctx git-snap log-triage logscan; do
    if [ ! -x "./$s" ]; then
        printf 'error: ./%s missing or not executable\n' "$s" >&2
        exit 2
    fi
done

here=$PWD

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=Test
export GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=Test
export GIT_COMMITTER_EMAIL=test@example.com
export GIT_CEILING_DIRECTORIES="$tmp"

echo '=== ctx ==='
mkdir -p "$tmp/fx"
printf 'one\ntwo\nthree\nfour\nfive\n' > "$tmp/fx/a.txt"

out=$(./ctx "$tmp/fx/a.txt"); rc=$?
eq 'ctx: exit 0' "$rc" 0
has 'ctx: header' "$out" "== $tmp/fx/a.txt (5 lines) =="
has 'ctx: line 1 numbered' "$out" "$(printf '     1\tone')"
has 'ctx: line 5 numbered' "$out" "$(printf '     5\tfive')"

out=$(./ctx "$tmp/fx/a.txt:2-4")
has 'ctx: range start' "$out" "$(printf '     2\ttwo')"
has 'ctx: range end' "$out" "$(printf '     4\tfour')"
hasnt 'ctx: range excludes 1' "$out" "$(printf '     1\tone')"
hasnt 'ctx: range excludes 5' "$out" "$(printf '     5\tfive')"

awk 'BEGIN { for (i = 1; i <= 450; i++) printf "line %03d\n", i }' > "$tmp/fx/big.txt"
out=$(./ctx "$tmp/fx/big.txt")
has 'ctx: truncation note' "$out" '... truncated, 50 more lines'
has 'ctx: line 400 shown' "$out" "$(printf '%6d\t%s' 400 'line 400')"
hasnt 'ctx: line 401 hidden' "$out" 'line 401'
hasnt 'ctx: line 450 hidden' "$out" 'line 450'

out=$(./ctx "$tmp/fx/big.txt:401-450")
has 'ctx: range past cap start' "$out" "$(printf '%6d\t%s' 401 'line 401')"
has 'ctx: range past cap end' "$out" "$(printf '%6d\t%s' 450 'line 450')"
hasnt 'ctx: range past cap truncated note' "$out" 'truncated'

printf 'text\0more\n' > "$tmp/fx/bin.dat"
out=$(./ctx "$tmp/fx/bin.dat"); rc=$?
eq 'ctx: binary exit 0' "$rc" 0
has 'ctx: binary noted' "$out" '(binary file, skipped)'
hasnt 'ctx: binary content hidden' "$out" 'text'

out=$(./ctx "$tmp/fx/nope.txt" "$tmp/fx/a.txt"); rc=$?
eq 'ctx: missing file exit 1' "$rc" 1
has 'ctx: missing reported' "$out" "== $tmp/fx/nope.txt (error: no such file or directory) =="
has 'ctx: continues after missing' "$out" "$(printf '     1\tone')"

: > "$tmp/fx/empty.txt"
out=$(./ctx "$tmp/fx/empty.txt")
has 'ctx: empty file header' "$out" '(0 lines)'

out=$(./ctx --help); rc=$?
eq 'ctx: --help exit 0' "$rc" 0
has 'ctx: --help text' "$out" 'usage: ctx'

out=$(./ctx 2>&1); rc=$?
eq 'ctx: no args exit 2' "$rc" 2

echo
echo '=== git-snap ==='
repo=$tmp/repo
git init -q "$repo"
git -C "$repo" symbolic-ref HEAD refs/heads/main
printf 'hello\n' > "$repo/README.md"
git -C "$repo" add README.md
git -C "$repo" commit -qm 'initial commit'
bare=$tmp/origin.git
git init -q --bare "$bare"
git -C "$repo" remote add origin "$bare"
git -C "$repo" push -qu origin main
git -C "$repo" branch feature/x
printf 'more\n' >> "$repo/README.md"
git -C "$repo" commit -qam 'second commit'
printf 'wip\n' >> "$repo/README.md"
git -C "$repo" stash -q

out=$(cd "$repo" && "$here/git-snap"); rc=$?
eq 'git-snap: default dir exit 0' "$rc" 0
has 'git-snap: repo section' "$out" '## repo'
has 'git-snap: work tree root' "$out" "$repo"
has 'git-snap: branch line' "$out" 'main -> origin/main [ahead 1, behind 0]'
has 'git-snap: status clean' "$out" 'clean'
has 'git-snap: local branch' "$out" 'feature/x'
has 'git-snap: remote branch' "$out" 'origin/main'
has 'git-snap: commits section' "$out" '## commits (last 5)'
has 'git-snap: newest commit' "$out" 'second commit'
has 'git-snap: older commit' "$out" 'initial commit'
has 'git-snap: remotes section' "$out" '## remotes'
has 'git-snap: origin url' "$out" "$bare"
has 'git-snap: stash section' "$out" '## stash'
has 'git-snap: stash count' "$out" '1 entries'

printf 'x\n' > "$repo/untracked.txt"
out=$(./git-snap "$repo")
has 'git-snap: dirty status' "$out" '?? untracked.txt'

i=1
while [ "$i" -le 60 ]; do
    : > "$repo/u$i.txt"
    i=$((i + 1))
done
out=$(./git-snap "$repo")
has 'git-snap: status line cap' "$out" '... 11 more entries (of 61)'
hasnt 'git-snap: status tail hidden' "$out" '?? u60.txt'

mkdir -p "$tmp/notrepo"
out=$(cd "$tmp/notrepo" && "$here/git-snap" 2>&1); rc=$?
eq 'git-snap: outside repo exit 1' "$rc" 1
has 'git-snap: outside repo message' "$out" 'not a git repository'

out=$(./git-snap "$tmp/notrepo" 2>&1); rc=$?
eq 'git-snap: outside repo dir arg exit 1' "$rc" 1

out=$(./git-snap "$tmp/no-such-dir" 2>&1); rc=$?
eq 'git-snap: missing dir exit 1' "$rc" 1
has 'git-snap: missing dir message' "$out" 'no such directory'

out=$(./git-snap --help); rc=$?
eq 'git-snap: --help exit 0' "$rc" 0
has 'git-snap: --help text' "$out" 'usage: git-snap'

echo
echo '=== log-triage ==='
mkdir -p "$tmp/logs" "$tmp/bulk"
awk 'BEGIN { for (i = 1; i <= 50; i++) printf "2026-01-01 %s event %03d\n", (i % 10 == 0 ? "error" : "info"), i }' > "$tmp/logs/app.log"
awk 'BEGIN { for (i = 1; i <= 100; i++) printf "{\"level\":\"%s\",\"user\":{\"id\":\"u%d\"},\"n\":%d}\n", (i % 10 == 0 ? "error" : "info"), (i % 2) + 1, i }' > "$tmp/logs/events.jsonl"
printf 'only line\n' > "$tmp/logs/small.log"
touch -t 202601010101 "$tmp/logs/small.log"
touch -t 202601010102 "$tmp/logs/events.jsonl"
touch -t 202601010103 "$tmp/logs/app.log"

out=$(./log-triage "$tmp/logs"); rc=$?
eq 'log-triage: dir exit 0' "$rc" 0
has 'log-triage: match summary' "$out" 'matched 3 file(s); showing 1 newest'
has 'log-triage: newest file picked' "$out" "== $tmp/logs/app.log ("
has 'log-triage: head section' "$out" '## head (first 20 lines)'
has 'log-triage: tail section' "$out" '## tail (last 20 lines)'
has 'log-triage: first line' "$out" 'info event 001'
has 'log-triage: last line' "$out" 'error event 050'
hasnt 'log-triage: middle omitted' "$out" 'event 030'

out=$(./log-triage "$tmp/logs" --n 2 --grep error --fields level,user.id); rc=$?
eq 'log-triage: --n/--grep/--fields exit 0' "$rc" 0
has 'log-triage: two files shown' "$out" 'showing 2 newest'
has 'log-triage: jsonl section' "$out" '## jsonl'
has 'log-triage: jsonl records' "$out" 'records: 100'
has 'log-triage: field block' "$out" '## field level'
has 'log-triage: field top value' "$out" '  90  info'
has 'log-triage: dotted field block' "$out" '## field user.id'
has 'log-triage: dotted field value' "$out" '  50  u1'
has 'log-triage: grep text log count' "$out" 'matches: 5'
has 'log-triage: grep jsonl count' "$out" 'matches: 10'
has 'log-triage: non-jsonl note' "$out" '(not JSONL; --fields ignored)'

out=$(./log-triage "$tmp/logs/small.log")
has 'log-triage: small file content mode' "$out" '## content (1 line)'
has 'log-triage: small file body' "$out" 'only line'

out=$(./log-triage "$tmp/logs/*.log")
has 'log-triage: glob match count' "$out" 'matched 2 file(s)'
has 'log-triage: glob newest file' "$out" "== $tmp/logs/app.log ("

out=$(./log-triage "$tmp/logs/*.nope" 2>&1); rc=$?
eq 'log-triage: no match exit 1' "$rc" 1
has 'log-triage: no match message' "$out" 'no files matched'

out=$(./log-triage "$tmp/logs/missing.txt" 2>&1); rc=$?
eq 'log-triage: missing path exit 1' "$rc" 1
has 'log-triage: missing path message' "$out" 'no such file or directory'

out=$(./log-triage "$tmp/logs" --n 0 2>&1); rc=$?
eq 'log-triage: --n 0 exit 2' "$rc" 2
out=$(./log-triage "$tmp/logs" --grep '[' 2>&1); rc=$?
eq 'log-triage: bad regex exit 2' "$rc" 2
out=$(./log-triage --help); rc=$?
eq 'log-triage: --help exit 0' "$rc" 0
has 'log-triage: --help text' "$out" 'usage: log-triage'
out=$(./log-triage 2>&1); rc=$?
eq 'log-triage: no args exit 2' "$rc" 2

awk 'BEGIN { for (i = 1; i <= 200000; i++) printf "t %d\n", i }' > "$tmp/bulk/big.log"
out=$(./log-triage "$tmp/bulk/big.log")
has 'log-triage: big text head' "$out" '## head (first 20 lines)'
has 'log-triage: big text first line' "$out" 't 1'
has 'log-triage: big text last line' "$out" 't 200000'
hasnt 'log-triage: big text middle hidden' "$out" 't 100000'

awk 'BEGIN { for (i = 1; i <= 100000; i++) printf "{\"i\":%d}\n", i }' > "$tmp/bulk/big.jsonl"
out=$(./log-triage "$tmp/bulk/big.jsonl" --fields i)
has 'log-triage: bulk jsonl records' "$out" 'records: 100000'
has 'log-triage: bulk jsonl field block' "$out" '## field i'

echo '=== logscan ==='
mkdir -p "$tmp/ls/sub"
printf '%s\n' '{"type":"message","message":{"role":"user","text":"hi"}}' '{"type":"message","message":{"role":"assistant","text":"a1"}}' 'not json' '{"type":"custom","n":3}' > "$tmp/ls/a.jsonl"
printf '%s\n' '{"type":"message","message":{"role":"assistant","text":"a2"}}' > "$tmp/ls/sub/b.jsonl"
out=$(./logscan "$tmp/ls"); rc=$?
eq 'logscan: exit 0' "$rc" 0
has 'logscan: summary' "$out" 'files 2, lines 5, unparsable 1, kept 4'
out=$(./logscan "$tmp/ls" --where message.role=assistant --fields message.text)
has 'logscan: where kept' "$out" 'kept 2'
has 'logscan: dotted field' "$out" 'message.text=a2'
hasnt 'logscan: where filters user' "$out" 'message.text=hi'
out=$(./logscan "$tmp/ls" --count type)
has 'logscan: count' "$out" '      3  message'
out=$(./logscan "$tmp/ls/*.jsonl" --grep custom --fields n)
has 'logscan: glob+grep' "$out" 'kept 1'
has 'logscan: number field' "$out" 'n=3'
out=$(./logscan "$tmp/ls" --last 1 --fields type)
has 'logscan: last 1' "$out" '## last 1 kept records'
out=$(./logscan "$tmp/nothing" 2>&1); rc=$?
eq 'logscan: no match exit 2' "$rc" 2

echo
if [ "$fail" -eq 0 ]; then
    printf 'ALL PASS: %d assertions\n' "$pass"
    exit 0
fi
printf 'FAILURES: %d passed, %d failed\n' "$pass" "$fail"
exit 1
