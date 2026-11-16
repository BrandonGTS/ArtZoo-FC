# Run with Windows PowerShell 5.1 or pwsh. All WSL/service actions are mocked.
param([string]$resolverDistribution)
$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot '../../deployment/artzoo-resident.ps1'
$wslPath = Join-Path $env:WINDIR 'System32/wsl.exe'
$global:artzooTestcalls = @()
$global:artzooTestrunning = $true
$global:artzooTestrelease = 'git-abcdef123456-20261116000000-123'
$global:artzooTestroot = '/srv/artzoo'
$global:artzooTestholderCode = 0
$global:artzooTestwebsiteCode = 0
$global:artzooTestresolverCode = 0
$global:artzooTestverifyCode = 0
$global:artzooTestmaintenanceCode = 0
$global:artzooTestresolverResponse = ''
$global:artzooTestfixture = ''
$global:artzooTestnativeWsl = Get-Command wsl.exe -CommandType Application | Select-Object -First 1
$global:artzooTestresolverDistribution = $resolverDistribution
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Reset-Fake {
    $global:artzooTestcalls = @()
    $global:artzooTestrunning = $true
    $global:artzooTestholderCode = 0
    $global:artzooTestwebsiteCode = 0
    $global:artzooTestresolverCode = 0
    $global:artzooTestverifyCode = 0
    $global:artzooTestmaintenanceCode = 0
    $global:artzooTestresolverResponse = ''
}
function Invoke-Case([string]$Name, [scriptblock]$Body) {
    Reset-Fake
    & $Body
    Write-Output "PASS: $Name"
}
function Expect-Failure([scriptblock]$Body) {
    $failed = $false
    try { & $Body | Out-Null } catch { $failed = $true }
    Assert $failed 'Expected rejection.'
}
# Override the exact executable name, without replacing a system file.
Set-Item -LiteralPath "Function:$wslPath" -Value {
    $arguments = @($args)
    $stdin = @($input)
    $global:artzooTestcalls += ,$arguments
    $global:LASTEXITCODE = 0
    if ($arguments[0] -eq '--list') {
        if ($global:artzooTestrunning) { 'ArtZoo-FC-Server' }
    } elseif ($arguments -contains '-s') {
        Assert ($stdin.Count -gt 0) 'Resolver must receive its program through stdin.'
        if ($global:artzooTestfixture) {
            ($stdin -join "`n") | & $global:artzooTestnativeWsl --distribution $global:artzooTestresolverDistribution --exec bash -s -- $global:artzooTestfixture $arguments[-1]
            return
        }
        $global:LASTEXITCODE = $global:artzooTestresolverCode
        if ($global:artzooTestresolverResponse) { $global:artzooTestresolverResponse }
        else { "$global:artzooTestroot/releases/$global:artzooTestrelease $global:artzooTestrelease $global:artzooTestroot/releases/$global:artzooTestrelease" }
    } elseif ($arguments -contains 'verify') {
        $global:LASTEXITCODE = $global:artzooTestverifyCode
    } elseif ($arguments[4] -like '*/deployment-resident.sh') {
        $global:LASTEXITCODE = $global:artzooTestholderCode
    } elseif ($arguments[4] -like '*/deployment-maintenance.sh') {
        if ($arguments[5] -eq 'status') { $global:LASTEXITCODE = $global:artzooTestwebsiteCode }
        else { $global:LASTEXITCODE = $global:artzooTestmaintenanceCode }
    }
}
function Start-Process {
    param($FilePath, $ArgumentList, $WindowStyle, [switch]$PassThru)
    Assert ($WindowStyle -eq 'Hidden') 'Holder window must stay hidden.'
    $global:artzooTestcalls += ,@('holder', $ArgumentList)
    [pscustomobject]@{ Id = 12345 }
}
function Start-Sleep { param($Milliseconds) }
try {
    Invoke-Case 'no mode shows usage without touching WSL' {
        $result = & $launcher
        Assert (($result -join ' ') -match '-start.*-stop.*-status') 'Missing usage.'
        Assert ($global:artzooTestcalls.Count -eq 0) 'Usage touched WSL.'
    }
    Invoke-Case 'conflicting modes are rejected before WSL' {
        Expect-Failure { & $launcher -start -stop }
        Expect-Failure { & $launcher -status -action start }
        Assert ($global:artzooTestcalls.Count -eq 0) 'Conflicting modes touched WSL.'
    }
    foreach ($mode in @('status', 'stop')) {
        Invoke-Case "$mode leaves a stopped distribution stopped" {
            $global:artzooTestrunning = $false
            $parameters = @{ $mode = $true }
            & $launcher @parameters | Out-Null
            Assert ($global:artzooTestcalls.Count -eq 1) 'Stopped distribution was accessed.'
            Assert ($global:artzooTestcalls[0][0] -eq '--list') 'Expected inventory only.'
        }
    }
    Invoke-Case 'start resolves current and launches a hidden holder' {
        $global:artzooTestrunning = $false
        $output = & $launcher -start
        Assert (($output -join ' ') -match $global:artzooTestrelease) 'Release was not displayed.'
        $commands = @($global:artzooTestcalls | ForEach-Object { $_ -join ' ' })
        Assert (@($commands | Where-Object { $_ -match '^holder .*deployment-resident.sh hold' }).Count -eq 1) 'Missing hidden holder.'
        Assert (@($commands | Where-Object { $_ -match "deployment-maintenance.sh start --bundle $global:artzooTestroot/releases/$global:artzooTestrelease" }).Count -eq 1) 'Wrong release or start command.'
        Assert (@($commands | Where-Object { $_ -match 'sudo systemctl start caddy' }).Count -eq 1) 'Caddy was not started.'
    }
    Invoke-Case 'status checks containers even when no holder exists' {
        $global:artzooTestholderCode = 3
        & $launcher -status | Out-Null
        Assert (@($global:artzooTestcalls | Where-Object { ($_ -join ' ') -match 'deployment-maintenance.sh status' }).Count -eq 1) 'Website check was skipped.'
        Assert (@($global:artzooTestcalls | Where-Object { $_[0] -eq 'holder' }).Count -eq 0) 'Status started a holder.'
    }
    Invoke-Case 'unhealthy website status is not reported as success' {
        $global:artzooTestwebsiteCode = 1
        Expect-Failure { & $launcher -status }
    }
    Invoke-Case 'stop releases holder only after services stop' {
        & $launcher -stop | Out-Null
        $commands = @($global:artzooTestcalls | ForEach-Object { $_ -join ' ' }) -join "`n"
        Assert ($commands -match '(?s)deployment-maintenance.sh stop.*sudo systemctl stop caddy.*deployment-resident.sh release') 'Unsafe stop order.'
        Assert ($commands -notmatch '--shutdown|--terminate') 'Global WSL shutdown must not be used.'
    }
    Invoke-Case 'failed website stop preserves holder' {
        $global:artzooTestmaintenanceCode = 1
        Expect-Failure { & $launcher -stop }
        Assert (@($global:artzooTestcalls | Where-Object { ($_ -join ' ') -match 'deployment-resident.sh release' }).Count -eq 0) 'Holder released after failed stop.'
    }
    Invoke-Case 'missing or pending deployment refuses start before holder' {
        $global:artzooTestresolverCode = 1
        Expect-Failure { & $launcher -start }
        Assert ($global:artzooTestcalls.Count -eq 2) 'Start continued after resolver failure.'
    }
    Invoke-Case 'malformed record and explicit stale bundle are rejected' {
        $global:artzooTestresolverResponse = '/tmp/bad;command arbitrary record'
        Expect-Failure { & $launcher -start }
        Reset-Fake
        Expect-Failure { & $launcher -start -bundle /srv/artzoo/releases/old }
        Assert (@($global:artzooTestcalls | Where-Object { $_[0] -eq 'holder' }).Count -eq 0) 'Stale bundle started a holder.'
    }
    Invoke-Case 'corrupt bundle refuses start before holder' {
        $global:artzooTestverifyCode = 1
        Expect-Failure { & $launcher -start }
        Assert (@($global:artzooTestcalls | Where-Object { $_[0] -eq 'holder' }).Count -eq 0) 'Invalid bundle started a holder.'
    }
    Invoke-Case 'changed current selects a different release without editing launcher' {
        $global:artzooTestrelease = 'git-fedcba654321-20261116000000-456'
        $output = & $launcher -status
        Assert (($output -join ' ') -match $global:artzooTestrelease) 'Launcher cached the old version.'
    }
    Write-Output 'PASS: launcher behavior suite (mock WSL; no Server operations).'
    if ($resolverDistribution) {
        # Only the bootstrap reader runs in the selected Dev distro. All service
        # and holder calls remain mocked; fixtures contain no database or media.
        $setup = @'
from pathlib import Path
import tempfile
base = Path.home() / '.local' / 'share' / 'artzoo-launcher-tests'
base.mkdir(parents=True, exist_ok=True, mode=0o700)
root = Path(tempfile.mkdtemp(prefix='fixture-', dir=base))
(root / 'deploy').mkdir(mode=0o700)
release = 'git-abcdef123456-20261116000000-123'
bundle = root / 'releases' / release
bundle.mkdir(parents=True, mode=0o700)
for name in ('deployment-images.sh', 'deployment-maintenance.sh', 'deployment-resident.sh'):
    (bundle / name).write_text('# fixture only\n')
record = f'{bundle} {release} {bundle}\n'
(root / 'deploy' / 'current').write_text(record)
(root / 'original-record').write_text(record)
print(root)
'@
        $global:artzooTestfixture = ($setup | & $global:artzooTestnativeWsl --distribution $resolverDistribution --exec python3 -).Trim()
        Assert ($LASTEXITCODE -eq 0 -and $global:artzooTestfixture.StartsWith('/')) 'Could not create Dev fixture.'
        function Set-Fixture([string]$Mode) {
            $change = @'
from pathlib import Path
import sys
root = Path(sys.argv[1]); mode = sys.argv[2]
record = root / 'deploy' / 'current'
if mode == 'restore':
    if record.is_symlink(): record.unlink()
    record.write_text((root / 'original-record').read_text()); record.chmod(0o600)
elif mode == 'missing': record.unlink()
elif mode == 'malformed': record.write_text('bad record\n')
elif mode == 'writable': record.chmod(0o666)
elif mode == 'linked':
    record.unlink(); record.symlink_to(root / 'original-record')
elif mode == 'pending': (root / 'deploy' / 'pending').write_text('upgrade\n')
elif mode == 'clear': (root / 'deploy' / 'pending').unlink()
'@
            $change | & $global:artzooTestnativeWsl --distribution $resolverDistribution --exec python3 - $global:artzooTestfixture $Mode
            Assert ($LASTEXITCODE -eq 0) 'Fixture update failed.'
        }
        Invoke-Case 'real Dev bootstrap accepts trusted current via native stdin' {
            & $launcher -status -root $global:artzooTestfixture | Out-Null
        }
        foreach ($invalid in @('missing', 'malformed', 'writable', 'linked')) {
            Invoke-Case "real Dev bootstrap rejects $invalid current" {
                Set-Fixture $invalid
                Expect-Failure { & $launcher -start -root $global:artzooTestfixture }
                Assert (@($global:artzooTestcalls | Where-Object { $_[0] -eq 'holder' }).Count -eq 0) 'Rejected record launched holder.'
                Set-Fixture 'restore'
            }
        }
        Invoke-Case 'real Dev bootstrap blocks pending start but allows stop' {
            Set-Fixture 'pending'
            Expect-Failure { & $launcher -start -root $global:artzooTestfixture }
            & $launcher -stop -root $global:artzooTestfixture | Out-Null
            Set-Fixture 'clear'
        }
        Write-Output 'PASS: real Dev resolver suite (no Server, Docker or service changes).'
    }
} finally {
    Remove-Item -LiteralPath "Function:$wslPath"
    if ($global:artzooTestfixture) {
        $cleanup = @'
from pathlib import Path
import shutil, sys
root = Path(sys.argv[1]).resolve()
base = (Path.home() / '.local' / 'share' / 'artzoo-launcher-tests').resolve()
assert root.parent == base and root.name.startswith('fixture-')
shutil.rmtree(root)
'@
        $cleanup | & $global:artzooTestnativeWsl --distribution $resolverDistribution --exec python3 - $global:artzooTestfixture
    }
    Get-Variable -Scope Global -Name 'artzooTest*' | Remove-Variable -Scope Global
}
