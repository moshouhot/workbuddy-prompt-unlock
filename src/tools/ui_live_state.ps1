param([switch]$Screenshots)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$project = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$exe = Join-Path $project 'WorkBuddyUnlock.exe'
$temp = Join-Path ([IO.Path]::GetTempPath()) ('wb-live-' + [guid]::NewGuid().ToString('N'))
$names = @('WORKBUDDY_ROOT','WORKBUDDY_CONFIG_DIR','WORKBUDDY_PROMPTS_DIR','WORKBUDDY_BACKUP_DIR','WORKBUDDY_STATE_DIR')
$old = @{}; foreach ($n in $names) { $old[$n] = [Environment]::GetEnvironmentVariable($n) }
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Put($file, $text) { [IO.Directory]::CreateDirectory((Split-Path $file -Parent)) | Out-Null; [IO.File]::WriteAllText($file, $text, $utf8) }
function WaitUntil([scriptblock]$condition, [string]$label = '', [int]$seconds = 60) {
    $limit = [DateTime]::UtcNow.AddSeconds($seconds)
    do { if (& $condition) { return } ; Start-Sleep -Milliseconds 200 } while ([DateTime]::UtcNow -lt $limit)
    throw "Timed out waiting for: $label"
}
function FindId($id) {
    $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $id)
    return $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}
function LogText { return (FindId 'Log').GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value }
function TextOf($id) {
    $el = FindId $id
    if (!$el) { return $null }
    return $el.Current.Name
}

$process = $null
try {
    $env:WORKBUDDY_ROOT = Join-Path $temp 'WorkBuddy'
    $env:WORKBUDDY_CONFIG_DIR = Join-Path $temp 'config'
    $env:WORKBUDDY_PROMPTS_DIR = Join-Path $temp 'prompts'
    $env:WORKBUDDY_BACKUP_DIR = Join-Path $temp 'backup'
    $env:WORKBUDDY_STATE_DIR = Join-Path $temp 'state'
    [IO.Directory]::CreateDirectory($env:WORKBUDDY_PROMPTS_DIR) | Out-Null
    Get-ChildItem (Join-Path $project 'prompts') -File | ForEach-Object { [IO.File]::Copy($_.FullName, (Join-Path $env:WORKBUDDY_PROMPTS_DIR $_.Name)) }
    $target = Join-Path $env:WORKBUDDY_ROOT 'resources\app.asar.unpacked\resources\templates\workbuddy-craft-code-prompt.tpl'
    Put $target '<content_policy>original</content_policy><personal_files_safety>original</personal_files_safety>'
    Put (Join-Path $env:WORKBUDDY_CONFIG_DIR 'settings.json') '{"sandbox":{"orderedRules":{"file":{"rules":[{"path":"example"}]}}}}'
    Put (Join-Path $env:WORKBUDDY_CONFIG_DIR 'app\app-config.json') '{"sandboxSafetyEnabled":true}'
    Put (Join-Path $env:WORKBUDDY_CONFIG_DIR 'storage\user-test-personal\global\preferences.json') '{ "theme": "light", "localTaskPermissionMode": "default-sandbox" }'

    # 带版本指纹的插件缓存目录：让 CLI 能算出 clientVersion。
    $cacheDir = Join-Path $env:WORKBUDDY_CONFIG_DIR 'plugins\cache\workbuddy-builtin\welcomemode-code'
    Put (Join-Path $cacheDir '5.8.2-wb.1.aaa\prompt.tpl') '<content_policy>original</content_policy>'

    $process = Start-Process $exe -PassThru
    WaitUntil { $process.Refresh(); $process.MainWindowHandle -ne 0 } 'window'
    $window = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
    WaitUntil { (FindId 'Apply').Current.IsEnabled -and (LogText).Length -gt 0 } 'ready'

    # 1) 起始状态：模板是官方内容 → 横幅应提示需要同步，且按钮为告警色。
    WaitUntil { (TextOf 'SyncHeadline') -match '需要同步' } 'headline=needApply'
    if ((TextOf 'SyncHeadline') -notmatch '检测到 \d+ 个文件需要同步') { throw "unexpected headline: $(TextOf 'SyncHeadline')" }
    if ((TextOf 'SyncDetail') -notmatch '客户端版本') { throw "detail should carry client version, got: $(TextOf 'SyncDetail')" }
    $banner0 = (FindId 'SyncBanner').Current.BoundingRectangle
    Write-Host "初始横幅: $(TextOf 'SyncHeadline')"

    # 2) 点击一键应用 → 横幅应自动变为“无需操作”（不需要手动刷新）。
    (FindId 'Apply').GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    WaitUntil { (LogText) -match '"changed"' } 'apply'
    WaitUntil { (TextOf 'SyncHeadline') -match '无需操作' } 'headline=inSync'
    Write-Host "应用后横幅: $(TextOf 'SyncHeadline')"
    $verdictAfterApply = TextOf 'SyncDetail'

    # 3) 实时性核心：窗口开着不动，从外部把目标文件改回官方内容（模拟客户端升级覆盖）。
    #    20 秒轮询应自动发现，无需任何点击。
    $before = TextOf 'SyncHeadline'
    Put $target '<content_policy>original</content_policy><personal_files_safety>original</personal_files_safety>'
    Write-Host "已从外部改回目标文件，等待自动复查（≤45s，不点任何按钮）…"
    WaitUntil { (TextOf 'SyncHeadline') -match '需要同步' } 'auto-detect after external change' 60
    Write-Host "自动发现: $(TextOf 'SyncHeadline')"
    if ($before -eq (TextOf 'SyncHeadline')) { throw 'headline did not change' }

    # 4) 再点一次应用，确认能收敛回“无需操作”（轮询不会误报）。
    (FindId 'Apply').GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    WaitUntil { (LogText) -match '"changed"' } 'apply #2'
    WaitUntil { (TextOf 'SyncHeadline') -match '无需操作' } 'headline=inSync #2'
    Start-Sleep -Seconds 22
    if ((TextOf 'SyncHeadline') -notmatch '无需操作') { throw "polling produced a false alarm: $(TextOf 'SyncHeadline')" }
    Write-Host "复查未误报: $(TextOf 'SyncHeadline')"

    $window.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()
    $process.WaitForExit(10000) | Out-Null
    Write-Host 'PASS: live sync banner (needApply -> in-sync -> auto-detect external change -> no false alarm)'
} finally {
    if ($process -and !$process.HasExited) { $process.Kill() }
    foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $old[$n]) }
    if (Test-Path $temp) { Remove-Item $temp -Recurse -Force }
}
