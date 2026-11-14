#!/usr/bin/env bash
# Destructive only inside a fresh, uniquely named Compose project.
set -Eeuo pipefail
[[ $# == 1 ]] || { echo 'Usage: bash deployment-compose-check.sh RELEASE_DIRECTORY' >&2; exit 1; }
bundle=$(realpath -e -- "$1")
docker_cmd=(docker --host unix:///var/run/docker.sock)
if ! "${docker_cmd[@]}" info >/dev/null 2>&1; then
  sudo -v
  docker_cmd=(sudo docker --host unix:///var/run/docker.sock)
fi
d() { "${docker_cmd[@]}" "$@"; }
d compose version >/dev/null
bash "$bundle/deployment-images.sh" import "$bundle"
for file in compose.yaml images.env; do test -f "$bundle/$file"; done
# A safe host ancestor, unlike /tmp. No existing media or secret file is read.
if [[ $EUID == 0 ]]; then root_cmd=(); else root_cmd=(sudo); fi
temporary=$("${root_cmd[@]}" mktemp -d /srv/artzoo-compose-check.XXXXXXXX)
project="artzoo-compose-check-${temporary##*.}"
project=${project,,}
"${root_cmd[@]}" chown "$(id -u):$(id -g)" "$temporary"
chmod 0755 "$temporary"
compose=()
cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if ((${#compose[@]})); then
    "${compose[@]}" down --volumes --remove-orphans --timeout 20 >/dev/null 2>&1 || status=1
  fi
  # Never delete an inferred production location, even on failure.
  if [[ "$temporary" == /srv/artzoo-compose-check.* && -d "$temporary" && ! -L "$temporary" ]]; then
    "${root_cmd[@]}" rm -rf --one-file-system -- "$temporary" || status=1
  else status=1; fi
  if [[ "$status" != 0 ]]; then printf 'FAIL: inspect resources for project %s\n' "$project" >&2; fi
  exit "$status"
}
trap cleanup EXIT
trap 'printf "FAIL: Compose check line %s\n" "$LINENO" >&2' ERR
trap 'exit 130' INT
trap 'exit 143' TERM
printf '【危险：仅新建临时项目 %s】迁移、写入、重建并删除测试库和媒体；不接触家庭运行目录。\n' "$project"
install -d -m 0700 "$temporary/media"
"${root_cmd[@]}" install -d -o 1000 -g 1000 -m 0700 "$temporary/media/"{original,derived,avatars}
umask 077
password=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
key=$(head -c 32 /dev/urandom | base64 -w 0)
printf 'COMPOSE_PROJECT_NAME=%s\nARTZOO_MEDIA_ROOT=%s/media\nARTZOO_HTTP_PORT=0\nARTZOO_PUBLIC_ORIGIN=https://localhost\nPOSTGRES_PASSWORD=%s\nARTZOO_INVITATION_KEY=%s\n' \
  "$project" "$temporary" "$password" "$key" > "$temporary/test.env"
# Preserve the real network topology; external integrations remain disabled.
cat > "$temporary/override.yaml" <<'YAML'
services:
  postgres:
    restart: "no"
  web:
    restart: "no"
  worker:
    restart: "no"
YAML
compose=(env -i "PATH=$PATH" "HOME=$HOME" "${docker_cmd[@]}" compose --project-name "$project" --env-file "$bundle/images.env" --env-file "$temporary/test.env" -f "$bundle/compose.yaml" -f "$temporary/override.yaml")
c() { "${compose[@]}" "$@"; }
c config --quiet
if (unset POSTGRES_PASSWORD ARTZOO_PUBLIC_ORIGIN ARTZOO_INVITATION_KEY; "${docker_cmd[@]}" compose --env-file "$bundle/images.env" --env-file "$bundle/.env.example" -f "$bundle/compose.yaml" config --quiet) >/dev/null 2>&1; then
  echo 'Unfilled environment template was accepted' >&2; exit 1
fi
c up -d --wait --wait-timeout 90 postgres
migrate() {
  c run --rm --no-deps -T --interactive=false --workdir /app/packages/db --entrypoint /app/packages/db/node_modules/.bin/prisma tools migrate deploy 2>&1 |
    sed "s/$password/[redacted]/g"
}
migrate
c up -d --wait --wait-timeout 90 web worker
output=$(c run --rm --no-deps -T --interactive=false worker --once --require-db)
c run --rm --no-deps -T --entrypoint node tools --input-type=module - worker-result "$output" ok < "$bundle/deployment-image-check.mjs"
test -z "$(c ps --all --quiet tools)"
db=$(c ps --quiet postgres)
web=$(c ps --quiet web)
worker=$(c ps --quiet worker)
test "$(d inspect --format '{{len .HostConfig.PortBindings}}' "$db")" == 0
test "$(d inspect --format '{{len .HostConfig.PortBindings}}' "$worker")" == 0
test "$(d inspect --format '{{range (index .HostConfig.PortBindings "3100/tcp")}}{{.HostIp}}{{end}}' "$web")" == 127.0.0.1
test "$(d network inspect --format '{{.Internal}}' "${project}_backend")" == true
test "$(d inspect --format '{{len .NetworkSettings.Networks}}' "$db")" == 1
endpoint=$(c port web 3100)
test "${endpoint%:*}" == 127.0.0.1
curl --fail --silent --show-error --max-time 10 --noproxy '*' "http://$endpoint/api/health" | grep -q '"ok":true'
test "$(c run --rm --no-deps -T --interactive=false tools)" == 'ArtZoo maintenance image: specify an explicit command. Nothing was changed.'
sql() { c exec -T postgres psql -X -v ON_ERROR_STOP=1 -U artzoo -d artzoo -At; }
sql <<'SQL'
CREATE TABLE compose_probe (value text NOT NULL);
INSERT INTO compose_probe VALUES ('persisted');
SQL
# Writes by web, reads and appends by worker, then reads after all containers are recreated.
c exec -T web node --input-type=module - <<'JS'
import assert from 'node:assert/strict';
import { statSync, writeFileSync } from 'node:fs';
assert.equal(process.getuid(), 1000);
assert.equal(process.getgid(), 1000);
for (const dir of ['/', '/app', '/app/storage', ...['original','derived','avatars'].map(x=>`/app/storage/${x}`)]) {
  const stat = statSync(dir);
  assert.ok([0,1000].includes(stat.uid));
  assert.equal(stat.mode & 0o022, 0);
}
for (const dir of ['original','derived','avatars']) writeFileSync(`/app/storage/${dir}/compose-probe`, 'web', {mode:0o600});
JS
c exec -T worker node --input-type=module - <<'JS'
import assert from 'node:assert/strict';
import { readFileSync, appendFileSync } from 'node:fs';
assert.equal(process.getuid(), 1000);
for (const dir of ['original','derived','avatars']) {
  const path = `/app/storage/${dir}/compose-probe`;
  assert.equal(readFileSync(path, 'utf8'), 'web');
  appendFileSync(path, '+worker');
}
JS
c down --timeout 20
c up -d --wait --wait-timeout 90 postgres web worker
test "$(sql <<< 'SELECT value FROM compose_probe;')" == persisted
for service in web worker; do
  c exec -T "$service" node --input-type=module - <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
for (const dir of ['original','derived','avatars']) assert.equal(readFileSync(`/app/storage/${dir}/compose-probe`, 'utf8'), 'web+worker');
JS
done
# A missing bind source must be refused, never silently created as root.
c stop worker
c rm -f worker
"${root_cmd[@]}" mv -- "$temporary/media/avatars" "$temporary/media/saved-avatars"
if c run --rm --no-deps -T --interactive=false --entrypoint node worker -e 'process.exit(0)' >/dev/null 2>&1; then
  echo 'Missing media directory was silently accepted' >&2; exit 1
fi
test ! -e "$temporary/media/avatars"
"${root_cmd[@]}" mv -- "$temporary/media/saved-avatars" "$temporary/media/avatars"
# Wrong ownership/mode must not be repaired by the unprivileged application.
"${root_cmd[@]}" chmod 0500 "$temporary/media/avatars"
if c run --rm --no-deps -T --interactive=false --entrypoint node worker -e 'require("node:fs").writeFileSync("/app/storage/avatars/forbidden", "no")' >/dev/null 2>&1; then
  echo 'Read-only media permissions were bypassed' >&2; exit 1
fi
"${root_cmd[@]}" chmod 0700 "$temporary/media/avatars"
printf 'PASS: Compose loopback, private database, opt-in tools, shared media, recreation persistence and rejection checks.\n'
