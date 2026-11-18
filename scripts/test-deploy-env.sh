#!/usr/bin/env bash
# Checks the order and guards of scripts/deploy-env.sh without Azure: az, pnpm and curl are stubs
# that log their calls. Needs full git history (CI checks out with fetch-depth 0).
set -euo pipefail
cd "$(dirname "$0")/.."

new=$(git rev-parse HEAD)
old=$(git rev-parse HEAD~1)
# Branch previews: commits that are not on "main" (here: the history of $new).
preview=$(git commit-tree "$old^{tree}" -p "$old" -m "preview")
preview2=$(git commit-tree "$old^{tree}" -p "$old" -m "another preview")
export MAIN_REF=$new
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"

cat > "$work/bin/az" <<'STUB'
#!/usr/bin/env bash
echo "az $*" >> "$LOG"
case "$*" in
  "containerapp list"*) echo "${FAKE_API_APP:-}" ;;
  "containerapp show"*) echo "reg.azurecr.io/event-manager/api:$FAKE_CURRENT" ;;
  "deployment group create"*)
    echo '{"migrateJobName":{"value":"caj-migrate"},"adminStorageAccount":{"value":"st"},"frontDoorHost":{"value":""},
           "apiHost":{"value":"api.test"},"publicApiHost":{"value":"public.test"},"attendeeHost":{"value":"attendee.test"},
           "adminOrigin":{"value":"https://admin.test"}}' ;;
  "containerapp job start"*) echo exec-1 ;;
  "containerapp job execution show"*) echo "$FAKE_MIGRATION" ;;
esac
STUB
printf '#!/usr/bin/env bash\necho "pnpm $*" >> "$LOG"\n' > "$work/bin/pnpm"
printf '#!/usr/bin/env bash\necho "curl $*" >> "$LOG"\ncase "$*" in *http_code*) echo 401 ;; esac\n' > "$work/bin/curl"
chmod +x "$work/bin/"*

export PATH="$work/bin:$PATH" RESOURCE_GROUP=rg-test ENTRA_ADMIN_CLIENT_ID=x ENTRA_AUTHORITY=x ENTRA_API_SCOPE=x POLL_SECONDS=0
fail() { echo "FAIL: $*" >&2; echo "--- calls:" >&2; cat "$LOG" >&2; exit 1; }
run() { # <name> <current tag> <migration status> <tag>; exit code in $code, calls in $LOG
  export LOG="$work/$1.log" FAKE_CURRENT=$2 FAKE_MIGRATION=$3 FAKE_API_APP=${2:+ca-em-test-api}
  : > "$LOG"
  code=0
  scripts/deploy-env.sh staging "$4" > "$work/$1.out" 2>&1 || code=$?
}
bicep_tags() { grep '^az deployment group create' "$LOG" | sed -E "s/.* imageTag=([^ ]+) -p migrateImageTag=([^ ]+).*/\\1 \\2/"; }

# Forward deploy: migrate with the new image while the apps keep the old one, then move the apps.
run forward "$old" Succeeded "$new"; [ "$code" = 0 ] || fail "forward deploy failed: $(cat "$work/forward.out")"
[ "$(bicep_tags)" = "$old $new
$new $new" ] || fail "expected bicep with apps on $old, then on $new"
order=$(grep -nE '^az (deployment group create|containerapp job start)' "$LOG" | cut -d: -f1 | tr '\n' ' ')
set -- $order
[ "$1" -lt "$2" ] && [ "$2" -lt "$3" ] || fail "migrations must run between the two Bicep deployments"

# A failed migration leaves the apps on the old image and uploads no admin.
run failed "$old" Failed "$new"; [ "$code" != 0 ] || fail "deploy succeeded although the migration failed"
[ "$(bicep_tags)" = "$old $new" ] || fail "apps rolled out although the migration failed"
! grep -q '^az storage' "$LOG" || fail "admin uploaded although the migration failed"

# An environment running a newer main commit is not rolled back.
run rollback "$new" Succeeded "$old"; [ "$code" != 0 ] || fail "deployed an older commit over a newer one"
! grep -q '^az deployment' "$LOG" || fail "changed the environment before refusing"
grep -q "ALLOW_REPLACE" "$work/rollback.out" || fail "refusal does not explain the override"

# ...unless that is explicitly asked for.
ALLOW_REPLACE=true run override "$new" Succeeded "$old"; [ "$code" = 0 ] || fail "ALLOW_REPLACE did not deploy"

# Main replaces a branch preview, but a branch does not replace another branch's preview.
run main-over-preview "$preview" Succeeded "$new"; [ "$code" = 0 ] || fail "main did not replace a preview: $(cat "$work/main-over-preview.out")"
run preview-over-preview "$preview" Succeeded "$preview2"; [ "$code" != 0 ] || fail "a branch replaced another branch's preview"
! grep -q '^az deployment' "$LOG" || fail "changed the environment before refusing"

# A fresh environment has no apps to keep: one tag throughout.
run fresh "" Succeeded "$new"; [ "$code" = 0 ] || fail "fresh deploy failed: $(cat "$work/fresh.out")"
[ "$(bicep_tags)" = "$new $new
$new $new" ] || fail "fresh environment should deploy $new in both steps"

echo "deploy-env.sh: order and guards OK"
