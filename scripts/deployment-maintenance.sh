#!/usr/bin/env bash
# Explicit runtime operations; never run initialization from a service entry point.
set +x
set -euo pipefail
fail() { printf '停止：%s\n' "$1" >&2; exit 1; }
usage() {
  cat <<'HELP'
用法：bash deployment-maintenance.sh 命令 --bundle 发布目录 --root 站点目录 [--project 项目名] [--origin HTTPS来源]
命令：
  prepare-env     核对空媒体目录并新建秘密配置（必须提供 --origin）
  database        首次创建空数据库卷；拒绝已有卷或项目容器
  migrate         仅迁移首次空库；失败保留现场，不自动重置或重试
  baseline        停写状态下初始化媒体基线；不清零既有用量
  owner           本机真实 TTY 初始化首位超管；不接受账号或密码参数
  enable-budget   首次启用全站 10 GB / 每账号每天 2 GB 并创建应用容器
  status          只读核对现有服务、配额、挂载、健康；不要求用量为零
  start           启动已初始化的现有容器；不建库、迁移、初始化或升级
  stop            先停止应用，再停止数据库；保留容器、卷和媒体
默认只显示帮助。项目名默认 artzoo，跨版本必须保持不变。
root 下预先准备 secrets 和 media/{original,derived,avatars}，UID/GID 1000、0700。
秘密文件固定为 root/secrets/compose.env（0600）；不 source、不打印配置。
运行端只需 Bash、Docker Compose、GNU 工具和 flock；无需源码、Node 或 pnpm。
所有写操作均须在核对目标后由站长单独执行；失败保留数据，勿删除卷或盲目重复初始化。
HELP
}
command=${1:---help}
[[ $# == 0 ]] || shift
case "$command" in --help|-h|help) usage; exit 0;; prepare-env|database|migrate|baseline|owner|enable-budget|status|start|stop) ;; *) fail '未知维护命令。';; esac
bundle='' root='' project=artzoo origin=''
while (($#)); do
  (($# >= 2)) || fail '选项缺少值。'
  case "$1" in
    --bundle) bundle=$2;; --root) root=$2;; --project) project=$2;; --origin) origin=$2;;
    *) fail '未知维护选项。';;
  esac
  shift 2
done
[[ "$project" =~ ^[a-z][a-z0-9-]{0,47}$ ]] || fail '项目名格式不符。'
[[ "$root" =~ ^/([a-zA-Z0-9_.-]+/)*[a-zA-Z0-9_.-]+$ && "$root" != / ]] || fail '站点目录须为无空格的绝对路径。'
[[ -n "$bundle" && -d "$bundle" ]] || fail '必须指定完整发布目录。'
[[ "$(id -u):$(id -g)" == 1000:1000 ]] || fail '请使用镜像对应的 UID/GID 1000 用户执行，不要 sudo 整个脚本。'
if [[ "$command" == owner ]]; then
  [[ -t 0 && -t 1 && -z "${SSH_CONNECTION:-}${SSH_CLIENT:-}${SSH_TTY:-}" ]] || fail '超管初始化必须使用本机真实 TTY，不能重定向或通过 SSH。'
fi
if [[ "$command" == prepare-env ]]; then
  [[ "$origin" =~ ^https://[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?(:[1-9][0-9]{0,4})?$ ]] || fail '必须提供精确 HTTPS origin，不含路径、参数或尾斜杠。'
else
  [[ -z "$origin" ]] || fail '--origin 仅用于新建配置；现有配置不自动改写来源。'
fi
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
for dir in "$root/secrets" "$root/media" "$root/media/"{original,derived,avatars}; do
  trusted_path "$dir"
  [[ "$(stat -c '%u:%g:%a' "$dir")" == 1000:1000:700 ]] || fail '秘密和媒体目录需要 UID/GID 1000、0700。'
done
bundle=$(realpath -e -- "$bundle")
config="$root/secrets/compose.env"
# Verify fixed manifests and checksums without importing or starting anything.
bash "$bundle/deployment-images.sh" verify "$bundle" >/dev/null 2>&1 || fail '发布包校验失败。'
[[ "$(sha256sum -- "${BASH_SOURCE[0]}" | cut -d ' ' -f 1)" == "$(sha256sum -- "$bundle/deployment-maintenance.sh" | cut -d ' ' -f 1)" ]] || fail '请使用发布包内匹配的维护脚本。'
declare -A values=() refs=() ids=()
while read -r role ref image_id platform extra; do refs[$role]=$ref; ids[$role]=$image_id; done < "$bundle/images.tsv"
for role in web worker tools; do [[ -n "${ids[$role]:-}" ]] || fail '维护需要完整三镜像包。'; done
umask 077
lock="$root/secrets/.maintenance.lock"
[[ ! -L "$lock" && ( ! -e "$lock" || ( -f "$lock" && "$(stat -c '%u:%g:%a' "$lock")" == 1000:1000:600 ) ) ]] || fail '维护锁文件不可信。'
exec 9>"$lock"
flock -n 9 || fail '同一站点有另一维护操作正在执行。'
docker_path=$(command -v docker) || fail '缺少 Docker。'
privilege=()
if ! timeout 15 "$docker_path" --host unix:///var/run/docker.sock info >/dev/null 2>&1; then
  sudo -v || fail '无法取得 Docker 权限。'
  privilege=(sudo)
fi
d() { "${privilege[@]}" timeout --kill-after=5s 30s "$docker_path" --host unix:///var/run/docker.sock "$@" </dev/null; }
d info >/dev/null 2>&1 || fail '本机 Docker 不可用。'
for role in web worker tools; do
  [[ "$(d image inspect "${refs[$role]}" --format '{{.Id}} {{.Os}}/{{.Architecture}}')" == "${ids[$role]} linux/amd64" ]] || fail '镜像缺失或 ID 不符，请先导入发布包。'
done
# Compose plugin is preferred; the official standalone binary is also supported.
compose_bin=("$docker_path" --host unix:///var/run/docker.sock compose)
if ! d compose version >/dev/null 2>&1; then
  standalone=$(command -v docker-compose) || fail '缺少 Docker Compose。'
  compose_bin=("$standalone")
fi
override='' temporary='' tool='' apps_touched=0
compose=()
dc() { "${privilege[@]}" timeout --kill-after=10s 330s env -i "PATH=$PATH" "HOME=$HOME" DOCKER_HOST=unix:///var/run/docker.sock "${compose[@]}" "$@" </dev/null; }
cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if [[ "$status" != 0 && "$apps_touched" == 1 ]]; then
    dc stop --timeout 30 web worker >/dev/null 2>&1 || printf '无法确认应用已停止，请立即核对。\n' >&2
  fi
  [[ -z "$tool" ]] || d rm -f "$tool" >/dev/null 2>&1 || status=1
  [[ -z "$temporary" ]] || rm -f -- "$temporary" || status=1
  [[ -z "$override" ]] || rm -f -- "$override" || status=1
  [[ "$status" == 0 ]] || printf '操作未全部完成；数据库、媒体和秘密配置保留，不自动回退或清零。\n' >&2
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
read_config() {
  [[ -f "$config" && ! -L "$config" && "$(stat -c '%u:%g:%a' "$config")" == 1000:1000:600 ]] || fail '秘密文件缺失或权限不符。'
  values=()
  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || fail '配置格式不符；不要输出文件内容。'
    key=${line%%=*}; value=${line#*=}
    case "$key" in COMPOSE_PROJECT_NAME|ARTZOO_MEDIA_ROOT|ARTZOO_HTTP_PORT|ARTZOO_PUBLIC_ORIGIN|ARTZOO_TRUSTED_PROXY|POSTGRES_PASSWORD|ARTZOO_INVITATION_KEY|ARTZOO_MEDIA_BUDGET_ENABLED|ARTZOO_MEDIA_GLOBAL_LIMIT_BYTES|ARTZOO_MEDIA_DAILY_LIMIT_BYTES) ;; *) fail '配置包含非模板变量。';; esac
    [[ ! -v "values[$key]" ]] || fail '配置含重复变量。'
    values[$key]=$value
  done < "$config"
  [[ ${#values[@]} == 10 ]] || fail '配置变量不完整。'
  [[ "${values[COMPOSE_PROJECT_NAME]}" == "$project" && "${values[ARTZOO_MEDIA_ROOT]}" == "$root/media" ]] || fail '项目名或媒体路径与目标不一致。'
  [[ "${values[POSTGRES_PASSWORD]}" =~ ^[0-9a-f]{64}$ && "${values[ARTZOO_INVITATION_KEY]}" =~ ^[0-9a-f]{64}$ ]] || fail '秘密配置格式不符。'
  [[ "${values[ARTZOO_PUBLIC_ORIGIN]}" =~ ^https://[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?(:[1-9][0-9]{0,4})?$ ]] || fail 'HTTPS origin 格式不符。'
  [[ "${values[ARTZOO_HTTP_PORT]}" =~ ^[1-9][0-9]{0,4}$ ]] && (( values[ARTZOO_HTTP_PORT] <= 65535 )) || fail '端口不符。'
  [[ "${values[ARTZOO_TRUSTED_PROXY]}" == '' || "${values[ARTZOO_TRUSTED_PROXY]}" == caddy ]] || fail '代理配置不符。'
  [[ "${values[ARTZOO_MEDIA_BUDGET_ENABLED]}" =~ ^[01]$ && "${values[ARTZOO_MEDIA_GLOBAL_LIMIT_BYTES]}" == 10000000000 && "${values[ARTZOO_MEDIA_DAILY_LIMIT_BYTES]}" == 2000000000 ]] || fail '本入口仅接受已约定的 10 GB / 2 GB 配额。'
  unset 'values[POSTGRES_PASSWORD]' 'values[ARTZOO_INVITATION_KEY]'
}
configure() {
  read_config
  override=$(mktemp "$root/secrets/.maintenance.XXXXXXXX.yaml")
  printf 'services:\n  tools:\n    logging:\n      driver: "none"\n' > "$override"
  compose=("${compose_bin[@]}" --project-name "$project" --env-file "$bundle/images.env" --env-file "$config" -f "$bundle/compose.yaml" -f "$override")
  dc config --quiet >/dev/null 2>&1 || fail 'Compose 配置解析失败，诊断内容未输出以保护秘密。'
}
no_project() {
  [[ -z "$(d ps -a --filter "label=com.docker.compose.project=$project" --format '{{.ID}}')" ]] || fail '已有项目容器，拒绝首次建库或重新生成秘密。'
  if d volume inspect "${project}_postgres-data" >/dev/null 2>&1; then fail '已有数据库卷，拒绝首次建库或重新生成秘密。'; fi
}
database_target() {
  postgres=$(dc ps --all --quiet postgres)
  [[ "$postgres" =~ ^[0-9a-f]{64}$ ]] || fail '未找到唯一数据库容器。'
  [[ "$(d inspect --format '{{range .Mounts}}{{.Type}}|{{.Name}}|{{.Destination}}{{end}}' "$postgres")" == "volume|${project}_postgres-data|/var/lib/postgresql/data" ]] || fail '数据库挂载不符。'
  [[ "$(d inspect --format '{{len .HostConfig.PortBindings}}' "$postgres")" == 0 ]] || fail '数据库不应发布宿主端口。'
}
sql() {
  d exec -e 'PGOPTIONS=-c statement_timeout=10000 -c lock_timeout=5000 -c default_transaction_read_only=on' -e PGCONNECT_TIMEOUT=5 "$postgres" psql -X -w -v ON_ERROR_STOP=1 -U artzoo -d artzoo -Atc "$1" 2>/dev/null
}
identity() { [[ "$(sql 'SELECT current_database(), current_user;')" == 'artzoo|artzoo' ]] || fail '实际目标数据库或用户不符。'; }
offline() {
  local running id source mounts
  [[ "${values[ARTZOO_MEDIA_BUDGET_ENABLED]}" == 0 ]] || fail '首次初始化要求配额尚未启用。'
  running=$(d ps --filter "label=com.docker.compose.project=$project" --format '{{.ID}}')
  [[ "$running" == "${postgres:0:12}" ]] || fail '请先停止本项目所有媒体写入者。'
  # Reject containers in other projects writing the same media tree as well.
  for id in $(d ps -q); do
    mounts=$(d inspect --format '{{range .Mounts}}{{if .RW}}{{println .Source}}{{end}}{{end}}' "$id")
    while IFS= read -r source; do
      [[ -z "$source" ]] && continue
      [[ "$source" != "$root/media" && "$source" != "$root/media/"* && "$root/media" != "$source/"* ]] || fail '其他运行容器仍挂载目标媒体；请先停写。'
    done <<< "$mounts"
  done
}
baseline_query='SELECT id, "baselineBytes", "committedBytes", "reservedBytes", "creditedBytes", "baselineInitializedAt" IS NOT NULL, "baselineFingerprint" IS NOT NULL AND length("baselineFingerprint")=64 FROM "MediaBudgetState" ORDER BY id;'
account_query=$'SELECT (SELECT count(*) FROM "Account"), (SELECT count(*) FROM "Account" WHERE "adminRole"=\x27SUPER_ADMIN\x27), (SELECT count(*) FROM "AccountAudit" a JOIN "Account" u ON u.id=a."actorId" WHERE a.action=\x27SUPER_ADMIN_INITIALIZED\x27 AND a."targetAccountId"=a."actorId" AND u."adminRole"=\x27SUPER_ADMIN\x27);'
empty_baseline() { [[ "$(sql "$baseline_query")" == 'global|0|0|0|0|t|t' ]] || fail '媒体基线不符合首次初始化阶段。'; }
prisma() {
  dc run --rm --no-deps -T --interactive=false --entrypoint node tools -e '
const {spawnSync}=require("node:child_process");
const result=spawnSync("/app/packages/db/node_modules/.bin/prisma",["migrate",process.argv[1]],{
cwd:"/app/packages/db",env:process.env,encoding:"utf8",stdio:["ignore","pipe","pipe"],timeout:300000,maxBuffer:4194304});
if(result.error||result.signal||result.status!==0){console.error("Migration failed; preserve database. Raw diagnostics withheld.");process.exit(1)}
console.log("PASS: prisma migrate "+process.argv[1]);' "$1"
}
check_mounts() {
  local actual expected
  actual=$(d inspect --format '{{range .Mounts}}{{.Type}}|{{.Source}}|{{.Destination}}|{{.RW}}{{println}}{{end}}' "$1" | sed '/^$/d' | LC_ALL=C sort)
  expected=$(for dir in avatars derived original; do printf 'bind|%s/media/%s|/app/storage/%s|true\n' "$root" "$dir" "$dir"; done)
  [[ "$actual" == "$expected" ]] || fail '实际媒体挂载不符。'
}
check_app() {
  local service=$1 container ports security=0
  container=$(dc ps --all --quiet "$service")
  [[ "$container" =~ ^[0-9a-f]{64}$ ]] || fail '应用容器缺失；start 不创建或升级容器。'
  [[ "$(d inspect --format '{{.Image}}' "$container")" == "${ids[$service]}" ]] || fail '现有容器与所选发布包不一致。'
  check_mounts "$container"
  if [[ "$service" == web ]]; then
    ports=$(d inspect --format '{{len .HostConfig.PortBindings}}|{{range index .HostConfig.PortBindings "3100/tcp"}}{{.HostIp}}|{{.HostPort}}{{end}}' "$container")
    [[ "$ports" == "1|127.0.0.1|${values[ARTZOO_HTTP_PORT]}" ]] || fail 'web 回环端口绑定不符。'
  else
    [[ "$(d inspect --format '{{len .HostConfig.PortBindings}}' "$container")" == 0 ]] || fail 'worker 不应发布端口。'
    security=1
  fi
  local key actual
  for key in ARTZOO_PUBLIC_ORIGIN ARTZOO_TRUSTED_PROXY ARTZOO_MEDIA_BUDGET_ENABLED ARTZOO_MEDIA_GLOBAL_LIMIT_BYTES ARTZOO_MEDIA_DAILY_LIMIT_BYTES; do
    actual=$(d inspect --format "{{range .Config.Env}}{{if eq (index (split . \"=\") 0) \"$key\"}}{{println .}}{{end}}{{end}}" "$container")
    [[ "$actual" == "$key=${values[$key]}" ]] || fail '容器配置与秘密文件中的非秘密字段不一致。'
  done
  for key in NODE_ENV=production ARTZOO_DEPLOYMENT_ENV=production ARTZOO_AVATAR_DIR=/app/storage/avatars PGHOST=postgres PGPORT=5432 PGUSER=artzoo PGDATABASE=artzoo ARTZOO_MEDIA_CLEANUP_EXECUTE=0 ARTZOO_OFFICIAL_SYNC_ENABLED=0 ARTZOO_QQ_MODE= ARTZOO_SMS_PROVIDER=unconfigured "ARTZOO_SECURITY_CLEANUP_ENABLED=$security"; do
    actual=$(d inspect --format "{{range .Config.Env}}{{if eq (index (split . \"=\") 0) \"${key%%=*}\"}}{{println .}}{{end}}{{end}}" "$container")
    [[ "$actual" == "$key" ]] || fail '容器运行策略不符。'
  done
}
status_check() {
  identity
  [[ "${values[ARTZOO_MEDIA_BUDGET_ENABLED]}" == 1 ]] || fail '配额尚未启用。'
  [[ "$(sql $'SELECT count(*) FROM "MediaBudgetState" WHERE id=\x27global\x27 AND "baselineInitializedAt" IS NOT NULL AND length("baselineFingerprint")=64;')" == 1 ]] || fail '媒体基线不存在。'
  for service in web worker; do
    check_app "$service"
    container=$(dc ps --quiet "$service")
    [[ -n "$container" && "$(d inspect --format '{{.State.Running}}' "$container")" == true ]] || fail '应用没有运行。'
    printf '%s quota=1 total=10000000000 daily=2000000000\n' "$service"
  done
  container=$(dc ps --quiet web)
  [[ "$(d inspect --format '{{.State.Health.Status}}' "$container")" == healthy ]] || fail 'web 尚未健康。'
  d exec "$container" node -e 'fetch("http://127.0.0.1:3100/api/health",{signal:AbortSignal.timeout(5000)}).then(async r=>{if(!r.ok||(await r.json()).ok!==true)throw Error();console.log("PASS: web health")}).catch(()=>process.exit(1))'
}
if [[ "$command" == prepare-env ]]; then
  [[ ! -e "$config" && ! -L "$config" ]] || fail '配置已存在，不覆盖。'
  no_project
  for dir in "$root/media/"{original,derived,avatars}; do [[ -z "$(find "$dir" -mindepth 1 -printf x -quit)" ]] || fail '媒体非空，不初始化。'; done
  temporary=$(mktemp "$root/secrets/.compose.env.XXXXXXXX")
  password=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  invitation=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      COMPOSE_PROJECT_NAME=*) printf 'COMPOSE_PROJECT_NAME=%s\n' "$project";;
      ARTZOO_MEDIA_ROOT=*) printf 'ARTZOO_MEDIA_ROOT=%s/media\n' "$root";;
      ARTZOO_PUBLIC_ORIGIN=*) printf 'ARTZOO_PUBLIC_ORIGIN=%s\n' "$origin";;
      POSTGRES_PASSWORD=*) printf 'POSTGRES_PASSWORD=%s\n' "$password";;
      ARTZOO_INVITATION_KEY=*) printf 'ARTZOO_INVITATION_KEY=%s\n' "$invitation";;
      *) printf '%s\n' "$line";;
    esac
  done < "$bundle/.env.example" > "$temporary"
  unset password invitation
  ln -T -- "$temporary" "$config"
  configure
  printf 'PASS: prepare-env；配置已创建，权限 0600，配额关闭。\n'
  exit 0
fi
configure
if [[ "$command" == database ]]; then
  no_project
  [[ "${values[ARTZOO_MEDIA_BUDGET_ENABLED]}" == 0 ]] || fail '首次建库要求配额关闭。'
  printf '【危险】创建项目 %s 的数据库卷并启动 PostgreSQL；不迁移。\n' "$project"
  dc up -d --wait --wait-timeout 90 postgres
fi
database_target
case "$command" in
  database)
    [[ "$(sql "SELECT current_database(), current_user, (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE');")" == 'artzoo|artzoo|0' ]] || fail '目标不是预期空库。'
    ;;
  migrate)
    identity; offline
    [[ "$(sql "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';")" == 0 ]] || fail '只允许首次空库迁移；非空或部分迁移请先核对。'
    printf '【危险】迁移项目 %s 的空数据库。\n' "$project"
    prisma deploy; prisma status
    ;;
  baseline)
    identity; offline; prisma status
    tool=$(dc run --rm --no-deps -T --interactive=false --detach tools node -e 'setInterval(()=>{},1000)')
    [[ "$tool" =~ ^[0-9a-f]{64}$ ]] || fail '未获得维护容器 ID。'
    check_mounts "$tool"
    printf '【危险】写入媒体基线；请保持宿主媒体目录停写。\n'
    "${privilege[@]}" timeout --kill-after=5s 90s "$docker_path" --host unix:///var/run/docker.sock exec "$tool" node /app/scripts/media-baseline-cli.mjs --offline --expect-database artzoo
    empty_baseline
    ;;
  owner)
    identity; offline; empty_baseline
    [[ "$(sql 'SELECT count(*) FROM "Account";')" == 0 && "$(sql $'SELECT count(*) FROM "AccountAudit" WHERE action=\x27SUPER_ADMIN_INITIALIZED\x27;')" == 0 ]] || fail '已有账号或初始化审计，不覆盖。'
    printf '【危险】初始化本人首位超管；不记录或转发交互内容。\n'
    "${privilege[@]}" env -i "PATH=$PATH" "HOME=$HOME" DOCKER_HOST=unix:///var/run/docker.sock "${compose[@]}" run --rm --no-deps --interactive=true -e ARTZOO_DEPLOYMENT_ENV=local -e ARTZOO_PUBLIC_ORIGIN=http://localhost:3100 tools node --import /app/scripts/auth-cli-loader.mjs /app/apps/web/server/auth/owner-init-cli.mjs
    [[ "$(sql "$account_query")" == '1|1|1' ]] || fail '超管和本人审计计数不符。'
    ;;
  enable-budget)
    identity; offline; empty_baseline
    [[ "$(sql "$account_query")" == '1|1|1' ]] || fail '首位超管和初始化审计不符。'
    before=$(sql 'SELECT row_to_json(s)::text FROM "MediaBudgetState" s ORDER BY id;')
    printf '【危险】启用配额并创建、启动 web/worker。\n'
    temporary=$(mktemp "$root/secrets/.compose.env.XXXXXXXX")
    sed 's/^ARTZOO_MEDIA_BUDGET_ENABLED=0$/ARTZOO_MEDIA_BUDGET_ENABLED=1/' "$config" > "$temporary"
    backup=$(mktemp "$root/secrets/compose.env.before-budget.XXXXXXXX")
    cp --preserve=mode -- "$config" "$backup"
    mv -T -- "$temporary" "$config"; temporary=''
    read_config
    apps_touched=1
    dc up --no-start --no-deps --force-recreate web worker
    check_app web; check_app worker
    dc up -d --no-deps --wait --wait-timeout 120 web worker
    status_check
    [[ "$(sql 'SELECT row_to_json(s)::text FROM "MediaBudgetState" s ORDER BY id;')" == "$before" ]] || fail '基线或用量发生变化。'
    [[ "$(sql "$account_query")" == '1|1|1' ]] || fail '初始化账号计数变化。'
    apps_touched=0
    ;;
  status) status_check;;
  start)
    [[ "${values[ARTZOO_MEDIA_BUDGET_ENABLED]}" == 1 ]] || fail '未启用配额，不能作为已初始化站点启动。'
    check_app web; check_app worker
    printf '【危险】启动现有容器；不重建、不迁移、不初始化。\n'
    dc start --wait --wait-timeout 90 postgres
    identity
    [[ "$(sql $'SELECT count(*) FROM "MediaBudgetState" WHERE id=\x27global\x27 AND "baselineInitializedAt" IS NOT NULL AND length("baselineFingerprint")=64;')" == 1 ]] || fail '基线未就绪。'
    [[ "$(sql $'SELECT count(*) FROM "Account" WHERE "adminRole"=\x27SUPER_ADMIN\x27;')" != 0 ]] || fail '超管未就绪。'
    apps_touched=1
    dc start --wait --wait-timeout 120 web worker
    status_check
    apps_touched=0
    ;;
  stop)
    printf '【危险】停止项目 %s 的应用和数据库，保留容器、数据卷和媒体。\n' "$project"
    dc stop --timeout 60 web worker
    dc stop --timeout 60 postgres
    ;;
esac
printf 'PASS: %s；项目 %s。\n' "$command" "$project"
