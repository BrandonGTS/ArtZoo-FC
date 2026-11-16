# Fixed Windows entry point. Copy once; release selection follows deploy/current.
[CmdletBinding()]
param(
    [switch]$start,
    [switch]$stop,
    [switch]$status,
    # Retain the old spelling for existing callers; bundle must match current.
    [ValidateSet('start', 'stop', 'status')][string]$action,
    [ValidatePattern('^/([a-zA-Z0-9_.-]+/)*[a-zA-Z0-9_.-]+$')][string]$bundle,
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_.-]*$')][string]$distribution = 'ArtZoo-FC-Server',
    [ValidatePattern('^/([a-zA-Z0-9_.-]+/)*[a-zA-Z0-9_.-]+$')][string]$root = '/srv/artzoo',
    [ValidatePattern('^[a-z][a-z0-9-]{0,47}$')][string]$project = 'artzoo'
)
$ErrorActionPreference = 'Stop'
$modes = @(@('start', 'stop', 'status') | Where-Object { (Get-Variable -Name $_ -ValueOnly).IsPresent })
if ($modes.Count -gt 1 -or ($modes.Count -gt 0 -and $action)) {
    throw 'Choose exactly one mode: -start, -stop or -status.'
}
if ($modes.Count -eq 1) { $action = $modes[0] }
if (-not $action) {
    Write-Output 'Usage: .\ArtZoo-FC-Server.ps1 -start | -stop | -status'
    Write-Output 'The active release is read from /srv/artzoo/deploy/current. No bundle path is needed.'
    return
}
$action = $action.ToLowerInvariant()
$wsl = Join-Path $env:WINDIR 'System32/wsl.exe'
function Invoke-Linux([string[]]$LinuxArgs) {
    & $wsl --distribution $Distribution --exec @LinuxArgs
    if ($LASTEXITCODE -ne 0) { throw "WSL operation failed ($LASTEXITCODE). Preserve data and check status." }
}
function Invoke-Maintenance([string]$Command) {
    Invoke-Linux @('bash', "$Bundle/deployment-maintenance.sh", $Command, '--bundle', $Bundle, '--root', $Root, '--project', $Project)
}
function Resolve-CurrentRelease {
    # ASCII, LF-only stdin avoids native command-line quoting differences in PS 5.1/7.
    # Read records as data; never source/eval them or choose a directory by timestamp.
    $reader = @'
set -euo pipefail
fail() { printf '%s\n' "$1" >&2; exit 1; }
trusted() {
  local path=$1 owner mode
  [[ "$(realpath -e -- "$path")" == "$path" ]] || fail 'Missing or linked deployment path.'
  while :; do
    owner=$(stat -c %u -- "$path"); mode=$(stat -c %a -- "$path")
    [[ "$owner" == 0 || "$owner" == 1000 ]] && (( (8#$mode & 022) == 0 )) || fail 'Untrusted deployment permissions.'
    [[ "$path" != / ]] || break
    path=$(dirname -- "$path")
  done
}
root=$1 action=$2
[[ "$(id -u):$(id -g)" == 1000:1000 ]] || fail 'Use the Server runtime user (UID/GID 1000).'
record="$root/deploy/current"
[[ -f "$record" && ! -L "$record" ]] || fail 'No deploy/current record. Complete initial deployment or register the existing release with upgrade --from; no release was guessed.'
trusted "$record"
[[ "$(stat -c %s -- "$record")" -le 4096 ]] || fail 'Invalid current record size.'
mapfile -t records < "$record"
[[ ${#records[@]} == 1 ]] || fail 'Current record must contain exactly one line.'
read -r selected release schema extra <<< "${records[0]}"
[[ -z "$extra" && "$release" =~ ^(git|dev)-[0-9a-f]{12}-[0-9]{14}-[0-9]+$ ]] || fail 'Invalid current release record.'
for directory in "$selected" "$schema"; do
  [[ "$directory" =~ ^/([a-zA-Z0-9_.-]+/)*[a-zA-Z0-9_.-]+$ && -d "$directory" ]] || fail 'Recorded release directory is missing or invalid.'
  trusted "$directory"
done
for file in deployment-images.sh deployment-maintenance.sh deployment-resident.sh; do
  [[ -f "$selected/$file" && ! -L "$selected/$file" ]] || fail 'Recorded release lacks a required control script.'
  trusted "$selected/$file"
done
if [[ "$action" == start ]]; then
  for mark in pending media-registration.pending; do
    [[ ! -e "$root/deploy/$mark" && ! -L "$root/deploy/$mark" ]] || fail 'Deployment or media recovery is unfinished. Keep the site stopped and finish recovery first.'
  done
fi
printf '%s\n' "${records[0]}"
# End of bootstrap input; any native trailing CRLF lands in this comment.
'@
    $record = @($reader.Replace("`r", '') | & $wsl --distribution $Distribution --exec bash -s -- $Root $action)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve the current release. No website start was requested.' }
    if ($record.Count -ne 1 -or $record[0] -notmatch '^(/[a-zA-Z0-9_./-]+) ((?:git|dev)-[0-9a-f]{12}-[0-9]{14}-[0-9]+) (/[a-zA-Z0-9_./-]+)$') {
        throw 'Unexpected current release response.'
    }
    return @{ Bundle = $Matches[1]; Release = $Matches[2] }
}
$mutex = [Threading.Mutex]::new($false, "Local\ArtZoo-Resident-$Distribution")
$locked = $false
try {
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another resident operation is running.' }
    $running = (& $wsl --list --running --quiet) -replace "`0", ''
    if ($LASTEXITCODE -ne 0) { throw 'Cannot list WSL distributions.' }
    if ($Action -ne 'start' -and $Distribution -notin @($running | ForEach-Object { $_.Trim() })) {
        Write-Output 'Resident: stopped (distribution is stopped; it was not started).'
        Write-Output 'Current release: not queried while WSL is stopped.'
        return
    }
    $current = Resolve-CurrentRelease
    if ($bundle -and $bundle -cne $current.Bundle) { throw 'The supplied bundle differs from deploy/current.' }
    $bundle = $current.Bundle
    Write-Output "Recorded release: $($current.Release)"
    Write-Output "Release directory: $bundle"
    Invoke-Linux @('bash', "$Bundle/deployment-images.sh", 'verify', $Bundle)
    $control = @('bash', "$Bundle/deployment-resident.sh")
    if ($Action -eq 'Status') {
        & $wsl --distribution $Distribution --exec @control status $Root
        if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 3) { throw 'Resident status failed.' }
        # No holder does not imply that containers are stopped; report both.
        & $wsl --distribution $Distribution --exec bash "$Bundle/deployment-maintenance.sh" status --bundle $Bundle --root $Root --project $Project
        $websiteResult = $LASTEXITCODE
        & $wsl --distribution $Distribution --exec systemctl is-active caddy
        $caddyResult = $LASTEXITCODE
        if ($websiteResult -ne 0 -or $caddyResult -ne 0) {
            throw 'Website is stopped, unhealthy or differs from its deployment record. See the checks above.'
        }
        Write-Output 'Website: healthy; running containers match the recorded release.'
    } elseif ($Action -eq 'Start') {
        # Validated arguments contain no whitespace or shell metacharacters.
        $arguments = "--distribution $Distribution --exec bash $Bundle/deployment-resident.sh hold $Root"
        $holder = Start-Process -FilePath $wsl -ArgumentList $arguments -WindowStyle Hidden -PassThru
        $ready = $false
        for ($attempt = 0; $attempt -lt 10; $attempt++) {
            Start-Sleep -Milliseconds 500
            & $wsl --distribution $Distribution --exec @control status $Root *> $null
            if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        }
        if (-not $ready) { throw 'Resident did not become ready. No application start was requested.' }
        Write-Output '[DANGER] Starting the existing website containers and Caddy.'
        Invoke-Maintenance 'start'
        Invoke-Linux @('sudo', 'systemctl', 'start', 'caddy')
        Invoke-Linux @('systemctl', 'is-active', 'caddy')
        Write-Output 'Resident: running. Terminals may be closed. Windows restart requires -start again.'
    } else {
        Write-Output '[DANGER] Stopping website, database and Caddy; preserving all data.'
        Invoke-Maintenance 'stop'
        Invoke-Linux @('sudo', 'systemctl', 'stop', 'caddy')
        Invoke-Linux ($control + @('release', $Root))
        Write-Output 'Resident: stopped. Other WSL distributions and terminals are unchanged.'
    }
} catch {
    throw "$_ Preserve deployment data; inspect -status before retrying. A holder may remain after a failed -start/-stop."
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
