#!/usr/bin/env bash
# Foreground WSL process, explicitly launched by Windows; no boot registration.
set -euo pipefail
fail() { printf 'Resident control refused; check target and permissions.\n' >&2; exit 1; }
[[ $# == 2 && "$1" =~ ^(hold|status|release)$ && "$2" =~ ^/([a-zA-Z0-9_.-]+/)*[a-zA-Z0-9_.-]+$ ]] || fail
action=$1 directory="$2/secrets"
[[ "$(id -u):$(id -g)" == 1000:1000 && "$(realpath -e -- "$directory")" == "$directory" ]] || fail
[[ "$(stat -c '%u:%g:%a' "$directory")" == 1000:1000:700 ]] || fail
path=$directory
while :; do
  owner=$(stat -c %u "$path"); mode=$(stat -c %a "$path")
  [[ "$owner" == 0 || "$owner" == 1000 ]] && (( (8#$mode & 022) == 0 )) || fail
  [[ "$path" != / ]] || break
  path=$(dirname -- "$path")
done
umask 077
lock="$directory/.resident.lock" request="$directory/.resident.request"
for file in "$lock" "$request" "$directory/.resident-control.lock"; do
  [[ ! -L "$file" && ( ! -e "$file" || ( -f "$file" && "$(stat -c '%u:%g:%a:%h' "$file")" == 1000:1000:600:1 ) ) ]] || fail
done
exec 9>"$directory/.resident-control.lock"
flock -w 10 9 || fail
exec 8>"$lock"
case "$action" in
  status)
    if flock -n 8; then printf 'Resident: stopped\n'; exit 3; fi
    [[ -f "$request" ]] || fail
    printf 'Resident: running\n';;
  release)
    rm -f -- "$request"
    flock -w 10 8 || fail
    printf 'Resident: stopped\n';;
  hold)
    flock -n 8 || exit 0
    : > "$request"
    flock -u 9
    trap 'rm -f -- "$request"' EXIT
    trap 'exit 0' INT TERM
    while [[ -f "$request" ]]; do sleep 1; done;;
esac
