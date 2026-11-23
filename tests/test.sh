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

for s in ctx git-snap change-snap pr-snap runtime-snap service-snap log-triage logscan gate-preflight test-map-snap run-cap repo-map verify recipe ship; do
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

pre_out=$(git show HEAD:bin/git-snap | bash -s -- "$repo")
def_out=$("$here/git-snap" "$repo")
eq 'git-snap: default output unchanged byte-identical' "$def_out" "$pre_out"

git -C "$repo" worktree add -q "$repo-wt" feature/x
printf 'dirty\n' > "$repo-wt/dirty.txt"
wt_out=$("$here/git-snap" "$repo" --worktrees); rc=$?
eq 'git-snap: --worktrees exit 0' "$rc" 0
has 'git-snap: worktrees section' "$wt_out" '## worktrees'
has 'git-snap: main worktree clean' "$wt_out" "$repo [main] clean"
has 'git-snap: second worktree dirty' "$wt_out" "$repo-wt [feature/x] dirty"

# Subscribe before each inspection; stale stat entries force a refresh if the
# tool accidentally allows optional writes. Index timestamps provide a second
# oracle independent of filesystem event delivery.
index_probe() {
    node - "$repo" "$repo-wt" "$@" <<'JS'
const { watch, statSync, utimesSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const [repo, linked, command, ...args] = process.argv.slice(2);
const indexes = [repo, linked].map(dir => execFileSync('git', [
    '-C', dir, 'rev-parse', '--path-format=absolute', '--git-path', 'index',
], { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim());
for (const dir of [repo, linked]) {
    // Prime non-racy stat entries, then change metadata without changing bytes.
    // Otherwise freshly written/smudged index entries make this case intermittent.
    utimesSync(join(dir, 'README.md'), 946684800, 946684800);
    execFileSync('git', ['-C', dir, 'status', '--short'], {
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '1' },
    });
    utimesSync(join(dir, 'README.md'), 978307200, 978307200);
}
for (const index of indexes) utimesSync(index, 915148800, 915148800);
const before = indexes.map(index => statSync(index, { bigint: true }).mtimeNs);
const events = [];
const watchers = indexes.map(index => watch(dirname(index), (event, file) => {
    if (file === 'index' || file === 'index.lock') events.push({ index, event, file });
}));
const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'ignore', 'pipe'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '1', GIT_TRACE2_EVENT: '3' },
    timeout: 10000,
    killSignal: 'SIGKILL',
});
let trace = '';
let output = '';
child.stdio[3].on('data', chunk => { trace += chunk; });
child.stdout.on('data', chunk => { output += chunk; });
child.on('error', error => { throw error; });
child.on('close', exit => {
    watchers.forEach(watcher => watcher.close());
    const indexesUnchanged = indexes.every((index, i) =>
        statSync(index, { bigint: true }).mtimeNs === before[i]);
    const records = trace.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const commands = new Map(records.filter(row => row.event === 'start').map(row => [row.sid, row.argv]));
    const indexWrites = records.filter(row =>
        row.event === 'region_enter' && row.label === 'do_write_index').map(row => commands.get(row.sid));
    console.log(JSON.stringify({ exit, events, indexesUnchanged, indexWrites, output }));
});
JS
}
out=$(index_probe git -C "$repo" status --short); rc=$?
eq 'index probe: control completes' "$rc" 0
has 'index probe: detects control lock creation' "$out" '"file":"index.lock"'
has 'index probe: detects control index refresh' "$out" '"indexesUnchanged":false'
for mode in default worktrees change map; do
    case "$mode" in
        default) out=$(index_probe "$here/git-snap" "$repo") ;;
        worktrees) out=$(index_probe "$here/git-snap" "$repo" --worktrees) ;;
        change) out=$(index_probe "$here/change-snap" "$repo") ;;
        map) out=$(index_probe "$here/test-map-snap" "$repo") ;;
    esac
    rc=$?
    eq "$mode: index probe completes" "$rc" 0
    has "$mode: snapshot succeeds" "$out" '"exit":0'
    has "$mode: no index or index.lock events" "$out" '"events":[]'
    has "$mode: indexes unchanged" "$out" '"indexesUnchanged":true'
    if [ "$mode" = change ]; then
        hasnt 'change: stat-only changes stay out of file lists' "$out" 'README.md'
    fi
    if [[ "$out" != *'"events":[]'* ]] || [[ "$out" != *'"indexesUnchanged":true'* ]]; then
        printf 'index probe details (%s): %s\n' "$mode" "$out"
    fi
done

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
echo '=== change-snap ==='
csrepo=$tmp/csrepo
git init -q "$csrepo"
git -C "$csrepo" symbolic-ref HEAD refs/heads/main
printf 'base content\n' > "$csrepo/file.txt"
printf 'unstaged base\n' > "$csrepo/unstaged.txt"
git -C "$csrepo" add file.txt unstaged.txt
git -C "$csrepo" commit -qm 'base commit'
git -C "$csrepo" branch mybase

printf 'updated content\n' > "$csrepo/file.txt"
git -C "$csrepo" commit -qam 'updated commit'

out=$(./change-snap "$csrepo" --base mybase); rc=$?
eq 'change-snap: --base exit 0' "$rc" 0
has 'change-snap: repo section' "$out" '## repo'
has 'change-snap: repo path' "$out" "$csrepo"
has 'change-snap: range section' "$out" '## range'
has 'change-snap: base range' "$out" 'mybase...HEAD (merge-base '
has 'change-snap: stat section' "$out" '## stat'
has 'change-snap: name-status section' "$out" '## name-status'
has 'change-snap: check clean' "$out" 'clean'

out=$(./change-snap "$csrepo"); rc=$?
eq 'change-snap: without base exit 0' "$rc" 0
has 'change-snap: working tree range' "$out" 'working tree'

printf 'staged content\n' > "$csrepo/staged.txt"
git -C "$csrepo" add staged.txt
printf 'unstaged modified\n' > "$csrepo/unstaged.txt"
out=$(./change-snap "$csrepo"); rc=$?
eq 'change-snap: staged/unstaged exit 0' "$rc" 0
nl=$'\n'
staged_section=$(printf '%s\n' "$out" | sed -n '/^## staged$/{:a; n; /^## /q; p; ba}')
has 'change-snap: staged section header' "$out" '## staged'
has 'change-snap: staged lists staged.txt' "${nl}${staged_section}${nl}" "${nl}staged.txt${nl}"
hasnt 'change-snap: staged excludes unstaged.txt' "${nl}${staged_section}${nl}" "${nl}unstaged.txt${nl}"

unstaged_section=$(printf '%s\n' "$out" | sed -n '/^## unstaged$/{:a; n; /^## /q; p; ba}')
has 'change-snap: unstaged section header' "$out" '## unstaged'
has 'change-snap: unstaged lists unstaged.txt' "${nl}${unstaged_section}${nl}" "${nl}unstaged.txt${nl}"
hasnt 'change-snap: unstaged excludes staged.txt' "${nl}${unstaged_section}${nl}" "${nl}staged.txt${nl}"

check_section=$(printf '%s\n' "$out" | sed -n '/^## check$/{:a; n; /^## /q; p; ba}')
has 'change-snap: check clean reported' "$check_section" 'clean'

printf 'trailing space   \n' >> "$csrepo/unstaged.txt"
out=$(./change-snap "$csrepo"); rc=$?
eq 'change-snap: whitespace findings still exit 0' "$rc" 0
check_section=$(printf '%s\n' "$out" | sed -n '/^## check$/{:a; n; /^## /q; p; ba}')
has 'change-snap: check reports whitespace error' "$check_section" 'trailing whitespace'
hasnt 'change-snap: check not clean with error' "$check_section" 'clean'

awk 'BEGIN { for (i = 1; i <= 20; i++) printf "line %02d\n", i }' > "$csrepo/big.txt"
git -C "$csrepo" add big.txt
out=$(./change-snap "$csrepo" --patch-lines 5)
patch_section=$(printf '%s\n' "$out" | sed -n '/^## patch$/,$p')
has 'change-snap: truncation note' "$patch_section" '... truncated, '
has 'change-snap: truncation note suffix' "$patch_section" ' more lines'

out=$(./change-snap "$tmp/no-such-dir" 2>&1); rc=$?
eq 'change-snap: missing dir exit 1' "$rc" 1
has 'change-snap: missing dir message' "$out" 'no such directory'

mkdir -p "$tmp/notrepo"
out=$(./change-snap "$tmp/notrepo" 2>&1); rc=$?
eq 'change-snap: not git repo exit 1' "$rc" 1
has 'change-snap: not git repo message' "$out" 'not a git repository'

out=$(./change-snap "$csrepo" --base invalid-base-ref 2>&1); rc=$?
eq 'change-snap: merge-base failure exit 1' "$rc" 1
has 'change-snap: merge-base failure message' "$out" 'merge-base'

out=$(./change-snap --help); rc=$?
eq 'change-snap: --help exit 0' "$rc" 0
has 'change-snap: --help text' "$out" 'usage: change-snap'

out=$(./change-snap --bogus-opt 2>&1); rc=$?
eq 'change-snap: unknown option exit 2' "$rc" 2
has 'change-snap: unknown option message' "$out" 'unknown option'

out=$(./change-snap "$csrepo" --patch-lines 0 2>&1); rc=$?
eq 'change-snap: patch-lines 0 exit 2' "$rc" 2

out=$(./change-snap "$csrepo" --patch-lines notanumber 2>&1); rc=$?
eq 'change-snap: patch-lines not number exit 2' "$rc" 2

out=$(./change-snap "$csrepo" extra-arg 2>&1); rc=$?
eq 'change-snap: extra argument exit 2' "$rc" 2
has 'change-snap: extra argument message' "$out" 'unexpected extra argument'

out=$(GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=diff.algorithm GIT_CONFIG_VALUE_0=invalid ./change-snap "$csrepo" 2>&1); rc=$?
eq 'change-snap: invalid Git config exits 1' "$rc" 1
has 'change-snap: invalid Git config reports lookup failure' "$out" 'lookup failed'
hasnt 'change-snap: failed diff never claims clean' "$out" $'## check\nclean'
out=$(./change-snap "$bare" 2>&1); rc=$?
eq 'change-snap: missing worktree exits 1' "$rc" 1
has 'change-snap: missing worktree reports lookup failure' "$out" 'lookup failed'

# Fail each lookup independently so success in an earlier section cannot hide
# a failure in a later one, including diff --check itself.
git_tools="$tmp/git-tools"
mkdir -p "$git_tools"
export REAL_GIT
REAL_GIT=$(command -v git)
cat > "$git_tools/git" <<'SH'
#!/usr/bin/env bash
case " $* " in
    *" $FAIL_GIT_ARGS "*)
        printf 'fixture lookup failure\n' >&2
        exit 128
        ;;
esac
exec "$REAL_GIT" "$@"
SH
chmod +x "$git_tools/git"
for failed_args in 'rev-parse --show-toplevel' 'rev-parse --verify -q HEAD' \
    'merge-base' 'diff --stat' 'diff --name-status' 'diff --check' \
    'diff --cached --name-only' 'diff --name-only' 'diff -p'; do
    base_args=()
    [ "$failed_args" != merge-base ] || base_args=(--base mybase)
    out=$(PATH="$git_tools:$PATH" FAIL_GIT_ARGS="$failed_args" ./change-snap "$csrepo" "${base_args[@]}" 2>&1); rc=$?
    eq "change-snap: $failed_args failure exits 1" "$rc" 1
    has "change-snap: $failed_args failure identified" "$out" "$failed_args lookup failed"
done

echo
echo '=== pr-snap ==='
tools="$tmp/tools"
mkdir -p "$tools"
cat > "$tools/gh" <<'SH'
#!/usr/bin/env bash
set -u
if [ "${FAKE_GH_READONLY:-0}" -eq 1 ] && [ "${GIT_OPTIONAL_LOCKS:-1}" != 0 ]; then
    exit 90
fi
printf '%s\n' "$*" >> "$FAKE_GH_LOG"
case "$*" in
    "pr view "*)
        case "$3" in
            missing) exit 1 ;;
            unauthenticated) printf 'secret auth diagnostic\n' >&2; exit 4 ;;
        esac
        cat "$FAKE_PR_JSON"
        ;;
    "pr checks "*" --json name,state,bucket")
        case "$3" in
            empty) printf '[]\n' ;;
            no-checks) printf 'no checks reported on branch\n' >&2; exit 1 ;;
            checks-error) printf 'private error\n' >&2; exit 1 ;;
            *) printf '[{"name":"lint","state":"SUCCESS","bucket":"pass"},{"name":"unit","state":"FAILURE","bucket":"fail"}]\n'; exit "${FAKE_CHECKS_RC:-1}" ;;
        esac
        ;;
    "pr diff "*" --color never")
        [ "$3" != diff-error ] || exit 1
        printf 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n'
        ;;
    *) printf 'unexpected gh call\n' >&2; exit 2 ;;
esac
SH
chmod +x "$tools/gh"
export FAKE_GH_LOG="$tmp/gh.log"
export FAKE_PR_JSON="$tmp/pr.json"
printf '%s\n' '{"number":7,"title":"Snapshot PR","state":"OPEN","author":{"login":"dev"},"baseRefName":"main","headRefName":"feature/snap","url":"https://example.invalid/pr/7","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":"APPROVED","reviews":[{"author":{"login":"rev"},"state":"APPROVED","body":"Looks good\nprivate second line"}],"files":[{"path":"a","additions":1,"deletions":2}]}' > "$FAKE_PR_JSON"
out=$(PATH="$tools:$PATH" ./pr-snap "$repo" 7 --patch-lines 3); rc=$?
eq 'pr-snap: failed checks still exit 0' "$rc" 0
has 'pr-snap: PR section' "$out" '## pr'
has 'pr-snap: title' "$out" '#7 Snapshot PR'
has 'pr-snap: author' "$out" 'author: dev'
has 'pr-snap: branches' "$out" 'main <- feature/snap'
has 'pr-snap: review decision' "$out" 'reviewDecision: APPROVED'
has 'pr-snap: fixed check fields' "$out" 'unit FAILURE/fail'
has 'pr-snap: review first line' "$out" 'rev APPROVED Looks good'
hasnt 'pr-snap: review excludes second line' "$out" 'private second line'
has 'pr-snap: file counts' "$out" 'a +1 -2'
has 'pr-snap: exact truncation' "$out" '... truncated, 3 more lines'
hasnt 'pr-snap: patch tail hidden' "$out" '+new'
out=$(PATH="$tools:$PATH" GIT_OPTIONAL_LOCKS=1 FAKE_GH_READONLY=1 ./pr-snap "$repo" 7); rc=$?
eq 'pr-snap: all gh children disable optional Git locks' "$rc" 0
out=$(PATH="$tools:$PATH" ./pr-snap "$repo" empty); rc=$?
eq 'pr-snap: empty checks exit 0' "$rc" 0
has 'pr-snap: empty checks noted' "$out" $'## checks\nnone'
has 'pr-snap: complete patch' "$out" '+new'
out=$(cd "$repo" && PATH="$tools:$PATH" "$here/pr-snap" no-checks); rc=$?
eq 'pr-snap: optional repo and no checks exit 0' "$rc" 0
has 'pr-snap: nonzero no checks noted' "$out" $'## checks\nnone'
out=$(PATH="$tools:$PATH" FAKE_CHECKS_RC=8 ./pr-snap "$repo" feature/snap); rc=$?
eq 'pr-snap: pending checks exit 0' "$rc" 0
for pr_case in missing unauthenticated checks-error diff-error; do
    out=$(PATH="$tools:$PATH" ./pr-snap "$repo" "$pr_case" 2>&1); rc=$?
    eq "pr-snap: $pr_case exit 1" "$rc" 1
    has 'pr-snap: lookup failure message' "$out" 'failed'
    hasnt 'pr-snap: diagnostics hidden' "$out" 'secret auth diagnostic'
done
mkdir -p "$tmp/no-gh"
ln -s "$(command -v bash)" "$tmp/no-gh/bash"
out=$(PATH="$tmp/no-gh" ./pr-snap "$repo" 7 2>&1); rc=$?
eq 'pr-snap: missing gh exit 1' "$rc" 1
has 'pr-snap: missing gh message' "$out" 'gh: not found'
out=$(./pr-snap --patch-lines 0 7 2>&1); rc=$?
eq 'pr-snap: invalid patch limit exit 2' "$rc" 2
out=$(./pr-snap --bogus 2>&1); rc=$?
eq 'pr-snap: bad option exit 2' "$rc" 2
out=$(./pr-snap 2>&1); rc=$?
eq 'pr-snap: no args exit 2' "$rc" 2
out=$(./pr-snap --help); rc=$?
eq 'pr-snap: help exit 0' "$rc" 0
has 'pr-snap: help usage' "$out" 'usage: pr-snap'
# Larger file sets must not expand the snapshot without a bound.
python3 -c 'import json,sys; p=json.load(open(sys.argv[1])); p["files"]=[{"path":f"file-{i}","additions":i,"deletions":0} for i in range(51)]; json.dump(p,open(sys.argv[1],"w"))' "$FAKE_PR_JSON"
out=$(PATH="$tools:$PATH" ./pr-snap "$repo" 7)
has 'pr-snap: file 50 shown' "$out" 'file-49 +49 -0'
hasnt 'pr-snap: file 51 hidden' "$out" 'file-50 +50 -0'
has 'pr-snap: file truncation noted' "$out" '... 1 more files'

echo
echo '=== runtime-snap ==='
cat > "$tools/snap-version" <<'SH'
#!/usr/bin/env bash
[ "$#" -eq 1 ] && [ "$1" = --version ] || exit 90
printf 'fixture 1.2.3\nbuild details\nthird line hidden\n'
SH
cat > "$tools/snap-hang" <<'SH'
#!/usr/bin/env bash
[ "$#" -eq 1 ] && [ "$1" = --version ] || exit 90
# Opening a FIFO with no writer blocks without sleeping or polling.
read -r line < "$HANG_FIFO"
SH
cat > "$tools/snap-fail" <<'SH'
#!/usr/bin/env bash
printf 'unsupported --version\n' >&2
exit 3
SH
chmod +x "$tools/snap-version" "$tools/snap-hang" "$tools/snap-fail"
ln -s "$tools/snap-version" "$tools/snap-link"
mkfifo "$tmp/hang.fifo"
out=$(PATH="$tools:$PATH" ./runtime-snap snap-link snap-version); rc=$?
eq 'runtime-snap: fixtures exit 0' "$rc" 0
has 'runtime-snap: command section' "$out" '## snap-link'
has 'runtime-snap: resolved path' "$out" "path: $tools/snap-link"
has 'runtime-snap: symlink target' "$out" "target: $tools/snap-version"
has 'runtime-snap: version shown' "$out" 'fixture 1.2.3'
has 'runtime-snap: second line shown' "$out" 'build details'
hasnt 'runtime-snap: third line hidden' "$out" 'third line hidden'
out=$(PATH="$tools:$PATH" ./runtime-snap snap-command-does-not-exist snap-version); rc=$?
eq 'runtime-snap: missing command exit 1' "$rc" 1
has 'runtime-snap: missing noted' "$out" $'## snap-command-does-not-exist\nnot found'
has 'runtime-snap: continues after missing' "$out" 'fixture 1.2.3'
# The outer deadline makes a regression in the internal timeout fail fast too.
out=$(PATH="$tools:$PATH" HANG_FIFO="$tmp/hang.fifo" RUNTIME_SNAP_TIMEOUT_SECONDS=1 timeout --kill-after=1s 3s ./runtime-snap snap-hang); rc=$?
eq 'runtime-snap: hanging command exit 1' "$rc" 1
has 'runtime-snap: bounded hang noted' "$out" 'timed out after 1s'
out=$(PATH="$tools:$PATH" ./runtime-snap snap-fail); rc=$?
eq 'runtime-snap: failed version exit 1' "$rc" 1
has 'runtime-snap: failure status' "$out" 'version failed (exit 3)'
out=$(./runtime-snap 2>&1); rc=$?
eq 'runtime-snap: no args exit 2' "$rc" 2
out=$(./runtime-snap --bogus 2>&1); rc=$?
eq 'runtime-snap: unknown option exit 2' "$rc" 2
out=$(RUNTIME_SNAP_TIMEOUT_SECONDS=0 ./runtime-snap node 2>&1); rc=$?
eq 'runtime-snap: invalid timeout exit 2' "$rc" 2
out=$(./runtime-snap --help); rc=$?
eq 'runtime-snap: help exit 0' "$rc" 0
has 'runtime-snap: help usage' "$out" 'usage: runtime-snap'

echo
echo '=== service-snap ==='
cat > "$tools/systemctl" <<'SH'
#!/usr/bin/env bash
set -u
printf 'systemctl %s\n' "$*" >> "$FAKE_SERVICE_LOG"
[ "${1:-}" != --user ] || shift
action=$1
unit=${!#}
case "$action" in
    show)
        case "$unit" in
            missing.service) printf 'LoadState=not-found\nActiveState=inactive\n'; exit 0 ;;
            lookup-error.service) exit 1 ;;
            failed.service) state=failed; sub=failed; pid=0; code=1 ;;
            *) state=active; sub=running; pid=123; code=0 ;;
        esac
        printf 'LoadState=loaded\nActiveState=%s\nSubState=%s\nMainPID=%s\nExecMainStatus=%s\nActiveEnterTimestamp=Wed 2026-10-28 10:00:00 UTC\nNRestarts=2\n' "$state" "$sub" "$pid" "$code"
        ;;
    status)
        printf 'status for %s\n' "$unit"
        for ((i=2; i<=20; i++)); do printf 'status-line-%02d\n' "$i"; done
        [ "$unit" != failed.service ] || exit 3
        ;;
    *) printf 'unexpected systemctl action\n' >&2; exit 90 ;;
esac
SH
cat > "$tools/journalctl" <<'SH'
#!/usr/bin/env bash
set -u
printf 'journalctl %s\n' "$*" >> "$FAKE_SERVICE_LOG"
case "$*" in
    *journal-error.service*) exit 1 ;;
    *empty.service*) exit 0 ;;
esac
for ((i=1; i<=45; i++)); do printf 'journal-line-%02d\n' "$i"; done
SH
chmod +x "$tools/systemctl" "$tools/journalctl"
export FAKE_SERVICE_LOG="$tmp/service.log"
out=$(PATH="$tools:$PATH" ./service-snap active.service); rc=$?
eq 'service-snap: active exit 0' "$rc" 0
has 'service-snap: unit section' "$out" $'## unit\nactive.service'
has 'service-snap: active state' "$out" 'ActiveState=active'
has 'service-snap: substate' "$out" 'SubState=running'
has 'service-snap: PID' "$out" 'MainPID=123'
has 'service-snap: main exit status' "$out" 'ExecMainStatus=0'
has 'service-snap: activation time' "$out" 'ActiveEnterTimestamp=Wed 2026-10-28'
has 'service-snap: restart count' "$out" 'NRestarts=2'
hasnt 'service-snap: lookup-only property hidden' "$out" 'LoadState='
has 'service-snap: status line 15 shown' "$out" 'status-line-15'
hasnt 'service-snap: status line 16 hidden' "$out" 'status-line-16'
has 'service-snap: default journal last 40' "$out" 'journal-line-06'
hasnt 'service-snap: default journal earlier hidden' "$out" 'journal-line-05'
has 'service-snap: journal last line' "$out" 'journal-line-45'
calls=$(< "$FAKE_SERVICE_LOG")
has 'service-snap: default relative since' "$calls" 'journalctl -u active.service --since -10m --no-pager --lines 40'
: > "$FAKE_SERVICE_LOG"
out=$(PATH="$tools:$PATH" ./service-snap --user failed.service --since '1 hour ago' --lines 2); rc=$?
eq 'service-snap: failed unit snapshot exit 0' "$rc" 0
has 'service-snap: failed state' "$out" 'ActiveState=failed'
has 'service-snap: failed exit code' "$out" 'ExecMainStatus=1'
has 'service-snap: custom journal tail' "$out" $'journal-line-44\njournal-line-45'
hasnt 'service-snap: custom journal excludes earlier' "$out" 'journal-line-43'
calls=$(< "$FAKE_SERVICE_LOG")
has 'service-snap: user show flag' "$calls" 'systemctl --user show --property=LoadState,ActiveState,SubState,MainPID,ExecMainStatus,ActiveEnterTimestamp,NRestarts -- failed.service'
has 'service-snap: user status flag' "$calls" 'systemctl --user status --no-pager -- failed.service'
has 'service-snap: user journal and since' "$calls" 'journalctl --user -u failed.service --since 1 hour ago --no-pager --lines 2'
for service_case in missing lookup-error journal-error; do
    out=$(PATH="$tools:$PATH" ./service-snap "$service_case.service" 2>&1); rc=$?
    eq "service-snap: $service_case exit 1" "$rc" 1
done
out=$(PATH="$tools:$PATH" ./service-snap empty.service); rc=$?
eq 'service-snap: empty journal exit 0' "$rc" 0
has 'service-snap: empty journal noted' "$out" $'## journal\nnone'
out=$(./service-snap active.service --lines 0 2>&1); rc=$?
eq 'service-snap: invalid line count exit 2' "$rc" 2
out=$(./service-snap active.service --since 2>&1); rc=$?
eq 'service-snap: missing since value exit 2' "$rc" 2
out=$(./service-snap active.service extra.service 2>&1); rc=$?
eq 'service-snap: extra unit exit 2' "$rc" 2
out=$(./service-snap --bogus 2>&1); rc=$?
eq 'service-snap: bad option exit 2' "$rc" 2
out=$(./service-snap 2>&1); rc=$?
eq 'service-snap: no unit exit 2' "$rc" 2
out=$(./service-snap --help); rc=$?
eq 'service-snap: help exit 0' "$rc" 0
has 'service-snap: help usage' "$out" 'usage: service-snap'

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

echo '=== gate-preflight ==='
gp="$tmp/gp"; mkdir -p "$gp/plugin" "$gp/node_modules/x"
printf '2.4.0\n' > "$gp/VERSION"
printf '{"name":"p","version":"2.4.1"}' > "$gp/package.json"
printf '{"version":"9.9.9"}' > "$gp/node_modules/x/package.json"
printf '[project]\nname="p"\nversion = "2.4.0"\n' > "$gp/pyproject.toml"
printf '{"version":"2.4.0"}' > "$gp/plugin/plugin.json"
git -C "$gp" init -q -b main && git -C "$gp" add -A && git -C "$gp" commit -qm init && git -C "$gp" tag v2.4.0
out=$(./gate-preflight "$gp"); rc=$?
eq 'gate-preflight: mismatch exit 1' "$rc" 1
has 'gate-preflight: mismatch verdict' "$out" 'MISMATCH 2.4.0 vs 2.4.1'
has 'gate-preflight: package.json read' "$out" 'package.json'
has 'gate-preflight: plugin manifest read' "$out" 'plugin/plugin.json'
hasnt 'gate-preflight: node_modules skipped' "$out" '9.9.9'
has 'gate-preflight: tag at head' "$out" 'tags    v2.4.0'
has 'gate-preflight: branch' "$out" 'branch  main'
printf '{"name":"p","version":"2.4.0"}' > "$gp/package.json"
out=$(./gate-preflight "$gp"); rc=$?
eq 'gate-preflight: match exit 0' "$rc" 0
has 'gate-preflight: match verdict' "$out" 'MATCH 2.4.0'
has 'gate-preflight: dirty count' "$out" 'dirty   1 file(s)'

echo
echo '=== test-map-snap ==='
tmrepo=$tmp/tmrepo
git init -q "$tmrepo"
git -C "$tmrepo" symbolic-ref HEAD refs/heads/main
mkdir -p "$tmrepo/src/lib" "$tmrepo/tests/lib" "$tmrepo/tests/deep"
printf 'export function engine() { return 1 }\n' > "$tmrepo/src/lib/engine.mjs"
printf 'export function parse() { return 1 }\n' > "$tmrepo/src/parser.js"
printf '// mirror file, no source text\n' > "$tmrepo/tests/lib/engine.mjs"
printf 'import { engine } from "../../src/lib/engine.mjs"\ntest("engine one", () => {})\ntest("engine two", () => {})\nit("engine three", () => {})\n' > "$tmrepo/tests/deep/engine-reference.test.mjs"
printf 'import { parse } from "../src/parser.js"\ntest("parse", () => {})\n' > "$tmrepo/tests/parser.test.js"
i=1
while [ "$i" -le 10 ]; do
    name=$(printf '%02d' "$i")
    printf '// engine reference %s\ntest("extra %s", () => {})\n' "$name" "$name" > "$tmrepo/tests/zz-extra-$name.test.mjs"
    i=$((i + 1))
done
cat > "$tmrepo/package.json" <<'JSON'
{
  "name": "tm",
  "scripts": {
    "test": "node --test tests/*.js",
    "test:unit": "node --test tests/**/*.js",
    "build": "true"
  }
}
JSON
printf 'test:\n\t@echo declared tests\n' > "$tmrepo/Makefile"
printf 'fixture readme\n' > "$tmrepo/README.md"
git -C "$tmrepo" add -A
git -C "$tmrepo" commit -qm 'fixture base'
git -C "$tmrepo" branch baseline
printf 'export function engine() { return 2 }\n' > "$tmrepo/src/lib/engine.mjs"
printf 'export function extra() { return 1 }\n' > "$tmrepo/src/lib/extra.mjs"
git -C "$tmrepo" add -A
git -C "$tmrepo" commit -qm 'engine update'
printf 'export function parse() { return 2 }\n' > "$tmrepo/src/parser.js"
printf 'notes\n' > "$tmrepo/notes.txt"

tms_section() { printf '%s\n' "$1" | sed -n "/^## $2\$/{:a; n; /^## /q; p; ba}"; }

out=$(./test-map-snap "$tmrepo"); rc=$?
eq 'test-map-snap: default exit 0' "$rc" 0
has 'test-map-snap: repo section' "$out" '## repo'
has 'test-map-snap: repo path' "$out" "$tmrepo"
changed=$(tms_section "$out" 'changed files')
has 'test-map-snap: default source' "$changed" 'source: HEAD -> working tree (including untracked)'
has 'test-map-snap: default lists unstaged change' "$changed" 'src/parser.js'
has 'test-map-snap: default lists untracked file' "$changed" 'notes.txt'
hasnt 'test-map-snap: default excludes clean commit' "$changed" 'src/lib/engine.mjs'

out=$(./test-map-snap "$tmrepo" --files src/lib/engine.mjs); rc=$?
eq 'test-map-snap: --files exit 0' "$rc" 0
changed=$(tms_section "$out" 'changed files')
has 'test-map-snap: --files source' "$changed" 'source: --files (repo-relative)'
has 'test-map-snap: --files input echoed' "$changed" 'src/lib/engine.mjs'
candidates=$(tms_section "$out" 'candidate tests')
has 'test-map-snap: mirror-dir match' "$candidates" 'tests/lib/engine.mjs [mirror]'
has 'test-map-snap: reference match' "$candidates" 'tests/deep/engine-reference.test.mjs [reference]'
has 'test-map-snap: candidate cap note' "$candidates" '... truncated, 2 more candidate tests (10 unique test limit)'
hasnt 'test-map-snap: candidate cap hides later match' "$candidates" 'tests/zz-extra-10.test.mjs'

out=$(./test-map-snap "$tmrepo" --files src/parser.js)
candidates=$(tms_section "$out" 'candidate tests')
has 'test-map-snap: naming-convention match' "$candidates" 'tests/parser.test.js [naming]'

out=$(./test-map-snap "$tmrepo" --base baseline); rc=$?
eq 'test-map-snap: --base exit 0' "$rc" 0
changed=$(tms_section "$out" 'changed files')
has 'test-map-snap: --base source' "$changed" 'source: baseline -> working tree (including untracked)'
has 'test-map-snap: --base includes committed change' "$changed" 'src/lib/engine.mjs'
has 'test-map-snap: --base includes committed addition' "$changed" 'src/lib/extra.mjs'
has 'test-map-snap: --base includes unstaged change' "$changed" 'src/parser.js'
has 'test-map-snap: --base includes untracked file' "$changed" 'notes.txt'

out=$(./test-map-snap "$tmrepo" --files src/lib/engine.mjs --lines 1); rc=$?
eq 'test-map-snap: --lines exit 0' "$rc" 0
names=$(tms_section "$out" 'test names')
has 'test-map-snap: name excerpt first line' "$names" 'test("engine one", () => {})'
hasnt 'test-map-snap: name excerpt second line hidden' "$names" 'test("engine two", () => {})'
has 'test-map-snap: name excerpt truncation note' "$names" '... truncated, 2 more lines'

out=$(./test-map-snap "$tmrepo" --files src/parser.js)
has 'test-map-snap: declared package.json header' "$out" '### package.json (declared text; not executed)'
has 'test-map-snap: declared package.json test' "$out" '"test": "node --test tests/*.js"'
has 'test-map-snap: declared Makefile header' "$out" '### Makefile (declared text; not executed)'
has 'test-map-snap: declared Makefile target' "$out" '1:test:'

mkdir -p "$tmp/tm-notrepo"
out=$(./test-map-snap "$tmp/tm-notrepo" 2>&1); rc=$?
eq 'test-map-snap: non-repo exit 1' "$rc" 1
has 'test-map-snap: non-repo message' "$out" 'not a git repository'

# gate regressions: renames keep the old path, binary files are skipped,
# a configured fsmonitor hook never runs.
tm2="$tmp/tm-gate"
mkdir -p "$tm2/src" "$tm2/tests"
git -C "$tm2" init -q
git -C "$tm2" config user.email t@t; git -C "$tm2" config user.name t
printf 'export const x = 1;\n' > "$tm2/src/old.js"
printf 'import "../src/old.js";\ntest("legacy uses old", () => {})\n' > "$tm2/tests/legacy.test.js"
git -C "$tm2" add -A; git -C "$tm2" commit -qm init
git -C "$tm2" mv src/old.js src/new.js
printf '\000test("binary is not a test", () => {})\n' > "$tm2/tests/new.test.js"
printf '#!/bin/sh\ntouch "%s/fsmonitor-ran"\nexit 1\n' "$tmp" > "$tmp/fsmon.sh"; chmod +x "$tmp/fsmon.sh"
git -C "$tm2" config core.fsmonitor "$tmp/fsmon.sh"
out=$(./test-map-snap "$tm2"); rc=$?
eq 'test-map-snap: gate fixture exit 0' "$rc" 0
has 'test-map-snap: rename keeps old path' "$out" 'src/old.js'
has 'test-map-snap: rename keeps new path' "$out" 'src/new.js'
has 'test-map-snap: rename old-path test found' "$out" 'tests/legacy.test.js'
hasnt 'test-map-snap: binary file not excerpted' "$out" 'binary is not a test'
[ -e "$tmp/fsmonitor-ran" ] && ran=yes || ran=no
eq 'test-map-snap: fsmonitor hook not executed' "$ran" no
out=$(./test-map-snap "$tmp/tm-no-such-dir" 2>&1); rc=$?
eq 'test-map-snap: missing dir exit 1' "$rc" 1
has 'test-map-snap: missing dir message' "$out" 'no such directory'
out=$(./test-map-snap "$tmrepo" --lines 0 2>&1); rc=$?
eq 'test-map-snap: --lines 0 exit 2' "$rc" 2
out=$(./test-map-snap "$tmrepo" --files ../escape 2>&1); rc=$?
eq 'test-map-snap: escaping --files exit 2' "$rc" 2
out=$(./test-map-snap --bogus 2>&1); rc=$?
eq 'test-map-snap: unknown option exit 2' "$rc" 2
out=$(./test-map-snap --help); rc=$?
eq 'test-map-snap: --help exit 0' "$rc" 0
has 'test-map-snap: --help text' "$out" 'usage: test-map-snap'

map_src=$(< ./test-map-snap)
has 'test-map-snap: disables optional locks' "$map_src" 'GIT_OPTIONAL_LOCKS=0'
has 'test-map-snap: disables stat refresh' "$map_src" 'diff.autoRefreshIndex=false'
hasnt 'test-map-snap: no mktemp' "$map_src" 'mktemp'
hasnt 'test-map-snap: no GIT_INDEX_FILE' "$map_src" 'GIT_INDEX_FILE'

mkdir -p "$tmp/tm-tmpdir"
tmp_before=$(ls -A /tmp | sort)
repo_before=$(cd "$tmrepo" && find . -mindepth 1 | sort)
index_before=$(stat -c '%y:%s' "$tmrepo/.git/index")
out=$(TMPDIR="$tmp/tm-tmpdir" ./test-map-snap "$tmrepo"); rc=$?
eq 'test-map-snap: read-only run exit 0' "$rc" 0
eq 'test-map-snap: TMPDIR left empty' "$(find "$tmp/tm-tmpdir" -mindepth 1)" ''
eq 'test-map-snap: repo tree unchanged' "$(cd "$tmrepo" && find . -mindepth 1 | sort)" "$repo_before"
eq 'test-map-snap: index unchanged' "$(stat -c '%y:%s' "$tmrepo/.git/index")" "$index_before"
eq 'test-map-snap: /tmp top level unchanged' "$(ls -A /tmp | sort)" "$tmp_before"

echo
echo '=== run-cap ==='
cap="$tmp/capture"
cap_log() { printf '%s\n' "${1##*$'\n'full log: }"; }

out=$(./run-cap --dir "$cap" -- sh -c 'printf "stdout\n"; printf "stderr\n" >&2; printf "last"'); rc=$?
eq 'run-cap: success exit preserved' "$rc" 0
has 'run-cap: summary status' "$out" 'exit 0'
has 'run-cap: unterminated line counted' "$out" '3 lines'
printf 'stdout\nstderr\nlast' > "$tmp/cap-expected"
cmp -s "$tmp/cap-expected" "$(cap_log "$out")"; rc=$?
eq 'run-cap: combined log byte exact and ordered' "$rc" 0

out=$(./run-cap --dir "$cap" -- sh -c 'printf "broken\n"; exit 23'); rc=$?
eq 'run-cap: failure exit preserved' "$rc" 23
has 'run-cap: failure status printed' "$out" 'exit 23'

# Each runner's result must survive even when the tail is disabled.
out=$(./run-cap --dir "$cap" --tail 0 -- printf '# tests 9\n# pass 6\n# fail 2\n# skipped 1\n')
has 'run-cap: TAP counters recognized' "$out" 'result: # tests 9 | # pass 6 | # fail 2 | # skipped 1'
out=$(./run-cap --dir "$cap" --tail 0 -- printf '=== 2 failed, 7 passed, 1 skipped in 0.02s ===\n')
has 'run-cap: pytest result recognized' "$out" 'result: === 2 failed, 7 passed, 1 skipped in 0.02s ==='
out=$(./run-cap --dir "$cap" --tail 0 -- printf 'ok  example/one 0.02s\nFAIL example/two 0.03s\n')
has 'run-cap: go results recognized' "$out" 'result: ok  example/one 0.02s | FAIL example/two 0.03s'
out=$(./run-cap --dir "$cap" --tail 0 -- printf 'test result: ok. 4 passed; 0 failed; 1 ignored;\n')
has 'run-cap: cargo result recognized' "$out" 'result: test result: ok. 4 passed; 0 failed; 1 ignored;'
out=$(./run-cap --dir "$cap" --tail 0 -- printf 'Test Suites: 1 failed, 2 passed, 3 total\nTests: 2 failed, 8 passed, 10 total\n')
has 'run-cap: jest result recognized' "$out" 'result: Test Suites: 1 failed, 2 passed, 3 total | Tests: 2 failed, 8 passed, 10 total'
out=$(./run-cap --dir "$cap" --tail 0 -- printf ' Test Files  1 failed | 2 passed (3)\n      Tests  2 failed | 8 passed (10)\n')
has 'run-cap: vitest result recognized' "$out" 'result: Test Files  1 failed | 2 passed (3) | Tests  2 failed | 8 passed (10)'

out=$(./run-cap --dir "$cap" --tail 0 -- sh -c '
    for marker in "not ok 1" "FAILED case" "Error: broken" "error: compile" "Traceback (most recent call last):"; do
        printf "%s\ncontext one\ncontext two\n" "$marker"
    done
    printf "Error: broken\nError: extra one\nError: extra two\n"
')
eq 'run-cap: five failure excerpts maximum' "$(printf '%s\n' "$out" | grep -c '^failure:')" 5
eq 'run-cap: repeated failure deduped' "$(printf '%s\n' "$out" | grep -c '^failure: Error: broken')" 1
has 'run-cap: two context lines included' "$out" 'failure: not ok 1 | context one | context two'
has 'run-cap: omitted matches counted' "$out" '2 more failure matches omitted'
hasnt 'run-cap: excess failure excerpt hidden' "$out" 'failure: Error: extra'

out=$(./run-cap --dir "$cap" --tail 2 -- printf 'first\nsecond\nthird\nfourth\n')
has 'run-cap: requested tail included' "$out" $'third\nfourth'
hasnt 'run-cap: earlier tail line excluded' "$out" 'second'
out=$(./run-cap --dir "$cap" --tail 0 -- printf 'hidden\n')
hasnt 'run-cap: zero tail hides output' "$out" 'hidden'
out=$(./run-cap --dir "$cap" -- sh -c 'i=1; while [ "$i" -le 12 ]; do printf "line %s\n" "$i"; i=$((i+1)); done')
has 'run-cap: default tail starts at last ten' "$out" $'\nline 3\n'
hasnt 'run-cap: default tail hides earlier lines' "$out" $'\nline 2\n'
eq 'run-cap: no live output echoed' "$(printf '%s\n' "$out" | grep -c '^line 12$')" 1

mkdir -p "$tmp/cap-work"
out=$(cd "$tmp/cap-work" && env -u RUN_CAP_DIR "$here/run-cap" -- printf 'local\n')
has 'run-cap: default log inside current workspace' "$(cap_log "$out")" "$tmp/cap-work/.cap/"
out=$(RUN_CAP_DIR="$tmp/cap-env" ./run-cap -- printf 'env\n')
has 'run-cap: environment directory selected' "$(cap_log "$out")" "$tmp/cap-env/"
out=$(RUN_CAP_DIR="$tmp/cap-env" ./run-cap --dir "$tmp/cap-override" -- printf 'override\n')
has 'run-cap: explicit directory overrides environment' "$(cap_log "$out")" "$tmp/cap-override/"

out=$(./run-cap --dir "$cap" -- run-cap-no-such-command-48391); rc=$?
eq 'run-cap: missing command exits 127' "$rc" 127
has 'run-cap: missing command diagnostic' "$out" 'command not found: run-cap-no-such-command-48391'
out=$(./run-cap --dir "$cap" -- sh -c 'kill -TERM $$'); rc=$?
eq 'run-cap: signaled command exits 143' "$rc" 143
has 'run-cap: signal reported' "$out" 'signal SIGTERM'
# The child signals its wrapper only after installing its own handler.
# No sleeps or readiness polling are needed to exercise forwarding.
out=$(./run-cap --dir "$cap" -- python3 -c '
import os, signal
signal.signal(signal.SIGTERM, lambda *_: os._exit(42))
os.kill(os.getppid(), signal.SIGTERM)
signal.pause()
'); rc=$?
eq 'run-cap: wrapper forwards signal and preserves handled exit' "$rc" 42
has 'run-cap: forwarded signal reported' "$out" 'signal SIGTERM'

out=$(./run-cap --dir "$cap" -- printf 'nul\0bytes\nunterminated')
has 'run-cap: summary strips NUL only' "$out" $'nulbytes\nunterminated'
# $(...) drops NULs itself, so count NUL bytes in a byte-preserving capture.
nuls=$(./run-cap --dir "$cap" -- printf 'nul\0bytes\nunterminated' | tr -cd '\000' | wc -c)
eq 'run-cap: raw summary stdout has no NUL bytes' "$nuls" 0
printf 'nul\0bytes\nunterminated' > "$tmp/cap-binary"
cmp -s "$tmp/cap-binary" "$(cap_log "$out")"; rc=$?
eq 'run-cap: binary log byte exact' "$rc" 0
out=$(./run-cap --dir "$cap" --tail 0 -- printf '')
has 'run-cap: empty log has zero lines' "$out" '0 lines'
out=$(./run-cap --dir "$cap" -- printf '%s\n' 'literal $(exit 9) * ; spaced argument')
has 'run-cap: arguments are not shell interpreted' "$out" 'literal $(exit 9) * ; spaced argument'

# Exercise many lines, omitted failures, and a single oversized physical line.
out=$(./run-cap --dir "$cap" -- python3 -c '
import sys
for i in range(10000):
    sys.stdout.write("Error: item %d\ncontext one\ncontext two\n" % i)
sys.stdout.write("x" * 200000 + "\nend")
')
has 'run-cap: huge output counted by physical lines' "$out" '30002 lines'
has 'run-cap: huge output omission count' "$out" '9995 more failure matches omitted'
summary_lines=$(printf '%s\n' "$out" | wc -l)
[ "$summary_lines" -le 20 ] && bounded=yes || bounded=no
eq 'run-cap: default summary bounded to twenty lines' "$bounded" yes
[ "${#out}" -lt 8000 ] && bounded=yes || bounded=no
eq 'run-cap: summary clips oversized lines' "$bounded" yes
python3 - "$(cap_log "$out")" <<'PY'
import sys
with open(sys.argv[1], "rb") as log:
    for i in range(10000):
        assert log.readline() == b"Error: item %d\n" % i
        assert log.readline() == b"context one\n"
        assert log.readline() == b"context two\n"
    assert log.read() == b"x" * 200000 + b"\nend"
PY
eq 'run-cap: huge log byte exact' "$?" 0

# Freeze the naming clock: the two invocations must share a second.
python3 - "$here/run-cap" "$cap" <<'PY'
import contextlib
import datetime
import io
import runpy
import sys
namespace = runpy.run_path(sys.argv[1])
main = namespace["main"]
class Frozen:
    @staticmethod
    def now(tz):
        return datetime.datetime(2026, 1, 2, 3, 4, 5, tzinfo=tz)
main.__globals__["datetime"] = Frozen
directory = sys.argv[2]
paths = []
for value in ("first", "second"):
    sys.argv = ["run-cap", "--dir", directory, "--", "printf", value]
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        assert main() == 0
    path = output.getvalue().split("full log: ", 1)[1].strip()
    assert "/20260102T030405Z-printf-" in path
    paths.append(path)
assert paths[0] != paths[1]
for path, value in zip(paths, (b"first", b"second")):
    with open(path, "rb") as log:
        assert log.read() == value
PY
eq 'run-cap: same-second runs never overwrite' "$?" 0

out=$(./run-cap --tail -1 -- printf unused 2>&1); rc=$?
eq 'run-cap: negative tail rejected' "$rc" 2
out=$(./run-cap --dir 2>&1); rc=$?
eq 'run-cap: missing directory argument rejected' "$rc" 2
out=$(./run-cap -- 2>&1); rc=$?
eq 'run-cap: missing command rejected' "$rc" 2
out=$(./run-cap --help); rc=$?
eq 'run-cap: help exits zero' "$rc" 0
has 'run-cap: help usage' "$out" 'usage: run-cap'

out=$(./run-cap --dir "$tmp/rc-spec" -- sh -c 'printf "\342\204\271 tests 5\n\342\204\271 pass 5\n\342\204\271 fail 0\n"'); rc=$?
eq 'run-cap: node spec reporter exit 0' "$rc" 0
has 'run-cap: node spec reporter result line' "$out" 'result: ℹ tests 5'
out=$(./run-cap --dir "$tmp/rc-dedup" -- sh -c 'echo "not ok 1 - boom"; echo "  Error: bad"; exit 3'); rc=$?
eq 'run-cap: dedup exit 3' "$rc" 3
n=$(printf '%s\n' "$out" | grep -c '^failure:')
eq 'run-cap: context line not repeated as its own excerpt' "$n" 1

echo
echo '=== repo-map ==='
rmfx=$tmp/rmfx
mkdir -p "$rmfx/src/lib" "$rmfx/tools" "$rmfx/tests" "$rmfx/docs" "$rmfx/node_modules/pkg"
cat > "$rmfx/package.json" <<'EOF'
{
  "name": "mixtool",
  "version": "1.2.0",
  "main": "src/index.js",
  "scripts": {
    "test": "node --test tests/",
    "lint": "node tools/lint.js"
  }
}
EOF
echo 'module.exports = 1;' > "$rmfx/src/index.js"
echo 'module.exports = 2;' > "$rmfx/src/lib/a.js"
test_js="$rmfx/tests/smoke.test.js"
printf "const test = require('node:test');\ntest('smoke', () => {});\n" > "$test_js"
printf 'TABLE = {i: i * i for i in range(10)}\n' > "$rmfx/tools/gen.py"
printf '[project]\nname = "mixtool-py"\nversion = "3.1.4"\n' > "$rmfx/pyproject.toml"
echo 'skip me' > "$rmfx/node_modules/pkg/index.js"
echo '# mixtool' > "$rmfx/README.md"

out=$(./repo-map "$rmfx"); rc=$?
eq 'repo-map: exit 0' "$rc" 0
has 'repo-map: repo section' "$out" '## repo'
has 'repo-map: tree section' "$out" '## tree'
has 'repo-map: dir line' "$out" 'src/'
has 'repo-map: file line' "$out" '- index.js'
hasnt 'repo-map: node_modules skipped' "$out" 'node_modules'
has 'repo-map: languages section' "$out" '## languages'
has 'repo-map: js count' "$out" ' .js: 3'
has 'repo-map: py count' "$out" ' .py: 1'
has 'repo-map: package.json manifest' "$out" 'package.json name=mixtool version=1.2.0'
has 'repo-map: test script' "$out" 'npm run test -> node --test tests/'
has 'repo-map: main field' "$out" 'main: src/index.js'
has 'repo-map: pyproject head' "$out" 'version = "3.1.4"'

awk 'BEGIN { for (i = 1; i <= 200; i++) printf "f%03d\n", i }' | while IFS= read -r f; do
    : > "$rmfx/many_$f.txt"
done
out=$(./repo-map "$rmfx")
has 'repo-map: truncation note' "$out" 'more entries'
n=$(printf '%s\n' "$out" | grep -c '^- ')
if [ "$n" -le 121 ]; then
    pass=$((pass + 1)); printf 'ok   repo-map: tree bounded\n'
else
    fail=$((fail + 1)); printf 'FAIL repo-map: tree bounded -- got %s file lines\n' "$n"
fi
rm -rf "$rmfx/many_"*.txt

out=$(./repo-map "$tmp/nope" 2>&1); rc=$?
eq 'repo-map: missing dir exit 1' "$rc" 1
has 'repo-map: missing dir message' "$out" 'not a directory'
out=$(./repo-map --help); rc=$?
eq 'repo-map: --help exit 0' "$rc" 0
has 'repo-map: --help usage' "$out" 'usage: repo-map'
out=$(./repo-map a b 2>&1); rc=$?
eq 'repo-map: two args exit 2' "$rc" 2

echo
echo '=== verify ==='
vfx=$tmp/vfx
mkdir -p "$vfx/tests" "$vfx/src" "$vfx/tools"
cat > "$vfx/package.json" <<'EOF'
{
  "name": "vfix",
  "version": "0.1.0",
  "scripts": {
    "test": "node --test tests/",
    "lint": "node tools/lint.js"
  }
}
EOF
cat > "$vfx/tests/core.test.js" <<'EOF'
const test = require('node:test');
const assert = require('node:assert');
test('adds numbers', () => assert.equal(1 + 1, 2));
test('multiplies numbers', () => assert.equal(2 * 3, 7));
EOF
cat > "$vfx/tools/lint.js" <<'EOF'
const fs = require('fs');
const path = require('path');
let bad = 0;
const walk = p => {
  const st = fs.statSync(p);
  if (st.isDirectory()) fs.readdirSync(p).sort().forEach(e => walk(path.join(p, e)));
  else if (p.endsWith('.js')) fs.readFileSync(p, 'utf8').split('\n').forEach((l, i) => {
    if (l.includes('console.log')) { bad++; console.log('Lint issue in ' + path.relative(process.cwd(), p)); }
  });
};
walk('src');
process.exit(bad ? 1 : 0);
EOF
echo "module.exports = { ok: () => 'fine' };" > "$vfx/src/clean.js"
printf "module.exports = { dump: () => {\n  console.log('dumping');\n} };\n" > "$vfx/src/debug.js"

out=$(./verify "$vfx"); rc=$?
eq 'verify: failing fixture exit 1' "$rc" 1
has 'verify: failing test named' "$out" 'test: FAIL -> multiplies numbers'
if printf '%s\n' "$out" | grep -q 'adds numbers'; then
    fail=$((fail + 1)); printf 'FAIL verify: passing test leaked into verdict\n'
else
    pass=$((pass + 1)); printf 'ok   verify: passing test not in verdict\n'
fi
has 'verify: lint failure named' "$out" 'lint: FAIL -> src/debug.js'
if printf '%s\n' "$out" | grep -q 'clean.js'; then
    fail=$((fail + 1)); printf 'FAIL verify: clean file wrongly flagged\n'
else
    pass=$((pass + 1)); printf 'ok   verify: clean file not flagged\n'
fi
printf "module.exports = { dump: () => 'quiet' };\n" > "$vfx/src/debug.js"
sed -i "s/assert.equal(2 \* 3, 7)/assert.equal(2 * 3, 6)/" "$vfx/tests/core.test.js"
out=$(./verify "$vfx"); rc=$?
eq 'verify: green fixture exit 0' "$rc" 0
has 'verify: test pass line' "$out" 'test: PASS'
has 'verify: lint pass line' "$out" 'lint: PASS'

mkfx=$tmp/vf-make
mkdir -p "$mkfx"
printf 'test:\n\t@echo all good\n' > "$mkfx/Makefile"
out=$(./verify "$mkfx"); rc=$?
eq 'verify: makefile discovery exit 0' "$rc" 0
has 'verify: makefile check pass' "$out" 'test: PASS'

empty=$tmp/vf-empty
mkdir -p "$empty"
out=$(./verify "$empty" 2>&1); rc=$?
eq 'verify: no checks exit 2' "$rc" 2
has 'verify: no checks message' "$out" 'no test/lint/build commands discovered'
out=$(./verify "$tmp/nope" 2>&1); rc=$?
eq 'verify: missing dir exit 1' "$rc" 1
out=$(./verify --help); rc=$?
eq 'verify: --help exit 0' "$rc" 0
has 'verify: --help usage' "$out" 'usage: verify'

echo
echo '=== recipe ==='
rcpfx=$tmp/rcpfx
mkdir -p "$rcpfx/.agent-lib/recipes"
printf '# demo recipe\necho hello $who\necho second step\nfalse\n' > "$rcpfx/.agent-lib/recipes/demo.recipe"
printf 'echo $a-$b\n' > "$rcpfx/.agent-lib/recipes/two.recipe"

out=$( (cd "$rcpfx" && "$here/recipe" run demo who=world --dry-run) ); rc=$?
eq 'recipe: dry-run exit 0' "$rc" 0
has 'recipe: dry line substituted' "$out" '1. DRY   echo hello world'
if printf '%s\n' "$out" | grep -q 'PASS'; then
    fail=$((fail + 1)); printf 'FAIL recipe: dry-run ran commands\n'
else
    pass=$((pass + 1)); printf 'ok   recipe: dry-run executes nothing\n'
fi

out=$( (cd "$rcpfx" && "$here/recipe" run two a=x b=y) ); rc=$?
eq 'recipe: two params exit 0' "$rc" 0
has 'recipe: both params substituted' "$out" '1. PASS  echo x-y'
has 'recipe: step output surfaced' "$out" 'out: x-y'

out=$( (cd "$rcpfx" && "$here/recipe" run demo who=world) ); rc=$?
eq 'recipe: failing third step exit 1' "$rc" 1
has 'recipe: first step passes' "$out" '1. PASS  echo hello world'
has 'recipe: second step passes' "$out" '2. PASS  echo second step'
has 'recipe: third step fails' "$out" '3. FAIL  false'

out=$( (cd "$rcpfx" && "$here/recipe" run nosuch) 2>&1); rc=$?
eq 'recipe: unknown recipe exit 2' "$rc" 2
has 'recipe: unknown recipe message' "$out" 'no such recipe: nosuch'
out=$( (cd "$rcpfx" && "$here/recipe" demo) 2>&1); rc=$?
eq 'recipe: missing run keyword exit 2' "$rc" 2
out=$( (cd "$rcpfx" && "$here/recipe" --help) ); rc=$?
eq 'recipe: --help exit 0' "$rc" 0
has 'recipe: --help usage' "$out" 'usage: recipe run'
out=$( (cd "$tmp" && "$here/recipe" run demo who=world) 2>&1); rc=$?
eq 'recipe: no recipe dir exit 2' "$rc" 2

echo
echo '=== ship ==='
spfx=$tmp/spfx
mkdir -p "$spfx/tests"
cat > "$spfx/package.json" <<'EOF'
{
  "name": "shipfix",
  "version": "2.4.1",
  "scripts": { "test": "node --test tests/" }
}
EOF
echo '2.4.0' > "$spfx/VERSION"
printf '# Changelog\n\n## 2.4.0\n\n- fixes\n' > "$spfx/CHANGELOG.md"
cat > "$spfx/tests/unit.test.js" <<'EOF'
const test = require('node:test');
const assert = require('node:assert');
test('formats output', () => assert.equal(2, 3));
EOF
echo '# shipfix' > "$spfx/README.md"
git init -q "$spfx"
git -C "$spfx" symbolic-ref HEAD refs/heads/main
git -C "$spfx" add -A
git -C "$spfx" commit -qm 'chore: release prep state'
printf '\n<!-- late note -->\n' >> "$spfx/README.md"

before_dirty=$(git -C "$spfx" status --porcelain | wc -l)
out=$(./ship --plan "$spfx"); rc=$?
eq 'ship: no-go exit 1' "$rc" 1
has 'ship: version mismatch detail' "$out" 'version: MISMATCH (VERSION=2.4.0 package.json=2.4.1)'
has 'ship: changelog gap' "$out" 'changelog: no entry for 2.4.1'
has 'ship: failing check named' "$out" 'test: FAIL -> formats output'
has 'ship: dirty tree counted' "$out" 'tree: DIRTY (1 changed/untracked)'
eq 'ship: no-go reason list' "$(printf '%s\n' "$out" | tail -1)" 'NO-GO: version-mismatch, changelog-missing-entry, test-fail, dirty-tree'
after_dirty=$(git -C "$spfx" status --porcelain | wc -l)
eq 'ship: plan does not mutate tree' "$after_dirty" "$before_dirty"
eq 'ship: plan creates no tags' "$(git -C "$spfx" tag | wc -l)" 0

spgo=$tmp/spgo
mkdir -p "$spgo/tests"
cat > "$spgo/package.json" <<'EOF'
{
  "name": "shipgo",
  "version": "1.0.0",
  "scripts": { "test": "node --test tests/" }
}
EOF
printf '# Changelog\n\n## 1.0.0\n\n- initial\n' > "$spgo/CHANGELOG.md"
cat > "$spgo/tests/unit.test.js" <<'EOF'
const test = require('node:test');
const assert = require('node:assert');
test('loads', () => assert.ok(true));
EOF
git init -q "$spgo"
git -C "$spgo" symbolic-ref HEAD refs/heads/main
git -C "$spgo" add -A
git -C "$spgo" commit -qm 'release ready'

out=$(./ship --plan "$spgo"); rc=$?
eq 'ship: go exit 0' "$rc" 0
has 'ship: version match' "$out" 'version: MATCH (1.0.0)'
has 'ship: changelog present' "$out" 'changelog: entry for 1.0.0 present'
has 'ship: checks pass' "$out" 'test: PASS'
has 'ship: clean tree' "$out" 'tree: clean'
eq 'ship: go line' "$(printf '%s\n' "$out" | tail -1)" 'GO: all checks passed'

out=$(./ship "$spgo" 2>&1); rc=$?
eq 'ship: without --plan exit 2' "$rc" 2
out=$(./ship --help); rc=$?
eq 'ship: --help exit 0' "$rc" 0
has 'ship: --help usage' "$out" 'usage: ship --plan'
out=$(./ship --plan "$tmp/nope" 2>&1); rc=$?
eq 'ship: missing dir exit 1' "$rc" 1

echo
if [ "$fail" -eq 0 ]; then
    printf 'ALL PASS: %d assertions\n' "$pass"
    exit 0
fi
printf 'FAILURES: %d passed, %d failed\n' "$pass" "$fail"
exit 1
