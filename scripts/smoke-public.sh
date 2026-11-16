#!/usr/bin/env bash
# Staging check for the public API behind Front Door (docs/implementation-plan.md, "Verification"):
#   - a repeated request is served from the edge cache (x-cache: TCP_HIT / HIT)
#   - two tenants' publishable keys never get each other's cached response
#   - a preview token is never cached
#
# Usage: scripts/smoke-public.sh <front door host> <tenant A pk_…> <tenant B pk_…> [prv_… of tenant A]
set -euo pipefail

host=${1:?front door host}
key_a=${2:?publishable key, tenant A}
key_b=${3:?publishable key, tenant B}
preview=${4:-}
# Same query for both tenants, so only the key differs. A fixed window keeps the URL stable.
query="from=2026-01-01T00:00:00Z&to=2027-12-31T00:00:00Z&locale=en&limit=50"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fail=0

fetch() { # name url [header]
  curl -sS -D "$tmp/$1.h" -o "$tmp/$1.b" ${3:+-H "$3"} "$2"
  tr -d '\r' < "$tmp/$1.h" | awk -F': ' 'tolower($1)=="x-cache"{print $2}' | tail -1
}
check() { if eval "$2"; then echo "ok    $1"; else echo "FAIL  $1"; fail=1; fi; }

url_a="https://$host/public/v1/occurrences?$query&key=$key_a"
url_b="https://$host/public/v1/occurrences?$query&key=$key_b"

fetch a1 "$url_a" >/dev/null
sleep 2
cache_a=$(fetch a2 "$url_a")
fetch b1 "$url_b" >/dev/null
sleep 2
cache_b=$(fetch b2 "$url_b")

echo "tenant A second request: x-cache=${cache_a:-none}"
echo "tenant B second request: x-cache=${cache_b:-none}"
check "tenant A is served from the edge cache" '[[ "$cache_a" == *HIT* ]]'
check "tenant B is served from the edge cache" '[[ "$cache_b" == *HIT* ]]'
check "responses are 200" 'grep -q "^HTTP/[0-9.]* 200" "$tmp/a2.h" && grep -q "^HTTP/[0-9.]* 200" "$tmp/b2.h"'
check "the two tenants get different bodies" '! cmp -s "$tmp/a2.b" "$tmp/b2.b"'
check "tenant A's cached body equals its fresh one" 'cmp -s "$tmp/a1.b" "$tmp/a2.b"'
check "cache-control allows edge caching" 'grep -qi "^cache-control: .*s-maxage" "$tmp/a2.h"'

if [[ -n "$preview" ]]; then
  fetch p1 "https://$host/public/v1/occurrences?$query" "Authorization: Bearer $preview" >/dev/null
  cache_p=$(fetch p2 "https://$host/public/v1/occurrences?$query" "Authorization: Bearer $preview")
  check "preview is not cached (x-cache=${cache_p:-none})" '[[ "$cache_p" != *HIT* ]]'
  check "preview says no-store" 'grep -qi "^cache-control: private, no-store" "$tmp/p2.h"'
fi

exit $fail
