#!/usr/bin/env bash
# Sourced only by the checksummed maintenance entry; shares its target checks and lock.
resume_apps=0 destructive_restore=0 snapshot='' saved_snapshot='' restore_sql=''
migrations_query='SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name;'
io() { "${privilege[@]}" timeout --kill-after=10s 3600s "$docker_path" --host unix:///var/run/docker.sock "$@"; }
restart_apps() {
  dc start --wait --wait-timeout 120 web worker >/dev/null 2>&1 && (status_check) || return 1
  resume_apps=0
}
backup_cleanup() {
  local failed=0 stop_option=''
  if [[ "$resume_apps" == 1 ]]; then
    restart_apps || { printf '备份后重启/健康检查失败，请检查并执行同一发布包的 start。\n' >&2; failed=1; }
  fi
  if [[ "$destructive_restore" == 1 ]]; then
    dc stop --timeout 60 web worker >/dev/null 2>&1 || failed=1
    printf '恢复未完成，保持停站。先排查原因；当前状态备份：%s\n' "$saved_snapshot" >&2
    [[ "$keep_stopped" != true && ! -e "$state/media-registration.pending" ]] || stop_option=' --keep-stopped true'
    printf '【危险】恢复命令：bash %q restore --bundle %q --root %q --project %q --backup-dir %q --backup %q%s\n' "$bundle/deployment-maintenance.sh" "$bundle" "$root" "$project" "$backup_dir" "$saved_snapshot" "$stop_option" >&2
  fi
  [[ -z "$restore_sql" ]] || rm -f -- "$restore_sql" || failed=1
  [[ -z "$snapshot" ]] || printf '未发布的临时备份保留在：%s\n' "$snapshot" >&2
  return "$failed"
}
backup_location() {
  local path=$1
  [[ "$path" =~ ^/([a-zA-Z0-9_.-]+/)*[a-zA-Z0-9_.-]+$ && "$path" != / ]] || fail '备份目录须为无空格的绝对路径。'
  [[ "$(realpath -m -- "$path")" == "$path" ]] || fail '备份路径不可含链接或点路径。'
  [[ "$path" != "$root" && "$path" != "$root/media"* && "$path" != "$root/secrets"* && "$path" != "$bundle" && "$path" != "$bundle/"* ]] || fail '备份目录不能覆盖站点、媒体、秘密或发布包。'
}
private_directory() {
  trusted_path "$1"
  [[ -d "$1" && "$(stat -c '%u:%g:%a' "$1")" == 1000:1000:700 ]] || fail '备份目录需要 UID/GID 1000、0700。'
}
verify_snapshot() {
  local directory=$1 matching=${2:-1} kind hash size name extra file expected actual mode owner date time count=0
  local -A seen=() paths=()
  private_directory "$directory"
  [[ -f "$directory/manifest" && ! -L "$directory/manifest" && "$(stat -c %s "$directory/manifest")" -le 4096 ]] || fail '备份清单缺失或过大。'
  # Strict data grammar: no shell evaluation and no paths supplied by a checksum tool.
  while read -r kind hash size name extra; do
    [[ -z "$extra" ]] || fail '备份清单格式不符。'
    case "$kind" in
      format|release|postgres|project)
        [[ -z "$size$name" && ! -v "seen[$kind]" ]] || fail '备份清单字段重复。'
        seen[$kind]=$hash;;
      file)
        [[ "$name" == database.dump || "$name" == media.tar || "$name" == migrations.txt ]] || fail '备份清单路径不符。'
        [[ ! -v "seen[$name]" && "$hash" =~ ^[0-9a-f]{64}$ && "$size" =~ ^(0|[1-9][0-9]*)$ ]] || fail '备份文件清单不符。'
        seen[$name]=1; file="$directory/$name"
        [[ -f "$file" && ! -L "$file" && "$(stat -c %s "$file")" == "$size" ]] || fail '备份文件缺失或大小不符。'
        actual=$(sha256sum -- "$file"); [[ "${actual%% *}" == "$hash" ]] || fail '备份校验和不符。';;
      *) fail '备份清单字段未知。';;
    esac
    count=$((count + 1))
  done < "$directory/manifest"
  [[ "$count" == 7 && "${seen[format]:-}" == 1 && "${seen[project]:-}" == "$project" && "${seen[postgres]:-}" == "$pg_image" && -v 'seen[database.dump]' && -v 'seen[media.tar]' && -v 'seen[migrations.txt]' ]] || fail '备份清单不完整，或项目/PostgreSQL 镜像不匹配。'
  [[ "${seen[release]:-}" =~ ^(git|dev)-[0-9a-f]{12}-[0-9]{14}-[0-9]+$ ]] || fail '备份版本格式不符。'
  [[ "$matching" == 0 || "${seen[release]:-}" == "$release" ]] || fail '备份发布版本不一致；请先切换到清单 release 对应的完整发布包和镜像。'
  [[ "$(find "$directory" -mindepth 1 -maxdepth 1 -printf x | wc -c)" == 4 ]] || fail '备份含额外内容。'
  # Only application-owned regular files and directories are allowed. Reject traversal,
  # links, devices and escaped/ambiguous names before any extraction or database change.
  actual=$(LC_ALL=C tar --list --verbose --numeric-owner --quoting-style=escape --file "$directory/media.tar" 2>/dev/null) || fail '媒体归档不可读。'
  seen=()
  while read -r mode owner size date time name; do
    [[ "$mode" =~ ^[-d][rwx-]{9}$ && "$owner" == 1000/1000 && "$name" =~ ^(original|derived|avatars)(/[a-zA-Z0-9_.-]+)*/?$ && "/$name/" != */../* && "/$name/" != */./* ]] || fail '媒体归档包含不安全的类型、属主、权限或路径。'
    expected=${name%/}
    [[ ! -v "paths[$expected]" ]] || fail '媒体归档路径重复。'; paths[$expected]=1
    if [[ "$name" == original/ || "$name" == derived/ || "$name" == avatars/ ]]; then
      [[ "$mode" == drwx------ ]] || fail '媒体根目录权限不符。'; seen[$name]=1
    fi
  done <<< "$actual"
  [[ ${#seen[@]} == 3 ]] || fail '媒体归档缺少三个根目录。'
  io run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --entrypoint pg_restore "$pg_image" --list < "$directory/database.dump" >/dev/null 2>&1 || fail '数据库备份不可读。'
}
stopped_writers() {
  local id source mounts
  [[ "$(d ps --filter "label=com.docker.compose.project=$project" --format '{{.ID}}')" == "${postgres:0:12}" ]] || fail '项目仍有写入容器；拒绝备份/恢复。'
  for id in $(d ps -q); do
    mounts=$(d inspect --format '{{range .Mounts}}{{if .RW}}{{println .Source}}{{end}}{{end}}' "$id")
    while IFS= read -r source; do
      [[ -z "$source" ]] && continue
      [[ "$source" != "$root/media" && "$source" != "$root/media/"* && "$root/media" != "$source/"* ]] || fail '其他容器仍可写媒体，请先停止。'
    done <<< "$mounts"
  done
  [[ "$(find "$root/media" -xdev -type d -printf '%D\n' | sort -u)" == "$(stat -c %d "$root/media")" ]] || fail '媒体中有嵌套挂载，拒绝跳过文件。'
  [[ -z "$(find "$root/media" -xdev -mindepth 1 ! -type f ! -type d -print -quit)" ]] || fail '媒体目录包含链接或特殊文件。'
  [[ -z "$(find "$root/media" -xdev -type f -links +1 -print -quit)" ]] || fail '媒体目录包含硬链接。'
}
create_snapshot() {
  local file hash
  snapshot=$(mktemp -d "$backup_dir/.partial.XXXXXXXX")
  io exec "$postgres" pg_dump -w -U artzoo -d artzoo --format=custom > "$snapshot/database.dump" 2>/dev/null || fail '数据库备份失败。'
  sql "$migrations_query" > "$snapshot/migrations.txt" || fail '迁移清单读取失败。'
  tar --create --numeric-owner --one-file-system --file "$snapshot/media.tar" --directory "$root/media" original derived avatars 2>/dev/null || fail '媒体备份失败。'
  {
    printf 'format 1\nrelease %s\npostgres %s\nproject %s\n' "$release" "$pg_image" "$project"
    for file in database.dump media.tar migrations.txt; do
      hash=$(sha256sum -- "$snapshot/$file")
      printf 'file %s %s %s\n' "${hash%% *}" "$(stat -c %s "$snapshot/$file")" "$file"
    done
  } > "$snapshot/manifest"
  verify_snapshot "$snapshot"
}
publish_snapshot() {
  saved_snapshot="$backup_dir/$1-$(date -u +%Y%m%dT%H%M%S%N)-$release"
  [[ ! -e "$saved_snapshot" ]] || fail '备份名称冲突。'
  mv -T -- "$snapshot" "$saved_snapshot"; snapshot=''
  printf '备份已保存：%s\n' "$saved_snapshot"
}
backup_estimate() {
  local database media
  database=$(sql 'SELECT pg_database_size(current_database());') || fail '无法估算数据库大小。'
  media=$(du --apparent-size --block-size=1 --summarize --total -- "$root/media/"{original,derived,avatars}) || fail '无法估算媒体大小。'
  media=${media##*$'\n'}; media=${media%%$'\t'*}
  [[ "$database" =~ ^[0-9]{1,16}$ && "$media" =~ ^[0-9]{1,16}$ ]] || fail '备份估算值不符。'
  estimate=$((database + media))
}
backup_available() {
  local location=$backup_dir
  while [[ ! -e "$location" ]]; do location=$(dirname -- "$location"); done
  trusted_path "$location"
  available=$(df --block-size=1 --output=avail -- "$location" | awk 'NR==2 {print $1}') || fail '无法读取备份文件系统空间。'
  [[ "$available" =~ ^[0-9]{1,16}$ ]] || fail '备份剩余空间值不符。'
}
backup_space_check() {
  local estimate available required
  backup_estimate; backup_available
  required=$(((estimate * 3 + 1) / 2 + 1000000000))
  ((available >= required)) || fail "备份空间不足：需要 ${required} 字节，剩余 ${available} 字节；尚未停站。"
}
snapshot_name() { [[ "$1" =~ ^(backup|upgrade|register|rescue)-[0-9]{8}T[0-9]{15}-(git|dev)-[0-9a-f]{12}-[0-9]{14}-[0-9]+$ ]]; }
prune_backups() {
  local directory kind count limit newest protected='' old version next extra
  local -a candidates=()
  if [[ -e "$state/previous" || -L "$state/previous" ]]; then
    state_file "$state/previous"
    read -r old version protected next extra < "$state/previous"
    [[ -n "$old" && -n "$next" && -z "$extra" && "$version" =~ ^(git|dev)-[0-9a-f]{12}-[0-9]{14}-[0-9]+$ ]] || fail '回退记录不符，拒绝清理备份。'
    backup_location "$protected"
  fi
  for kind in backup upgrade register rescue; do
    count=0; newest=''; limit=$keep_maintenance
    [[ "$kind" != backup ]] || limit=$keep
    mapfile -d '' -t candidates < <(find "$backup_dir" -mindepth 1 -maxdepth 1 -type d -name "$kind-*" -print0 | LC_ALL=C sort -zr)
    for directory in "${candidates[@]}"; do
      if ! snapshot_name "${directory##*/}"; then printf '保留未知备份目录：%q\n' "$directory"; continue; fi
      [[ -n "$newest" ]] || newest=$directory
      if (verify_snapshot "$directory" 0) >/dev/null 2>&1; then
        count=$((count + 1))
        # Protected copies may exceed the limit, including after a backward clock jump.
        if ((count > limit)) && [[ "$directory" != "$newest" && "$directory" != "$saved_snapshot" && "$directory" != "$protected" ]]; then
          rm -rf --one-file-system -- "$directory"
        fi
      else printf '保留未通过校验的备份：%q\n' "$directory"
      fi
    done
  done
}
backup_status() {
  local directory name kind stamp epoch latest_time count used=0 partial=0 other=0 estimate available
  local -A counts=() latest=()
  backup_dir=${backup_dir:-$root/backups}; backup_location "$backup_dir"
  printf '备份：目录=%s\n' "$backup_dir"
  if [[ -e "$backup_dir" ]]; then
    private_directory "$backup_dir"
    used=$(du --summarize --block-size=1 -- "$backup_dir") || fail '无法统计备份占用。'
    used=${used%%$'\t'*}
    while IFS= read -r -d '' directory; do
      name=${directory##*/}; kind=${name%%-*}
      case "$name" in
        .partial.*) partial=$((partial + 1)); printf '保留临时目录：%q\n' "$directory"; continue;;
        backup-*|upgrade-*|register-*|rescue-*) counts[$kind]=$((${counts[$kind]:-0} + 1));;
        *) other=$((other + 1)); printf '保留未知目录：%q\n' "$directory"; continue;;
      esac
      if ! snapshot_name "$name"; then printf '保留未知备份目录：%q\n' "$directory"; continue; fi
      stamp=${name#*-}; stamp=${stamp%%-*}
      epoch=$(date -u -d "${stamp:0:4}-${stamp:4:2}-${stamp:6:2} ${stamp:9:2}:${stamp:11:2}:${stamp:13:2}" +%s 2>/dev/null) || continue
      if ((epoch > ${latest[$kind]:-0})); then latest[$kind]=$epoch; fi
    done < <(find "$backup_dir" -mindepth 1 -maxdepth 1 -type d -print0)
  fi
  backup_available
  printf '总占用=%s 字节；文件系统剩余=%s 字节\n' "$used" "$available"
  for kind in backup upgrade register rescue; do
    latest_time=无
    [[ ! -v "latest[$kind]" ]] || latest_time=$(date -u -d "@${latest[$kind]}" +%FT%TZ)
    printf '%s：份数=%s；最新时间=%s\n' "$kind" "${counts[$kind]:-0}" "$latest_time"
  done
  printf '.partial.*：数量=%s；其他目录=%s（统计不代表校验通过）\n' "$partial" "$other"
  if [[ ! -v 'latest[backup]' ]]; then printf '警告：没有可识别时间的 backup 备份。\n'
  elif (($(date -u +%s) - latest[backup] > 129600)); then printf '警告：最新 backup 备份已超过 36 小时。\n'; fi
  backup_estimate
  printf '下次备份估算=%s 字节\n' "$estimate"
  if ((available < estimate * 2)); then printf '警告：剩余空间低于下次备份估算值的 2 倍。\n'; fi
}
backup_main() {
  local reference file running='' previous=running
  release=${refs[web]#*:}
  pg_image=$(d inspect --format '{{.Image}}' "$postgres")
  reference=$(dc config --images | LC_ALL=C sort -u | grep '^postgres:')
  [[ "$pg_image" == "$(d image inspect --format '{{.Id}}' "$reference")" ]] || fail '数据库镜像与发布包配置不一致。'
  [[ "$keep" =~ ^[1-9][0-9]{0,3}$ ]] || fail '保留份数必须为 1–9999。'
  backup_dir=${backup_dir:-$root/backups}
  backup_location "$backup_dir"
  if [[ "$command" != backup ]]; then
    [[ -n "$backup_source" ]] || fail '必须用 --backup 指定备份目录。'
    backup_location "$backup_source"
    verify_snapshot "$backup_source"
    if [[ "$command" == backup-verify ]]; then printf 'PASS: backup-verify。\n'; return; fi
  else
    [[ -z "$backup_source" ]] || fail 'backup 不接受 --backup。'
  fi
  if [[ ! -e "$backup_dir" ]]; then trusted_path "$(dirname "$backup_dir")"; mkdir -m 700 -- "$backup_dir"; fi
  private_directory "$backup_dir"
  identity; check_app web; check_app worker
  if [[ "$command" == backup ]]; then status_check; fi
  if [[ "$command" == restore ]]; then
    for file in web worker; do
      running+="$(d inspect --format '{{.State.Running}}' "$(dc ps --all --quiet "$file")") "
    done
    case "$running" in 'true true ') previous=running;; 'false false ') previous=stopped;; *) fail '应用运行状态不一致，请先明确停站。';; esac
  fi
  backup_reason=space-check
  backup_space_check
  backup_reason=snapshot-failed
  printf '【危险】停止 web、worker 并保持宿主媒体停写；项目 %s。\n' "$project"
  [[ "$previous" != running ]] || resume_apps=1
  dc stop --timeout 60 web worker >/dev/null 2>&1 || fail '停止应用失败。'
  stopped_writers
  create_snapshot
  if [[ "$command" == backup ]]; then
    backup_reason=restart-failed
    restart_apps || fail '备份后启动/健康检查失败。'
    backup_reason=publish-failed
    publish_snapshot backup
    backup_reason=prune-failed
    prune_backups
    printf 'PASS: backup。\n'; return
  fi
  # Rescue snapshots are retained until a later successful maintenance operation.
  publish_snapshot rescue
  verify_snapshot "$backup_source"
  printf '【危险】覆盖项目 %s 的数据库和三个媒体目录。\n' "$project"
  resume_apps=0; destructive_restore=1
  [[ "$keep_stopped" != true ]] || previous=stopped
  [[ -d "$state" ]] || mkdir -m 700 -- "$state"
  trusted_path "$state"; state_write media-registration.pending "$previous"
  restore_snapshot
  destructive_restore=0
  printf 'PASS: restore；保持停站，登记成功后应恢复状态=%s。\n' "$previous"
  registration_command
}

restore_snapshot() {
  local file
  # Prepare the complete SQL before beginning the transaction: a failed producer
  # must never let psql commit a truncated restore. ArtZoo owns only public schema.
  [[ "$(sql "SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('public','information_schema') AND nspname NOT LIKE 'pg_%';")" == 0 ]] || fail '存在额外数据库 schema，拒绝覆盖。'
  restore_sql=$(mktemp "$backup_dir/.restore.XXXXXXXX.sql")
  printf 'DROP SCHEMA public CASCADE;\nCREATE SCHEMA public AUTHORIZATION artzoo;\n' > "$restore_sql"
  io run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --entrypoint pg_restore "$pg_image" --file=- < "$backup_source/database.dump" >> "$restore_sql" 2>/dev/null || fail '无法生成恢复 SQL。'
  io exec -i "$postgres" psql -X -w -U artzoo -d artzoo --single-transaction -v ON_ERROR_STOP=1 -f - < "$restore_sql" >/dev/null 2>&1 || fail '数据库恢复失败，数据库事务已回滚。'
  [[ "$(sql "$migrations_query")" == "$(cat "$backup_source/migrations.txt")" ]] || fail '恢复后的迁移列表不符。'
  for file in original derived avatars; do
    private_directory "$root/media/$file"
    find "$root/media/$file" -xdev -mindepth 1 -delete || fail '清空媒体失败。'
  done
  tar --extract --numeric-owner --same-owner --same-permissions --file "$backup_source/media.tar" --directory "$root/media" 2>/dev/null || fail '媒体恢复失败。'
}
