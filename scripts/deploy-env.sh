#!/usr/bin/env bash
# Deploys one environment from images already in its registry (infra/README.md).
# Used by .github/workflows/deploy-env.yml, and by hand for the test environment:
#
#   set -a; . infra/env/staging.env; set +a      # resource group, Entra and Postgres admin settings
#   scripts/build-images.sh <tag>                # build and push images (ACR Tasks)
#   scripts/deploy-env.sh staging <tag>
#
# Steps: Bicep (infra and apps) → migrations → admin SPA build and upload → smoke test.
# Bicep parameters come from the environment (see infra/env/<env>.bicepparam).
set -euo pipefail

ENV_NAME=${1:?usage: deploy-env.sh <staging|prod> <image tag>}
TAG=${2:?usage: deploy-env.sh <staging|prod> <image tag>}
RG=${RESOURCE_GROUP:?RESOURCE_GROUP is required}
cd "$(dirname "$0")/.."

echo "▸ Bicep ($RG, tag $TAG)"
az bicep install >/dev/null 2>&1 || true
out=$(az deployment group create -g "$RG" -n "em-$(date +%Y%m%d%H%M%S)" \
  -f infra/main.bicep -p "infra/env/$ENV_NAME.bicepparam" -p imageTag="$TAG" \
  --query properties.outputs -o json)
val() { echo "$out" | jq -r ".$1.value"; }
MIGRATE_JOB=$(val migrateJobName)
STORAGE=$(val adminStorageAccount)
FRONT_DOOR=$(val frontDoorHost)
API_HOST=$(val apiHost)
PUBLIC_HOST=$(val publicApiHost)
ADMIN_ORIGIN=$(val adminOrigin)

# Container Apps roll out the new image when Bicep updates the template; migrations are
# additive within a version (ADR 0007), so old revisions keep working meanwhile.
echo "▸ Migrations ($MIGRATE_JOB)"
exec_name=$(az containerapp job start -g "$RG" -n "$MIGRATE_JOB" --query name -o tsv)
for _ in $(seq 1 90); do
  status=$(az containerapp job execution show -g "$RG" -n "$MIGRATE_JOB" --job-execution-name "$exec_name" --query properties.status -o tsv)
  echo "  migration: $status"
  [ "$status" = "Succeeded" ] && break
  if [ "$status" = "Failed" ]; then
    echo "Migration failed. Logs: az containerapp job logs show -g $RG -n $MIGRATE_JOB --execution $exec_name --container migrate" >&2
    exit 1
  fi
  sleep 10
done
[ "$status" = "Succeeded" ] || { echo "Migration timed out" >&2; exit 1; }

# Behind Front Door the admin calls /v1 on its own host; without it, the API's host (CORS allows the admin).
echo "▸ Admin ($STORAGE)"
if [ -n "$FRONT_DOOR" ]; then api_base=""; else api_base="https://$API_HOST"; fi
VITE_API_BASE_URL="$api_base" VITE_AUTH_MODE=msal \
VITE_ENTRA_CLIENT_ID="${ENTRA_ADMIN_CLIENT_ID:?}" VITE_ENTRA_AUTHORITY="${ENTRA_AUTHORITY:?}" VITE_ENTRA_API_SCOPE="${ENTRA_API_SCOPE:?}" \
  pnpm turbo run build --filter=@event-manager/admin... >/dev/null
# Unknown paths serve index.html, so deep links like /events/<id> load the SPA.
az storage blob service-properties update --account-name "$STORAGE" --static-website \
  --index-document index.html --404-document index.html --auth-mode login -o none
# shellcheck disable=SC2016 # '$web' is the literal static-website container name
az storage blob upload-batch --account-name "$STORAGE" -d '$web' -s apps/admin/dist --overwrite --auth-mode login -o none

echo "▸ Smoke test"
host=${FRONT_DOOR:-$API_HOST}
# A scaled-to-zero app needs a few seconds to start; retry the first request.
for i in $(seq 1 12); do
  curl -fsS --max-time 20 "https://$host/v1/openapi.json" >/dev/null && break
  [ "$i" = 12 ] && { echo "API did not answer" >&2; exit 1; }
  sleep 5
done
code=$(curl -s -o /dev/null -w '%{http_code}' "https://$host/v1/me")
[ "$code" = "401" ] || { echo "Expected 401 from /v1/me, got $code" >&2; exit 1; }
curl -fsS --max-time 30 "https://${FRONT_DOOR:-$PUBLIC_HOST}/public/v1/openapi.json" >/dev/null

echo
echo "Admin:      $ADMIN_ORIGIN/"
echo "Core API:   https://$host/v1"
echo "Public API: https://${FRONT_DOOR:-$PUBLIC_HOST}/public/v1"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  { echo "admin=$ADMIN_ORIGIN"; echo "api=https://$host"; echo "public=https://${FRONT_DOOR:-$PUBLIC_HOST}"; } >> "$GITHUB_OUTPUT"
fi
