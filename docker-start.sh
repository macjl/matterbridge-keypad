#!/bin/sh
set -eu
for plugin in matterbridge-hybrid-poc matterbridge-audio-poc matterbridge-keypad; do
  if [ -f "/usr/local/lib/node_modules/$plugin/package.json" ]; then
    matterbridge --docker --homedir /data --no-ansi --add "$plugin"
  fi
done
set -- matterbridge --docker --homedir /data --bridge --port "${POC_MATTER_PORT:-5545}" \
  --frontend "${POC_HTTP_PORT:-8284}" --bind "${POC_HTTP_BIND:-0.0.0.0}" \
  --productName 'Matterbridge' --novirtual --no-ansi
if [ -n "${POC_MDNS_INTERFACE:-}" ]; then set -- "$@" --mdnsinterface "$POC_MDNS_INTERFACE"; fi
exec "$@"
