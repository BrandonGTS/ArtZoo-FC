# 家庭 WSL 环境：一次性配置

本文是家庭部署的一次性环境配置：一台 Windows 电脑上跑两个 WSL，`ArtZoo-FC-Dev`（开发、构建发布包）和 `ArtZoo-FC-Server`（运行网站）。只有新装或重建这台电脑时才需要。日常发版、备份、启停见 [DEPLOYMENT.md](DEPLOYMENT.md)；独立的 Linux 服务器不需要本文。

依据的决定：DECISIONS 第 10–12 条。

## 配置完成后的样子

| 项目 | 状态 |
|---|---|
| WSL 网络 | mirrored 模式，开启 DNS 隧道、自动代理和本机 IP 回环；局域网入口由 Windows 防火墙限制 |
| Dev 的 Docker | rootless 模式，网络独立，不会覆盖 Server 的防火墙规则；Dev 构建或运行开发容器时 Server 不中断 |
| Server 的 Docker | 普通的系统 Docker，运行网站；Caddy 也装在 Server 里，Windows 不装 Caddy |
| 局域网入口 | Windows 防火墙只允许指定局域网访问 Server 的 TCP 443；不做公网端口映射 |
| 开机 | 不设开机自启或计划任务。systemd 服务本身不会让 WSL 一直运行（[微软说明](https://learn.microsoft.com/en-us/windows/wsl/systemd)），Windows 重启后用固定入口 `-start` 启动网站（DEPLOYMENT 3.2） |

每一步失败都先停下，需要撤销时看第 7 节。

---

## 1. Windows：把 WSL 网络改成 mirrored

在 **Windows 管理员 PowerShell** 里执行：先备份现有的 `.wslconfig`，再打开它编辑。

```powershell
$cfg = Join-Path $env:USERPROFILE '.wslconfig'
if (Test-Path -LiteralPath $cfg) {
    Copy-Item -LiteralPath $cfg -Destination "$cfg.before-artzoo-$(Get-Date -Format yyyyMMddHHmmss)"
}
notepad.exe $cfg
```

把仓库里 `deployment/wslconfig.example` 的设置合并进去：同名的项改成模板里的值，其他已有设置保留。模板内容：

```ini
[wsl2]
networkingMode=mirrored
dnsTunneling=true
autoProxy=true
firewall=true

[experimental]
hostAddressLoopback=true
```

改动要等第 3 步重启 WSL 后才生效。

## 2. Dev：把 Docker 改成 rootless

**第 1 步：先看现状。** 在 Dev 里执行：

```bash
docker info --format '{{json .SecurityOptions}}'
systemctl --user is-active docker
```

输出里已经有 `rootless`、用户服务是 `active` 的，说明之前做过，直接跳到第 3 节。

**第 2 步：准备。** 按 [Docker rootless 安装步骤](https://docs.docker.com/engine/security/rootless/) 检查 `uidmap`、`rootlesskit`、`slirp4netns` 以及 `/etc/subuid`、`/etc/subgid`；保留原来的 Docker 版本。切换前导出需要的镜像、备份容器数据，保留旧的数据目录。

**第 3 步：【危险：停止 Dev 的容器】** 只在 Dev 执行：

```bash
sudo systemctl disable --now docker.service docker.socket
```

然后安装并运行 `dockerd-rootless-setuptool.sh install`。如果用的是 Ubuntu 的 `docker.io` 包，脚本可能在 `/usr/share/docker.io/contrib/`，先把那里的两个 `dockerd-rootless*.sh` 链接到 `/usr/local/bin/`。

**第 4 步：安装两份系统模板。** 先确认上一步的 rootless Docker 已经启动成功（`systemctl --user is-active docker` 显示 `active`），再在 Dev 的仓库根目录执行（模板按 UID 1000 编写；已有同名配置先备份）：

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

最后一条的输出里要有 `rootless`。第一份模板把 `/run/docker.sock` 指向 rootless Docker 的套接字，第二份让用户服务在 WSL 启动时失败后自动重试。

**第 5 步：导回镜像和数据。** 把导出的镜像导入 rootless Docker，核对镜像 ID 和需要的容器数据。有差异立即停下。不要删除原来的 `/var/lib/docker`、`/var/lib/containerd`。

## 3. 重启两个 WSL，验证联网

**第 1 步：【危险：停止网站并关闭两个 WSL】** 先保存 Dev 里的工作。

- Server 已经部署过网站的：Windows 固定入口执行 `-stop`（DEPLOYMENT 3.2）；还没装入口的，在 Server 里先 `sudo systemctl stop caddy`（装了 Caddy 才需要），再按 DEPLOYMENT 0.4 设置变量后执行 `bash "$bundle/deployment-maintenance.sh" stop --root "$root"`。
- Dev 执行 `systemctl --user stop docker`。
- Windows 执行 `wsl --shutdown`。

**第 2 步：确认网络模式。** 在 Windows 分别打开 `ArtZoo-FC-Dev` 和 `ArtZoo-FC-Server`，两边都执行 `wslinfo --networking-mode`，应该显示 `mirrored`。

**第 3 步：验证联网。** 保持平时的系统代理和 TUN 设置，在 Dev 和 Server 里各执行下面三条。每条都要退出码为 0，并显示 `HTTP=200 TLS_VERIFY=0`。

```bash
curl --disable --fail --silent --show-error --output /dev/null --connect-timeout 8 --max-time 30 --write-out 'HTTP=%{http_code} TLS_VERIFY=%{ssl_verify_result}\n' https://github.com
curl --disable --ipv4 --noproxy '*' --fail --silent --show-error --output /dev/null --connect-timeout 8 --max-time 30 --write-out 'HTTP=%{http_code} TLS_VERIFY=%{ssl_verify_result}\n' https://github.com
curl --disable --ipv4 --noproxy '*' --fail --silent --show-error --output /dev/null --connect-timeout 8 --max-time 30 --write-out 'HTTP=%{http_code} TLS_VERIFY=%{ssl_verify_result}\n' https://archive.ubuntu.com/ubuntu/
```

不走代理的两条超时的话，把 FLClash 的 TUN 关掉再打开，然后重测。仍然失败就按 7.1 撤销网络改动，不要继续开站。

**第 4 步：【危险：恢复网站】** 用 Windows 固定入口 `-start`；还没装入口的，在 Server 里先按 DEPLOYMENT 0.4 重新设置变量（WSL 重启过，之前的变量已经没了），再执行 `bash "$bundle/deployment-maintenance.sh" start --root "$root"`，成功后再 `sudo systemctl start caddy`（装了 Caddy 才需要）。

## 4. Dev：Docker 下载代理（需要时）

Dev 的 rootless Docker 拉镜像、构建时如果要走 FLClash 代理，按下面配置。在 Dev 的仓库根目录执行。

**第 1 步：准备模板。** 确认 FLClash 本机 HTTP 代理端口。模板 `deployment/dev-docker-proxy.conf.example` 里的 `7890` 要换成实际端口；内部网关 `10.0.2.2` 保留不改。这个配置允许 Dev 容器访问宿主的回环服务，同时保持网络独立。已有同名文件先备份；如果 `~/.config/docker/daemon.json` 里已经配了代理，先核对谁优先，不要直接覆盖。参考 [Docker 用户服务代理配置](https://docs.docker.com/engine/daemon/proxy/)。

```bash
mkdir -p "$HOME/.config/systemd/user/docker.service.d"
install -m 600 deployment/dev-docker-proxy.conf.example "$HOME/.config/systemd/user/docker.service.d/proxy.conf"
```

（端口不是 7890 的，安装后编辑这个 `proxy.conf` 改端口。）

**第 2 步：【危险：重启 Dev 的 Docker】** 先保存开发容器里的工作；执行时确认 Server 的网站不受影响。

```bash
systemctl --user daemon-reload
systemctl --user restart docker
docker --host unix:///var/run/docker.sock pull docker/dockerfile:1
export ARTZOO_BUILD_PROXY=http://10.0.2.2:7890
```

拉取成功后就可以按 DEPLOYMENT 2.1 构建（`ARTZOO_BUILD_PROXY` 的端口同样按实际值）。失败就按 7.3 撤销，不要动 Server 的配置。

## 5. Windows：局域网入口防火墙

**第 1 步：准备。** 在路由器上给这台电脑保留固定 IP；不做公网端口映射；不要关闭 Windows 或 Hyper-V 防火墙。

**第 2 步：添加只放行 TCP 443 的规则。** 在 **Windows 管理员 PowerShell** 执行，按提示填入固定的局域网 IPv4 和允许访问的局域网网段（CIDR）。同名规则已经存在时，先核对它，不要覆盖。

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

**第 3 步：访问测试。** 用本机浏览器和同一局域网的手机分别打开网站，证书警告可以手动继续。想消除警告时，只从 Server 导出 Caddy 的根证书 `root.crt`，在设备上安装并信任；不要分发私钥。各设备是否已信任证书单独记录（DECISIONS 第 11 条）。

## 6. 验收：入口隔离，Dev 和 Server 同时运行

1. 在另一台局域网 Windows 电脑上执行 `Test-NetConnection <站点IP> -Port <端口>`：443 应该能通；13100、3100、5432、2019 都不应该通。
2. Dev 构建镜像、运行临时开发容器期间，用另一台设备持续访问网站，确认不中断。
3. 【危险：重启 Dev 的容器引擎】保存开发工作后，在 Dev 执行 `systemctl --user restart docker`，同时确认网站不中断。

任何一项不通过就停止验收，先排查。

## 7. 撤销

只执行对应的那一项。

**7.1 【危险】撤销 WSL 网络改动**：先按第 3 节第 1 步停止网站并关闭 WSL；在 Windows 用备份还原 `.wslconfig`（原来没有这个文件的，就移走这次新建的）；执行 `wsl --shutdown`，再分别启动两个 WSL，验证联网。

**7.2 Dev 改 rootless 失败**：保留 rootless 和旧 Docker 的数据，停止 Dev 的 Docker 后排查。Server 在线时，不要在 Dev 重新启用普通（rootful）Docker。

**7.3 Dev 代理配置失败**：恢复原来的 `proxy.conf`（原来没有就移走新装的文件），执行 `systemctl --user daemon-reload`，再重启 Dev 的 Docker。不要动 Server 的配置。

**7.4 防火墙规则不对**：在 Windows 管理员 PowerShell 执行 `Remove-NetFirewallHyperVRule -Name ArtZoo-HTTPS-LAN`，只撤销这一条规则。
