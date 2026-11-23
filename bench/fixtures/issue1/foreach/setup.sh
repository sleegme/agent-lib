#!/usr/bin/env bash
set -eu
export GIT_AUTHOR_NAME=bench GIT_AUTHOR_EMAIL=bench@example.com GIT_COMMITTER_NAME=bench GIT_COMMITTER_EMAIL=bench@example.com
export GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z'
c() { git add -A && git commit -qm "$1"; };

git init -q -b main .
c 'init fixture'
git update-ref refs/remotes/origin/main HEAD
for i in 02 05 08 11 14 17; do printf 'def broken(:\n' >> src/mod_$i.py; done
for i in 20 22 24 26 28 30; do printf '# tweaked for bench\n' >> src/mod_$i.py; done
export GIT_AUTHOR_DATE='2026-01-02T00:00:00Z' GIT_COMMITTER_DATE='2026-01-02T00:00:00Z'
c 'tweak batch'
