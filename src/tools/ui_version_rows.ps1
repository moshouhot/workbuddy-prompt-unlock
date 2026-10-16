$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$project = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$exe = Join-Path $project 'WorkBuddyUnlock.exe'
$temp = Join-Path ([IO.Path]::GetTempPath()) ('wb-ver-' + [guid]::NewGuid().ToString('N'))
$names = @('WORKBUDDY_ROOT','WORKBUDDY_CONFIG_DIR','WORKBUDDY_PROMPTS_DIR','WORKBUDDY_BACKUP_DIR','WORKBUDDY_STATE_DIR')
$old = @{}; foreach ($n in $names) { $old[$n] = [Environment]::GetEnvironmentVariable($n) }
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Put($file, $text) { [IO.Directory]::CreateDirectory((Split-Path $file -Parent)) | Out-Null; [IO.File]::WriteAllText($file, $text, $utf8) }
function WaitUntil([scriptblock]$c, [string]$l = '', [int]$s = 90) {
    $lim = [DateTime]::UtcNow.AddSeconds($s)
    do { if (& $c) { return }; Start-Sleep -Milliseconds 200 } while ([DateTime]::UtcNow -lt $lim)
    throw "Timed out: $l"
}
function FindId($id) {
    $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $id)
    return $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c)
}
function VersionRows {
    $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'InstallVersion')
    return @($window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $c) | ForEach-Object { $_.Current.Name })
}
$proc = $null
try {
    $install = Join-Path $temp 'WorkBuddy'
    $cfg = Join-Path $temp 'cfg'
    $env:WORKBUDDY_ROOT = $install
    $env:WORKBUDDY_CONFIG_DIR = $cfg
    $env:WORKBUDDY_PROMPTS_DIR = Join-Path $temp 'prompts'
    $env:WORKBUDDY_BACKUP_DIR = Join-Path $temp 'backup'
    $env:WORKBUDDY_STATE_DIR = Join-Path $temp 'state'
    [IO.Directory]::CreateDirectory($env:WORKBUDDY_PROMPTS_DIR) | Out-Null
    Get-ChildItem (Join-Path $project 'prompts') -File | ForEach-Object { [IO.File]::Copy($_.FullName, (Join-Path $env:WORKBUDDY_PROMPTS_DIR $_.Name)) }

    $verOld = '5.7.7-wb.111.gaaa.hbbb'
    Put (Join-Path $install 'resources/app.asar.unpacked/resources/templates/workbuddy-craft-code-prompt.tpl') '<content_policy>original</content_policy><personal_files_safety>original</personal_files_safety>'
    Put (Join-Path $cfg 'settings.json') '{}'
    Put (Join-Path $cfg 'app/app-config.json') '{"sandboxSafetyEnabled":true}'
    Put (Join-Path $cfg 'storage/user-test-personal/global/preferences.json') '{ "theme": "light", "localTaskPermissionMode": "default-sandbox" }'
    Put (Join-Path $cfg "plugins/cache/workbuddy-builtin/welcomemode-code/$verOld/prompt.tpl") '<content_policy>original</content_policy>'

    # 1) 先应用：记录版本指纹 = 5.7.7…
    $a = & node (Join-Path $project 'wb.mjs') apply --json --no-restart 2>&1 | Out-String
    if ($a -notmatch '"ok":true') { throw "apply failed: $a" }

    $proc = Start-Process $exe -PassThru
    WaitUntil { $proc.Refresh(); $proc.MainWindowHandle -ne 0 } 'window'
    $window = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
    WaitUntil { (FindId 'Apply').Current.IsEnabled -and (VersionRows).Count -gt 0 } 'version rows'
    Start-Sleep -Seconds 1
    $rows1 = VersionRows
    Write-Host "应用后版本行: $($rows1 -join ' / ')"
    if (($rows1 -join '|') -notmatch '当前 5\.7\.7') { throw "expected 当前 5.7.7, got: $rows1" }
    if (($rows1 -join '|') -notmatch '上次应用 5\.7\.7') { throw "expected 上次应用 5.7.7, got: $rows1" }
    $detail = (FindId 'SyncDetail').Current.Name
    Write-Host "横幅详情: $detail"
    if ($detail -match '客户端版本') { throw 'banner must not carry client version anymore' }

    # 2) 模拟客户端升级：换掉版本目录名（内容仍同步）。
    #    期望：当前版本变为 5.8.3，上次应用仍为 5.7.7 —— 两者不一致。
    Rename-Item (Join-Path $cfg "plugins/cache/workbuddy-builtin/welcomemode-code/$verOld") '5.8.3-wb.222.gccc.hddd'
    Write-Host "已改名以模拟升级，等待自动复查…"
    WaitUntil { (VersionRows -join '|') -match '当前 5\.8\.3' } 'current version updated' 60
    $rows2 = VersionRows
    Write-Host "升级后版本行: $($rows2 -join ' / ')"
    if (($rows2 -join '|') -notmatch '上次应用 5\.7\.7') { throw "applied version should stay 5.7.7, got: $rows2" }
    Write-Host 'PASS: 每行显示「当前版本 + 上次应用版本」，且升级后当前版本自动更新、上次应用保持不变'
} finally {
    if ($proc -and !$proc.HasExited) { $proc.Kill() }
    foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $old[$n]) }
    if (Test-Path $temp) { Remove-Item $temp -Recurse -Force }
}
