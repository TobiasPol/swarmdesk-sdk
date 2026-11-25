#!/usr/bin/env bash
# Sends one HMAC-SHA256 signed JSON payload to Swarmdesk /api/verdicts (or SWARMDESK_ENDPOINT).
# Attaches sent_at UTC timestamp inside the signed payload and X-Swarmdesk-Signature: sha256=...
# Retries transient 5xx/network errors with exponential backoff; stops immediately on 4xx.
set -euo pipefail

: "${SWARMDESK_URL:?}" "${VERDICT_SECRET:?}"
file="${1:?usage: send-verdict.sh <payload.json> [endpoint]}"
endpoint="${2:-${SWARMDESK_ENDPOINT:-/api/verdicts}}"

base_url="${SWARMDESK_URL%/}"
printf '%s' "$base_url" | grep -Eqx 'https://[a-z0-9.-]+(:[0-9]{1,5})?' || {
  echo "bad site address" >&2
  exit 2
}
printf '%s' "$endpoint" | grep -Eqx '/api/[a-z0-9/_-]+' || {
  echo "bad endpoint path" >&2
  exit 2
}
[ -s "$file" ] || { echo "missing or empty payload file" >&2; exit 2; }

payload=$(jq -c --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '. + {sent_at: $at}' "$file")
signature=$(printf '%s' "$payload" | openssl dgst -sha256 -hmac "$VERDICT_SECRET" -hex | sed 's/^.* //')
answer=$(mktemp)
trap 'rm -f "$answer"' EXIT

for wait in 0 5 15 45; do
  if [ "$wait" -gt 0 ]; then
    sleep "$wait"
  fi
  code=$(curl -sS --proto '=https' --max-redirs 0 --max-time 20 -o "$answer" -w '%{http_code}' -X POST \
    -H 'Content-Type: application/json' \
    -H "X-Swarmdesk-Signature: sha256=$signature" \
    --data-binary "$payload" \
    "${base_url}${endpoint}" 2>/dev/null || echo 000)
  if [ "$code" = 200 ]; then
    echo "Swarmdesk accepted payload ($endpoint): $(cat "$answer")"
    exit 0
  fi
  case "$code" in
    4??)
      echo "Swarmdesk refused payload ($code): $(cat "$answer")" >&2
      exit 1
      ;;
  esac
  echo "Swarmdesk answered $code" >&2
done

echo "Swarmdesk could not be reached" >&2
exit 1
