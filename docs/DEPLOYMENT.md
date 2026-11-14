# 部署配置操作手册

## 1. Dev：制作发布包（仓库根目录）

1. 提交前完成仓库检查；正式交付使用干净工作区。
2. 构建完整发布包：`bash scripts/deployment-images.sh build`；使用家庭代理时先执行 `export ARTZOO_BUILD_PROXY=http://10.0.2.2:7890`，端口与第 3 节一致。
3. 将输出的整个版本目录复制到 Server 的 `/srv/artzoo/releases/`，不复制源码。
4. 同步交付七份 `.example` 配置、HTTPS 检查脚本和本手册；不要修改发布包内文件。

## 2. Server：准备运行环境（任意目录）

1. 使用 Ubuntu、systemd、UID/GID 为 `1000:1000` 的运行用户；安装 Docker 和 Docker Compose。已有环境跳过安装。
2. 指定完整发布目录、站点地址和后端端口；已有站点须选与运行镜像一致的发布包，不在本流程升级。

   ```bash
   read -r -p '完整发布目录：' bundle
   read -r -p '站点 HTTPS 地址（无尾斜杠）：' origin
   root=/srv/artzoo
   port=13100
   bash "$bundle/deployment-images.sh" import "$bundle"
   bash "$bundle/deployment-images.sh" check "$bundle"
   ```

3. 仅新站创建目录；已有站点直接进入第 3 节。以下命令逐步执行，任一步失败立即停止。

   ```bash
   sudo install -d -o 1000 -g 1000 -m 700 "$root/secrets" "$root/media" "$root/media/"{original,derived,avatars}
   bash "$bundle/deployment-maintenance.sh" prepare-env --bundle "$bundle" --root "$root" --origin "$origin"
   ```

4. 【危险：新建数据库】仅空站执行 `bash "$bundle/deployment-maintenance.sh" database --bundle "$bundle" --root "$root"`。
5. 【危险：迁移空库】执行 `bash "$bundle/deployment-maintenance.sh" migrate --bundle "$bundle" --root "$root"`。
6. 【危险：写入媒体基线】执行 `bash "$bundle/deployment-maintenance.sh" baseline --bundle "$bundle" --root "$root"`。
7. 【危险：创建首位超管】在 Server 本机真实终端执行 `bash "$bundle/deployment-maintenance.sh" owner --bundle "$bundle" --root "$root"`；按提示输入，不能通过 SSH 执行。
8. 【危险：启用应用】执行 `bash "$bundle/deployment-maintenance.sh" enable-budget --bundle "$bundle" --root "$root"`。
9. 确认 `curl --fail --noproxy '*' "http://127.0.0.1:$port/api/health"` 返回 `{"ok":true}`。失败即停止，不删除卷、不重复初始化。

## 3. 家庭 WSL：网络与 Dev 隔离（独立 Linux 服务器跳过）

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

10. 绕过代理超时时，关闭再开启 FLClash TUN 后重测；仍失败则按第 8 节回退，不继续开站。
11. 【危险：恢复服务】Server 执行 `bash "$bundle/deployment-maintenance.sh" start --bundle "$bundle" --root "$root"`；已安装 Caddy 的机器再执行 `sudo systemctl start caddy`。

### Dev Docker 代理（Dev 仓库根目录）

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

## 4. Server：配置 Caddy（任意目录）

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

5. 【危险：切换 HTTPS 入口】执行以下命令；失败按第 8 节恢复备份。

   ```bash
   sudo install -m 644 /etc/caddy/Caddyfile.pending /etc/caddy/Caddyfile
   sudo systemctl reload caddy
   systemctl show caddy -p ActiveState -p SubState
   ```

## 5. Windows：家庭局域网入口（管理员 PowerShell，任意目录）

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

## 6. Server：验证代理并启用信任（任意目录）

1. 重新设置第 2 节的 `bundle`、`root`、`origin`、`port`；确认对应当前运行版本。验证发布包后取得 tools 镜像：

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
7. 从另一台局域网电脑执行 `Test-NetConnection <站点IP> -Port <端口>`：443 应通过；13100、3100、5432、2019 均不应通过。
8. Dev 构建镜像、运行临时开发容器期间，另一设备连续访问 Server；确认不中断。
9. 【危险：重启 Dev 容器引擎】保存开发工作后，Dev 执行 `systemctl --user restart docker`；同时检查 Server 不中断。失败停止验收。

## 7. Server：日常维护（任意目录）

1. 每次先设置匹配当前运行版本的 `bundle` 和 `root=/srv/artzoo`；以下命令自动加载 `deploy/proxy.compose.yaml`。
2. 只读检查：`bash "$bundle/deployment-maintenance.sh" status --bundle "$bundle" --root "$root"`。
3. 【危险：停止网站】先 `sudo systemctl stop caddy`，再 `bash "$bundle/deployment-maintenance.sh" stop --bundle "$bundle" --root "$root"`。
4. 【危险：启动网站】先 `bash "$bundle/deployment-maintenance.sh" start --bundle "$bundle" --root "$root"`，再 `sudo systemctl start caddy`；重复第 6 节检查。
5. 配置模板入仓库；实际秘密、证书私钥、数据库、媒体、日志和备份留在 Server。部署到新服务器时，从第 2 节重做，不重复排查历史故障。

## 8. 失败回退（只执行对应项）

1. Caddy 候选校验失败：不安装候选文件，修改后重新校验。
2. 【危险：恢复 Caddy】Server 执行 `sudo cp -p "$caddy_backup" /etc/caddy/Caddyfile && sudo systemctl reload caddy`；重新检查 HTTPS。
3. 【危险：清除中断的测试路由】Server 执行 `sudo systemctl reload caddy`；确认 Caddy `active/running`，再检查 HTTPS。
4. 【危险：恢复代理】还原 `$proxy_backup`；此前无覆盖则只移走本次新增的 `$proxy`。用原发布包、原覆盖文件重建 web；无覆盖时从 `dc` 定义移除 `-f "$proxy"`，再执行第 6 节第 5 步。
5. 【危险：恢复 WSL 网络】先按第 3 节第 7 步停服务；Windows 还原 `.wslconfig` 备份（原本不存在则移走本次创建的文件），执行 `wsl --shutdown`，重新启动并验证两套 WSL 联网。
6. Dev rootless 失败：保留 rootless 与旧 Docker 数据，停止 Dev Docker 排查；不要在 Server 在线时重新启用 Dev rootful Docker。
7. 防火墙规则不符合预期：Windows 管理员执行 `Remove-NetFirewallHyperVRule -Name ArtZoo-HTTPS-LAN`，只撤销本条规则。
