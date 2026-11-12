#!/usr/bin/env bash
# Ubuntu/WSL entry point. No source checkout or host Node is needed for import/check.
set -Eeuo pipefail
export GIT_OPTIONAL_LOCKS=0
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
script_path="$script_dir/deployment-images.sh"
helper="$script_dir/deployment-image-check.mjs"
docker_cmd=()
token="artzoo-images-$(date +%s)-$$-$RANDOM"
scope_label="artzoo.image-check=$token"
partial=''
declare -A refs=() ids=()
roles=()
config_files=(compose.yaml .env.example images.env deployment-compose-check.sh)
maintenance_file=deployment-maintenance.sh

fail() { printf '错误：%s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'HELP'
用法：
  bash scripts/deployment-images.sh build [--output 目录] [--target all|web|worker|tools] [--allow-dirty]
  bash deployment-images.sh verify 发布包目录
  bash deployment-images.sh import 发布包目录
  bash deployment-images.sh check 发布包目录 [--database]

build：开发端构建、基础验证并导出；默认三个镜像、干净工作区，输出到仓库外。
verify：仅验证文件清单和校验和，不连接 Docker。
import：运行端校验并导入；不启动或替换网站。重复导入同一版本可安全跳过。
check：运行端临时容器验收。--database 额外创建隔离空库，执行迁移和 worker 写操作。
服务器只需要 Bash、Docker 和常用 GNU 工具；不需要源码、Node、pnpm 或 Python。
HELP
}
d() { "${docker_cmd[@]}" "$@"; }
engine() {
  command -v docker >/dev/null || fail '请先安装 Docker。'
  docker_cmd=(docker --host unix:///var/run/docker.sock)
  if ! d info >/dev/null 2>&1; then
    command -v sudo >/dev/null || fail '无法访问本机 Docker。'
    sudo -v || fail '无法取得 Docker 操作权限。'
    docker_cmd=(sudo docker --host unix:///var/run/docker.sock)
    d info >/dev/null || fail '本机 Docker 不可用。'
  fi
}
cleanup() {
  local status=$? id resources
  trap - EXIT
  set +e
  if ((${#docker_cmd[@]})); then
    # Only resources bearing this invocation's unique label are eligible.
    if resources=$(d ps --all --quiet --filter "label=$scope_label"); then
      while read -r id; do
        [[ -z "$id" ]] || d rm --force --volumes "$id" >/dev/null || status=1
      done <<< "$resources"
    else status=1; fi
    if resources=$(d network ls --quiet --filter "label=$scope_label"); then
      while read -r id; do
        [[ -z "$id" ]] || d network rm "$id" >/dev/null || status=1
      done <<< "$resources"
    else status=1; fi
    if [[ "$status" != 0 ]]; then
      printf '如需排查本次测试资源，请核对标签：%s\n' "$scope_label" >&2
    fi
  fi
  if [[ -n "$partial" ]]; then
    printf '构建未完成；检查后可手动删除临时发布目录：%s\n' "$partial" >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

load_bundle() {
  [[ -d "$1" ]] || fail '发布包目录不存在。'
  bundle=$(realpath -e -- "$1")
  local file hash extra name role ref id platform version='' current config_count=0 maintenance_count=0 expected actual
  local -A sums=() seen=()
  for file in SHA256SUMS images.tsv images.tar source.txt deployment-images.sh deployment-image-check.mjs; do
    [[ -f "$bundle/$file" && ! -L "$bundle/$file" ]] || fail "发布包缺少普通文件：$file"
  done
  # Never source package metadata or accept checksum paths outside the bundle.
  while read -r hash name extra || [[ -n "${hash:-}${name:-}${extra:-}" ]]; do
    [[ "$hash" =~ ^[0-9a-f]{64}$ && -z "$extra" ]] || fail '校验清单格式错误。'
    case "$name" in
      images.tsv|images.tar|source.txt|deployment-images.sh|deployment-image-check.mjs) ;;
      deployment-maintenance.sh) maintenance_count=$((maintenance_count + 1)) ;;
      compose.yaml|.env.example|images.env|deployment-compose-check.sh) config_count=$((config_count + 1)) ;;
      *) fail '校验清单包含非预期路径。';;
    esac
    [[ -z "${sums[$name]:-}" ]] || fail '校验清单含重复文件。'
    sums[$name]=1
  done < "$bundle/SHA256SUMS"
  [[ "$config_count" == 0 || "$config_count" == 4 ]] || fail '运行模板清单不完整。'
  ((${#sums[@]} == 5 + config_count + maintenance_count)) || fail '校验清单不完整。'
  if [[ "$maintenance_count" == 1 ]]; then
    [[ "$config_count" == 4 && -f "$bundle/$maintenance_file" && ! -L "$bundle/$maintenance_file" ]] || fail '维护入口需要完整且经过校验的运行模板。'
  else
    [[ ! -e "$bundle/$maintenance_file" && ! -L "$bundle/$maintenance_file" ]] || fail '发现未经校验的维护入口。'
  fi
  for file in "${config_files[@]}"; do
    if [[ "$config_count" == 4 ]]; then
      [[ -f "$bundle/$file" && ! -L "$bundle/$file" ]] || fail "发布包缺少普通文件：$file"
    else
      [[ ! -e "$bundle/$file" && ! -L "$bundle/$file" ]] || fail '发现未经校验的运行模板。'
    fi
  done
  (cd -- "$bundle" && sha256sum --check --strict SHA256SUMS) || fail '发布包校验失败；请重新传输。'
  refs=(); ids=(); roles=()
  while read -r role ref id platform extra || [[ -n "${role:-}${ref:-}${id:-}${platform:-}${extra:-}" ]]; do
    case "$role" in web|worker|tools) ;; *) fail '镜像清单角色无效。';; esac
    [[ -z "${seen[$role]:-}" && -z "$extra" ]] || fail '镜像清单重复或列数错误。'
    [[ "$ref" =~ ^artzoo-$role:((git|dev)-[0-9a-f]{12}-[0-9]{14}-[0-9]+)$ ]] || fail '镜像标签格式错误。'
    current=${BASH_REMATCH[1]}
    [[ -z "$version" || "$version" == "$current" ]] || fail '发布包混用了不同版本。'
    version=$current
    [[ "$id" =~ ^sha256:[0-9a-f]{64}$ && "$platform" == linux/amd64 ]] || fail '镜像 ID 或平台错误。'
    seen[$role]=1; refs[$role]=$ref; ids[$role]=$id; roles+=("$role")
  done < "$bundle/images.tsv"
  ((${#roles[@]} > 0)) || fail '镜像清单为空。'
  if [[ "$config_count" == 4 ]]; then
    expected=$(image_environment)
    actual=$(cat -- "$bundle/images.env")
    [[ "$actual" == "$expected" ]] || fail 'images.env 与镜像清单不一致。'
  fi
}
image_environment() {
  local role
  for role in web worker tools; do
    [[ -z "${refs[$role]:-}" ]] || printf 'ARTZOO_%s_IMAGE=%s\n' "${role^^}" "${refs[$role]}"
  done
}
image_matches() {
  local actual
  actual=$(d image inspect "${refs[$1]}" --format '{{.Id}} {{.Os}}/{{.Architecture}}') || return 1
  [[ "$actual" == "${ids[$1]} linux/amd64" ]]
}
node_check() {
  local role=$1 mode=$2
  shift 2
  d run --rm --interactive --network none --label "$scope_label" --entrypoint node \
    "${refs[$role]}" --input-type=module - "$mode" "$@" < "$helper"
}
basic_checks() {
  local role web output code
  for role in "${roles[@]}"; do
    image_matches "$role" || fail "镜像缺失或版本不符：$role，请先导入。"
    printf '\n检查 %s\n' "${refs[$role]}"
    node_check "$role" runtime
    case "$role" in
      web|worker) node_check "$role" media "$role" ;;
    esac
    if [[ "$role" == web ]]; then
      web=$(d run --detach --network none --label "$scope_label" \
        --env ARTZOO_DEPLOYMENT_ENV=production --env ARTZOO_PUBLIC_ORIGIN=https://localhost "${refs[web]}")
      if ! d exec --interactive "$web" node --input-type=module - http < "$helper"; then
        d logs --tail 40 "$web" >&2
        fail 'web HTTP 验证失败。'
      fi
      d rm --force "$web" >/dev/null
    elif [[ "$role" == worker ]]; then
      node_check worker database-module
      if output=$(d run --rm --network none --label "$scope_label" "${refs[worker]}" --once --require-db 2>&1); then
        fail 'worker 在缺少数据库时没有拒绝运行。'
      else code=$?; fi
      [[ "$code" == 1 ]] || fail 'worker 返回了非预期退出码。'
      node_check worker worker-result "$output" missing
    else
      output=$(d run --rm --network none --label "$scope_label" "${refs[tools]}")
      [[ "$output" == 'ArtZoo maintenance image: specify an explicit command. Nothing was changed.' ]] || fail 'tools 默认入口异常。'
      d run --rm --network none --label "$scope_label" --workdir /app/packages/db \
        --entrypoint /app/packages/db/node_modules/.bin/prisma "${refs[tools]}" --version
      d run --rm --interactive --network none --label "$scope_label" --entrypoint node \
        "${refs[tools]}" --import ./scripts/auth-cli-loader.mjs --input-type=module - owner < "$helper"
      if output=$(d run --rm --network none --label "$scope_label" \
        --env ARTZOO_DEPLOYMENT_ENV=local --env ARTZOO_PUBLIC_ORIGIN=http://localhost:3100 \
        --entrypoint node "${refs[tools]}" --import ./scripts/auth-cli-loader.mjs \
        ./apps/web/server/auth/owner-init-cli.mjs 2>&1); then
        fail '超管初始化没有拒绝非交互调用。'
      else code=$?; fi
      [[ "$code" == 1 && "$output" == '初始化未完成。请检查本地 TTY、无参数调用、local 来源、数据库迁移及连接；不要提交密码或诊断秘密。' ]] || fail '超管初始化保护检查异常。'
    fi
  done
}

database_checks() {
  [[ -n "${refs[worker]:-}" && -n "${refs[tools]:-}" ]] || fail '--database 需要同时包含 worker 和 tools 的发布包。'
  printf '【危险：仅临时测试库】将执行迁移和认证记录清理，结束后删除本次测试数据。\n'
  local network="$token-net" db="$token-db" password ready=0 output count
  local postgres=postgres:17.11-bookworm
  password=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
  d image inspect "$postgres" >/dev/null 2>&1 || d pull "$postgres"
  d network create --internal --label "$scope_label" "$network" >/dev/null
  d run --detach --name "$db" --network "$network" --label "$scope_label" \
    --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,size=536870912 \
    --env POSTGRES_USER=image_test --env POSTGRES_DB=artzoo_image_test \
    --env POSTGRES_PASSWORD="$password" "$postgres" >/dev/null
  for ((attempt=0; attempt<40; attempt++)); do
    if d exec "$db" pg_isready -h 127.0.0.1 -U image_test -d artzoo_image_test >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
  done
  [[ "$ready" == 1 ]] || fail '临时 PostgreSQL 未就绪。'
  sql() { d exec --interactive "$db" psql -X -v ON_ERROR_STOP=1 -U image_test -d artzoo_image_test -At; }
  migrate() {
    d run --rm --network "$network" --label "$scope_label" --workdir /app/packages/db \
      --env DATABASE_URL="postgresql://image_test:$password@$db:5432/artzoo_image_test?schema=public" \
      --entrypoint /app/packages/db/node_modules/.bin/prisma "${refs[tools]}" "$@" 2>&1 |
      sed "s/$password/[redacted]/g"
  }
  worker_once() {
    output=$(d run --rm --network "$network" --label "$scope_label" \
      --env PGHOST="$db" --env PGPORT=5432 --env PGUSER=image_test --env PGDATABASE=artzoo_image_test \
      --env PGPASSWORD="$password" --env ARTZOO_SECURITY_CLEANUP_ENABLED="$1" \
      --env ARTZOO_MEDIA_BUDGET_ENABLED=0 --env ARTZOO_MEDIA_CLEANUP_EXECUTE=0 \
      --env ARTZOO_OFFICIAL_SYNC_ENABLED=0 "${refs[worker]}" --once --require-db)
    node_check worker worker-result "$output" "${2:-ok}"
  }
  count=$(sql <<< "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';")
  [[ "$count" == 0 ]] || fail '测试库不是空库。'
  migrate migrate deploy
  migrate migrate deploy
  migrate migrate status
  migrate migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
  # Three ephemeral media mounts survive all CLI subprocesses within this one tools container.
  d run --rm --interactive --network "$network" --label "$scope_label" --entrypoint node \
    --tmpfs /app/storage/original:rw,nosuid,nodev,uid=1000,gid=1000,mode=0700 \
    --tmpfs /app/storage/derived:rw,nosuid,nodev,uid=1000,gid=1000,mode=0700 \
    --tmpfs /app/storage/avatars:rw,nosuid,nodev,uid=1000,gid=1000,mode=0700 \
    --env PGHOST="$db" --env PGPORT=5432 --env PGUSER=image_test --env PGDATABASE=artzoo_image_test \
    --env PGPASSWORD="$password" --env ARTZOO_AVATAR_DIR=/app/storage/avatars \
    "${refs[tools]}" --input-type=module - media-baseline < "$helper"
  worker_once 0
  sql <<'SQL'
INSERT INTO "AccountRateEvent" ("id", "key", "createdAt") VALUES
('image-test-expired', 'image-test-expired', now() - interval '2 days'),
('image-test-current', 'image-test-current', now());
SQL
  worker_once 0
  count=$(sql <<< 'SELECT count(*) FROM "AccountRateEvent";')
  [[ "$count" == 2 ]] || fail '清理关闭时测试记录发生变化。'
  worker_once 1 cleanup
  count=$(sql <<< 'SELECT id FROM "AccountRateEvent";')
  [[ "$count" == image-test-current ]] || fail '清理没有正确保留新记录。'
  worker_once 1
  count=$(sql <<< 'SELECT id FROM "AccountRateEvent";')
  [[ "$count" == image-test-current ]] || fail '重复清理结果异常。'
  printf 'PASS: 隔离空库迁移、重复迁移、结构对比、媒体基线及 worker 清理。\n'
}

build_bundle() {
  local output="${HOME}/artzoo-releases" target=all dirty_allowed=0 root status commit state release role tag id
  while (($#)); do
    case "$1" in
      --output|--target)
        (($# >= 2)) || fail "$1 缺少参数。"
        if [[ "$1" == --output ]]; then output=$2; else target=$2; fi
        shift 2 ;;
      --allow-dirty) dirty_allowed=1; shift ;;
      *) fail "未知构建参数：$1" ;;
    esac
  done
  case "$target" in all|web|worker|tools) ;; *) fail 'target 只能是 all、web、worker、tools。';; esac
  root=$(git -C "$script_dir" rev-parse --show-toplevel)
  root=$(realpath -e -- "$root")
  output=$(realpath -m -- "$output")
  [[ "$output" != "$root" && "$output" != "$root/"* ]] || fail '发布目录必须位于仓库外。'
  status=$(git -C "$root" status --porcelain=v1 --untracked-files=all)
  [[ -z "$status" || "$dirty_allowed" == 1 ]] || fail '工作区有未提交改动；提交后构建，或显式使用 --allow-dirty 生成开发包。'
  commit=$(git -C "$root" rev-parse HEAD)
  state=clean
  [[ -z "$status" ]] || state=dirty
  release="git-${commit:0:12}-$(date -u +%Y%m%d%H%M%S)-$RANDOM"
  if [[ "$dirty_allowed" == 1 || "$target" != all ]]; then release="dev-${release#git-}"; fi
  engine
  d buildx version >/dev/null || fail '开发端需要 Docker Buildx。'
  mkdir -p -- "$output"
  partial=$(mktemp -d "$output/.artzoo-build.XXXXXX")
  cp -- "$script_path" "$helper" "$partial/"
  cp -- "$root/deployment/compose.yaml" "$root/deployment/.env.example" "$partial/"
  cp -- "$root/scripts/deployment-compose-check.sh" "$root/scripts/$maintenance_file" "$partial/"
  roles=(web worker tools)
  [[ "$target" == all ]] || roles=("$target")
  for role in "${roles[@]}"; do
    tag="artzoo-$role:$release"
    ! d image inspect "$tag" >/dev/null 2>&1 || fail '生成的版本标签已存在，请重新运行。'
    d buildx build --platform linux/amd64 --load --progress=plain --target "$role" --tag "$tag" "$root"
    id=$(d image inspect "$tag" --format '{{.Id}}')
    refs[$role]=$tag; ids[$role]=$id
    printf '%s\t%s\t%s\tlinux/amd64\n' "$role" "$tag" "$id" >> "$partial/images.tsv"
  done
  [[ "$(git -C "$root" rev-parse HEAD)" == "$commit" && "$(git -C "$root" status --porcelain=v1 --untracked-files=all)" == "$status" ]] || fail '构建期间 Git 状态发生变化，请重新构建。'
  helper="$partial/deployment-image-check.mjs"
  basic_checks
  image_environment > "$partial/images.env"
  printf 'format=3\nrelease=%s\ncommit=%s\nworktree=%s\nplatform=linux/amd64\ntarget=%s\n' \
    "$release" "$commit" "$state" "$target" > "$partial/source.txt"
  local images=()
  for role in "${roles[@]}"; do images+=("${refs[$role]}"); done
  d image save "${images[@]}" > "$partial/images.tar"
  (cd -- "$partial" && sha256sum images.tar images.tsv source.txt deployment-images.sh deployment-image-check.mjs "${config_files[@]}" "$maintenance_file" > SHA256SUMS)
  [[ ! -e "$output/$release" ]] || fail '发布目录已存在。'
  mv -T -- "$partial" "$output/$release"
  partial=''
  printf '\n发布包已完成：%s\n' "$output/$release"
  printf '将整个目录复制到运行端，再执行其中脚本的 import 和 check 命令。\n'
}

command=${1:---help}
[[ $# == 0 ]] || shift
case "$command" in
  --help|-h|help) usage ;;
  build) build_bundle "$@" ;;
  verify|import|check)
    (($# >= 1 && $# <= 2)) || fail '请指定发布包目录。'
    database=0
    if (($# == 2)); then
      [[ "$command" == check && "$2" == --database ]] || fail '无效参数。'
      database=1
    fi
    load_bundle "$1"
    if [[ "$command" == verify ]]; then printf "PASS: 发布包文件校验完成。\n"; exit 0; fi
    helper="$bundle/deployment-image-check.mjs"
    if [[ "$database" == 1 ]]; then
      [[ -n "${refs[worker]:-}" && -n "${refs[tools]:-}" ]] || fail '--database 需要同时包含 worker 和 tools 的发布包。'
    fi
    engine
    if [[ "$command" == import ]]; then
      needed=0
      for role in "${roles[@]}"; do
        if d image inspect "${refs[$role]}" >/dev/null 2>&1; then
          image_matches "$role" || fail "本机已有不同内容的同名标签：${refs[$role]}"
        else needed=1; fi
      done
      if [[ "$needed" == 1 ]]; then d image load --input "$bundle/images.tar"; fi
      for role in "${roles[@]}"; do image_matches "$role" || fail "导入后的镜像不匹配：$role"; done
      printf 'PASS: 镜像已导入并核对；运行中的服务未变更。\n'
    else
      basic_checks
      if [[ "$database" == 1 ]]; then database_checks; fi
      printf 'PASS: 发布包镜像验证完成；本次临时容器和网络将自动清理。\n'
    fi ;;
  *) fail "未知命令：$command" ;;
esac
