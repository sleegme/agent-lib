#!/usr/bin/env bash
# Redact personal absolute paths from issue1 raw logs and records.
# Usage: bash bench/issue1-redact.sh
# Replaces /home/<user> and $HOME references in bench/results/issue1/raw/*.log
# and bench/results/issue1/*.jsonl (in place). Idempotent.
set -eu
cd "$(dirname "$0")/.."
U="$(id -un)"
H="/home/$U"

for f in bench/results/issue1/raw/*.log bench/results/issue1/*.jsonl; do
  [ -f "$f" ] || continue
  sed -i "s|$H|[HOME]|g; s|/home/[a-z0-9_-]*|[HOME]|g" "$f"
done
echo "redaction done; remaining /home mentions:"
grep -rl '/home/' bench/results/issue1/ 2>/dev/null || echo "(none)"
