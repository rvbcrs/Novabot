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

# Build Docker image
echo "Building Docker image..."
docker compose build --no-cache

# Tag and push
docker tag rvbcrs/opennova:latest "rvbcrs/opennova:$NEW"
echo "Pushing rvbcrs/opennova:latest + rvbcrs/opennova:$NEW..."
docker push rvbcrs/opennova:latest
docker push "rvbcrs/opennova:$NEW"

echo ""
echo "Released v$NEW"
echo "  Docker: rvbcrs/opennova:latest + rvbcrs/opennova:$NEW"
