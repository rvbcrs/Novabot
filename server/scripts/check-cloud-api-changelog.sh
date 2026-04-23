#!/usr/bin/env bash
# Block commits that touch server/src/cloud-api/ without updating its CHANGELOG.md.
# Frozen cloud-api tree — shape/value changes are a contract decision that
# must be visible in the CHANGELOG.
set -e

changed=$(git diff --cached --name-only)
touches_cloud_api=$(echo "$changed" | grep -E '^server/src/cloud-api/' || true)
touches_changelog=$(echo "$changed" | grep -E '^server/src/cloud-api/CHANGELOG\.md$' || true)

if [ -n "$touches_cloud_api" ] && [ -z "$touches_changelog" ]; then
  echo "ERROR: Changes under server/src/cloud-api/ require a CHANGELOG entry."
  echo "Add a dated entry to server/src/cloud-api/CHANGELOG.md before committing."
  exit 1
fi
exit 0
