#!/bin/bash
set -Eeuo pipefail
plugin=$(cd "$(dirname "$0")/.." && pwd)
image=${KEYPAD_TEST_IMAGE:-matterbridge-stack:local}
task=$(mktemp -d /tmp/mb-native-auth.XXXXXX)
chmod 700 "$task"
node - "$task" <<'JS'
const fs=require('fs'),path=require('path'),crypto=require('crypto'),dir=process.argv[2];
const storage=path.join(dir,'data/.matterbridge/storage/.matterbridge');fs.mkdirSync(storage,{recursive:true});
const password=crypto.randomBytes(24).toString('hex');
fs.writeFileSync(path.join(dir,'password'),password,{mode:0o600});
fs.writeFileSync(path.join(storage,crypto.createHash('sha256').update('password').digest('hex')),JSON.stringify({key:'password',value:password}),{mode:0o600});
JS
container=mb-native-auth-test
cleanup() {
  sudo -n docker logs "$container" > "$task/server.log" 2>&1 || true
  sudo -n docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT
sudo -n docker run -d --name "$container" --network host \
  -e MATTERBRIDGE_LINK_LOCAL_PLUGINS=false -e POC_HTTP_BIND=127.0.0.1 \
  -e POC_HTTP_PORT=46204 -e POC_MATTER_PORT=46203 -v "$task/data:/data" "$image" >/dev/null
sudo -n docker run --rm --network host --entrypoint node \
  -v "$task:/test" -v "$plugin/test:/fixtures:ro" "$image" /fixtures/native-auth.mjs
