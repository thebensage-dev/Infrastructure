#!/bin/sh
# Shares the "Live status" dashboard (uid public-status) publicly at
#   $GF_SERVER_ROOT_URL/public-dashboards/$STATUS_ACCESS_TOKEN
# so the link on the main site never changes, even after Grafana's data is reset.
# Grafana can't provision public dashboards from files, so this runs next to Grafana on every
# start (see the Dockerfile) and uses its API as the local admin. Without STATUS_ACCESS_TOKEN it
# does nothing and the dashboard stays private.
set -u
token="${STATUS_ACCESS_TOKEN:-}"
[ -n "$token" ] || exit 0
case "$token" in
  *[!0-9a-f]* | "") echo "share-status: STATUS_ACCESS_TOKEN must be 32 lowercase hex characters" >&2; exit 0 ;;
esac
[ "${#token}" -eq 32 ] || { echo "share-status: STATUS_ACCESS_TOKEN must be 32 characters" >&2; exit 0; }

api="http://localhost:3000/api/dashboards/uid/public-status/public-dashboards"
auth="${GF_SECURITY_ADMIN_USER:-admin}:${GF_SECURITY_ADMIN_PASSWORD:-admin}"

# Wait up to 5 minutes for Grafana (and the provisioned dashboard) to be ready.
i=0
until curl -fsS -o /dev/null "http://localhost:3000/api/health"; do
  i=$((i + 1)); [ "$i" -ge 60 ] && { echo "share-status: Grafana didn't start" >&2; exit 0; }
  sleep 5
done
sleep 5

current=$(curl -sS -u "$auth" "$api")
case "$current" in
  *"\"accessToken\":\"$token\""*"\"isEnabled\":true"* | *"\"isEnabled\":true"*"\"accessToken\":\"$token\""*)
    echo "share-status: Live status already public"; exit 0 ;;
esac
# A share with another token (or switched off): replace it.
uid=$(printf '%s' "$current" | sed -n 's/.*"uid":"\([^"]*\)","dashboardUid".*/\1/p')
[ -n "$uid" ] && curl -sS -o /dev/null -u "$auth" -X DELETE \
  "http://localhost:3000/api/dashboards/uid/public-status/public-dashboards/$uid"

if curl -fsS -o /dev/null -u "$auth" -H "Content-Type: application/json" -X POST "$api" \
  -d "{\"isEnabled\":true,\"share\":\"public\",\"accessToken\":\"$token\"}"; then
  echo "share-status: Live status shared publicly"
else
  echo "share-status: couldn't share Live status" >&2
fi
