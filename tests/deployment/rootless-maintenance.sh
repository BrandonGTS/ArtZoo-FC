#!/usr/bin/env bash
# Run the real maintenance tests with the same UID mapping as the rootless daemon.
# Only a fresh sibling scratch directory and a private mount namespace are modified.
set -euo pipefail
if [[ "${1:-}" == --inside ]]; then
  shift
  scratch=$1 socket=$2 repo=$3 bundle=$4 node_bin=$5 compose_bin=$6
  socket_group=$(stat -c %g "$socket")
  cp -a --reflink=auto -- "$bundle" "$scratch/bundle"
  bundle="$scratch/bundle"
  chown -R 1000:1000 "$bundle"
  jail="$scratch/jail"
  mkdir "$jail"
  mount -t tmpfs -o mode=755 tmpfs "$jail"
  # The host's real root UID is unmapped here. A private root gives the fixture
  # trusted ancestors without changing ownership or permissions on the host.
  for directory in /usr /bin /lib /lib64 /etc /dev /proc; do
    mkdir -p "$jail$directory"
    mount --rbind "$directory" "$jail$directory"
  done
  mkdir -p "$jail/run" "$jail/var" "$jail/tools" "$jail/tmp" \
    "$jail$repo/scripts" "$jail$repo/tests/deployment" "$jail$bundle" "$jail$scratch"
  chmod 1777 "$jail/tmp"
  ln -s /run "$jail/var/run"
  touch "$jail/run/docker.sock" "$jail/tools/node" "$jail/tools/docker-compose"
  mount --bind "$socket" "$jail/run/docker.sock"
  mount --bind "$node_bin" "$jail/tools/node"
  install -m 755 "$compose_bin" "$scratch/docker-compose"
  mount --bind "$scratch/docker-compose" "$jail/tools/docker-compose"
  for directory in "$repo/scripts" "$repo/tests/deployment" "$bundle" "$scratch"; do
    mount --bind "$directory" "$jail$directory"
  done
  install -d -o 1000 -g 1000 -m 700 "$scratch/home"
  chown 1000:1000 "$scratch"
  exec chroot "$jail" /usr/bin/setpriv --reuid=1000 --regid=1000 --groups="0,$socket_group" \
    /usr/bin/env HOME="$scratch/home" PATH=/tools:/usr/bin:/bin \
    DOCKER_HOST=unix:///var/run/docker.sock ARTZOO_MAINTENANCE_TEST_BUNDLE="$bundle" \
    /bin/bash -c 'cd "$1" && exec node --test "$2/tests/deployment/maintenance.test.mjs"' bash "$scratch" "$repo"
fi
[[ $# == 1 ]] || { printf 'Usage: bash tests/deployment/rootless-maintenance.sh RELEASE_DIRECTORY\n' >&2; exit 1; }
[[ "$(id -u):$(id -g)" == 1000:1000 ]]
docker --host unix:///var/run/docker.sock info --format '{{json .SecurityOptions}}' | grep -q 'name=rootless'
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
bundle=$(realpath -e -- "$1")
node_bin=$(command -v node)
compose_bin=$(command -v docker-compose)
pid=$(pgrep -u "$(id -u)" -x dockerd)
[[ "$pid" =~ ^[0-9]+$ ]] || { printf 'Expected one rootless dockerd.\n' >&2; exit 1; }
socket=$(realpath -e /var/run/docker.sock)
scratch=$(mktemp -d "$(dirname "$repo")/artzoo-rootless-test.XXXXXXXX")
cleanup() {
  local status=$?
  trap - EXIT
  # Refuse to delete anything except this invocation's fresh, resolved sibling.
  if [[ "$scratch" == "$(dirname "$repo")/artzoo-rootless-test."* && ! -L "$scratch" && "$(realpath -e "$scratch")" == "$scratch" ]]; then
    nsenter --user="/proc/$pid/ns/user" --setuid=0 --setgid=0 -- rm -rf --one-file-system -- "$scratch" || status=1
  else status=1; fi
  exit "$status"
}
trap cleanup EXIT
printf 'Isolated rootless maintenance test; scratch: %s\n' "$scratch"
nsenter --user="/proc/$pid/ns/user" --setuid=0 --setgid=0 -- \
  unshare --mount --propagation private bash "$repo/tests/deployment/rootless-maintenance.sh" \
  --inside "$scratch" "$socket" "$repo" "$bundle" "$node_bin" "$compose_bin"
