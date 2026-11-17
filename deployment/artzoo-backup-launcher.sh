#!/usr/bin/env bash
# Install once; select the recorded release as data, never by directory timestamps.
set +x
set -euo pipefail
fail() { printf '停止：%s\n' "$1" >&2; exit 1; }
root='' backup_dir='' keep=7 keep_maintenance=3 project=artzoo
while (($#)); do
  (($# >= 2)) || fail '选项缺少值。'
  case "$1" in
    --root) root=$2;; --backup-dir) backup_dir=$2;; --keep) keep=$2;;
    --keep-maintenance) keep_maintenance=$2;; --project) project=$2;;
    *) fail '未知启动器选项。';;
  esac
  shift 2
done
trusted_path() {
  local path=$1 owner mode
  [[ "$(realpath -e -- "$path")" == "$path" ]] || fail '目录缺失或路径含符号链接。'
  while :; do
    owner=$(stat -c %u "$path"); mode=$(stat -c %a "$path")
    [[ "$owner" == 0 || "$owner" == 1000 ]] || fail '目录所有者不可信。'
    (( (8#$mode & 022) == 0 )) || fail '目录允许组或其他用户写入。'
    [[ "$path" != / ]] || break
    path=$(dirname -- "$path")
  done
}
[[ "$root" =~ ^/([a-zA-Z0-9_.-]+/)*[a-zA-Z0-9_.-]+$ && "$root" != / ]] || fail '站点目录须为无空格的绝对路径。'
[[ "$(id -u):$(id -g)" == 1000:1000 ]] || fail '请使用镜像对应的 UID/GID 1000 用户执行，不要 sudo 整个脚本。'
backup_result() {
  local code=$1 result=failed detail="reason=$backup_reason" record="$root/deploy/backup-last" temp version=${backup_release:-unknown}
  [[ "$code" != 0 ]] || { result=success; detail="backup=${saved_snapshot:--}"; }
  if [[ "$version" == unknown ]] && (trusted_path "$root/deploy/current" && [[ -f "$root/deploy/current" && "$(stat -c %s "$root/deploy/current")" -le 4096 ]]) >/dev/null 2>&1; then
    read -r _ version _ < "$root/deploy/current" || version=unknown
    [[ "$version" =~ ^(git|dev)-[0-9a-f]{12}-[0-9]{14}-[0-9]+$ ]] || version=unknown
  fi
  (trusted_path "$root/deploy" && { [[ ! -e "$record" && ! -L "$record" ]] || { [[ -f "$record" && ! -L "$record" ]] && trusted_path "$record"; }; }) >/dev/null 2>&1 || return 1
  temp=$(mktemp "$root/deploy/.backup-last.XXXXXXXX") || return 1
  if ! printf '%s result=%s release=%s %s\n' "$(date -u +%FT%TZ)" "$result" "$version" "$detail" > "$temp" || ! mv -T -- "$temp" "$record"; then
    rm -f -- "$temp"; return 1
  fi
}
backup_exit() {
  local code=$?
  trap - EXIT
  if ! backup_result "$code"; then printf '警告：无法安全写入 deploy/backup-last。\n' >&2; code=1; fi
  exit "$code"
}
umask 077
backup_reason=current-invalid backup_release=unknown
trap backup_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
record="$root/deploy/current"
trusted_path "$record"
[[ -f "$record" && ! -L "$record" && "$(stat -c %s "$record")" -le 4096 ]] || fail '当前版本记录缺失或不可信；不猜测版本。'
mapfile -t records < "$record"
[[ ${#records[@]} == 1 ]] || fail '当前版本记录必须只有一行。'
read -r bundle version schema extra <<< "${records[0]}"
[[ -z "$extra" && "$version" =~ ^(git|dev)-[0-9a-f]{12}-[0-9]{14}-[0-9]+$ ]] || fail '当前版本格式不符。'
backup_release=$version
for directory in "$bundle" "$schema"; do
  [[ "$directory" =~ ^/([a-zA-Z0-9_.-]+/)*[a-zA-Z0-9_.-]+$ && -d "$directory" ]] || fail '当前版本目录不存在或不可信；不猜测版本。'
  trusted_path "$directory"
done
backup_reason=bundle-invalid
for file in deployment-images.sh deployment-maintenance.sh artzoo-backup-launcher.sh; do
  [[ -f "$bundle/$file" && ! -L "$bundle/$file" ]] || fail '当前包不支持固定备份入口；请先升级，不修改旧包。'
  trusted_path "$bundle/$file"
done
bash "$bundle/deployment-images.sh" verify "$bundle" >/dev/null 2>&1 || fail '当前发布包校验失败。'
[[ "$(awk '$1=="web" {sub(/^.*:/,"",$2);print $2}' "$bundle/images.tsv")" == "$version" ]] || fail '当前版本记录与发布包不一致。'
for mark in pending media-registration.pending; do
  if [[ -e "$root/deploy/$mark" || -L "$root/deploy/$mark" ]]; then backup_reason=$mark; fail "维护尚未完成：$mark；不执行备份。"; fi
done
backup_reason=exec-failed
exec bash "$bundle/deployment-maintenance.sh" backup --root "$root" --project "$project" --backup-dir "${backup_dir:-$root/backups}" --keep "$keep" --keep-maintenance "$keep_maintenance"
