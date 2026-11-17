#!/usr/bin/env bash
# Loaded by the verified controller; all operations share the maintenance lock.
upgrade_phase='' old_bundle='' new_bundle='' rollback_snapshot='' operation=''
state="$root/deploy"
# Each immutable release is fully verified once per locked maintenance operation.
declare -A verified_versions=(["$controller"]=1 ["$bundle"]=1)
state_file() {
  local -a lines=()
  trusted_path "$1"
  [[ -f "$1" && ! -L "$1" && "$(stat -c %s "$1")" -le 4096 ]] || fail '版本记录格式不符。'
  mapfile -t lines < "$1"
  [[ ${#lines[@]} == 1 ]] || fail '版本记录必须只有一行。'
}
bundle_path() { [[ "$1" =~ ^/([a-zA-Z0-9_.-]+/)*[a-zA-Z0-9_.-]+$ ]] && trusted_path "$1"; }
verified_bundle() {
  bundle_path "$1" || fail '发布目录路径不可信。'
  [[ ! -v "verified_versions[$1]" ]] || return 0
  bash "$controller/deployment-images.sh" verify "$1" >/dev/null 2>&1 || fail '发布包校验失败。'
  verified_versions[$1]=1
}
state_write() {
  local name=$1; shift
  [[ ! -e "$state/$name" && ! -L "$state/$name" ]] || state_file "$state/$name"
  temporary=$(mktemp "$state/.pointer.XXXXXXXX")
  printf '%s\n' "$*" > "$temporary"
  mv -T -- "$temporary" "$state/$name"; temporary=''
}
write_current() {
  [[ -d "$state" ]] || mkdir -m 700 -- "$state"
  trusted_path "$state"
  state_write current "$1" "${refs[web]#*:}" "$2"
}
read_current() {
  state_file "$state/current"
  read -r current_bundle current_release current_schema extra < "$state/current"
  [[ -z "$extra" && "$current_release" =~ ^(git|dev)-[0-9a-f]{12}-[0-9]{14}-[0-9]+$ ]] || fail '当前版本记录不符。'
  verified_bundle "$current_bundle"; verified_bundle "$current_schema"
  [[ "$(awk '$1=="web" {sub(/^.*:/,"",$2);print $2}' "$current_bundle/images.tsv")" == "$current_release" ]] || fail '当前版本记录和发布包不一致。'
}
allow_schema() {
  local key requirement rest
  verified_bundle "$1"
  while IFS='|' read -r key requirement rest; do
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ && "$requirement" != fixed ]] || continue
    allowed_extra[$key]=1
  done < "$1/runtime-config.manifest"
}
upgrade_guard() {
  if [[ -e "$state/media-registration.pending" || -L "$state/media-registration.pending" ]]; then
    state_file "$state/media-registration.pending"
    case "$command" in
      media-reregister|media-identity|stop) ;;
      restore) [[ "$keep_stopped" == true ]] || fail '登记未完成；restore 须保持停站。';;
      *) fail '媒体登记未完成；保持停站，先运行 media-reregister。';;
    esac
  fi
  if [[ -e "$state/pending" || -L "$state/pending" ]]; then
    [[ "$command" == rollback || "$command" == stop ]] || fail '升级/恢复尚未完成；保持停站，请先执行 rollback。'
  fi
  if [[ -e "$state/current" || -L "$state/current" ]]; then
    read_current
    [[ "$command" != rollback ]] || allow_schema "$current_schema"
    case "$command" in status|start|stop|backup|restore|media-identity|media-reregister)
      [[ "$bundle" == "$current_bundle" ]] || fail '所选发布包与 deploy/current 不一致。'
      allow_schema "$current_schema";;
    esac
  fi
}
activate_bundle() {
  verified_bundle "$1"
  bundle=$1; refs=(); ids=()
  while read -r role ref image_id platform extra; do refs[$role]=$ref; ids[$role]=$image_id; done < "$bundle/images.tsv"
  for role in web worker tools; do
    [[ -n "${ids[$role]:-}" && "$(d image inspect "${refs[$role]}" --format '{{.Id}} {{.Os}}/{{.Architecture}}')" == "${ids[$role]} linux/amd64" ]] || fail '镜像缺失或 ID 不一致。'
  done
  [[ -z "$override" ]] || rm -f -- "$override"
  load_manifest; configure; database_target; identity
  release=${refs[web]#*:}
  [[ "$(d inspect --format '{{.Image}}' "$postgres")" == "$pg_image" && "$(d image inspect --format '{{.Id}}' "$(dc config --images | LC_ALL=C sort -u | grep '^postgres:')")" == "$pg_image" ]] || fail '升级不能更换 PostgreSQL 镜像。'
}
history() {
  local source=$old_bundle target=$new_bundle
  if [[ "$operation" == rollback ]]; then source=$new_bundle; target=$old_bundle; fi
  [[ ! -L "$state/history.log" && ( ! -e "$state/history.log" || -f "$state/history.log" ) ]] || fail '历史日志须为普通文件。'
  [[ ! -e "$state/history.log" ]] || trusted_path "$state/history.log"
  printf '%s %s from=%s to=%s backup=%s result=%s\n' "$(date -u +%FT%TZ)" "$operation" "$(awk '$1=="web" {print $2}' "$source/images.tsv")" "$(awk '$1=="web" {print $2}' "$target/images.tsv")" "$rollback_snapshot" "$1" >> "$state/history.log"
}
rollback_command() {
  printf '【危险】回退会丢弃升级后写入的数据：bash %q rollback --bundle %q --root %q --project %q --backup-dir %q\n' "$controller/deployment-maintenance.sh" "$controller" "$root" "$project" "$backup_dir" >&2
}
registration_command() {
  printf '【危险】重新登记媒体身份：bash %q media-reregister --bundle %q --root %q --project %q --backup-dir %q\n' "$controller/deployment-maintenance.sh" "$bundle" "$root" "$project" "$backup_dir"
}
upgrade_cleanup() {
  [[ "$1" != 0 && -n "$upgrade_phase" ]] || return 0
  resume_apps=0; destructive_restore=0; apps_touched=0
  if [[ "$upgrade_phase" == before ]]; then
    (activate_bundle "$old_bundle"; restart_apps) || printf '旧版本未能恢复启动；请人工检查。\n' >&2
  else
    dc stop --timeout 60 web worker >/dev/null 2>&1 || printf '无法确认停站，请立即核对。\n' >&2
    printf '迁移或恢复已开始，保持停站，不自动覆盖数据库。\n' >&2
    rollback_command
  fi
  (history failed) || printf '历史记录写入失败；请保留现场。\n' >&2
}
compare_migrations() {
  local name hash extra applied known pending='' count
  local -A available=()
  known=$(dc run --rm --no-deps -T --interactive=false --entrypoint node tools -e '
const fs=require("node:fs"),crypto=require("node:crypto"),dir="/app/packages/db/prisma/migrations";
const {Client}=require("/app/packages/db/node_modules/pg");
const c=new Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000,options:"-c default_transaction_read_only=on"});
c.connect().then(()=>c.query("SELECT 1")).then(()=>c.end()).catch(()=>process.exit(1));
for(const n of fs.readdirSync(dir).sort()){if(n==="migration_lock.toml")continue;
if(!/^[a-zA-Z0-9_]+$/.test(n))process.exit(1);
console.log(n+"|"+crypto.createHash("sha256").update(fs.readFileSync(dir+"/"+n+"/migration.sql")).digest("hex"));}' 2>/dev/null) || fail '无法读取新 tools 镜像的迁移清单。'
  while IFS='|' read -r name hash extra; do
    [[ "$name" =~ ^[a-zA-Z0-9_]+$ && "$hash" =~ ^[a-f0-9]{64}$ && -z "$extra" && ! -v "available[$name]" ]] || fail '迁移清单格式不符。'
    available[$name]=$hash
  done <<< "$known"
  count=$(sql 'SELECT count(*) FROM "_prisma_migrations" WHERE rolled_back_at IS NULL AND finished_at IS NULL;') || fail '无法核对迁移状态。'
  [[ "$count" == 0 ]] || fail '存在未完成迁移，拒绝继续升级。'
  applied=$(sql 'SELECT migration_name, checksum FROM "_prisma_migrations" WHERE rolled_back_at IS NULL AND finished_at IS NOT NULL ORDER BY migration_name;') || fail '无法读取已执行迁移。'
  while IFS='|' read -r name hash extra; do
    [[ "$name" =~ ^[a-zA-Z0-9_]+$ && -v "available[$name]" ]] || fail '数据库包含新包不认识的迁移，拒绝降级。'
    [[ "${available[$name]}" == "$hash" ]] || fail '已执行迁移内容发生变化，拒绝升级。'
    unset 'available[$name]'
  done <<< "$applied"
  for name in "${!available[@]}"; do pending+="$name"$'\n'; done
  printf '待执行迁移（空表示无新增）：\n'; printf '%s' "$pending" | LC_ALL=C sort
}
rebuild_apps() {
  dc up --no-start --no-deps --no-build --pull never --force-recreate web worker >/dev/null 2>&1 || fail '应用容器重建失败。'
  check_app web; check_app worker
  [[ "$command" != rollback ]] || return 0
  dc start --wait --wait-timeout 120 web worker >/dev/null 2>&1 || fail '应用启动或健康检查失败。'
  status_check
}
upgrade_main() {
  source "$controller/deployment-backup.sh"
  operation=$command; new_bundle=$bundle
  pg_image=$(d inspect --format '{{.Image}}' "$postgres")
  backup_dir=${backup_dir:-$root/backups}
  backup_location "$backup_dir"
  [[ -z "$backup_source" && "$keep" =~ ^[1-9][0-9]{0,3}$ ]] || fail '升级/回退不接受 --backup，保留份数须为正整数。'
  [[ -d "$state" ]] || mkdir -m 700 -- "$state"
  trusted_path "$state"
  if [[ "$command" == upgrade ]]; then
    if [[ -e "$state/current" ]]; then
      [[ -z "$from_bundle" ]] || fail '已有 current，不接受 --from。'
      old_bundle=$current_bundle
    else
      [[ -n "$from_bundle" ]] || fail '首次升级必须用 --from 指定当前发布包。'
      old_bundle=$(realpath -e -- "$from_bundle")
    fi
    [[ "$new_bundle" != "$old_bundle" ]] || fail '相同发布版本，无需升级。'
    allow_schema "$new_bundle"
    [[ -z "${current_schema:-}" ]] || allow_schema "$current_schema"
    activate_bundle "$old_bundle"; status_check
    [[ "${refs[web]#*:}" != "$(awk '$1=="web" {sub(/^.*:/,"",$2);print $2}' "$new_bundle/images.tsv")" ]] || fail '相同版本，无需升级。'
    activate_bundle "$new_bundle"; compare_migrations
    activate_bundle "$old_bundle"
    backup_location "$backup_dir"
    [[ -e "$backup_dir" ]] || { trusted_path "$(dirname "$backup_dir")"; mkdir -m 700 -- "$backup_dir"; }
    private_directory "$backup_dir"
    backup_space_check
    if [[ ! -e "$state/current" ]]; then write_current "$old_bundle" "$new_bundle"; fi
    printf '【危险】停止应用、强制备份后迁移；项目 %s。\n' "$project"
    upgrade_phase=before
    dc stop --timeout 60 web worker >/dev/null 2>&1 || fail '停止应用失败。'
    stopped_writers; create_snapshot; publish_snapshot upgrade
    rollback_snapshot=$saved_snapshot
    state_write previous "$old_bundle" "$release" "$rollback_snapshot" "$new_bundle"
    activate_bundle "$new_bundle"
    state_write pending upgrade
    upgrade_phase=after
    prisma deploy; prisma status
    rebuild_apps
    write_current "$new_bundle" "$new_bundle"
  else
    state_file "$state/previous"
    read -r old_bundle old_release rollback_snapshot new_bundle extra < "$state/previous"
    [[ -z "$extra" && -n "$new_bundle" ]] || fail '回退记录格式不符。'
    verified_bundle "$new_bundle"; allow_schema "$new_bundle"
    verified_bundle "$old_bundle"
    [[ -f "$old_bundle/deployment-media-reregister.sh" && ! -L "$old_bundle/deployment-media-reregister.sh" ]] || fail '旧包不支持登记，回退后无法安全开站。'
    [[ "$current_bundle" == "$old_bundle" || "$current_bundle" == "$new_bundle" ]] || fail '当前版本不属于回退记录。'
    # Both running and partially recreated containers must belong to this transition.
    for role in web worker; do
      container=$(dc ps --all --quiet "$role")
      [[ -z "$container" ]] && continue
      actual=$(d inspect --format '{{.Image}}' "$container")
      [[ "$actual" == "$(awk -v r="$role" '$1==r {print $3}' "$new_bundle/images.tsv")" || "$actual" == "$(awk -v r="$role" '$1==r {print $3}' "$old_bundle/images.tsv")" ]] || fail '容器不属于回退记录中的版本。'
      check_mounts "$container"
    done
    activate_bundle "$old_bundle"
    backup_location "$backup_dir"
    [[ "$release" == "$old_release" ]] || fail '回退版本记录不符。'
    backup_location "$rollback_snapshot"; verify_snapshot "$rollback_snapshot"
    [[ -e "$backup_dir" ]] || { trusted_path "$(dirname "$backup_dir")"; mkdir -m 700 -- "$backup_dir"; }
    private_directory "$backup_dir"
    backup_space_check
    printf '【危险】恢复升级前备份，升级后数据将丢弃；项目 %s。\n' "$project"
    state_write pending rollback
    upgrade_phase=after
    dc stop --timeout 60 web worker >/dev/null 2>&1 || fail '停止应用失败。'
    stopped_writers
    # Preserve the present (possibly partially migrated) state before overwriting it.
    release=$(awk '$1=="web" {sub(/^.*:/,"",$2);print $2}' "$new_bundle/images.tsv")
    create_snapshot; publish_snapshot rescue
    release=$old_release
    backup_source=$rollback_snapshot
    verify_snapshot "$backup_source"
    restore_snapshot
    rebuild_apps
    state_write media-registration.pending running
    write_current "$old_bundle" "$new_bundle"
  fi
  history success
  [[ "$command" != rollback ]] || rm -f -- "$state/previous"
  rm -f -- "$state/pending"
  upgrade_phase=''
  prune_backups
  printf 'PASS: %s。\n' "$command"
  if [[ "$command" == rollback ]]; then
    printf '保持停站；登记成功后自动启动旧版本并检查健康。\n'
    registration_command
  fi
}
