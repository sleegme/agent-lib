#!/usr/bin/env bash
set -eu
export GIT_AUTHOR_NAME=bench GIT_AUTHOR_EMAIL=bench@example.com GIT_COMMITTER_NAME=bench GIT_COMMITTER_EMAIL=bench@example.com
export GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z'
c() { git add -A && git commit -qm "$1"; };

git init -q -b main .
git add src/modules/beta tools package.json README.md .gitignore .agent-lib
git commit -qm 'feat: add beta module'
git add src/modules/alpha
git commit -qm 'feat: add alpha module'
git add src/modules/gamma
git commit -qm 'feat: add gamma module'
