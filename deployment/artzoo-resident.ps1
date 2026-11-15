# Run manually as the Windows user who owns the WSL distribution. No startup task.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Start', 'Stop', 'Status')][string]$Action,
    [Parameter(Mandatory)][ValidatePattern('^/([a-zA-Z0-9_.-]+/)*[a-zA-Z0-9_.-]+$')][string]$Bundle,
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_.-]*$')][string]$Distribution = 'ArtZoo-FC-Server',
    [ValidatePattern('^/([a-zA-Z0-9_.-]+/)*[a-zA-Z0-9_.-]+$')][string]$Root = '/srv/artzoo',
    [ValidatePattern('^[a-z][a-z0-9-]{0,47}$')][string]$Project = 'artzoo'
)
$ErrorActionPreference = 'Stop'
$wsl = Join-Path $env:WINDIR 'System32/wsl.exe'
function Invoke-Linux([string[]]$LinuxArgs) {
    & $wsl --distribution $Distribution --exec @LinuxArgs
    if ($LASTEXITCODE -ne 0) { throw "WSL operation failed ($LASTEXITCODE). Preserve data and check status." }
}
function Invoke-Maintenance([string]$Command) {
    Invoke-Linux @('bash', "$Bundle/deployment-maintenance.sh", $Command, '--bundle', $Bundle, '--root', $Root, '--project', $Project)
}
$mutex = [Threading.Mutex]::new($false, "Local\ArtZoo-Resident-$Distribution")
$locked = $false
try {
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another resident operation is running.' }
    $running = (& $wsl --list --running --quiet) -replace "`0", ''
    if ($LASTEXITCODE -ne 0) { throw 'Cannot list WSL distributions.' }
    if ($Action -ne 'Start' -and $Distribution -notin @($running | ForEach-Object { $_.Trim() })) {
        Write-Output 'Resident: stopped (distribution is stopped; it was not started).'
        return
    }
    Invoke-Linux @('bash', "$Bundle/deployment-images.sh", 'verify', $Bundle)
    $control = @('bash', "$Bundle/deployment-resident.sh")
    if ($Action -eq 'Status') {
        & $wsl --distribution $Distribution --exec @control status $Root
        if ($LASTEXITCODE -eq 3) { return }
        if ($LASTEXITCODE -ne 0) { throw 'Resident status failed.' }
        Invoke-Maintenance 'status'
        Invoke-Linux @('systemctl', 'is-active', 'caddy')
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
        Write-Output 'Resident: running. Terminals may be closed. Windows restart requires Start again.'
    } else {
        Write-Output '[DANGER] Stopping website, database and Caddy; preserving all data.'
        Invoke-Maintenance 'stop'
        Invoke-Linux @('sudo', 'systemctl', 'stop', 'caddy')
        Invoke-Linux ($control + @('release', $Root))
        Write-Output 'Resident: stopped. Other WSL distributions and terminals are unchanged.'
    }
} catch {
    Write-Error "$_ Resident may remain active after failure; inspect Status and retry Stop after resolving the error."
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
