#!/bin/bash
# Release script: bump patch version, build + push Docker image
set -e

cd "$(dirname "$0")"

# Version = date.time (e.g. 2026.0410.1523)
NEW=$(date +"%Y.%m%d.%H%M")
echo "Version: $NEW"

# Update package.json
CURRENT=$(node -p "require('./server/package.json').version")
sed -i '' "s/\"version\": \"$CURRENT\"/\"version\": \"$NEW\"/" server/package.json

# Commit version bump
git add server/package.json
git commit -m "release: v$NEW"
git tag "v$NEW"
git push && git push --tags

# Build + push multi-platform Docker image (amd64 + arm64)
echo "Building Docker image (amd64 + arm64)..."
docker buildx build --platform linux/amd64,linux/arm64 \
  --builder multiplatform-builder \
  -t "rvbcrs/opennova:latest" \
  -t "rvbcrs/opennova:$NEW" \
  --push --no-cache .

# Restart local container with new image
echo "Restarting local container..."
docker compose down 2>/dev/null
docker compose up -d 2>/dev/null

echo ""
echo "Released v$NEW"
echo "  Docker: rvbcrs/opennova:latest + rvbcrs/opennova:$NEW"
echo "  Local container restarted"
