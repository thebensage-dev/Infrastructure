#!/usr/bin/env bash
# The shared deploy step (action.yml next to it), used by the CI pipeline of every thebensage-dev repo
# and run only after the "production"
# environment's approval. It talks to Coolify's API with the job's secrets and variables:
#   0. finds the app in Coolify by APP_NAME (or takes APP_UUID);
#   1. writes the app's runtime environment from every APP_ENV_<NAME> variable of the job
#      (empty ones are skipped), so Coolify's env always matches GitHub's secrets and variables;
#   2. points the app at the change to run: the image tag just built (IMAGE + TAG) or, for apps
#      Coolify builds from git, the commit (GIT_SHA);
#   3. starts the deployment and waits for it to finish, so the job fails if the deploy does.
# An APP_ENV_ value written as derive:<label> is replaced by HMAC-SHA256(PLATFORM_SECRET, label)
# in hex, so one secret yields every per-app secret (the same label gives the same value in every
# repo). Needs COOLIFY_TOKEN (write + deploy) and DOMAIN (or COOLIFY_URL), plus APP_NAME (the
# app's name in Coolify) or APP_UUID. Never prints a value.
set -euo pipefail

: "${COOLIFY_TOKEN:?Set the COOLIFY_TOKEN secret (see the README, Deploying)}"
if [ -z "${COOLIFY_URL:-}" ]; then
  : "${DOMAIN:?Set the DOMAIN variable (see the README, Deploying)}"
  COOLIFY_URL="https://coolify.$DOMAIN"
fi

api() {
  local method=$1 path=$2 body=${3:-}
  curl --silent --show-error --fail-with-body -X "$method" "${COOLIFY_URL%/}/api/v1$path" \
    -H "Authorization: Bearer $COOLIFY_TOKEN" -H "Accept: application/json" \
    ${body:+-H "Content-Type: application/json" --data "$body"}
}

# 0. Which app: APP_UUID if given, otherwise the one Coolify application named APP_NAME.
if [ -z "${APP_UUID:-}" ]; then
  : "${APP_NAME:?Set APP_NAME (or APP_UUID) for this app}"
  matches=$(api GET "/applications" | jq -r --arg n "$APP_NAME" '[.[] | select(.name == $n) | .uuid]')
  if [ "$(jq length <<<"$matches")" -ne 1 ]; then
    echo "::error::Expected exactly one Coolify application named \"$APP_NAME\" (found $(jq length <<<"$matches")). Rename it in Coolify, or set the COOLIFY_APP_UUID variable."
    exit 1
  fi
  APP_UUID=$(jq -r '.[0]' <<<"$matches")
fi
echo "Coolify app: ${APP_NAME:-$APP_UUID}"

# Derived secrets (masked in the log).
for name in $(compgen -e | grep '^APP_ENV_' || true); do
  value=${!name}
  if [[ $value == derive:* ]]; then
    : "${PLATFORM_SECRET:?Set the PLATFORM_SECRET secret (see the README, Deploying)}"
    derived=$(printf '%s' "${value#derive:}" | openssl dgst -sha256 -hmac "$PLATFORM_SECRET" -r | cut -d' ' -f1)
    echo "::add-mask::$derived"
    export "$name=$derived"
  fi
done

# 1. Runtime environment. is_literal: values are used as typed ("$" is not a variable).
env_json=$(jq -n '[env | to_entries[]
  | select(.key | startswith("APP_ENV_")) | select(.value != "")
  | {key: (.key | ltrimstr("APP_ENV_")), value, is_preview: false, is_literal: true}]')
if [ "$(jq length <<<"$env_json")" -gt 0 ]; then
  api PATCH "/applications/$APP_UUID/envs/bulk" "$(jq -n --argjson d "$env_json" '{data: $d}')" >/dev/null
  echo "Environment: $(jq -r 'map(.key) | join(", ")' <<<"$env_json")"
fi

# 2. What to run.
if [ -n "${IMAGE:-}" ]; then
  api PATCH "/applications/$APP_UUID" \
    "$(jq -n --arg n "$IMAGE" --arg t "$TAG" '{docker_registry_image_name: $n, docker_registry_image_tag: $t}')" >/dev/null
  echo "Image: $IMAGE:$TAG"
elif [ -n "${GIT_SHA:-}" ]; then
  api PATCH "/applications/$APP_UUID" "$(jq -n --arg s "$GIT_SHA" '{git_commit_sha: $s}')" >/dev/null
  echo "Commit: $GIT_SHA"
fi

# 3. Deploy and wait (up to 20 minutes).
deployment=$(api POST "/deploy?uuid=$APP_UUID" | jq -r '.deployments[0].deployment_uuid')
echo "Deployment $deployment started"
for _ in $(seq 1 120); do
  status=$(api GET "/deployments/$deployment" | jq -r '.status')
  case "$status" in
    finished) echo "Deployed."; exit 0 ;;
    failed | cancelled*) echo "::error::Coolify deployment $status. See the app's Deployments tab."; exit 1 ;;
  esac
  sleep 10
done
echo "::error::Timed out waiting for the Coolify deployment."
exit 1
