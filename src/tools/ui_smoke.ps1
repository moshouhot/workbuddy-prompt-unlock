param([switch]$Screenshots)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$project = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$exe = Join-Path $project 'WorkBuddyUnlock.exe'
$temp = Join-Path ([IO.Path]::GetTempPath()) ('wb-ui-' + [guid]::NewGuid().ToString('N'))
$names = @('WORKBUDDY_ROOT','WORKBUDDY_CONFIG_DIR','WORKBUDDY_PROMPTS_DIR','WORKBUDDY_BACKUP_DIR','WORKBUDDY_STATE_DIR')
$old = @{}; foreach ($n in $names) { $old[$n] = [Environment]::GetEnvironmentVariable($n) }
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Put($file, $text) { [IO.Directory]::CreateDirectory((Split-Path $file -Parent)) | Out-Null; [IO.File]::WriteAllText($file, $text, $utf8) }
function WaitUntil([scriptblock]$condition, [string]$label = '') {
    $limit = [DateTime]::UtcNow.AddSeconds(60)
    do { if (& $condition) { return }; Start-Sleep -Milliseconds 100 } while ([DateTime]::UtcNow -lt $limit)
    $status = try { (FindId 'Status').Current.Name } catch { '(?)' }
    $log = try { LogText } catch { '(?)' }
    throw "Timed out waiting for GUI state: $label | status=$status | log=$log"
}
function FindId($id) {
    $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $id)
    return $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}
function LogText { return (FindId 'Log').GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value }
function Click($id) {
    $el = FindId $id
    if (!$el.Current.IsEnabled -or $el.Current.IsOffscreen) { throw "Button unavailable: $id" }
    $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}

# 点按钮并等待日志出现预期内容。命令是 async void，必须等它真正跑完（日志更新）再继续，
# 否则下一次点击会被 ViewModel 的 busy 检查丢弃。
function ClickAndWait($id, [string]$expect, [string]$label) {
    $before = LogText
    Click $id
    WaitUntil { (LogText) -ne $before -and (LogText).Contains($expect) } $label
    WaitUntil { (FindId 'Apply').Current.IsEnabled } "$label (idle)"
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
    $prefPath = Join-Path $env:WORKBUDDY_CONFIG_DIR 'storage\user-test-personal\global\preferences.json'
    Put $prefPath '{ "theme": "light", "language": "zh-CN", "localTaskPermissionMode": "default-sandbox" }'
    $original = (Get-FileHash $target).Hash
    $process = Start-Process $exe -PassThru
    WaitUntil { $process.Refresh(); $process.MainWindowHandle -ne 0 }
    $window = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
    WaitUntil { (FindId 'Apply').Current.IsEnabled -and (LogText).Length -gt 0 }
    # Inspect the real tree first, then invoke controls by their observed IDs.
    $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object {
        if ($_.Current.AutomationId) { Write-Host $_.Current.ControlType.ProgrammaticName $_.Current.AutomationId $_.Current.IsEnabled }
    }
    if ((FindId 'Restore').Current.IsEnabled) { throw 'Restore must be disabled before first application' }
    # 两个开关默认都开启。
    if ((FindId 'Security').GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState -ne 'On') { throw 'Security must default to ON' }
    if ((FindId 'FullAccess').GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState -ne 'On') { throw 'FullAccess must default to ON' }
    # 预览不应写目标文件；之后必须等命令真正跑完再点应用。
    ClickAndWait 'Preview' 'pendingChanges' 'preview'
    if ((Get-FileHash $target).Hash -ne $original) { throw 'Preview wrote a target file' }
    $beforeApply = LogText
    Click 'Apply'
    WaitUntil { (LogText) -ne $beforeApply -and (LogText).Contains('"changed"') } 'apply #1'
    WaitUntil { (FindId 'Apply').Current.IsEnabled } 'idle after apply #1'
    if ((Get-FileHash $target).Hash -eq $original) { throw 'Apply did not write target' }
    $pref = Get-Content $prefPath -Raw | ConvertFrom-Json
    if ($pref.localTaskPermissionMode -ne 'full-access') { throw "FullAccess default did not reach CLI (got '$($pref.localTaskPermissionMode)')" }
    if ($pref.theme -ne 'light' -or $pref.language -ne 'zh-CN') { throw 'FullAccess write clobbered sibling preference fields' }
    # 默认勾选的 Security 必须已生效（沙箱开关关闭）。
    $app = Get-Content (Join-Path $env:WORKBUDDY_CONFIG_DIR 'app\app-config.json') -Raw | ConvertFrom-Json
    if ($app.sandboxSafetyEnabled -ne $false) { throw 'Security default ON did not reach CLI' }
    if (!(FindId 'Restore').Current.IsEnabled) { throw 'Restore must enable after application' }

    # 取消安全配置勾选：再应用时不得改动安全配置。
    (FindId 'Security').GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle()
    WaitUntil { (FindId 'Security').GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState -eq 'Off' } 'security unchecked'
    $beforeApply2 = LogText
    Click 'Apply'
    WaitUntil { (LogText) -ne $beforeApply2 -and (LogText).Contains('"changed"') } 'apply #2'
    WaitUntil { (FindId 'Apply').Current.IsEnabled } 'idle after apply #2'
    $app = Get-Content (Join-Path $env:WORKBUDDY_CONFIG_DIR 'app\app-config.json') -Raw | ConvertFrom-Json
    if ($app.sandboxSafetyEnabled -ne $false) { throw 'Unchecked Security must leave security settings untouched (was re-enabled)' }

    $beforeRestore = LogText
    Click 'Restore'
    WaitUntil { (LogText) -ne $beforeRestore -and (LogText).Contains('"undone"') } 'restore'
    WaitUntil { (FindId 'Apply').Current.IsEnabled } 'idle after restore'
    if ((Get-FileHash $target).Hash -ne $original) { throw 'Restore did not recover original bytes' }
    $app = Get-Content (Join-Path $env:WORKBUDDY_CONFIG_DIR 'app\app-config.json') -Raw | ConvertFrom-Json
    if ($app.sandboxSafetyEnabled -ne $true) { throw 'Restore did not recover security setting' }
    if ((Get-Content $prefPath -Raw | ConvertFrom-Json).localTaskPermissionMode -ne 'default-sandbox') { throw 'Restore did not recover permission mode' }
    if ((FindId 'Restore').Current.IsEnabled) { throw 'No remaining apply backup: Restore must disable' }
    $window.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()
    $process.WaitForExit(10000) | Out-Null
    if ($Screenshots) {
        $docs = Join-Path $project 'docs'; [IO.Directory]::CreateDirectory($docs) | Out-Null
        foreach ($variant in @('normal','compact150')) {
            $file = Join-Path $docs ("ui-synthetic-$variant.png")
            $arguments = @('--screenshot', ('"' + $file + '"'))
            if ($variant -eq 'compact150') { $arguments += @('--compact','--scale150') }
            $p = Start-Process $exe -ArgumentList $arguments -PassThru
            if (!$p.WaitForExit(60000)) { $p.Kill(); throw 'Screenshot process timed out' }
            if (!(Test-Path $file)) { throw 'Screenshot missing' }
        }
    }
    Write-Host 'PASS: UI preview, security checkbox, apply, restore, button states, byte parity, close'
} finally {
    if ($process -and !$process.HasExited) { $process.Kill() }
    foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $old[$n]) }
    if (Test-Path $temp) { Remove-Item $temp -Recurse -Force }
}
