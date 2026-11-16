#!/usr/bin/env bash
# Builds the four images in the environment's registry with ACR Tasks (no local Docker or
# cross-compiling on Apple silicon) and tags them with the given tag. CI builds with buildx instead.
#
#   ACR_NAME=<registry name without .azurecr.io> scripts/build-images.sh [tag]   # tag defaults to the git SHA
set -euo pipefail

ACR=${ACR_NAME:?ACR_NAME is required}
TAG=${1:-$(git rev-parse HEAD)}
cd "$(dirname "$0")/.."
if [ -n "$(git status --porcelain)" ]; then
  echo "Note: the working tree has uncommitted changes; they are built into tag $TAG." >&2
fi

for app in api public-api worker db; do
  echo "▸ $app:$TAG"
  az acr build --registry "$ACR" --image "event-manager/$app:$TAG" --build-arg "APP=$app" \
    --platform linux/amd64 --no-logs -o none .
done
echo "Built event-manager/{api,public-api,worker,db}:$TAG in $ACR"
