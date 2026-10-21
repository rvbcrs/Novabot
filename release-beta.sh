#!/bin/bash
# release-beta.sh — let GitHub build the pushed code of this branch and push it
# to rvbcrs/opennova:beta (.github/workflows/docker.yml).
#
# A moving "beta" channel for the latest stuff to test on a beta device, WITHOUT
# touching production: no version, no tag, no :latest. Nothing is built or
# started on this machine. The workflow runs the server tests first.
#
#   Beta device:  image: rvbcrs/opennova:beta   (then `docker compose pull && up -d`)
#   Promote a good beta to production: ./release.sh
set -e
cd "$(dirname "$0")"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
SHA=$(git rev-parse HEAD)
git fetch -q origin "$BRANCH"
if [ "$SHA" != "$(git rev-parse "origin/$BRANCH")" ]; then
  echo "ERROR: push $BRANCH first; GitHub builds the beta from what is on GitHub." >&2
  exit 1
fi

gh workflow run docker.yml --ref "$BRANCH"
echo "GitHub builds rvbcrs/opennova:beta from $BRANCH (${SHA:0:8})..."
RUN_ID=""
for _ in $(seq 1 30); do
  sleep 5
  RUN_ID=$(gh run list --workflow docker.yml --event workflow_dispatch --branch "$BRANCH" --limit 5 \
    --json databaseId,headSha -q "map(select(.headSha == \"$SHA\")) | .[0].databaseId // empty" 2>/dev/null || true)
  [ -n "$RUN_ID" ] && break
done
if [ -z "$RUN_ID" ]; then
  echo "ERROR: the beta run did not show up; see https://github.com/rvbcrs/Novabot/actions" >&2
  exit 1
fi
gh run watch "$RUN_ID" --exit-status --interval 30

echo ""
echo "Pushed rvbcrs/opennova:beta"
echo "Beta device pulls :beta. Promote when good: ./release.sh"
