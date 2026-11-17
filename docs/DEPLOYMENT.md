# 部署操作手册

所有 Server 命令由站长执行。按步骤逐条运行，失败即停；不要把整章一次粘贴执行。发布包不可改文件或重算校验和；保留旧包、镜像和备份。秘密配置、证书私钥不随发布包传输，也不输出到终端或日志。以下默认根目录 `/srv/artzoo`、Compose 项目 `artzoo`、运行用户 UID/GID `1000:1000`；已有站点使用原值，跨版本保持一致。不要 sudo 整个维护脚本。

## 1. 日常发版：构建、传输、升级、验证与回退

本节面向已经可用的站点，正常发版不需要重新初始化或查看其他章节。首次部署用第 3 节。家庭 Server 必须已启动并保持常驻；升级不负责开启 WSL。正式服务器使用同一发布包和维护命令，仅传输方式不同。

### 1.1 Dev：构建完整发布包（仓库根目录）

1. 将本次改动通过 PR 合并到 `main`，在干净工作区更新代码；有未提交内容时先处理，不强制切分支或覆盖文件。

   ```bash
   git status --short
   git switch main
   git pull --ff-only origin main
   node scripts/check-rules.mjs --base origin/main
   pnpm format:check && pnpm lint && pnpm typecheck && pnpm build
   ```

2. 家庭 Dev 确认 `docker info --format '{{json .SecurityOptions}}'` 包含 `rootless`；保持现有隔离配置。需要构建代理时设置 `ARTZOO_BUILD_PROXY=http://10.0.2.2:7890`，端口按本机实际值；代理不得含账号密码。构建三镜像完整包，不加 `--allow-dirty` 或单镜像 `--target`：

   ```bash
   bash scripts/deployment-images.sh build --output "$(dirname "$PWD")/artzoo-runtime-releases"
   ```

3. 成功后复制输出的完整版本目录，记录版本名。随包已包含维护脚本、配置模板及本手册，无须另外复制文件。核对包并测量大小：

   ```bash
   read -r -p 'Dev 完整发布目录：' bundle
   bash scripts/deployment-images.sh verify "$bundle"
   du -sb "$bundle"
   ```

   2026-11-16 实测并校验的完整包 `git-f53effefd26a-20261115141618-27895` 为 **557,236,851 字节，约 557 MB（531 MiB）**；其中 `images.tar` 为 557,082,112 字节。该包用于说明实际体量，不代表今后的当前版本。未超过约 1 GB；以后超过时在 PLAN 技术改进中登记“发布包压缩或增量传输”，本流程不实现。

### 1.2 传输：家庭和正式服务器二选一

**家庭：Windows PowerShell，任意目录。** 沿用站长的 `Copy-Item` 跨 WSL 直接复制方式，不经过 Windows 中转目录。输入版本名和 Dev 发布包父目录的完整 UNC 路径（以 `\\wsl.localhost\ArtZoo-FC-Dev\` 开头，后接实际 Linux 目录）。只复制该版本目录；Server 的 releases 目录应已存在。

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

复制失败只留下未完成的新目录，旧站不受影响；不要导入、升级或覆盖重传。先核对失败目录，另选全新目标重新复制；复制完成仍须在 Server 校验。

**正式服务器：Dev 终端，仓库根目录。** 服务器需已配置 SSH 和 `rsync`，且运行用户可写 `/srv/artzoo/releases/`；不把密码写在命令中。`bundle` 为上一步的 Dev 版本目录，目标同名版本应尚未交付使用：

```bash
read -r -p 'SSH 目标（用户@主机或已配置别名）：' remote
rsync -a --partial -e ssh -- "$bundle" "${remote}:/srv/artzoo/releases/"
```

源目录末尾不加 `/`，这样传输的是整个版本目录。中断时仅对同一个未交付的新包重复此命令续传，不覆盖已使用的发布目录；不要加 `--delete`。传完登录服务器，执行下面的 `verify`，通过前不导入、不升级。

### 1.3 Server：校验、导入与升级前检查（任意目录）

1. 重新输入 **Server 内**的新包路径，不沿用 Dev 的变量；核对站点地址、项目和旧版本。备份目录若原来在另一块盘，继续填原目录。以下示例使用默认值：

   ```bash
   read -r -p 'Server 新包完整目录：' bundle
   read -r -p '站点 HTTPS 地址（无尾斜杠）：' origin
   root=/srv/artzoo
   project=artzoo
   backups="$root/backups"
   bash "$bundle/deployment-images.sh" verify "$bundle"
   bash "$bundle/deployment-images.sh" import "$bundle"
   bash "$bundle/deployment-images.sh" check "$bundle"
   bash "$bundle/deployment-maintenance.sh" config-check --bundle "$bundle" --root "$root" --project "$project"
   ```

   `verify` 只核对文件；`import` 核对镜像 ID 并导入，不替换网站；`check` 使用临时容器验收。此处不加 `--database`。配置不合格时只报告变量名；站长用 `editor "$root/secrets/compose.env"` 私下补齐，再运行 `config-check`，不复制新模板覆盖已有秘密。

2. 确认当前站点健康；`current` 是数据记录，不是符号链接，也不能 `source`：

   ```bash
   from_args=()
   if test -f "$root/deploy/current"; then
     read -r current current_release current_schema < "$root/deploy/current"
     bash "$bundle/deployment-maintenance.sh" status --root "$root" --project "$project"
   else
     read -r -p '当前正在运行的旧发布包完整目录：' current
     from_args=(--from "$current")
     bash "$bundle/deployment-maintenance.sh" status --bundle "$current" --root "$root" --project "$project"
   fi
   printf '升级前发布目录：%s\n' "$current"
   ```

   缺少 `current` 才使用 `--from`，脚本会核对旧容器后登记；已有记录时不传。状态不符、版本相同、旧包或镜像丢失时先排查，不删除记录绕过。升级不会更换 PostgreSQL 镜像；未知或被改写的历史迁移会被拒绝。

3. 避免定时备份与升级冲突。已安装定时任务时记录原状态并暂停调度，未安装则保持变量为 `0`：

   ```bash
   timer_was_active=0
   if systemctl is-active --quiet artzoo-backup.timer; then
     timer_was_active=1
     sudo systemctl stop artzoo-backup.timer
   fi
   systemctl is-active artzoo-backup.service
   df -h "$root" "$backups" 2>/dev/null
   ```

   服务仍为 `active`/`activating` 时等备份完成，不杀进程；`inactive` 或未安装表示无需等待。备份目录尚不存在时检查其父目录空间。预留新旧镜像、完整数据库及媒体备份空间，并确保宿主机没有其他媒体写入者。若此时取消发版，恢复原本开启的 timer；网站尚未停服。即使未暂停 timer，维护锁也会让同时触发的备份安全失败，新入口会记录 `maintenance-locked`，不会与升级并发停站或写备份。

### 1.4 【危险：停服升级】Server 单独执行

```bash
bash "$bundle/deployment-maintenance.sh" upgrade --bundle "$bundle" --root "$root" --project "$project" --backup-dir "$backups" "${from_args[@]}"
```

脚本检查配置和迁移，列出待执行迁移；随后停 web、worker，强制备份，迁移，重建新镜像并检查健康，成功后更新 `deploy/current`、`deploy/previous` 和 `deploy/history.log`。无新增迁移也可以发布代码小改动；同版本重复升级会拒绝。停服期间 HTTPS 可能显示 502。此步骤不需要另行手动 `migrate`，也没有跳过备份选项。

迁移开始前失败，会尝试启动旧版；先用原包 `status` 确认恢复。迁移开始后失败则保持停站，按输出的准确回退命令执行 1.6，不直接 `start`。任何失败都保留新旧包、备份及控制文件。

### 1.5 Server：验证并恢复日常维护

1. 看到 `PASS: upgrade` 后检查版本、服务和媒体身份。检查期间暂停上传、删除媒体：

   ```bash
   read -r current current_release current_schema < "$root/deploy/current"
   bash "$bundle/deployment-maintenance.sh" status --root "$root" --project "$project"
   bash "$bundle/deployment-maintenance.sh" media-identity --root "$root" --project "$project"
   cat "$root/deploy/current" "$root/deploy/previous"
   tail -n 5 "$root/deploy/history.log"
   curl --fail --noproxy '*' http://127.0.0.1:13100/api/health
   ```

   后端端口若已有定制，使用原端口。应返回 `{"ok":true}`；`current` 指向新包，`previous` 保留旧包及升级前备份，最新历史为 `upgrade ... result=success`。媒体诊断退出码 `0` 才表示一致；`2` 表示不一致或无法检查，`1` 表示执行失败。不把 HTTP 健康等同于业务验收。

2. 在浏览器和另一台家庭设备打开 `$origin`；家庭证书警告可以手动继续，正式域名须证书可信。验证登录、旧图显示、本次小改动，并上传、删除一张测试照片，确认配额退回。失败先停止验收，按 1.6 决定回退；不要把失败版本标为发布成功。
3. 已按第 2 节迁移到固定启动器的定时备份会自动跟随 `deploy/current`，升级、回退无需修改 service。恢复原调度：

   ```bash
   if test "$timer_was_active" = 1; then sudo systemctl start artzoo-backup.timer; fi
   systemctl list-timers artzoo-backup.timer
   bash "$bundle/deployment-maintenance.sh" status --root "$root" --backup-dir "$backups"
   ```

   未安装 timer 跳过。仍使用旧 service 的站点先完成第 2 节的一次性迁移。检查最近备份结果；升级本身不会触发日常备份，上一条结果可能属于旧版本。固定 Windows 常驻入口也自动读取 `deploy/current`，无需修改参数、重新复制入口或重启当前隐藏常驻进程。

### 1.6 【危险：回退会丢弃升级后数据】Server 单独执行

迁移后失败时优先复制脚本打印的完整命令。升级成功后主动回退时，保持 `bundle` 为**本次新包（升级控制包）**，不要先改为旧包；`root`、`project`、`backups` 沿用本章值：

```bash
bash "$bundle/deployment-maintenance.sh" rollback --bundle "$bundle" --root "$root" --project "$project" --backup-dir "$backups"
```

回退在停站和覆盖前检查旧包是否支持媒体登记；不支持就拒绝，运行中的网站保持原状，已因迁移失败停站的网站继续停止。通过后另存当前状态、恢复 `previous` 记录的升级前数据库与媒体、重建并核对旧镜像容器，但不启动 web、worker。成功后 `current` 改回旧包，历史记录 `rollback ... result=success`，消耗 `previous` 并删除升级 `pending`，留下值为 `running` 的 `media-registration.pending`。只支持一级回退，不执行逆向迁移。

看到 `PASS: rollback` 后网站仍停止，必须执行输出的完整 `media-reregister` 命令；`start` 和 Windows 固定入口都会拒绝提前开站。恢复媒体会改变 inode，登记须全量核验内容。沿用本章变量时，先读取恢复后的旧包：

```bash
read -r current current_release current_schema < "$root/deploy/current"
```

【危险：停写并重新登记】Server 单独执行；登记会先备份，逐项核对内容后原子更新身份，不清零用量：

```bash
bash "$bundle/deployment-maintenance.sh" media-reregister --bundle "$current" --root "$root" --project "$project" --backup-dir "$backups"
```

登记成功后按 `running` 标记自动启动旧版本并检查健康；再执行 `status`、`media-identity`，检查登录、旧图、删图退额及 `history.log`。失败保持停站，保留备份和维护标记，不强开网站。按 1.5 把 timer 的两处路径改回实际旧包；Windows 固定入口自动跟随 `current`，无需手工改版本。仅恢复原本开启的调度。升级后新增的数据消失是回退的预期结果。

以上停站保护只随新控制包生效，已交付旧包不改文件、不重算校验和。旧包的 `rollback` 仍可能直接开站，不用它代替本流程；先取得包含本修复的完整控制包并校验。目标旧包还必须自带登记脚本和兼容 tools；不支持时保留现场，另行评审恢复方案，不把新 tools 强塞给旧包。


## 2. 备份与恢复（Server，任意目录）

所有命令由站长执行；先设置 `bundle` 为当前完整发布目录、`root=/srv/artzoo`，并运行 `bash "$bundle/deployment-maintenance.sh" status --root "$root"`。使用含备份、恢复及媒体登记功能的已校验完整包；旧包不可自行补文件或重算校验和。定制项目需给每条维护命令补同一个 `--project`。

备份为 PostgreSQL custom dump、三个媒体目录的 tar、已完成迁移列表和清单（版本、PostgreSQL 镜像 ID、项目、大小、SHA-256）。媒体数字属主和权限保留；拒绝链接、特殊文件、路径穿越及嵌套挂载。`compose.env` 不进入备份；站长须另外离线保存秘密配置。备份目录仍含站点数据，必须按私有数据保管。

### 手动备份与校验

1. 默认备份位置为 `$root/backups`，`backup-*` 保留最近 7 份；`upgrade-*`、`register-*`、`rescue-*` 每类各保留最近 3 份，可用 `--keep-maintenance 1–99` 调整。可用 `--backup-dir` 指定另一块 Linux 文件系统上的专用目录，用 `--keep` 指定 1–9999 份；目录及父级不可由组/其他用户写入，目录须为 UID/GID 1000、0700，不可使用链接、空格或 Windows 挂载目录。不要让多个站点共用一个备份目录。以下选定保留 7 份：

   ```bash
   backups="$root/backups"
   ```

2. 停站前先检查备份所在文件系统的可用空间：至少为“数据库 `pg_database_size` + 三个媒体目录的内容字节数”之和 × 1.5 + 1 GB（1,000,000,000 字节，向上取整）。媒体按逻辑大小计算，避免稀疏文件在 tar 中展开时低估。空间不足会打印需要/剩余字节并拒绝，不停应用、不写维护标记、不留下 `.partial.*`；`backup`、`upgrade`、`rollback`、`media-reregister` 和 `restore` 的救援备份都适用。估算不能预留空间或阻止其他进程继续占用磁盘。

3. 【危险：短暂停站】暂停 web、worker，保持宿主机不直接写媒体；数据库继续运行。备份成功后启动应用并检查健康，最后发布正式备份目录、清理超过保留数的旧备份：

   ```bash
   bash "$bundle/deployment-maintenance.sh" backup --bundle "$bundle" --root "$root" --backup-dir "$backups" --keep 7
   ```

4. 成功应出现 `PASS: backup` 和备份完整路径。复制该路径后只读验证；这会用无网络临时容器执行 `pg_restore --list`，不修改数据库或媒体：

   ```bash
   read -r -p '完整备份目录：' snapshot
   bash "$bundle/deployment-maintenance.sh" backup-verify --bundle "$bundle" --root "$root" --backup "$snapshot"
   ```

5. 备份失败会尝试重新启动应用并检查健康，不删除旧备份；失败仍返回非零。检查 `status`，未恢复时执行本节末尾的【危险】启动步骤。`.partial.*` 是失败现场，不计入保留份数，也不自动删除；排查后由站长清理。断电、强制杀进程或 Docker 不可用不能保证自动重启，须人工检查。

### 保留规则与只读统计

`backup`、`upgrade`、`rollback`、`media-reregister` 成功后，在本次 `--backup-dir` 内按类别清理；失败时不清理。只删除同项目、同 PostgreSQL 镜像、完整校验通过且名称符合脚本格式的旧备份。各类按名称中的 UTC 创建时间排序；`deploy/previous` 引用、各类最新的一份和本次新备份始终保留，即使时钟回拨或因此超过保留数。损坏、其他项目/镜像、未知名称和 `.partial.*` 保留现场，不能靠调整保留数清除它们。空间不足时也不会先删旧备份腾空间。

只读查看默认目录，或明确传入日常使用的外置备份目录：

```bash
bash "$bundle/deployment-maintenance.sh" status --root "$root" --backup-dir "$backups"
```

“备份”段显示总磁盘占用、文件系统剩余字节、四类目录的份数和最新 UTC 创建时间，以及 `.partial.*` 数量；损坏目录照常计数，未知和临时目录列出供人工处理。统计不会逐份校验，恢复前仍须 `backup-verify`。没有备份时输出 0 和“无”，不创建目录。最新 `backup-*` 超过 36 小时、无可识别的日常备份，或可用空间低于下次备份估算值的 2 倍时输出“警告”；统计失败也仅告警，不改变原有站点检查和退出码。`status` 只接受 `--backup-dir`，不接受保留数量或 `--backup`。

这些规则仅随新发布包生效；旧包仍按旧规则运行，不补文件或重算校验和。升级取得新包后，后续成功维护会处理指定目录内兼容的既有备份；换用不同备份目录时，其他目录不会自动清理。回退到旧包后须按该旧包的实际能力检查空间与保留情况，不能假定它具有新预检功能。

### 原地恢复演练

1. 先执行并验证一次备份，记录路径。登录家庭站，发一条日常、上传一张图片；记录旧图是否正常。
2. 【危险：覆盖当前站点】执行以下命令。脚本重新核对校验和、归档路径、发布版本、数据库镜像和项目；不一致时在停站前拒绝。本流程只恢复当前版本的备份；跨版本退回上一版用 1.6 的 `rollback`，不手动改 `current` 或修改备份清单绕过。停站后自动创建 `rescue-*` 当前状态备份，成功才开始覆盖：

   ```bash
   bash "$bundle/deployment-maintenance.sh" restore --bundle "$bundle" --root "$root" --backup-dir "$backups" --backup "$snapshot"
   ```

3. 恢复清空并重建应用的 `public` schema，拒绝额外用户 schema；SQL 在单个事务中恢复，错误回滚。媒体随后清空、解包；恢复一律保持停站并写 `media-registration.pending`：恢复前 web、worker 均在运行则为 `running`，均停止则为 `stopped`；状态不一致时在停站前拒绝。仍接受 `--keep-stopped true`，强制登记后继续停站。数据库和文件不是同一事务：覆盖阶段任一步失败，保持停站，输出恢复前备份路径及带 `--keep-stopped true` 的恢复命令；排查后由站长单独执行。准备阶段失败仅在应用原本运行时尝试恢复启动，不启动原本已停的应用。
4. 【危险：停写并重新登记】恢复成功仍保持停站；执行脚本输出的完整命令，或以下等价命令，成功须出现 `PASS: media-reregister`。登记前全量校验内容并更新身份；任一文件缺失或内容不符会拒绝。登记完成前 `start` 和 Windows 入口拒绝开站，失败保留停站标记，不删除标记绕过。

   ```bash
   bash "$bundle/deployment-maintenance.sh" media-reregister --bundle "$bundle" --root "$root" --backup-dir "$backups"
   ```

5. 标记为 `running` 时，登记成功会自动开站并检查健康，再运行 `status` 和 `media-identity`（退出码须为 0）。标记为 `stopped` 时仍停止；需要开站时，由站长单独执行【危险：恢复开站】`bash "$bundle/deployment-maintenance.sh" start --root "$root"`，然后检查。确认新增日常和新图消失、登录及旧图显示正常；删除一张恢复前已有的相册照片，核对配额恰好退回一次。
6. 需要撤销本次恢复时，将输出的 `rescue-*` 完整路径作为 `--backup` 再执行第 2 步。恢复本身不清理备份；随后登记成功会按维护保留规则清理。需要长期保存的恢复点应由站长另外归档。

旧发布包不会获得默认停站行为：若已有包支持登记和 `--keep-stopped true`，恢复时必须显式加该选项，登记后再单独 `start`；不支持则停止演练，先通过正常发版取得完整支持包。不要改写旧发布包。

### 每日定时备份

固定入口只安装一次；每次读取 `deploy/current` 的单行记录，校验可信路径、版本和完整发布包，再执行当前包的 `backup`。不 source 记录、不按目录时间猜版本。模板面向系统 Docker 的 Server，不安装到 Dev；UID/GID 1000 须无需 sudo 交互即可访问 Docker。以下步骤均在 Server 任意目录执行，沿用已校验的新包 `$bundle`、站点 `$root` 和备份目录 `$backups`。

1. 首次安装或从旧 service 迁移前，记录 timer 是否开启并暂停；正在运行的备份须等其结束，不杀进程。已有单元先另存，`saved` 使用全新目录，不覆盖历史副本：

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

   服务仍为 `active`/`activating` 时先等完成，确认网站健康再继续。候选 service 的 `ExecStart` 固定为 `/usr/local/libexec/artzoo-backup`；仅沿用站点的 `--root`、`--backup-dir`、`--keep`、`--keep-maintenance`（默认 3）。非默认项目加 `--project` 原项目名。启动器为 root 所有、0755，运行进程仍是 UID/GID 1000；以后发版不重复覆盖它。旧 service 的两处发布目录不再使用。

2. 安装一次性启动器并替换单元（若固定入口已经存在，先核对其来源，不覆盖）。这些命令不启动备份；任何一步失败即停，用第 5 步回退单元：

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

   `stat` 应为 `root:root 755`，verify 须通过。timer 时间不变：北京时间 03:00，关机错过不补跑。旧发布包不补文件、不重算校验和；当前包须包含本次新入口与结果记录功能。回退到不支持的新入口之前的旧包时，固定入口会拒绝并记录 `bundle-invalid`；暂停 timer，由站长恢复另存的旧 service 并按旧手册核对版本，或正常升级回支持包后恢复新单元。

3. 【危险：立即停站备份一次】单独触发服务，成功后才能恢复定时调度：

   ```bash
   sudo systemctl start artzoo-backup.service
   ```

4. 检查结果，并恢复原调度；首次安装需要每日备份时单独执行 `sudo systemctl enable --now artzoo-backup.timer`。家庭 Server 再按第 1 节升级一个小版本，不改 service，重复第 3 步确认仍成功：

   ```bash
   systemctl show artzoo-backup.service -p Result -p ExecMainStatus
   bash "$bundle/deployment-maintenance.sh" status --root "$root" --backup-dir "$backups"
   sudo journalctl -u artzoo-backup.service -n 40 --no-pager
   if test "$timer_was_active" = 1; then sudo systemctl start artzoo-backup.timer; fi
   systemctl list-timers artzoo-backup.timer
   ```

   服务结果应为 `success`、`0`，`status` 的最近备份结果应为 `result=success`、当前 `release` 和实际 `backup` 路径。Windows 固定入口 `-status` 同样显示结果。`backup` 可省略 `--bundle`；固定脚本路径的需求应使用启动器，而非长期调用旧包脚本。

   每次正常退出或可捕获中断都原子写入 `deploy/backup-last`：UTC 时间、成功/失败、版本、备份路径或固定原因代码。`pending`、`media-registration.pending`、`maintenance-locked` 表示维护未完成或锁被占用；`current-invalid` / `bundle-invalid` 表示记录或发布包异常；`preflight`、`space-check`、`snapshot-failed`、`restart-failed`、`publish-failed`、`prune-failed` 结合本次 journal 排查。失败会告警，原有 `status` 退出码不变；锁或 pending 拒绝前也显示最近结果。记录不可信时仅警告，不执行内容。根目录不可信、权限/磁盘故障可能无法写入；断电或 SIGKILL 无法保证记录，仍须结合备份时间和 journal。不要删除维护标记绕过失败。

5. 回退本次单元迁移：停止 timer，等待正在运行的备份结束；从 `$saved` 恢复原有单元，运行 `systemd-analyze verify`、`daemon-reload`，确认网站健康后恢复原 timer 状态。首次安装没有旧单元时保持 timer 禁用。固定入口可保留，不删除备份、发布包或站点数据。WSL 常驻仍按附录 4.3 手动开启。

### 日常查看与启停（Server，任意目录）

设置 `bundle` 为当前已校验发布包、`root=/srv/artzoo`。`status/start/stop` 可以省略 `--bundle`，由 `deploy/current` 决定目标；不是让脚本路径固定到任意旧包。没有 `current` 的历史站点显式指定原包，升级时按第 1 节登记。

- 只读状态：`bash "$bundle/deployment-maintenance.sh" status --root "$root"`。
- 【危险：停止网站】先执行 `sudo systemctl stop caddy`，再单独执行 `bash "$bundle/deployment-maintenance.sh" stop --root "$root"`；同时停止数据库，保留容器和数据。
- 【危险：启动网站】单独执行 `bash "$bundle/deployment-maintenance.sh" start --root "$root"`，成功再执行 `sudo systemctl start caddy`；检查健康、HTTPS、登录与旧图。启动不执行迁移或升级；媒体登记或升级待处理标记存在时，先完成相应恢复流程。

## 3. 首次部署新站点（Server，任意目录）

仅用于全新的独立站点；已有站点用第 1 节升级。家庭先完成附录的网络隔离准备；正式 Linux 服务器跳过整个附录。首次发布包构建与传输复用 1.1–1.2；正式服务器首位超管需要本机真实控制台（如 VNC），SSH 不能完成 `owner`。

1. 使用 Ubuntu、systemd、UID/GID 为 `1000:1000` 的运行用户；安装 Docker 和 Docker Compose。已有环境跳过安装。
2. 指定完整发布目录、站点地址和后端端口；导入前先校验文件。

   ```bash
   read -r -p '完整发布目录：' bundle
   read -r -p '站点 HTTPS 地址（无尾斜杠）：' origin
   root=/srv/artzoo
   port=13100
   bash "$bundle/deployment-images.sh" verify "$bundle"
   bash "$bundle/deployment-images.sh" import "$bundle"
   bash "$bundle/deployment-images.sh" check "$bundle"
   ```

3. 仅新站创建目录；已有站点不得执行以下初始化。以下命令逐步执行，任一步失败立即停止。

   ```bash
   sudo install -d -o 1000 -g 1000 -m 700 "$root/secrets" "$root/media" "$root/media/"{original,derived,avatars}
   bash "$bundle/deployment-maintenance.sh" prepare-env --bundle "$bundle" --root "$root" --origin "$origin"
   ```

   创建配置后，用 `editor "$root/secrets/compose.env"` 私下填写短信配置和需要的配额；保持初始化阶段 `ARTZOO_MEDIA_BUDGET_ENABLED=0`。执行 `bash "$bundle/deployment-maintenance.sh" config-check --bundle "$bundle" --root "$root"`，通过后再建库。秘密配置另外离线保存，不进日常备份。

4. 【危险：新建数据库】仅空站执行 `bash "$bundle/deployment-maintenance.sh" database --bundle "$bundle" --root "$root"`。
5. 【危险：迁移空库】执行 `bash "$bundle/deployment-maintenance.sh" migrate --bundle "$bundle" --root "$root"`。
6. 【危险：写入媒体基线】执行 `bash "$bundle/deployment-maintenance.sh" baseline --bundle "$bundle" --root "$root"`。
7. 【危险：创建首位超管】在 Server 本机真实终端执行 `bash "$bundle/deployment-maintenance.sh" owner --bundle "$bundle" --root "$root"`；按提示输入，不能通过 SSH 执行。
8. 【危险：启用应用】执行 `bash "$bundle/deployment-maintenance.sh" enable-budget --bundle "$bundle" --root "$root"`。
9. 成功后 `deploy/current` 登记初始版本。确认 `curl --fail --noproxy '*' "http://127.0.0.1:$port/api/health"` 返回 `{"ok":true}`。失败即停止，不删除卷、不重复初始化。

### 3.1 Server：配置 Caddy（任意目录）

1. 已安装 Caddy 则跳过本步；新机器按 [Caddy 官方 Ubuntu 安装步骤](https://caddyserver.com/docs/install#debian-ubuntu-raspbian)执行：

   ```bash
   sudo apt install --yes debian-keyring debian-archive-keyring apt-transport-https curl gnupg
   curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
   sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
   sudo apt update
   sudo apt install caddy
   ```

2. 选择一种模板，复制到候选文件：
   - 家庭局域网：`sudo install -m 644 "$bundle/Caddyfile.lan.example" /etc/caddy/Caddyfile.pending`；替换两处 `LAN_IP` 为固定局域网 IPv4。
   - 正式域名：取得上线授权、完成域名解析后，执行 `sudo install -m 644 "$bundle/Caddyfile.public.example" /etc/caddy/Caddyfile.pending`；替换 `SITE_DOMAIN`。此模式需放行服务器 TCP 80、443，不用于当前家庭公网映射。
3. 执行 `sudoedit /etc/caddy/Caddyfile.pending`；核对站点地址与 `$origin` 完全一致，后端端口与 `$port` 一致；保留 `127.0.0.1`，不添加 `trusted_proxies`、`header_up` 或访问日志。
4. 校验候选文件，看到 `Valid configuration` 后备份原文件：

   ```bash
   sudo caddy fmt --overwrite /etc/caddy/Caddyfile.pending
   sudo -u caddy -H caddy validate --config /etc/caddy/Caddyfile.pending --adapter caddyfile
   caddy_backup=$(sudo mktemp /etc/caddy/Caddyfile.before-artzoo.XXXXXX)
   sudo cp -p /etc/caddy/Caddyfile "$caddy_backup"
   printf 'Caddy 备份：%s\n' "$caddy_backup"
   ```

5. 【危险：切换 HTTPS 入口】执行以下命令；失败按第 5 节恢复备份。

   ```bash
   sudo install -m 644 /etc/caddy/Caddyfile.pending /etc/caddy/Caddyfile
   sudo systemctl reload caddy
   systemctl show caddy -p ActiveState -p SubState
   ```

### 3.2 Server：验证代理并启用信任（任意目录）

1. 重新设置第 3 节的 `bundle`、`root`、`origin`、`port`；确认对应当前运行版本。验证发布包后取得 tools 镜像：

   ```bash
   bash "$bundle/deployment-images.sh" verify "$bundle"
   tools_image=$(awk '$1 == "tools" {print $2}' "$bundle/images.tsv")
   test -n "$tools_image"
   ca_mount=()
   ```

2. 仅局域网证书模式增加根证书挂载；正式域名跳过：

   ```bash
   ca_mount=(--mount type=bind,src=/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt,dst=/ca.crt,readonly)
   ```

3. 【危险：短暂加载测试路由】执行检查；60 秒内用另一台局域网设备打开打印的地址，核对 `source` 是该设备 IP、`protocol=https`、`host` 是站点地址。结束须出现两条 `PASS`；失败停止，先恢复 Caddy 配置。

   ```bash
   sudo docker --host unix:///var/run/docker.sock run --rm --network host \
     --user 0:0 --cap-drop ALL --security-opt no-new-privileges --read-only \
     --mount "type=bind,src=$bundle/deployment-https-check.mjs,dst=/check.mjs,readonly" \
     "${ca_mount[@]}" --entrypoint node "$tools_image" /check.mjs "$origin" "$port" 60
   ```

4. 备份原覆盖文件（如有），再安装代理模板；秘密配置中的 `ARTZOO_TRUSTED_PROXY` 保持空值，仅 web 通过覆盖文件启用。

   ```bash
   sudo install -d -o 1000 -g 1000 -m 750 "$root/deploy"
   proxy="$root/deploy/proxy.compose.yaml"
   proxy_backup=''
   if test -e "$proxy"; then
     proxy_backup=$(mktemp "$root/deploy/proxy.before-artzoo.XXXXXX")
     cp -p "$proxy" "$proxy_backup"
   fi
   sudo install -o 1000 -g 1000 -m 640 "$bundle/proxy.compose.yaml.example" "$proxy"
   printf '代理备份（空值表示此前无覆盖）：%s\n' "$proxy_backup"
   dc() { sudo env -i "PATH=$PATH" "HOME=$HOME" docker --host unix:///var/run/docker.sock compose --project-name artzoo --env-file "$bundle/images.env" --env-file "$root/secrets/compose.env" -f "$bundle/compose.yaml" -f "$proxy" "$@"; }
   dc config --quiet
   ```

5. 【危险：重建 web】仅当前运行镜像与发布包一致时执行；短暂中断，不重建数据库或 worker。

   ```bash
   dc up -d --no-deps --no-build --pull never --force-recreate --wait web
   bash "$bundle/deployment-maintenance.sh" status --bundle "$bundle" --root "$root"
   ```

6. 重新执行第 3 步（等待时间可改为 `0`），确认 HTTPS、健康检查、伪造代理头拒绝及原 Caddy 配置恢复全部通过。
7. 从另一台设备检查：HTTPS 的 443 应可达；后端 13100、开发端口 3100、数据库 5432、Caddy 管理端口 2019 均不应向外开放。家庭防火墙和 Dev/Server 同时运行的验收见附录 4.2；正式服务器使用其主机防火墙和安全组，只开放所需的 SSH、HTTP/HTTPS 入口。

## 4. 附录：家庭 WSL 专用

独立正式 Linux 服务器跳过整个附录。以下保留家庭 rootless、mirrored、Windows 防火墙和手动常驻配置；当前实现不创建 Windows 开机或登录计划任务。

### 4.1 家庭 WSL：网络与 Dev 隔离（独立 Linux 服务器跳过）

1. Windows 管理员 PowerShell：备份现有配置；用 `wslconfig.example` 合并同名设置，保留其他设置。

   ```powershell
   $cfg = Join-Path $env:USERPROFILE '.wslconfig'
   if (Test-Path -LiteralPath $cfg) {
       Copy-Item -LiteralPath $cfg -Destination "$cfg.before-artzoo-$(Get-Date -Format yyyyMMddHHmmss)"
   }
   notepad.exe $cfg
   ```

2. Dev：确认 Docker 已是 rootless；已完成隔离的机器跳到第 7 步。

   ```bash
   docker info --format '{{json .SecurityOptions}}'
   systemctl --user is-active docker
   ```

3. Dev：按 [Docker rootless 安装步骤](https://docs.docker.com/engine/security/rootless/)检查 `uidmap`、`rootlesskit`、`slirp4netns` 和 `/etc/subuid`、`/etc/subgid`；保留原 Docker 版本。切换前导出需要的镜像、备份容器数据，保留旧数据目录。
4. 【危险：停止 Dev 容器】仅 Dev 执行 `sudo systemctl disable --now docker.service docker.socket`；安装并运行 `dockerd-rootless-setuptool.sh install`。Ubuntu `docker.io` 的脚本若位于 `/usr/share/docker.io/contrib/`，先将其中两个 `dockerd-rootless*.sh` 链接到 `/usr/local/bin/`。
5. Dev 仓库根目录：确认 rootless 启动成功，再安装两份系统模板；已有同名配置先备份。以下模板对应 UID 1000。

   ```bash
   templates="$PWD/deployment"
   test "$(id -u)" = 1000 && test "$(id -g)" = 1000
   sudo systemctl mask docker.service docker.socket
   sudo loginctl enable-linger "$(id -un)"
   sudo install -m 644 "$templates/dev-docker.tmpfiles.conf.example" /etc/tmpfiles.d/artzoo-dev-docker.conf
   sudo install -d /etc/systemd/system/user@1000.service.d
   sudo install -m 644 "$templates/dev-user-retry.conf.example" /etc/systemd/system/user@1000.service.d/wsl-retry.conf
   sudo systemctl daemon-reload
   sudo systemd-tmpfiles --create /etc/tmpfiles.d/artzoo-dev-docker.conf
   docker --host unix:///var/run/docker.sock info --format '{{json .SecurityOptions}}'
   ```

6. Dev：将导出的镜像导入 rootless Docker；核对镜像 ID 和需要的容器数据。出现差异立即停止；不要删除原 `/var/lib/docker`、`/var/lib/containerd`。需要 FLClash 代理时按下方步骤配置。
7. 【危险：关闭两套 WSL】保存 Dev 工作；Server 仅在已安装 Caddy 时执行 `sudo systemctl stop caddy`；随后停止应用和数据库：`bash "$bundle/deployment-maintenance.sh" stop --bundle "$bundle" --root "$root"`；Dev 执行 `systemctl --user stop docker`；Windows 执行 `wsl --shutdown`。
8. Windows：分别打开 `ArtZoo-FC-Dev` 和 `ArtZoo-FC-Server`；两边执行 `wslinfo --networking-mode`，确认 `mirrored`。
9. Dev、Server：保持日常系统代理和 TUN 状态，各执行以下三项，均须退出码为 0、`HTTP=200 TLS_VERIFY=0`。

   ```bash
   curl --disable --fail --silent --show-error --output /dev/null --connect-timeout 8 --max-time 30 --write-out 'HTTP=%{http_code} TLS_VERIFY=%{ssl_verify_result}\n' https://github.com
   curl --disable --ipv4 --noproxy '*' --fail --silent --show-error --output /dev/null --connect-timeout 8 --max-time 30 --write-out 'HTTP=%{http_code} TLS_VERIFY=%{ssl_verify_result}\n' https://github.com
   curl --disable --ipv4 --noproxy '*' --fail --silent --show-error --output /dev/null --connect-timeout 8 --max-time 30 --write-out 'HTTP=%{http_code} TLS_VERIFY=%{ssl_verify_result}\n' https://archive.ubuntu.com/ubuntu/
   ```

10. 绕过代理超时时，关闭再开启 FLClash TUN 后重测；仍失败则按第 5 节回退，不继续开站。
11. 【危险：恢复服务】Server 执行 `bash "$bundle/deployment-maintenance.sh" start --bundle "$bundle" --root "$root"`；已安装 Caddy 的机器再执行 `sudo systemctl start caddy`。

#### Dev Docker 代理（Dev 仓库根目录）

1. 确认 FLClash 本机 HTTP 代理端口；复制模板前备份已有同名文件。按实际端口替换模板中的 `7890`；保留内部网关 `10.0.2.2`。此配置允许 Dev 容器访问宿主回环服务，独立网络仍保留。
2. 按 [Docker 用户服务代理配置](https://docs.docker.com/engine/daemon/proxy/)安装模板；若 `~/.config/docker/daemon.json` 已配置代理，先核对其优先级，不直接覆盖。

   ```bash
   mkdir -p "$HOME/.config/systemd/user/docker.service.d"
   install -m 600 deployment/dev-docker-proxy.conf.example "$HOME/.config/systemd/user/docker.service.d/proxy.conf"
   ```

3. 【危险：重启 Dev Docker】保存开发容器工作后执行；同时确认 Server HTTPS 不间断。

   ```bash
   systemctl --user daemon-reload
   systemctl --user restart docker
   docker --host unix:///var/run/docker.sock pull docker/dockerfile:1
   export ARTZOO_BUILD_PROXY=http://10.0.2.2:7890
   ```

4. 拉取成功后执行第 1 节构建。失败则恢复原 `proxy.conf`（此前无文件则移走新文件），重新加载用户服务并重启 Dev Docker；不调整 Server 配置。

### 4.2 Windows：家庭局域网入口（管理员 PowerShell，任意目录）

1. 路由器保留固定 IP；不配置公网端口映射。不关闭 Windows 或 Hyper-V 防火墙。
2. 填入实际 IP、局域网 CIDR，仅放行 TCP 443；同名规则已存在时先核对，不覆盖。

   ```powershell
   $lanIp = Read-Host '固定局域网 IPv4'
   $lanSubnet = Read-Host '允许访问的局域网 CIDR'
   $wslCreator = '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'
   $rule = 'ArtZoo-HTTPS-LAN'
   if (-not (Get-NetFirewallHyperVRule -Name $rule -ErrorAction SilentlyContinue)) {
       New-NetFirewallHyperVRule -Name $rule -DisplayName $rule -Direction Inbound -Action Allow -VMCreatorId $wslCreator -Protocol TCP -LocalAddresses $lanIp -LocalPorts 443 -RemoteAddresses $lanSubnet
   }
   Get-NetFirewallHyperVRule -PolicyStore ActiveStore -Name $rule |
       Select-Object Name, Enabled, Action, LocalAddresses, LocalPorts, RemoteAddresses
   ```

3. 本机浏览器、同一局域网手机分别访问站点；家庭证书警告可手动继续。需要消除警告时，仅从 Server 导出 Caddy 的 `root.crt` 并在设备安装、信任；不分发私钥。
4. 从另一台局域网 Windows 电脑执行 `Test-NetConnection <站点IP> -Port <端口>`：443 应通过；13100、3100、5432、2019 均不应通过。Dev 构建镜像、运行临时开发容器期间，另一设备连续访问 Server，确认不中断。
5. 【危险：重启 Dev 容器引擎】保存开发工作后，Dev 执行 `systemctl --user restart docker`；同时检查 Server 不中断。失败停止验收。

### 4.3 家庭 WSL：手动常驻与媒体身份检查

本节按站长本次要求采用**手动开启、手动关闭**，不创建 Windows 开机或登录计划任务。Windows 重启后要重新执行 `-start`。Microsoft 说明 [systemd 服务本身不会让 WSL 持续运行](https://learn.microsoft.com/en-us/windows/wsl/systemd)，因此由隐藏的前台 WSL 进程保持发行版存活。Linux 内已有 Docker、Caddy 的服务配置保留；本脚本不阻止其他软件或终端另行启动发行版。

#### 固定 Windows 入口：开启、查看和关闭

Windows 只保存一个小型控制脚本，默认操作 `ArtZoo-FC-Server`、站点 `/srv/artzoo`、项目 `artzoo`。不用输入发布包名或 Linux 绝对路径；每次从 `deploy/current` 读取当前部署记录，核对路径权限、包完整性及现有容器。不能把文件名最新的目录当成正在使用的版本。

前提：Server 已完成部署并有有效 `deploy/current`；对应包须包含 `deployment-resident.sh` 和维护脚本。入口可以控制具备这些能力的已有完整包，不要求为了安装 Windows 入口重建网站，也不修改已交付包。旧站没有 `current` 时，先通过已授权的首次部署或 `upgrade --from` 建立记录；入口不猜版本、不自行初始化。升级或媒体恢复未完成时拒绝启动，保留现场。

1. **首次安装，仅一次。** 使用仓库 `deployment/artzoo-resident.ps1` 或包含新入口的完整发布包内同名文件。在 Windows PowerShell 输入该文件的完整路径，复制为固定文件名；不是复制整个发布包。默认目录为当前用户的 `Documents\ArtZoo-FC`：

   ```powershell
   $source = Read-Host '新版 artzoo-resident.ps1 的完整路径'
   $directory = Join-Path $env:USERPROFILE 'Documents\ArtZoo-FC'
   New-Item -ItemType Directory -Path $directory -Force | Out-Null
   $control = Join-Path $directory 'ArtZoo-FC-Server.ps1'
   if (Test-Path -LiteralPath $control) { throw '固定入口已存在，请先核对，不覆盖' }
   Copy-Item -LiteralPath $source -Destination $control
   ```

   已经安装固定入口则跳过；网站升级、回退后不用再次复制。只有 Windows 入口代码本身变化时才更新这一文件，更新前另存原入口。不要直接从 WSL UNC 路径运行入口，避免在查看关闭状态时唤醒发行版。不创建快捷方式、计划任务或开机自启。

2. Windows PowerShell 进入固定目录，查看帮助或状态（任意工作目录可先执行下面的 `Set-Location`）：

   ```powershell
   Set-Location (Join-Path $env:USERPROFILE 'Documents\ArtZoo-FC')
   .\ArtZoo-FC-Server.ps1
   .\ArtZoo-FC-Server.ps1 -status
   ```

   无参数只显示用法；每次只选一个小写模式。PowerShell 从当前目录调用脚本要带 `.\`，不需要把目录加入 PATH。`-status` 显示已记录版本、发布目录、常驻、网站及 Caddy 检查结果。WSL 已关闭时只报告关闭，不读取包、不将其启动，也不把缓存当实时版本。常驻关闭但 WSL 仍运行时继续检查网站；有终端维持网站运行时，不误报网站已经停止。

3. 【危险：启动网站】在这个 Windows 目录单独执行：

   ```powershell
   .\ArtZoo-FC-Server.ps1 -start
   ```

   自动选择当前部署包，启动隐藏常驻进程，再启动已有数据库、web、worker 和 Caddy；不建库、不迁移、不升级。Caddy 的 sudo 提示仍由站长在前台输入，不保存密码。看到 `Resident: running`、Caddy `active` 后，用手机访问 HTTPS。关闭所有 WSL 和 PowerShell 终端，等至少一分钟后再访问，确认常驻有效。重复启动不累积常驻进程；Windows 重启后需重新执行 `-start`。

4. 【危险：停止网站】在同一目录单独执行：

   ```powershell
   .\ArtZoo-FC-Server.ps1 -stop
   ```

   正常停止 web、worker、数据库、Caddy 后释放常驻，成功显示 `Resident: stopped`。保留全部容器和数据，不执行 `wsl --shutdown` 或 `--terminate`，不影响 Dev。发行版已经关闭时直接报告关闭；停止服务失败时保留常驻，先排错再重试。

5. 验证：依次查看 `-status`、执行一次【危险】`-start`、检查 HTTPS 与关闭终端后的访问，再单独执行【危险】`-stop`。下次正常升级或回退后，再用同一入口查看状态，确认记录及容器版本匹配。任何失败返回错误；不要通过删除 `current` 或维护标记绕过。回退入口更新时恢复原先另存的 Windows 文件，不恢复或修改站点数据。脚本被执行策略拦截时先核对来源，按本机策略处理这一文件，不永久降低全局执行策略。

#### 只读媒体身份诊断

Server 终端，设置当前 `bundle`、`root=/srv/artzoo`。检查期间不要上传或删除媒体，也不要直接修改宿主媒体；命令不自动停站，在线写入可能导致瞬时无法检查，需要在无写入时重测。数据库快照使用只读 SQL，诊断容器无网络、无秘密环境、根文件系统和三个媒体挂载只读；只会创建并清理维护锁、临时快照等控制文件。

```bash
bash "$bundle/deployment-maintenance.sh" media-identity --bundle "$bundle" --root "$root"
echo "退出码=$?"
```

JSON 中 `consistent` 为一致，`inconsistent` 为不一致，`unchecked` 为无法检查；`components` 是文件组件合计，`directories` 按实际子目录统计，`baseline` 单独比较整体媒体基线。整体基线只保存一个哈希，无法倒推出具体哪个根目录变化。`skippedCredited` 是已返还配额的历史组件；`skippedAggregate` 是不对应单文件的基线汇总记录，不计为一致文件。`skippedDatabase` 是存放在数据库 bytea 中的快捷图标，不参加磁盘身份比较。

退出码 `0` 表示所有可检查项一致且没有无法检查项，`2` 表示发现不一致或无法检查，`1` 表示执行失败或快照不完整。缺失身份、未知类型、丢失文件、内容被改、链接或不可信权限均不会误报为一致。文件组件数为零只能证明基线检查结果，不能作为上传媒体验证通过的证据。诊断复用当前 tools 镜像的只读身份核对方法，不重新登记身份，不删除图片，不退还或清零配额。

#### 实测记录与重启顺序

各轮先记录版本、文件组件数、诊断 JSON 和退出码。确保有恢复前上传的图片及身份记录；没有非零一致样本就不能确认重启安全。检查完成后另做 HTTPS、登录、旧图显示验收。

- 恢复：按第 2 节完成备份及【危险】原地恢复，在停站状态分别记录登记前、登记后的诊断。文件重新写入可能使文件身份变化；根目录保留时整体基线仍可能一致。
- 容器重启：【危险】Server 按第 2 节正常停止、启动已有容器，再检查诊断；无需重启 Windows 或 WSL。
- Windows 重启，Dev 先启动：【危险】保存全部工作，先运行 `-stop`，再由站长重启 Windows。登录后先打开 Dev，再执行 `-start` 启动 Server，检查诊断与网站。
- Windows 重启，Server 先启动：【危险】重复上述停站、保存、重启步骤；登录后先执行 `-start`，再打开 Dev，检查诊断与网站。先确认其他软件没有提前启动另一个发行版；否则本轮不能证明启动顺序。

记录中区分 Dev 临时项目结果与家庭 Server 实测结果。Windows 重启只能由站长安排，未实际完成就保留未验收状态，不用 `wsl --shutdown` 或容器重启冒充。恢复或启动顺序出现不一致时，按第 2 节执行已交付的媒体身份登记流程；登记失败保持停站，核对文件完整性和权限，不改身份算法或清零配额。
## 5. 失败回退（只执行对应项）

1. Caddy 候选校验失败：不安装候选文件，修改后重新校验。
2. 【危险：恢复 Caddy】Server 执行 `sudo cp -p "$caddy_backup" /etc/caddy/Caddyfile && sudo systemctl reload caddy`；重新检查 HTTPS。
3. 【危险：清除中断的测试路由】Server 执行 `sudo systemctl reload caddy`；确认 Caddy `active/running`，再检查 HTTPS。
4. 【危险：恢复代理】还原 `$proxy_backup`；此前无覆盖则只移走本次新增的 `$proxy`。用原发布包、原覆盖文件重建 web；无覆盖时从 `dc` 定义移除 `-f "$proxy"`，再执行3.2 第 5 步。
5. 【危险：恢复 WSL 网络】先按附录 4.1 第 7 步停服务；Windows 还原 `.wslconfig` 备份（原本不存在则移走本次创建的文件），执行 `wsl --shutdown`，重新启动并验证两套 WSL 联网。
6. Dev rootless 失败：保留 rootless 与旧 Docker 数据，停止 Dev Docker 排查；不要在 Server 在线时重新启用 Dev rootful Docker。
7. 防火墙规则不符合预期：Windows 管理员执行 `Remove-NetFirewallHyperVRule -Name ArtZoo-HTTPS-LAN`，只撤销本条规则。


8. 升级配置、包校验或迁移比较失败：在停站前修正；不删版本指针、不重置数据库。迁移前停站阶段失败，确认旧版已恢复；迁移开始后失败，按 1.6 单独执行输出的【危险】`rollback`。
9. 备份失败：保留已有备份及 `.partial.*` 现场，检查服务是否自动恢复；断电或 Docker 不可用时人工核对。不要因失败删除最后一份有效备份。
10. 恢复覆盖阶段、媒体登记或回退失败：保持停站，保留输出的 `rescue-*`、`register-*` 备份和维护标记；按报错核对内容、权限与空间。不要直接开站，或用旧脚本绕过标记。修复后再执行对应的【危险】恢复/登记命令。
11. 定时备份失败：查看 `status` 中的最近备份结果（Windows 入口 `-status` 同样可见），按原因代码结合 `journalctl -u artzoo-backup.service` 排查；确认维护完成、站点健康后手动触发验证。已迁移的 service 自动跟随当前版本；旧 service 按第 2 节迁移。
