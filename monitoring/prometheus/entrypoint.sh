#!/bin/sh
# Turns MONITORED_SITES (comma-separated URLs) into a Prometheus target file,
# then starts Prometheus. Prometheus can't read environment variables in its
# config, so this keeps domains out of the repo and in Coolify instead.
set -eu

: "${MONITORED_SITES:?Set MONITORED_SITES to a comma-separated list of URLs}"

targets_dir=/tmp/targets
mkdir -p "$targets_dir"
{
  echo "- targets:"
  echo "$MONITORED_SITES" | tr ',' '\n' | while read -r url; do
    url=$(echo "$url" | tr -d '[:space:]')
    [ -n "$url" ] && echo "    - \"$url\""
  done
} >"$targets_dir/sites.yml"

echo "Checking these sites:"
cat "$targets_dir/sites.yml"

exec /bin/prometheus \
  --config.file=/etc/prometheus/prometheus.yml \
  --storage.tsdb.path=/prometheus \
  --storage.tsdb.retention.time="${PROMETHEUS_RETENTION_TIME:-30d}" \
  --storage.tsdb.retention.size="${PROMETHEUS_RETENTION_SIZE:-5GB}"
