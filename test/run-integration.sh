#!/bin/bash
set -Eeuo pipefail
plugin=$(cd "$(dirname "$0")/.." && pwd)
task=$(mktemp -d /tmp/mb-keypad-integration.XXXXXX)
chmod 700 "$task"
mkdir "$task/data"
container=mb-keypad-integration
image=${KEYPAD_TEST_IMAGE:-matterbridge-securitysystem-stack:local}
cleanup() {
  sudo -n docker logs "$container" > "$task/server.log" 2>&1 || true
  sudo -n docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT
sudo -n docker run -d --name "$container" --network host \
  -e MATTERBRIDGE_LINK_LOCAL_PLUGINS=false \
  -e POC_HTTP_BIND=127.0.0.1 -e POC_HTTP_PORT=46104 -e POC_MATTER_PORT=46103 \
  -v "$task:/test" -v "$task/data:/data" "$image" >/dev/null
for attempt in $(seq 1 35); do
  sudo -n docker logs "$container" 2>&1 | sed -nE 's/.*[Mm]anual pairing code[[:space:]:]+([0-9]{11}).*/\1/p' | head -1 > "$task/bridge-code"
  if test -s "$task/bridge-code"; then break; fi
  sleep 1
done
test -s "$task/bridge-code"
sudo -n docker run --rm --network host \
  -v "$task:/test" -v "$plugin/test:/usr/local/lib/node_modules/keypad-fixture" \
  --entrypoint node "$image" /usr/local/lib/node_modules/keypad-fixture/integration.mjs &
fixture_pid=$!
for attempt in $(seq 1 150); do
  if test -f "$task/restart"; then
    sudo -n docker restart --time 10 "$container" >/dev/null
    touch "$task/restarted"
    break
  fi
  if ! kill -0 "$fixture_pid" 2>/dev/null; then break; fi
  sleep 1
done
wait "$fixture_pid"
echo "Rapport du test : $task/server.log"
