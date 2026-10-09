#!/usr/bin/env bash
# Bringt den Betriebsordner auf den Stand von origin/main und startet das Board neu.
# Aufruf im Betriebsordner: scripts/deploy.sh
# Vorher: Aenderung getestet, nach main gemergt und gepusht.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$PATH"

branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = main ] || { echo "Betriebsordner steht auf $branch statt main." >&2; exit 1; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "Betriebsordner hat lokale Änderungen." >&2; exit 1; }

node scripts/backup.mjs vor-update
before=$(git rev-parse --short HEAD)
git pull --ff-only -q
after=$(git rev-parse --short HEAD)
echo "Stand: $before -> $after"

npm ci --include=dev --no-audit --no-fund --loglevel=error
npm run build --silent
systemctl --user restart ticket-board.service

for _ in $(seq 1 20); do
  sleep 1
  if curl -sf -o /dev/null http://127.0.0.1:8787/api/config; then
    echo "Board läuft wieder ($after)."
    exit 0
  fi
done
echo "Board antwortet nach dem Neustart nicht. journalctl --user -u ticket-board -n 50" >&2
exit 1
