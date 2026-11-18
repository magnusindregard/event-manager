#!/usr/bin/env bash
# Deploys one environment from images already in its registry (infra/README.md).
# Used by .github/workflows/deploy-env.yml, and by hand for the test environment:
#
#   set -a; . infra/env/staging.env; set +a      # resource group, Entra and Postgres admin settings
#   scripts/build-images.sh <tag>                # build and push images (ACR Tasks)
#   scripts/deploy-env.sh staging <tag>
#
# Steps: freshness check → Bicep (infra and migrate job; apps stay on their image) → migrations
# → Bicep (apps to the new image) → admin SPA build and upload → smoke test.
# Bicep parameters come from the environment (see infra/env/<env>.bicepparam).
#
# The workflow runs this under one concurrency group per environment. By hand, do not run it while
# a workflow deploy to the same environment is in progress.
#
# ALLOW_REPLACE=true deploys <tag> even when it would replace a newer main commit or another
# branch's preview (see the freshness check). Without it such a deploy stops before changing anything.
set -euo pipefail

ENV_NAME=${1:?usage: deploy-env.sh <staging|prod> <image tag>}
TAG=${2:?usage: deploy-env.sh <staging|prod> <image tag>}
RG=${RESOURCE_GROUP:?RESOURCE_GROUP is required}
cd "$(dirname "$0")/.."

# The image tag the apps run now (empty on a fresh environment).
api_app=$(az containerapp list -g "$RG" --query "[?ends_with(name, '-api')].name | [0]" -o tsv)
current=""
if [ -n "$api_app" ]; then
  current=$(az containerapp show -g "$RG" -n "$api_app" --query "properties.template.containers[0].image" -o tsv)
  current=${current##*:}
fi

# Never silently roll an environment back: a delayed run, or a branch deploy started before newer
# main code deployed, must not replace it. Allowed without ALLOW_REPLACE:
#   - <tag> contains what runs (forward);
#   - what runs is not on main (a branch preview) and <tag> is on main (main replaces previews).
MAIN_REF=${MAIN_REF:-origin/main}
is_commit() { git cat-file -e "$1^{commit}" 2>/dev/null; }
on_main() { is_commit "$1" && git merge-base --is-ancestor "$1" "$MAIN_REF"; }
if [ -n "$current" ] && [ "$current" != "$TAG" ] && [ "$current" != bootstrap ] && [ "${ALLOW_REPLACE:-false}" != true ]; then
  if is_commit "$current" && is_commit "$TAG" && git merge-base --is-ancestor "$current" "$TAG"; then
    :
  elif ! on_main "$current" && on_main "$TAG"; then
    echo "▸ $ENV_NAME runs branch preview $current; replacing it with $TAG from main"
  else
    if on_main "$current"; then why="a newer main commit"; else why="another branch's preview"; fi
    echo "::error::$ENV_NAME runs $current ($why), which $TAG does not contain. Not replacing it." >&2
    echo "Deploy again with ALLOW_REPLACE=true (workflow input replace_newer) to replace it on purpose." >&2
    exit 1
  fi
fi

bicep() {
  az deployment group create -g "$RG" -n "em-$(date +%Y%m%d%H%M%S)-$1" \
    -f infra/main.bicep -p "infra/env/$ENV_NAME.bicepparam" -p imageTag="$2" -p migrateImageTag="$TAG" \
    --query properties.outputs -o json
}

# New application code may need the new schema, so the apps move only after migrations succeed.
# Migrations stay additive within a version (ADR 0007), so the old apps keep working meanwhile.
# A fresh environment has no apps to keep, and nothing is served before this deploy finishes.
echo "▸ Bicep: infrastructure and migrate job ($RG, migrate $TAG, apps stay on ${current:-$TAG})"
az bicep install >/dev/null 2>&1 || true
out=$(bicep prepare "${current:-$TAG}")
val() { echo "$out" | jq -r ".$1.value"; }
MIGRATE_JOB=$(val migrateJobName)

echo "▸ Migrations ($MIGRATE_JOB)"
exec_name=$(az containerapp job start -g "$RG" -n "$MIGRATE_JOB" --query name -o tsv)
status=""
for _ in $(seq 1 90); do
  status=$(az containerapp job execution show -g "$RG" -n "$MIGRATE_JOB" --job-execution-name "$exec_name" --query properties.status -o tsv)
  echo "  migration: $status"
  [ "$status" = "Succeeded" ] && break
  if [ "$status" = "Failed" ]; then
    echo "Migration failed; the apps still run ${current:-nothing}. Logs: az containerapp job logs show -g $RG -n $MIGRATE_JOB --execution $exec_name --container migrate" >&2
    exit 1
  fi
  sleep "${POLL_SECONDS:-10}"
done
[ "$status" = "Succeeded" ] || { echo "Migration timed out; the apps still run ${current:-nothing}" >&2; exit 1; }

echo "▸ Bicep: apps → $TAG"
out=$(bicep apps "$TAG")
STORAGE=$(val adminStorageAccount)
FRONT_DOOR=$(val frontDoorHost)
API_HOST=$(val apiHost)
PUBLIC_HOST=$(val publicApiHost)
ATTENDEE_HOST=$(val attendeeHost)
ADMIN_ORIGIN=$(val adminOrigin)

# Behind Front Door the admin calls /v1 on its own host; without it, the API's host (CORS allows the admin).
echo "▸ Admin ($STORAGE)"
if [ -n "$FRONT_DOOR" ]; then api_base=""; else api_base="https://$API_HOST"; fi
VITE_API_BASE_URL="$api_base" VITE_AUTH_MODE=msal VITE_ATTENDEE_URL="https://$ATTENDEE_HOST" \
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
# The public API answers without a key only with 401 key_required.
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 "https://${FRONT_DOOR:-$PUBLIC_HOST}/public/v1/occurrences")
[ "$code" = "401" ] || { echo "Expected 401 from /public/v1/occurrences without a key, got $code" >&2; exit 1; }
# The attendee app answers its health check (it scales to zero in staging, so allow a cold start).
for i in $(seq 1 12); do
  curl -fsS --max-time 20 "https://$ATTENDEE_HOST/healthz" >/dev/null && break
  [ "$i" = 12 ] && { echo "Attendee app did not answer" >&2; exit 1; }
  sleep 5
done

echo
echo "Admin:      $ADMIN_ORIGIN/"
echo "Core API:   https://$host/v1"
echo "Public API: https://${FRONT_DOOR:-$PUBLIC_HOST}/public/v1"
echo "Attendee:   https://$ATTENDEE_HOST"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  { echo "admin=$ADMIN_ORIGIN"; echo "api=https://$host"; echo "public=https://${FRONT_DOOR:-$PUBLIC_HOST}"; echo "attendee=https://$ATTENDEE_HOST"; } >> "$GITHUB_OUTPUT"
fi
