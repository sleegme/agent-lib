#!/usr/bin/env bash
set -eu
export GIT_AUTHOR_NAME=bench GIT_AUTHOR_EMAIL=bench@example.com GIT_COMMITTER_NAME=bench GIT_COMMITTER_EMAIL=bench@example.com
export GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z'
c() { git add -A && git commit -qm "$1"; };

git init -q -b main .
git add README.md config.json src/app.js .gitignore && git commit -qm 'chore: initial layout'
git add src/util.js && git commit -qm 'feat: add util helpers'
git checkout -q -b feature/limits
git commit -q --allow-empty -m 'feat: raise limit ceiling'
git commit -q --allow-empty -m 'fix: adjust rate limits'
git update-ref refs/remotes/origin/main HEAD~2
printf '\n// local tweak\n' >> src/app.js
printf '\n// local tweak\n' >> src/util.js
echo 'scratch notes' > notes.txt
