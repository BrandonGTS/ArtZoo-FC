# 部署操作手册

这份手册写给站长本人：怎么发新版本、怎么备份和恢复、出问题时怎么办，以及第一次搭建新站点的步骤。所有命令都由站长亲自执行。

> 本文件会随每个发布包一起交付。在服务器上请以**当前发布包里附带的 DEPLOYMENT.md** 为准，它和那个版本的脚本是配套的。

---

## 0. 开始之前

### 0.1 三个地方

| 名称 | 是什么 | 在这里做什么 |
|---|---|---|
| **Dev** | 开发用的 WSL（`ArtZoo-FC-Dev`），有源码 | 构建发布包 |
| **Server** | 运行网站的机器。家庭是 WSL `ArtZoo-FC-Server`，以后是正式 Linux 服务器 | 导入发布包、升级、备份、恢复 |
| **Windows** | 家庭电脑本身 | 把发布包从 Dev 复制到 Server；用固定入口启停家庭网站 |

Server 上没有源码，也不需要 Node、pnpm、Python，只需要 Docker、Docker Compose 和 Caddy。

网站以**发布包**的形式交付：一个版本一个目录，名字形如 `git-<12 位提交号>-<UTC 时间>-<随机数>`。目录里有三个镜像（web、worker、tools）、校验和、运行配置模板、维护脚本和这份手册。`dev-` 开头的是开发测试包，不用于正式发版。

### 0.2 Server 上的目录

| 位置 | 内容 |
|---|---|
| `/srv/artzoo/releases/<版本>/` | 各版本的发布包。保留旧版本，不修改里面的文件 |
| `/srv/artzoo/secrets/compose.env` | 运行配置，含数据库密码、邀请密钥、短信凭证。权限 0600；不在备份里，要另外离线保存一份 |
| `/srv/artzoo/media/{original,derived,avatars}` | 上传的原图、缩略图和预览图、头像 |
| `/srv/artzoo/backups/` | 备份（默认位置） |
| `/srv/artzoo/deploy/` | 部署记录：`current`（当前版本）、`previous`（可回退的上一版）、`history.log`、`backup-last` 等，见 7.2 |
| Docker 卷 `artzoo_postgres-data` | 数据库 |
| `/etc/caddy/Caddyfile`、`/var/lib/caddy/` | Caddy 配置、证书和私钥 |

### 0.3 几条规矩

- **一次只执行一步**，看到成功标志再做下一步；失败就停下处理，不要整段粘贴。
- 标着 **【危险】** 的命令会停站、覆盖数据或重启服务，要单独执行，执行前确认变量是对的。
- Server 上用 **UID/GID 1000 的运行用户**执行维护脚本，**不要 `sudo` 整个脚本**；需要权限时脚本会自己请求 `sudo`。
- 不修改发布包里的任何文件，不重算校验和；不为了省事删除旧发布包、旧镜像或备份。
- 不手动删除 `deploy/` 里的标记文件来绕过检查。
- 密码、密钥、证书私钥不放进发布包，不打印到终端，不发给 AI。

### 0.4 每次打开 Server 终端，先设置变量

家庭 Server：先在 Windows 用固定入口 `-status` 确认看到 `Resident: running`（3.2），再打开 Server 终端。这样 WSL 不会在你操作到一半时被关闭。

```bash
root=/srv/artzoo
backups=/srv/artzoo/backups     # 备份放在别的盘时改成那个目录，以后每次都用同一个
read -r bundle _ < "$root/deploy/current"
printf '当前发布包：%s\n' "$bundle"
```

- `bundle` 是当前正在运行的发布包，第 3、4 节的命令都用它。第 5 节（搭建新站点）还没有 `current` 记录，按那一节自己设置变量。
- 项目名默认 `artzoo`，下面的命令都省略了 `--project`。项目名决定用哪个数据库卷，站点建好后所有版本都不能改。如果你的站点用了别的项目名，每条维护命令都要加 `--project 项目名`。
- 查看维护命令的完整用法：`bash "$bundle/deployment-maintenance.sh" --help`。

---

## 1. 速查

| 我要…… | 看哪里 |
|---|---|
| 看网站是否正常 | 3.1 |
| 发布新版本 | 第 2 节 |
| 新版本有问题，退回上一版 | 2.6 |
| 启动或停止网站 | 3.2 |
| 手动备份一次 | 3.3 |
| 检查定时备份 | 3.4 |
| 从备份恢复 | 第 4 节 |
| 第一次搭建新站点（正式服务器上线） | 第 5 节 |
| 看到报错不知道怎么办 | 第 6 节 |

家庭 Server 和正式服务器用同一套发布包和维护命令，区别只有这些：

| | 家庭 Server | 正式服务器 |
|---|---|---|
| 发布包怎么传过去 | Windows PowerShell 复制（2.2） | 在 Dev 上用 rsync（2.2） |
| 启动和停止 | Windows 固定入口 `-start` / `-stop` | 维护脚本 `start` / `stop`，再加 Caddy |
| HTTPS | 固定局域网 IP + Caddy 内部证书，浏览器会提示证书不受信任，可以手动继续 | 域名 + 自动申请的证书 |
| 首位超管 | 在 Server 的 WSL 终端里创建 | 必须在服务器的真实控制台（如 VNC）创建，SSH 不行 |
| 一次性环境配置 | 仓库里的 `docs/HOME_WSL_SETUP.md` | 无 |

---

## 2. 发布新版本

流程：Dev 构建发布包 → 复制到 Server → 校验和导入 → 【危险】升级 → 验证。升级会停站几分钟（期间打开网站会看到 502），脚本自动先备份再迁移数据库，不需要手动迁移。

### 2.1 Dev：构建发布包

在 Dev 的仓库根目录执行。

**第 1 步：更新到最新的 main 并检查。** 本次改动应该已经通过 PR 合并到 `main`。

```bash
git status --short                 # 应该没有输出；有未提交的改动先处理
git switch main
git pull --ff-only origin main
node scripts/check-rules.mjs --base origin/main
pnpm format:check && pnpm lint && pnpm typecheck && pnpm build
```

全部通过再继续。

**第 2 步：确认 Dev 的 Docker 是 rootless 模式。**

```bash
docker info --format '{{json .SecurityOptions}}'
```

输出里要有 `rootless`。没有就停下：家庭 Dev 必须用 rootless Docker，否则会影响 Server 的网络（见 `docs/HOME_WSL_SETUP.md`）。

**第 3 步：构建。** 需要走代理下载时，先设置构建代理（端口按 FLClash 的实际端口；代理地址里不能带账号密码）：

```bash
export ARTZOO_BUILD_PROXY=http://10.0.2.2:7890     # 不需要代理就跳过这一行
bash scripts/deployment-images.sh build --output "$(dirname "$PWD")/artzoo-runtime-releases"
```

成功时会打印 `发布包已完成：<完整目录>`，记下这个目录；目录的最后一段就是版本名。

不要加 `--allow-dirty` 或 `--target`，那样得到的是 `dev-` 开头的测试包。

**第 4 步：校验刚构建的包。**

```bash
read -r -p '刚构建的发布包完整目录：' new
bash scripts/deployment-images.sh verify "$new"
du -sh "$new"
```

看到 `PASS: 发布包文件校验完成。`。包目前约 560 MB；如果以后超过 1 GB，在 PLAN 的技术改进里登记"发布包压缩或增量传输"。

### 2.2 复制到 Server

二选一。

**家庭：在 Windows PowerShell 里执行（任意目录）。** 直接从 Dev 的 WSL 复制到 Server 的 WSL，不经过 Windows 中转目录。要输入两样东西：版本名，以及 Dev 上发布包**父目录**的 UNC 路径（以 `\\wsl.localhost\ArtZoo-FC-Dev\` 开头，后面接 Linux 路径，用反斜杠分隔）。

```powershell
$ErrorActionPreference = 'Stop'
$release = Read-Host '构建输出的完整版本名'
$devReleaseRoot = Read-Host 'Dev 发布包父目录的完整 UNC 路径'
$src = Join-Path $devReleaseRoot $release
$parent = '\\wsl.localhost\ArtZoo-FC-Server\srv\artzoo\releases'
$dst = Join-Path $parent $release
if (-not (Test-Path -LiteralPath $src -PathType Container)) {
    throw 'Dev 发布包不存在'
}
if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
    throw 'Server releases 目录不存在，请停止并反馈'
}
if (Test-Path -LiteralPath $dst) {
    throw '目标版本目录已经存在，请停止并核对，不要覆盖'
}
Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force
Write-Host "复制完成：$dst"
```

看到 `复制完成：...` 即可。中途失败时旧网站不受影响；不要导入或升级这个不完整的目录，查明原因后复制到一个**新的**目标，不要覆盖。复制完都要在 Server 上校验（2.3）。

**正式服务器：在 Dev 的仓库根目录执行。** 前提：Dev 能用 SSH 登录服务器（不要把密码写进命令）；服务器装有 `rsync`；运行用户能写 `/srv/artzoo/releases/`。`$new` 是 2.1 第 4 步的目录。

```bash
read -r -p 'SSH 目标（用户@主机，或 ssh 配置里的别名）：' remote
rsync -a --partial -e ssh -- "$new" "${remote}:/srv/artzoo/releases/"
```

- `"$new"` 末尾不要加 `/`，这样传过去的是整个版本目录。
- 不要加 `--delete`。中断了，就对**同一个还没用过的新包**重新执行这条命令续传。

### 2.3 Server：校验、导入、预检

在 Server 终端执行，先按 0.4 设置好变量。

**第 1 步：校验并导入新包。** 输入 Server 上的路径（例如 `/srv/artzoo/releases/<版本名>`），不要用 Dev 上的路径。

```bash
read -r -p 'Server 上新发布包的完整目录：' new
bash "$new/deployment-images.sh" verify "$new"
bash "$new/deployment-images.sh" import "$new"
bash "$new/deployment-images.sh" check "$new"
```

依次应该看到：

- `PASS: 发布包文件校验完成。`——只核对文件和校验和。
- `PASS: 镜像已导入并核对；运行中的服务未变更。`——导入镜像，不影响正在运行的网站。重复导入同一版本是安全的。
- `PASS: 发布包镜像验证完成；……`——用临时容器检查镜像，结束后自动清理。这里不要加 `--database`。

**第 2 步：确认当前网站正常。**

```bash
bash "$bundle/deployment-maintenance.sh" status --root "$root" --backup-dir "$backups"
```

最后一行应该是 `PASS: status；项目 artzoo。`。不正常就先排查（第 6 节），不要带着问题升级。

**第 3 步：暂停定时备份，确认没有备份在运行。** 升级和备份共用一把维护锁，同时触发时备份会安全失败；暂停定时器是为了不留下一条"备份失败"的记录。

```bash
timer_was_active=0
if systemctl is-active --quiet artzoo-backup.timer; then
  timer_was_active=1
  sudo systemctl stop artzoo-backup.timer
fi
echo "timer_was_active=$timer_was_active"
systemctl is-active artzoo-backup.service
```

最后一条显示 `inactive`（或 `failed`，表示上次失败过）都说明现在没有在备份，可以继续；显示 `active` 或 `activating` 说明正在备份，等它结束，不要杀进程。没装定时备份的站点会显示 `inactive`。

记住打印出来的 `timer_was_active`：中途换了终端这个变量会丢失，到时按它手动恢复（2.5 第 3 步）。如果这时决定不升级了，也按 2.5 第 3 步恢复定时器。

**第 4 步：看一眼磁盘空间。**

```bash
df -h / "$root" "$backups" 2>/dev/null
```

升级脚本会自己检查备份盘的空间，不够时在停站前就拒绝；但它不检查 Docker 自己的磁盘（新镜像和迁移都要用），也发现不了宿主机上直接写媒体目录的程序。确认 Docker 所在的盘（通常是 `/`）有余量，并且除了网站容器，没有别的程序在写 `/srv/artzoo/media`。

**第 5 步：检查新版本对配置的要求。**

```bash
bash "$new/deployment-maintenance.sh" config-check --bundle "$new" --root "$root"
```

看到 `PASS: config-check；配置符合发布包清单。` 就继续 2.4。不通过时只会列出变量名（`缺失：`、`多余：`、`格式不符：`），不显示值：

- 新版本**新增了变量**（`缺失：`）：用 `editor "$root/secrets/compose.env"` 补上，再执行一次 `config-check`。补上之后，正在运行的旧版本会把它当作"多余"的变量，`status`、备份和 Windows 入口都会拒绝，所以补完就直接做 2.4；决定不升级了，就把刚补的变量删掉。
- 要求**修改已有变量的值**或删掉变量：先停下，交给 AI 给出步骤（原因见 7.5）。
- 不要拿新模板覆盖已有的 `compose.env`。写法见 7.5。

### 2.4 【危险：停站升级】

单独执行这一条：

```bash
bash "$new/deployment-maintenance.sh" upgrade --bundle "$new" --root "$root" --backup-dir "$backups"
```

脚本会依次：核对新包和配置 → 列出要执行的数据库迁移（没有新迁移也可以升级）→ 检查备份空间 → 停止 web、worker → 做一份 `upgrade-*` 备份并校验，写入 `deploy/previous` → 执行迁移 → 用新镜像重建并启动 web、worker → 健康检查 → 更新 `deploy/current` 和 `deploy/history.log`。

**成功**：最后看到 `PASS: upgrade。`，接着做 2.5。

**失败**分两种，看输出：

- **迁移开始之前失败**：大部分检查（配置、镜像、迁移列表、空间）都在停站之前，失败时网站根本没停；停站之后、迁移之前失败的，脚本会尝试重新启动旧版本。两种情况都执行 `bash "$bundle/deployment-maintenance.sh" status --root "$root"` 确认旧版本正常，查明原因后再升级。
- **迁移开始之后失败**：网站保持停止，输出里有一条【危险】回退命令。不要执行 `start`，按 2.6 回退。

不管哪种失败，新旧发布包、备份和 `deploy/` 里的文件都保留，不要删。同一个版本不能重复升级（会提示"相同版本"）。

### 2.5 Server：验证新版本

**第 1 步：检查服务和记录。** 检查期间先不要上传或删除图片。

```bash
read -r bundle _ < "$root/deploy/current"      # 现在应该是新包
printf '当前发布包：%s\n' "$bundle"
bash "$bundle/deployment-maintenance.sh" status --root "$root" --backup-dir "$backups"
bash "$bundle/deployment-maintenance.sh" media-identity --root "$root"; echo "退出码=$?"
cat "$root/deploy/current" "$root/deploy/previous"
tail -n 3 "$root/deploy/history.log"
curl --fail --noproxy '*' http://127.0.0.1:13100/api/health
```

应该看到：

- 当前发布包是新包；`status` 最后一行是 `PASS: status；项目 artzoo。`
- `media-identity` 的退出码是 `0`（`2` 和 `1` 的含义见 6.3）
- `previous` 记着旧包和这次升级前的备份；`history.log` 最后一行是 `upgrade ... result=success`
- `curl` 返回 `{"ok":true}`（改过 `ARTZOO_HTTP_PORT` 的话，把 13100 换成你的端口）

**第 2 步：在浏览器里验收。** 用电脑和另一台设备打开网站（家庭 Server 的证书警告可以手动继续；正式服务器的证书必须受信任）。检查：能登录；旧图片正常显示；这次改动的功能正常；上传一张测试照片再删掉，确认配额退回。

有问题就停止验收，决定是否回退（2.6）。健康检查通过不等于功能验收通过。

**第 3 步：恢复定时备份。**

```bash
if test "$timer_was_active" = 1; then sudo systemctl start artzoo-backup.timer; fi
systemctl list-timers artzoo-backup.timer
```

换过终端、`timer_was_active` 已经丢了的话：2.3 第 3 步打印的是 `timer_was_active=1`，就执行 `sudo systemctl start artzoo-backup.timer`。

定时备份和 Windows 固定入口都会自动跟着 `deploy/current` 走，升级后不用改任何配置。升级本身不会触发日常备份，所以 `status` 里的"最近备份结果"可能还是旧版本那次。

### 2.6 回退到上一版 【危险】

回退就是用"旧版本镜像 + 这次升级前的备份"恢复。**升级之后写入的数据（新帖子、新图片、新账号等）都会丢失**，这是预期的。只能回退一级，不做反向迁移。

**第 1 步：【危险：回退】** 必须用**这次升级用的新包**里的脚本执行。升级失败时脚本打印过回退命令的，直接复制那条执行；否则执行：

```bash
read -r _ _ _ new < "$root/deploy/previous"      # previous 的第 4 列就是这次升级用的新包
bash "$new/deployment-maintenance.sh" rollback --bundle "$new" --root "$root" --backup-dir "$backups"
```

没有 `deploy/previous` 文件，说明没有可回退的版本（只能回退一级，已经回退过一次就没有了）。

脚本会：检查旧包支持媒体登记、升级前的备份完好、空间足够（不通过就拒绝，网站保持原状）→ 停站 → 把当前状态另存为 `rescue-*` 备份 → 恢复升级前的数据库和媒体 → 用旧镜像重建容器，但不启动 → 写入登记标记，`current` 改回旧包。

成功时看到 `PASS: rollback。` 和 `保持停站；登记成功后自动启动旧版本并检查健康。`，下面还打印一条【危险】`media-reregister` 命令。**这时网站仍然是停止的**，`start` 和 Windows 入口都会拒绝开站，必须先做第 2 步。

**第 2 步：【危险：停写并重新登记媒体】** 恢复媒体后文件的磁盘身份变了，必须重新登记（原因见 `docs/adr/0004-media-file-identity.md`）。复制上一步打印的命令执行；输出找不到了，就执行下面这两行，它和打印的命令是同一条（用新包的脚本，登记旧包）：

```bash
read -r bundle _ new < "$root/deploy/current"     # 回退后：第 1 列是旧包，第 3 列是刚回退掉的新包
bash "$new/deployment-maintenance.sh" media-reregister --bundle "$bundle" --root "$root" --backup-dir "$backups"
```

它会先做一份 `register-*` 备份，逐个核对文件内容，再一次性更新身份，不改配额用量。成功时看到 `PASS: media-reregister；原运行状态=running，……`，并自动启动旧版本、检查健康。

**第 3 步：验证。** 同样用新包的脚本、指定旧包：

```bash
bash "$new/deployment-maintenance.sh" status --bundle "$bundle" --root "$root" --backup-dir "$backups"
bash "$new/deployment-maintenance.sh" media-identity --bundle "$bundle" --root "$root"; echo "退出码=$?"
tail -n 3 "$root/deploy/history.log"
```

`status` 通过、`media-identity` 退出码 0、`history.log` 最后一行是 `rollback ... result=success`。再在浏览器里检查登录、旧图片、删图后配额退回。然后按 2.5 第 3 步恢复定时备份。

停站之前的检查不通过时网站保持原状；停站之后失败则网站保持停止，备份和标记都保留。不要强行开站，按第 6 节处理。

**回退之后、下一次升级之前要注意**：`deploy/current` 的第 3 列仍然指向回退掉的新包，旧包的脚本每次都会校验它。如果新包比旧包多了交付文件（只有部署工具本身改过的版本才会这样），旧包的脚本认不出新包，会报 `发布包校验失败`。这时按 0.4 方式执行的日常命令、定时备份和 Windows 入口都会失败，只能像第 3 步那样用新包的脚本加 `--bundle 旧包`。遇到这种情况，尽快修好问题重新升级，并告诉 AI。

---

## 3. 日常维护

先按 0.4 设置变量。

### 3.1 查看状态（只读）

```bash
bash "$bundle/deployment-maintenance.sh" status --root "$root" --backup-dir "$backups"
```

正常时最后一行是 `PASS: status；项目 artzoo。`。它检查数据库、配额基线，web 和 worker 的镜像、挂载、端口、配置、日志设置是否和当前发布包一致，以及 web 的健康状态。开头还会显示备份情况：

- 最近一次备份结果：`result=success`，或 `result=failed` 加原因代码（见 7.4）；
- 备份目录占用、剩余空间、各类备份的份数和最新时间；
- 出现 `警告：` 时要处理：最新的日常备份超过 36 小时、找不到日常备份、剩余空间不到下次备份估算值的 2 倍，或最近一次备份失败。

备份统计不会逐份校验备份，恢复前仍要用 `backup-verify`（3.3）。

其他只读检查：

```bash
bash "$bundle/deployment-maintenance.sh" media-identity --root "$root"; echo "退出码=$?"   # 媒体文件身份，见 6.3
curl --fail --noproxy '*' http://127.0.0.1:13100/api/health                              # 应返回 {"ok":true}
tail -n 5 "$root/deploy/history.log"                                                      # 最近的升级、回退记录
```

### 3.2 启动和停止

**家庭 Server：用 Windows 固定入口。** 在 Windows PowerShell 里执行（入口的安装见 5.8）。先进入入口所在目录，查看状态（只读）：

```powershell
Set-Location (Join-Path $env:USERPROFILE 'Documents\ArtZoo-FC')
.\ArtZoo-FC-Server.ps1 -status
```

【危险：启动网站】

```powershell
.\ArtZoo-FC-Server.ps1 -start
```

【危险：停止网站】

```powershell
.\ArtZoo-FC-Server.ps1 -stop
```

- `-status`：显示当前版本、发布目录、常驻进程、网站和 Caddy 的检查结果。WSL 没在运行时只报告已停止，不会把它启动。
- `-start`：先启动一个隐藏的常驻进程，让 WSL 保持运行；再启动已有的数据库、web、worker 和 Caddy（Caddy 需要输入 sudo 密码）。不建库、不迁移、不升级。看到 `Resident: running` 和 Caddy `active` 后，可以关掉所有终端，网站继续运行。**Windows 重启后要重新执行一次 `-start`。**
- `-stop`：停止 web、worker、数据库和 Caddy，再释放常驻进程，看到 `Resident: stopped`。数据和容器都保留，不关闭 WSL，不影响 Dev。停止中途失败时常驻进程会保留，先用 `-status` 看清状态再重试。

入口每次都从 `deploy/current` 找当前版本，升级或回退后不用改它。有未完成的升级或媒体登记时，`-start` 会拒绝开站。

**正式服务器（或不用 Windows 入口时）：** 停止和启动各分两步，每步单独执行。

停止：

```bash
sudo systemctl stop caddy                                       # 【危险】第 1 步：先停 Caddy
```

```bash
bash "$bundle/deployment-maintenance.sh" stop --root "$root"     # 【危险】第 2 步：停应用和数据库，容器和数据都保留
```

启动：

```bash
bash "$bundle/deployment-maintenance.sh" start --root "$root"    # 【危险】第 1 步：先启动数据库和应用
```

```bash
sudo systemctl start caddy                                      # 【危险】第 2 步：成功后再启动 Caddy
```

`start` 成功会看到 `PASS: start；项目 artzoo。`，然后检查 HTTPS、登录和旧图片。`start` 只启动已有的容器，不建库、不迁移、不升级；有未完成的升级或媒体登记时会拒绝（第 6 节）。正式服务器重启后，用 3.1 的 `status` 确认网站已经恢复，没有恢复就按上面的步骤启动。

### 3.3 手动备份 【危险：短暂停站】

备份时网站会停一小会儿：脚本停止 web、worker（数据库继续运行），导出数据库、打包三个媒体目录并校验，然后重新启动应用、检查健康，最后才把备份放进备份目录，并清理超出份数的旧备份。

```bash
bash "$bundle/deployment-maintenance.sh" backup --root "$root" --backup-dir "$backups"
```

成功时看到 `备份已保存：<完整路径>` 和 `PASS: backup。`。停站前会先检查空间，不够就直接拒绝，网站不受影响。

**校验某一份备份（只读）**：用一个不联网的临时容器检查数据库导出能否读取，不改数据库和媒体。

```bash
read -r -p '备份完整目录：' snapshot
bash "$bundle/deployment-maintenance.sh" backup-verify --bundle "$bundle" --root "$root" --backup "$snapshot"
```

看到 `PASS: backup-verify。`。它只能校验**当前版本**做的备份；升级之后，旧版本做的备份（包括 `upgrade-*`）会被它拒绝，这不代表备份坏了。

**备份失败时**：脚本会尝试重新启动应用，旧备份不会被删除。先用 `status` 看网站是否恢复，没恢复就按 3.2 启动。失败留下的 `.partial.*` 目录是现场，不计入份数，也不会被自动删除，排查后自己删掉。断电、强杀进程或 Docker 不可用时，脚本没法自动恢复网站，要人工检查。

备份里有什么、保留几份、空间怎么算，见 7.3。

### 3.4 定时备份

装好以后（安装见 5.7），每天北京时间 03:00 自动执行一次 3.3 的备份；那时 Server 没开机就跳过，不会补。它通过固定启动器 `/usr/local/libexec/artzoo-backup` 读取 `deploy/current`，所以升级、回退后不用改配置。

```bash
systemctl list-timers artzoo-backup.timer                          # 下次运行时间
systemctl show artzoo-backup.service -p Result -p ExecMainStatus   # 上次结果，正常是 Result=success、ExecMainStatus=0
sudo journalctl -u artzoo-backup.service -n 40 --no-pager          # 上次的输出
cat "$root/deploy/backup-last"                                     # 最近一次备份结果，status 里也会显示
```

暂停：`sudo systemctl stop artzoo-backup.timer`；恢复：`sudo systemctl start artzoo-backup.timer`。

定时备份失败时，`status` 和 Windows 入口的 `-status` 都会显示警告和原因代码（见 7.4）。查明原因、确认没有维护操作在进行、网站健康后，可以手动触发一次验证：【危险：立即停站备份】`sudo systemctl start artzoo-backup.service`。

---

## 4. 从备份恢复（原地恢复）【危险】

用一份备份覆盖当前站点的数据库和全部媒体，用于家庭 Server 演练或误操作后找回数据。注意：

- 只能恢复**当前版本**做的备份（备份记录的版本必须和 `deploy/current` 一致）。要退回上一个版本请用 2.6 回退，不要手动改 `current` 或备份清单。
- 恢复前脚本会自动把当前状态另存为 `rescue-*` 备份，恢复错了还能撤销（第 5 步）。
- 恢复后必须做媒体登记（第 3 步），登记完成前网站保持停止。

**第 1 步：选好备份并校验。** 也可以先按 3.3 做一份新备份再恢复它。

```bash
read -r -p '要恢复的备份完整目录：' snapshot
bash "$bundle/deployment-maintenance.sh" backup-verify --bundle "$bundle" --root "$root" --backup "$snapshot"
```

演练时，可以在这之后登录网站发一条日常、传一张图，恢复后它们应该消失。

**第 2 步：【危险：覆盖当前站点】**

```bash
bash "$bundle/deployment-maintenance.sh" restore --bundle "$bundle" --root "$root" --backup-dir "$backups" --backup "$snapshot"
```

脚本会：重新核对备份（校验和、版本、数据库镜像、项目，不符就在停站前拒绝）→ 停止 web、worker → 另存 `rescue-*` 备份 → 写入登记标记 → 在一个事务里重建数据库 → 清空并解包三个媒体目录 → 保持停站。

成功时看到 `PASS: restore；保持停站，登记成功后应恢复状态=running`（恢复前网站是停着的则为 `=stopped`），下面打印一条【危险】`media-reregister` 命令。记下输出里 `备份已保存：` 后面的 `rescue-*` 路径。

覆盖阶段失败时网站保持停止，脚本会打印当前状态的备份路径，以及一条带 `--keep-stopped true` 的恢复命令；查明原因后单独执行它。准备阶段失败时，如果网站原本在运行，脚本会尝试重新启动它。

**第 3 步：【危险：停写并重新登记媒体】** 复制上一步打印的命令执行，或者执行：

```bash
bash "$bundle/deployment-maintenance.sh" media-reregister --root "$root" --backup-dir "$backups"
```

成功时看到 `PASS: media-reregister；原运行状态=……`。任何文件缺失或内容不符都会拒绝，网站保持停止。

**第 4 步：开站并验证。**

- 状态是 `running`：登记成功后已经自动开站并检查过健康。
- 状态是 `stopped`（恢复前网站本来就停着，或者第 2 步加了 `--keep-stopped true`）：网站仍然停止，需要时按 3.2 启动。

然后执行 3.1 的 `status` 和 `media-identity`（退出码 0），登录看旧图片；删除一张恢复前就有的相册照片，确认配额恰好退回一次。演练时确认第 1 步之后发的日常和图片已经消失。

**第 5 步（需要时）：撤销这次恢复。** 把第 2 步输出的 `rescue-*` 路径当作 `--backup`，重新做第 2–4 步。

恢复本身不清理备份，之后登记成功时会按保留规则清理（7.3）。需要长期保存的恢复点，另外复制归档。

---

## 5. 第一次搭建新站点

只用于**全新的空站点**（例如正式服务器上线）。已经在运行的站点用第 2 节升级，绝对不要再执行这里的初始化命令。

开始前：

- 家庭 WSL 先完成 `docs/HOME_WSL_SETUP.md` 里的一次性配置；独立的 Linux 服务器不需要。
- 正式服务器的首位超管必须在服务器的**真实控制台**（例如云厂商的 VNC）上创建，SSH 不行（5.4 第 4 步）。
- 发布包按 2.1 构建。

### 5.1 准备主机

使用 Ubuntu + systemd，有一个 UID 和 GID 都是 1000 的运行用户，装好 Docker 和 Docker Compose（已经有就跳过）。然后创建发布包目录，再按 2.2 把发布包复制进去：

```bash
sudo install -d -o 1000 -g 1000 -m 755 /srv/artzoo/releases
```

### 5.2 导入发布包

```bash
read -r -p '发布包完整目录：' bundle
read -r -p '站点 HTTPS 地址（例如 https://192.168.1.10，不要结尾斜杠）：' origin
root=/srv/artzoo
backups=/srv/artzoo/backups
port=13100
bash "$bundle/deployment-images.sh" verify "$bundle"
bash "$bundle/deployment-images.sh" import "$bundle"
bash "$bundle/deployment-images.sh" check "$bundle"
```

三条都看到 `PASS`。后面 5.3–5.6 都在这个终端里做；中途换了终端，重新执行前五行设置变量。

### 5.3 创建目录和配置

**第 1 步：创建目录并生成配置**（只在新站执行）。

```bash
sudo install -d -o 1000 -g 1000 -m 700 "$root/secrets" "$root/media" "$root/media/"{original,derived,avatars}
bash "$bundle/deployment-maintenance.sh" prepare-env --bundle "$bundle" --root "$root" --origin "$origin"
```

看到 `PASS: prepare-env；配置已创建，权限 0600，配额关闭。`。数据库密码和邀请密钥已经自动随机生成。

**第 2 步：填写短信等配置。**

```bash
editor "$root/secrets/compose.env"
```

- 需要短信（邀请注册、找回密码都要用）：`ARTZOO_SMS_PROVIDER=aliyun-pnvs`，并填齐另外五项，模板编号必须是 `100001` 和 `100003`。不需要就保持 `unconfigured`，五项留空。
- 需要时调整配额上限。**保持 `ARTZOO_MEDIA_BUDGET_ENABLED=0`**，后面由 `enable-budget` 打开。
- 写法见 7.5，各变量的含义见 ARCHITECTURE.md 第十一节。

**第 3 步：检查配置。**

```bash
bash "$bundle/deployment-maintenance.sh" config-check --bundle "$bundle" --root "$root"
```

看到 `PASS: config-check；配置符合发布包清单。`。然后把 `compose.env` 另外离线保存一份，它不在日常备份里。

### 5.4 初始化数据库和首位超管

每一步单独执行，看到成功标志再做下一步。任何一步失败都停下：不要删除数据卷，不要重复初始化。

**第 1 步：【危险：新建数据库】** 创建数据库卷并启动 PostgreSQL（只能在空站执行）。

```bash
bash "$bundle/deployment-maintenance.sh" database --bundle "$bundle" --root "$root"
```

成功：`PASS: database；项目 artzoo。`

**第 2 步：【危险：迁移空库】**

```bash
bash "$bundle/deployment-maintenance.sh" migrate --bundle "$bundle" --root "$root"
```

成功：`PASS: migrate；项目 artzoo。`

**第 3 步：【危险：写入媒体基线】** 上传配额必须先有基线。

```bash
bash "$bundle/deployment-maintenance.sh" baseline --bundle "$bundle" --root "$root"
```

成功：`PASS: baseline；项目 artzoo。`

**第 4 步：【危险：创建首位超管】** 必须在 Server 本机的真实终端执行，不能通过 SSH。按提示输入本人手机号、参与身份、确认语和两遍密码；密码不会出现在命令行或日志里。

```bash
bash "$bundle/deployment-maintenance.sh" owner --bundle "$bundle" --root "$root"
```

成功：`PASS: owner；项目 artzoo。`

**第 5 步：【危险：启用配额并启动网站】**

```bash
bash "$bundle/deployment-maintenance.sh" enable-budget --bundle "$bundle" --root "$root"
```

成功：看到 `PASS: web health` 和 `PASS: enable-budget；项目 artzoo。`。这时 `deploy/current` 已记录初始版本。再确认一次：

```bash
curl --fail --noproxy '*' "http://127.0.0.1:$port/api/health"     # 应返回 {"ok":true}
```

### 5.5 配置 Caddy（HTTPS 入口）

**第 1 步：安装 Caddy**（已经装了就跳过），按 [Caddy 官方 Ubuntu 安装步骤](https://caddyserver.com/docs/install#debian-ubuntu-raspbian)：

```bash
sudo apt install --yes debian-keyring debian-archive-keyring apt-transport-https curl gnupg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

**第 2 步：选一个模板，复制成候选文件。**

- 家庭局域网：

  ```bash
  sudo install -m 644 "$bundle/Caddyfile.lan.example" /etc/caddy/Caddyfile.pending
  ```

  把文件里两处 `LAN_IP` 换成固定的局域网 IPv4。

- 正式域名（取得上线授权、域名已经解析到服务器之后）：

  ```bash
  sudo install -m 644 "$bundle/Caddyfile.public.example" /etc/caddy/Caddyfile.pending
  ```

  把 `SITE_DOMAIN` 换成域名。服务器要放行 TCP 80 和 443。

**第 3 步：编辑并核对候选文件。** 执行 `sudoedit /etc/caddy/Caddyfile.pending`：站点地址必须和 `$origin` 完全一致；后端是 `127.0.0.1:` 加 `$port`；不要添加 `trusted_proxies`、`header_up` 或访问日志。

**第 4 步：校验候选文件，并备份原配置。**

```bash
sudo caddy fmt --overwrite /etc/caddy/Caddyfile.pending
sudo -u caddy -H caddy validate --config /etc/caddy/Caddyfile.pending --adapter caddyfile
caddy_backup=$(sudo mktemp /etc/caddy/Caddyfile.before-artzoo.XXXXXX)
sudo cp -p /etc/caddy/Caddyfile "$caddy_backup"
printf 'Caddy 备份：%s\n' "$caddy_backup"
```

校验要看到 `Valid configuration`；不通过就修改候选文件后重新校验，不要安装它。

**第 5 步：【危险：切换 HTTPS 入口】**

```bash
sudo install -m 644 /etc/caddy/Caddyfile.pending /etc/caddy/Caddyfile
sudo systemctl reload caddy
systemctl show caddy -p ActiveState -p SubState
```

应该显示 `ActiveState=active`、`SubState=running`。出问题时恢复原配置：【危险】`sudo cp -p "$caddy_backup" /etc/caddy/Caddyfile && sudo systemctl reload caddy`，再检查 HTTPS。

### 5.6 验证代理，让网站信任 Caddy 传来的 IP

网站默认把所有访问者算作同一个来源（限流共用一个桶）。先确认 Caddy 会覆盖伪造的转发头，再让 web 读取 Caddy 传来的真实 IP。

**第 1 步：准备检查工具。**

```bash
bash "$bundle/deployment-images.sh" verify "$bundle"
tools_image=$(awk '$1 == "tools" {print $2}' "$bundle/images.tsv")
test -n "$tools_image"
ca_mount=()
```

只有家庭局域网证书模式再执行下面这一行（正式域名跳过）：

```bash
ca_mount=(--mount type=bind,src=/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt,dst=/ca.crt,readonly)
```

**第 2 步：【危险：短暂加载测试路由】** 检查工具会临时给 Caddy 加一条测试路由，核对证书、健康检查，以及伪造的 `X-Forwarded-*` 头会被 Caddy 覆盖；然后等 60 秒，让你用另一台局域网设备打开它打印的地址；最后删掉测试路由、恢复原配置。

```bash
sudo docker --host unix:///var/run/docker.sock run --rm --network host \
  --user 0:0 --cap-drop ALL --security-opt no-new-privileges --read-only \
  --mount "type=bind,src=$bundle/deployment-https-check.mjs,dst=/check.mjs,readonly" \
  "${ca_mount[@]}" --entrypoint node "$tools_image" /check.mjs "$origin" "$port" 60
```

- 先出现 `PASS: HTTPS certificate, health and forged forwarding headers`；
- 60 秒内用另一台设备打开 `CLIENT CHECK` 后面的地址：`source` 应该是那台设备的 IP，`protocol` 是 `https`，`host` 是站点地址；
- 最后出现 `PASS: original Caddy configuration restored`。

失败就停下：先执行【危险】`sudo systemctl reload caddy` 清掉可能残留的测试路由，确认 Caddy 是 `active/running`；必要时按 5.5 第 5 步恢复原配置。

**第 3 步：安装代理覆盖文件。** `compose.env` 里的 `ARTZOO_TRUSTED_PROXY` 保持空值，这个文件只给 web 打开信任。

```bash
sudo install -d -o 1000 -g 1000 -m 750 "$root/deploy"
proxy="$root/deploy/proxy.compose.yaml"
proxy_backup=''
if test -e "$proxy"; then
  proxy_backup=$(mktemp "$root/deploy/proxy.before-artzoo.XXXXXX")
  cp -p "$proxy" "$proxy_backup"
fi
sudo install -o 1000 -g 1000 -m 640 "$bundle/proxy.compose.yaml.example" "$proxy"
printf '代理备份（空值表示此前没有覆盖文件）：%s\n' "$proxy_backup"
dc() { sudo env -i "PATH=$PATH" "HOME=$HOME" docker --host unix:///var/run/docker.sock compose --project-name artzoo --env-file "$bundle/images.env" --env-file "$root/secrets/compose.env" -f "$bundle/compose.yaml" -f "$proxy" "$@"; }
dc config --quiet
```

`dc config --quiet` 没有输出就是正常。

**第 4 步：【危险：重建 web】** 只在当前运行的就是这个发布包时执行。网站会中断几十秒，数据库和 worker 不动。

```bash
dc up -d --no-deps --no-build --pull never --force-recreate --wait web
bash "$bundle/deployment-maintenance.sh" status --bundle "$bundle" --root "$root"
```

`status` 最后一行是 `PASS: status；项目 artzoo。`。

**第 5 步：再检查一次。** 重新执行第 2 步（最后的 `60` 可以改成 `0`，不再等其他设备），两条 `PASS` 都要出现。

**第 6 步：确认端口没有暴露。** 从另一台设备检查：443 能连上；13100（后端）、3100（开发端口）、5432（数据库）、2019（Caddy 管理）都连不上。家庭的 Windows 防火墙见 `docs/HOME_WSL_SETUP.md`；正式服务器用安全组或主机防火墙，只开放 SSH、80 和 443。

**需要撤销代理信任时**：把 `$proxy_backup` 复制回 `$proxy`；此前没有覆盖文件的，就只移走这次新装的 `$proxy`，并把上面 `dc()` 定义里的 `-f "$proxy"` 去掉。然后重新执行第 4 步。

### 5.7 安装定时备份（一次性）

模板面向 Server 的系统 Docker，不要装到 Dev。运行用户要能不输入 sudo 密码访问 Docker（服务单元里用 `SupplementaryGroups=docker`）。

**第 1 步：另存现有单元，准备候选文件。**

```bash
timer_was_active=0
if systemctl is-active --quiet artzoo-backup.timer; then
  timer_was_active=1
  sudo systemctl stop artzoo-backup.timer
fi
systemctl is-active artzoo-backup.service
saved=$(mktemp -d "$root/deploy/backup-units.XXXXXXXX")
for unit in artzoo-backup.service artzoo-backup.timer; do
  if test -f "/etc/systemd/system/$unit"; then sudo cp -a "/etc/systemd/system/$unit" "$saved/"; fi
done
cp "$bundle/artzoo-backup.service.example" "$saved/artzoo-backup.service.new"
cp "$bundle/artzoo-backup.timer.example" "$saved/artzoo-backup.timer.new"
editor "$saved/artzoo-backup.service.new"
```

服务显示 `active` 或 `activating` 时，先等这次备份结束、确认网站健康再继续。

在候选的 service 里，`ExecStart` 固定是 `/usr/local/libexec/artzoo-backup`，只需要核对参数：`--root`、`--backup-dir`、`--keep`（日常备份保留份数，默认 7）、`--keep-maintenance`（升级、登记、救援备份每类保留份数，默认 3）；项目名不是 `artzoo` 时加 `--project`。

**第 2 步：安装固定启动器和单元。** 这些命令不会启动备份。

```bash
sudo install -d -o root -g root -m 755 /usr/local/libexec
if test -e /usr/local/libexec/artzoo-backup; then
  printf '固定入口已存在，请核对来源和权限；不覆盖。\n'
else
  sudo install -o root -g root -m 755 "$bundle/artzoo-backup-launcher.sh" /usr/local/libexec/artzoo-backup
fi
stat -c '%U:%G %a %n' /usr/local/libexec/artzoo-backup
sudo install -m 644 "$saved/artzoo-backup.service.new" /etc/systemd/system/artzoo-backup.service
sudo install -m 644 "$saved/artzoo-backup.timer.new" /etc/systemd/system/artzoo-backup.timer
sudo systemd-analyze verify /etc/systemd/system/artzoo-backup.service /etc/systemd/system/artzoo-backup.timer
sudo systemctl daemon-reload
```

`stat` 应该显示 `root:root 755 /usr/local/libexec/artzoo-backup`，`systemd-analyze verify` 没有报错。启动器只装一次，以后发版不用重装；只有启动器本身的代码改了才需要更新（先另存旧文件）。

**第 3 步：【危险：立即停站备份一次】**

```bash
sudo systemctl start artzoo-backup.service
```

**第 4 步：检查结果，启用每日定时。**

```bash
systemctl show artzoo-backup.service -p Result -p ExecMainStatus
bash "$bundle/deployment-maintenance.sh" status --root "$root" --backup-dir "$backups"
sudo journalctl -u artzoo-backup.service -n 40 --no-pager
```

应该是 `Result=success`、`ExecMainStatus=0`，`status` 里的最近备份结果是 `result=success`。然后启用每日定时：

- 第一次安装：【危险：启用每日停站备份】`sudo systemctl enable --now artzoo-backup.timer`
- 原来就开着的：`sudo systemctl start artzoo-backup.timer`

最后用 `systemctl list-timers artzoo-backup.timer` 看下次运行时间。

**撤销**：停止 timer，等正在运行的备份结束；把 `$saved` 里的原单元复制回 `/etc/systemd/system/`，执行 `systemd-analyze verify` 和 `daemon-reload`，确认网站健康后恢复原来的 timer 状态。第一次安装（没有原单元）就保持 timer 禁用。固定启动器可以留着，不用删备份、发布包或站点数据。

### 5.8 家庭：安装 Windows 固定入口（一次性）

前提：Server 已经部署好，有有效的 `deploy/current`。

在 Windows PowerShell 里执行，把仓库 `deployment/` 里或发布包里的 `artzoo-resident.ps1` 复制成固定文件（只复制这一个文件，不是整个发布包）：

```powershell
$source = Read-Host '新版 artzoo-resident.ps1 的完整路径'
$directory = Join-Path $env:USERPROFILE 'Documents\ArtZoo-FC'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$control = Join-Path $directory 'ArtZoo-FC-Server.ps1'
if (Test-Path -LiteralPath $control) { throw '固定入口已存在，请先核对，不覆盖' }
Copy-Item -LiteralPath $source -Destination $control
```

- 已经装过就跳过；升级、回退后都不用重新复制。只有入口脚本本身改了才更新，更新前先另存原文件。
- 不要直接从 `\\wsl.localhost\...` 路径运行入口（查看状态时会把已经关闭的 WSL 唤醒）。
- 不创建快捷方式、计划任务或开机自启。
- PowerShell 拦截脚本运行时，只针对这一个文件处理，不要永久降低全局执行策略。

装好后验证一遍（用法见 3.2）：`-status` → 【危险】`-start` → 关掉所有 WSL 和 PowerShell 终端，等至少一分钟后用手机访问网站 → 【危险】`-stop`。

### 5.9 收尾

- 按 3.3 手动备份一次，并用 `backup-verify` 校验。
- 把 `compose.env` 离线保存好（5.3 第 3 步）。
- 按 DECISIONS 第 16 条，正式服务器上线前还要做一次独立目标恢复演练，具体步骤届时另定。

---

## 6. 出错时怎么办

### 6.1 维护脚本的拒绝提示

脚本拒绝时以 `停止：` 开头。下表这些拒绝都发生在改动任何东西之前，网站保持原状。

| 提示里有 | 意思 | 怎么做 |
|---|---|---|
| `同一站点有另一维护操作正在执行` | 另一条维护命令正在运行（常见是定时备份） | 等它结束（`systemctl is-active artzoo-backup.service` 不再是 `active`）再重试；不要杀进程 |
| `媒体登记未完成` | 恢复或回退后还没登记媒体，网站保持停止 | 执行 `media-reregister`（2.6 第 2 步，或第 4 节第 3 步） |
| `登记未完成；restore 须保持停站` | 媒体登记没完成时又要恢复 | 恢复命令加上 `--keep-stopped true` |
| `升级/恢复尚未完成` | 升级在迁移开始后失败了 | 按 2.6 回退 |
| `维护尚未完成：…；不执行备份` | 有没完成的升级、恢复或登记，备份被跳过 | 先把那个操作做完 |
| `备份空间不足：需要 … 字节，剩余 … 字节` | 备份盘空间不够，网站没受影响 | 腾出空间，或换备份目录（之后所有命令都用新目录），再重试 |
| `镜像缺失或 ID 不符` / `镜像缺失或 ID 不一致` | 命令要用的发布包镜像不在本机 | 导入那个发布包：`bash "<发布包>/deployment-images.sh" import "<发布包>"`。日常命令用的是当前包，升级是新包，回退还要用到旧包 |
| `发布包校验失败` | 发布包文件不完整或被改过；回退之后也可能出现（见 2.6 最后一段） | 不要改发布包；回退后的情况按 2.6 处理，其他情况交给 AI 排查 |
| `所选发布包与 deploy/current 不一致` | 用错了发布包 | 按 0.4 重新读取 `bundle` |
| `请使用镜像对应的 UID/GID 1000 用户执行` | 用了 root 或 `sudo` 执行脚本 | 换回运行用户，不要 `sudo` 整个脚本 |
| `相同发布版本，无需升级` / `相同版本，无需升级` | 这个版本已经在运行 | 不用升级 |
| `配置检查未通过` | `compose.env` 有缺失、多余或格式不对的变量，上面会列出变量名 | `editor "$root/secrets/compose.env"` 改好后再 `config-check`。刚为新版本补了变量、还没升级时，旧版本会报 `多余：`，直接升级即可（2.3 第 5 步） |
| `容器非秘密配置不一致` | `compose.env` 里某个值和正在运行的容器不一样，通常是改过配置 | 见 7.5 最后一条 |
| `应用运行状态不一致，请先明确停站` | web 和 worker 一个在运行、一个停了 | 先按 3.2 让两者一致（都停或都启动） |
| `数据库包含新包不认识的迁移，拒绝降级` | 新包比数据库还旧，多半选错了包 | 核对版本 |
| `已执行迁移内容发生变化，拒绝升级` | 已经执行过的迁移文件被改过 | 停下，交给 AI 排查（迁移只能新增，不能修改） |
| `旧包不支持登记，回退后无法安全开站` | 上一版太旧，没有媒体登记功能 | 不要回退，保持现状，交给 AI 另行评估 |
| `升级不能更换 PostgreSQL 镜像` | 新包的数据库镜像版本变了 | 停下，这需要单独的数据库升级方案 |

### 6.2 各环节失败后，网站处于什么状态

| 失败在哪 | 网站状态 | 下一步 |
|---|---|---|
| 升级：迁移开始前 | 多数检查在停站前，网站没停；停站后才失败的，脚本尝试重新启动旧版本 | 用 `status` 确认旧版本正常 |
| 升级：迁移开始后 | 停止，留下 `deploy/pending` | 执行输出里的回退命令，或按 2.6 回退 |
| 回退或媒体登记 | 停站前的检查失败：保持原状；停站后失败：停止，备份和标记都保留 | 按报错核对文件内容、权限和空间，修好后重新执行同一条命令。如果 `deploy/` 里 `pending` 和 `media-registration.pending` 同时存在，两条命令都会被拒绝，这时停下交给 AI |
| 手动或定时备份 | 脚本尝试重新启动应用 | `status`；没恢复就按 3.2 启动；`.partial.*` 保留 |
| 恢复：准备阶段 | 原本在运行的会尝试重新启动 | `status` |
| 恢复：覆盖阶段 | 停止 | 执行输出里那条带 `--keep-stopped true` 的恢复命令（用 `rescue-*` 备份） |

不管哪种失败：不要删除最后一份有效备份，不要删 `deploy/` 里的标记，不要用旧发布包的脚本绕过检查。

### 6.3 媒体文件身份检查（media-identity）

```bash
bash "$bundle/deployment-maintenance.sh" media-identity --root "$root"; echo "退出码=$?"
```

这个检查是只读的：数据库只用只读查询，检查容器不联网、媒体只读挂载；不改身份、不删图、不动配额。检查期间不要上传或删除图片，也不要直接改动宿主机上的媒体文件，否则可能出现暂时的"无法检查"。

输出是一行 JSON：`consistent` 一致，`inconsistent` 不一致，`unchecked` 无法检查。`baseline` 是三个媒体根目录的整体基线，`components` 是全部文件，`directories` 按子目录分别统计。`skippedCredited`（已删除并退还配额的历史记录）、`skippedAggregate`（基线汇总记录）、`skippedDatabase`（存在数据库里的快捷入口图标）不参与磁盘比较。`components` 全是 0 只说明还没有上传过图片，不能当作图片验证通过。

| 退出码 | 意思 | 怎么做 |
|---|---|---|
| 0 | 全部一致 | 不用处理 |
| 2 | 有不一致或无法检查的项 | 确认没人在上传或删除后重新检查；仍是 2，就执行下面的【危险】登记 |
| 1 | 检查本身失败（例如快照不完整） | 看报错后重试 |

【危险：停写、备份并重新登记媒体】网站正在运行时也可以执行，登记完会自动恢复运行：

```bash
bash "$bundle/deployment-maintenance.sh" media-reregister --root "$root" --backup-dir "$backups"
```

恢复和回退之后脚本会强制要求登记。其他时候一般不需要：站长实测过，家庭 Server 在 Windows 重启后身份保持一致。

---

## 7. 参考

### 7.1 维护命令一览

用法：`bash "$bundle/deployment-maintenance.sh" <命令> --root /srv/artzoo [选项]`。

| 命令 | 作用 | 影响 | `--bundle` |
|---|---|---|---|
| `status` | 检查站点，显示备份统计 | 只读 | 可省略，读 `current` |
| `media-identity` | 检查媒体文件身份 | 只读 | 可省略 |
| `config-check` | 检查 `compose.env` | 只读，不连 Docker | 必须 |
| `backup-verify` | 校验一份备份 | 只读 | 必须 |
| `start` / `stop` | 启动 / 停止现有容器（`stop` 也停数据库） | 启停网站 | 可省略 |
| `backup` | 备份 | 短暂停站 | 可省略 |
| `restore` | 用备份覆盖当前站点 | 停站，覆盖数据 | 必须 |
| `media-reregister` | 备份并重新登记媒体身份 | 停站 | 可省略 |
| `upgrade` | 升级到新包 | 停站，迁移数据库 | 必须（新包） |
| `rollback` | 回退到上一版 | 停站，丢弃升级后的数据 | 用新包里的脚本执行 |
| `prepare-env`、`database`、`migrate`、`baseline`、`owner`、`enable-budget` | 新站初始化（第 5 节） | 创建数据 | 必须 |

常用选项：

- `--backup-dir`：备份目录，默认 `/srv/artzoo/backups`。
- `--keep`：日常备份保留份数，默认 7；`--keep-maintenance`：其他备份每类保留份数，默认 3（见 7.3）。
- `--backup`：恢复或校验时指定备份目录。
- `--keep-stopped true`：只用于 `restore`，登记成功后仍保持停站。
- `--project`：项目名，默认 `artzoo`。
- `--from`：只用于没有 `deploy/current` 记录的老站点第一次升级。按本手册初始化的站点都有这条记录，不需要它。

发布包工具：`bash deployment-images.sh verify|import|check <发布包目录>`；构建只在 Dev 的仓库里用 `bash scripts/deployment-images.sh build`。

### 7.2 `deploy/` 里的文件

| 文件 | 内容 | 什么时候有 |
|---|---|---|
| `current` | 一行：`<当前发布包目录> <版本名> <配置清单来源包>` | 初始化完成后；升级成功后三列都指向新包；回退后第 1 列指回旧包，第 3 列仍是回退掉的新包 |
| `previous` | 一行：`<旧包目录> <旧版本名> <升级前备份目录> <新包目录>` | 升级时（迁移之前）写入；回退成功后删除 |
| `pending` | 升级或回退正在进行，或者中途失败 | 存在时只允许 `rollback` 和 `stop` |
| `media-registration.pending` | 媒体登记还没完成；内容是登记后要恢复的状态（`running` 或 `stopped`） | 恢复、回退时写入，单独执行 `media-reregister` 时也会先写入；登记成功后删除。存在时只允许 `media-reregister`、`media-identity`、`stop`，以及带 `--keep-stopped true` 的 `restore` |
| `history.log` | 每次升级、回退一行：时间、操作、from、to、备份、结果 | 一直追加 |
| `backup-last` | 最近一次备份的结果（见 7.4） | 每次 `backup`（含定时）结束时更新 |
| `proxy.compose.yaml` | 让 web 信任 Caddy 的四行配置 | 5.6 安装 |

这些都是纯文本记录：`current` 不是符号链接，也不要 `source` 它。脚本只按记录选择版本，不会按目录时间去猜。

### 7.3 备份

**内容**：PostgreSQL 导出（custom 格式）、三个媒体目录的 tar 包、已完成的迁移列表，以及清单（版本、PostgreSQL 镜像 ID、项目、各文件大小和 SHA-256）。媒体保留数字属主和权限；遇到链接、特殊文件、路径穿越或嵌套挂载会拒绝。`compose.env` 不在备份里。备份目录含全部站点数据，按私有数据保管。

**分类和默认保留份数**（名字里的时间是 UTC）：

| 前缀 | 谁产生 | 默认保留 |
|---|---|---|
| `backup-` | 手动和定时备份 | 7 份（`--keep`） |
| `upgrade-` | 升级前 | 3 份（`--keep-maintenance`） |
| `register-` | 媒体登记前 | 3 份 |
| `rescue-` | 恢复、回退覆盖前的现场 | 3 份 |

**清理规则**：只在 `backup`、`upgrade`、`rollback`、`media-reregister` 成功后清理，失败时不清理；`restore` 本身不清理。只删除同项目、同 PostgreSQL 镜像、校验通过、名字符合格式的旧备份；`previous` 引用的那份、每类最新的一份和本次新做的一份始终保留。损坏的、其他项目的、名字不认识的和 `.partial.*` 都不动，留给人工处理。空间不足时也不会先删旧备份腾地方。

> 建议一直用默认份数（日常 7、其他每类 3）。会清理备份的命令都按 `--keep` 和 `--keep-maintenance` 执行，没写就用默认值；脚本打印的回退、登记命令也不带这两个参数。如果把定时备份改成了别的份数，手动执行 `backup`、`upgrade`、`rollback`、`media-reregister` 时都要自己加上同样的参数，否则会按默认值清理。

**空间**：停站前要求备份所在文件系统的剩余空间 ≥（数据库大小 + 三个媒体目录的内容字节数）× 1.5 + 1 GB，不够就在停站前拒绝。`backup`、`upgrade`、`rollback`、`media-reregister`，以及 `restore` 另存现场时都会检查。按默认份数，同时会有 16 份左右的全量备份（日常 7 份，另外三类各 3 份）。媒体按上限 10 GB 估算，16 份约 160 GB，再加上每次备份前的空间检查（`status` 在剩余空间不到下次备份估算值的 2 倍时就会警告），备份盘建议准备 200 GB 左右。

**备份目录的要求**：绝对路径，不含空格和链接；属于 UID/GID 1000、权限 0700，上级目录不能被组或其他用户写入；不能放在 Windows 挂载的盘上；不要几个站点共用一个目录。换目录以后，旧目录里的备份不会被自动清理。

### 7.4 `backup-last` 和原因代码

格式：`<UTC 时间> result=success release=<版本> backup=<路径>`，或 `<UTC 时间> result=failed release=<版本> reason=<代码>`。

| 代码 | 意思 |
|---|---|
| `maintenance-locked` | 有别的维护操作在执行 |
| `pending`、`media-registration.pending` | 升级、恢复或媒体登记没完成，不做备份 |
| `current-invalid`、`bundle-invalid` | `deploy/current` 记录或它指向的发布包有问题 |
| `preflight` | 备份前的检查没通过（配置、容器、健康等） |
| `space-check` | 空间不足 |
| `snapshot-failed` | 导出数据库或打包媒体失败 |
| `restart-failed` | 备份后重新启动应用或健康检查失败 |
| `publish-failed` | 把备份放进备份目录时失败 |
| `prune-failed` | 清理旧备份失败（新备份已经保存） |
| `exec-failed` | 固定启动器没能启动当前包的备份脚本 |

详细输出看 `sudo journalctl -u artzoo-backup.service`。断电或进程被强杀时可能来不及写这条记录，要结合备份目录里的时间和 journal 判断。

### 7.5 `compose.env` 的写法

- 只能写**当前运行版本**的 `runtime-config.manifest` 里声明的变量。多写、缺必填项或格式不对，`config-check` 都会指出（只列变量名）；`status`、备份等日常命令也会因此拒绝。升级时例外：升级会同时接受新旧两个版本声明的变量（见 2.3 第 5 步）。
- 普通值写成 `NAME=value`。值里有 `$`、`#`、引号或反斜杠时，用单引号包起来，值里的单引号写成 `\'`。
- 不支持：双引号、变量插值、行尾注释、多行值、首尾空格、以反斜杠结尾的值、反斜杠紧挨着单引号。
- 可选项留空就用默认值。短信的五项在 `ARTZOO_SMS_PROVIDER=aliyun-pnvs` 时必须全部填写，`unconfigured` 时必须全部留空。
- 各变量的含义和默认值见 ARCHITECTURE.md 第十一节。
- 站点建好后不要再改 `POSTGRES_PASSWORD`：改它不会改变数据库里的实际密码，容器重建后反而连不上数据库。
- **改了已有变量的值，正在运行的容器不会自动更新。** 非秘密的值（例如配额上限、短信签名、`AUTH_SMS_DAILY_LIMIT`）改了以后，维护脚本会发现容器里的值对不上，`status`、`start`、备份（含定时备份）、`restore`、`media-identity`、`media-reregister` 和 `upgrade` 都会以"容器非秘密配置不一致"拒绝；秘密的值（例如短信凭证）不会报错，但在容器重建前不会生效。目前没有专门重建容器的维护命令，所以**改配置前先让 AI 给出具体步骤**，不要先改了再说。
