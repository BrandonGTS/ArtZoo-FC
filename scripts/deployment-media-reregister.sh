#!/usr/bin/env bash
# Sourced by the verified controller; media remains read-only, SQL owns the only writes.
register_main() {
  local reference service running='' previous='' mark="$state/media-registration.pending"
  [[ -z "$backup_source" ]] || fail '登记不接受 --backup。'
  [[ "${values[ARTZOO_MEDIA_BUDGET_ENABLED]}" == 1 ]] || fail '登记要求已启用配额。'
  identity; check_app web; check_app worker
  release=${refs[web]#*:}; pg_image=$(d inspect --format '{{.Image}}' "$postgres")
  reference=$(dc config --images | LC_ALL=C sort -u | grep '^postgres:')
  [[ "$pg_image" == "$(d image inspect --format '{{.Id}}' "$reference")" ]] || fail '数据库镜像不符。'
  backup_dir=${backup_dir:-$root/backups}; backup_location "$backup_dir"
  if [[ ! -e "$backup_dir" ]]; then trusted_path "$(dirname "$backup_dir")"; mkdir -m 700 -- "$backup_dir"; fi
  private_directory "$backup_dir"
  backup_space_check
  for service in web worker; do
    running+="$(d inspect --format '{{.State.Running}}' "$(dc ps --all --quiet "$service")") "
  done
  case "$running" in 'true true ') previous=running;; 'false false ') previous=stopped;; *) fail '应用运行状态不一致，请先明确停站。';; esac
  if [[ -e "$mark" || -L "$mark" ]]; then
    state_file "$mark"; read -r previous < "$mark"
    [[ "$previous" == running || "$previous" == stopped ]] || fail '登记维护标记不符。'
  else
    [[ -d "$state" ]] || mkdir -m 700 -- "$state"
    trusted_path "$state"; state_write media-registration.pending "$previous"
  fi
  printf '【危险】停写、强制备份并全量重新登记；失败保持停站。\n'
  apps_touched=1
  dc stop --timeout 60 web worker >/dev/null 2>&1 || fail '停止应用失败。'
  stopped_writers
  create_snapshot; publish_snapshot register
  # Dedicated Compose override: same network/DB configuration, ONLY read-only media mounts.
  cat >> "$override" <<EOF
    read_only: true
    volumes:
      - type: bind
        source: $root/media/original
        target: /app/storage/original
        read_only: true
      - type: bind
        source: $root/media/derived
        target: /app/storage/derived
        read_only: true
      - type: bind
        source: $root/media/avatars
        target: /app/storage/avatars
        read_only: true
EOF
  tool=$(dc run --rm --no-deps -T --interactive=false --detach --entrypoint node tools -e 'setInterval(()=>{},1000)')
  [[ "$tool" =~ ^[0-9a-f]{64}$ ]] || fail '登记工具未启动。'
  local actual expected
  actual=$(d inspect --format '{{range .Mounts}}{{.Type}}|{{.Source}}|{{.Destination}}|{{.RW}}{{println}}{{end}}' "$tool" | sed '/^$/d' | LC_ALL=C sort)
  expected=$(for service in avatars derived original; do printf 'bind|%s/media/%s|/app/storage/%s|false\n' "$root" "$service" "$service"; done)
  [[ "$actual" == "$expected" ]] || fail '登记工具只读挂载不符。'
  "${privilege[@]}" timeout --kill-after=5s 270s "$docker_path" --host unix:///var/run/docker.sock exec "$tool" node /app/scripts/media-reregister-cli.mjs --offline --expect-database artzoo || fail '登记未完成；保持停站，保留维护标记及备份。'
  d rm -f "$tool" >/dev/null; tool=''
  media_identity || fail '登记后独立诊断未通过；保持停站。'
  if [[ "$previous" == running ]]; then restart_apps || fail '登记后健康检查失败；保持停站。'; fi
  rm -- "$mark"
  apps_touched=0
  prune_backups
  printf 'PASS: media-reregister；原运行状态=%s，金额及历史删除凭据未修改。\n' "$previous"
}
