using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Windows.Input;

namespace WorkBuddyUnlock;
public sealed record PromptFile(string Name, string Path)
{
    public string Label => Name switch
    {
        "content_policy.craft-expert.txt" => "Agent / Expert 内容策略",
        "content_policy.ask-legacy.txt" => "Ask 内容策略",
        "content_policy.cli.txt" => "CLI 内容策略",
        "personal_files_safety.txt" => "文件操作与防误删",
        "windows_command_safety.txt" => "Windows 命令建议",
        "ask_mode.current_mode.txt" => "Ask 模式行为",
        "ask_mode.reminder.txt" => "Ask 模式提醒",
        "cli_security_note.new.txt" => "安全工具说明",
        "user_custom.new.txt" => "用户自定义指令优先级",
        _ => Name
    } + "  ·  " + Name;
}

/// <summary>一个可勾选的 WorkBuddy 安装及其配对的用户配置目录。</summary>
public sealed class InstallTarget : INotifyPropertyChanged
{
    private bool selected;
    private string currentVersion = "", appliedVersion = "";
    public event PropertyChangedEventHandler? PropertyChanged;
    public required string Name { get; init; }
    public required string Root { get; init; }
    public required string ConfigDir { get; init; }
    public required bool ConfigExists { get; init; }
    public bool Selected
    {
        get => selected;
        set { if (selected == value) return; selected = value; PropertyChanged?.Invoke(this, new(nameof(Selected))); }
    }

    /// <summary>客户端当前版本指纹（如 5.8.2-wb.41111488.g…）。空表示取不到。</summary>
    public string CurrentVersion
    {
        get => currentVersion;
        set { if (currentVersion == value) return; currentVersion = value; NotifyVersion(); }
    }

    /// <summary>上次成功“一键应用”时记录的版本指纹。空表示没有记录（旧备份或从未应用）。</summary>
    public string AppliedVersion
    {
        get => appliedVersion;
        set { if (appliedVersion == value) return; appliedVersion = value; NotifyVersion(); }
    }

    private void NotifyVersion()
    {
        foreach (var n in new[] { nameof(CurrentVersion), nameof(AppliedVersion), nameof(VersionLine), nameof(VersionMismatch), nameof(VersionTooltip) })
            PropertyChanged?.Invoke(this, new(n));
    }

    /// <summary>指纹前缀（版本号主体），目录名带构建哈希，界面只显示到第二段。</summary>
    private static string Short(string fingerprint)
    {
        if (string.IsNullOrEmpty(fingerprint)) return "";
        var head = fingerprint.Split('-')[0];
        return head;
    }

    /// <summary>当前版本与上次应用版本不一致：说明客户端升级过，之前的改动可能已失效。</summary>
    public bool VersionMismatch => CurrentVersion.Length > 0 && AppliedVersion.Length > 0
        && CurrentVersion != AppliedVersion;

    /// <summary>“当前 X · 上次应用 Y”一行；取不到的段落用“未知 / 无记录”说明，不伪造数值。</summary>
    public string VersionLine
    {
        get
        {
            var cur = CurrentVersion.Length > 0 ? Short(CurrentVersion) : "未知";
            var app = AppliedVersion.Length > 0 ? Short(AppliedVersion) : "无记录";
            return $"当前 {cur}　·　上次应用 {app}";
        }
    }

    /// <summary>悬停显示完整指纹，避免界面被长哈希刷屏。</summary>
    public string VersionTooltip =>
        $"客户端当前：{(CurrentVersion.Length > 0 ? CurrentVersion : "未知")}\n上次应用：{(AppliedVersion.Length > 0 ? AppliedVersion : "无记录（旧版本应用或从未应用）")}";

    /// <summary>用户看到的说明：安装名 + 配置目录是否有独立安全配置。</summary>
    public string Label => ConfigExists
        ? $"{Name}  ·  {Root}"
        : $"{Name}  ·  {Root}（无独立配置目录）";
}
public sealed class UiCommand(Func<Task> execute, Func<bool> canExecute) : ICommand
{
    public event EventHandler? CanExecuteChanged;
    public bool CanExecute(object? parameter) => canExecute();
    public async void Execute(object? parameter) { if (CanExecute(parameter)) await execute(); }
    public void Refresh() => CanExecuteChanged?.Invoke(this, EventArgs.Empty);
}
public sealed class MainViewModel : INotifyPropertyChanged
{
    private readonly CliService service;
    private bool busy, includeSecurity = true, fullAccess = true, hasBackup;
    /// <summary>串行化偏好保存，避免快速连续切换时写入竞态。</summary>
    private Task saveChain = Task.CompletedTask;
    private string status = "正在检查客户端…", log = "", installSummary = "";
    private PromptFile? selectedPrompt;
    public event PropertyChangedEventHandler? PropertyChanged;
    public ObservableCollection<PromptFile> PromptFiles { get; } = [];
    /// <summary>发现的安装列表；默认全部勾选。</summary>
    public ObservableCollection<InstallTarget> Installs { get; } = [];
    public bool IsIdle => !busy;
    public bool IncludeSecurity { get => includeSecurity; set { if (includeSecurity == value) return; includeSecurity = value; Notify(); Remember(); } }
    /// <summary>允许完全访问：新任务不再逐条确认。默认开启，不依赖“安全配置”勾选。</summary>
    public bool FullAccess { get => fullAccess; set { if (fullAccess == value) return; fullAccess = value; Notify(); Remember(); } }
    public string Status { get => status; private set { status = value; Notify(); } }
    public string InstallSummary { get => installSummary; private set { installSummary = value; Notify(); } }

    private bool needApply;
    private string syncHeadline = "正在检查客户端…", syncDetail = "";
    /// <summary>是否检测到需要重新应用（由 CLI 的内容比对得出，非启发式）。</summary>
    public bool NeedApply { get => needApply; private set { needApply = value; Notify(); Notify(nameof(NeedApplyHighlight)); } }
    /// <summary>状态横幅主句：直接告诉用户现在要不要点“一键应用”。</summary>
    public string SyncHeadline { get => syncHeadline; private set { syncHeadline = value; Notify(); } }
    /// <summary>状态横幅补充句：说明原因与客户端版本。</summary>
    public string SyncDetail { get => syncDetail; private set { syncDetail = value; Notify(); } }
    /// <summary>需要应用时把按钮画成告警色，不用读文字也知道要动手。</summary>
    public bool NeedApplyHighlight => NeedApply;
    public string Log { get => log; private set { log = value; Notify(); } }
    public PromptFile? SelectedPrompt { get => selectedPrompt; set { selectedPrompt = value; Notify(); RefreshCommands(); } }
    public UiCommand ApplyCommand { get; }
    public UiCommand PreviewCommand { get; }
    public UiCommand RestoreCommand { get; }
    public UiCommand EditCommand { get; }
    public UiCommand FolderCommand { get; }
    private IEnumerable<UiCommand> Commands => [ApplyCommand, PreviewCommand, RestoreCommand, EditCommand, FolderCommand];
    public MainViewModel(CliService cli)
    {
        service = cli;
        ApplyCommand = new(() => RunAsync("apply"), () => IsIdle && !HasNoInstallSelected);
        PreviewCommand = new(() => RunAsync("preview"), () => IsIdle && !HasNoInstallSelected);
        RestoreCommand = new(() => RunAsync("restore"), () => IsIdle && hasBackup);
        EditCommand = new(() => SafeAction(() => service.EditFile(SelectedPrompt!.Path)), () => IsIdle && SelectedPrompt != null);
        FolderCommand = new(() => SafeAction(service.OpenFolder), () => IsIdle);
    }
    private void Notify([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new(name));
    /// <summary>记住勾选：写 .state/ui-preferences.json，下次打开恢复。</summary>
    private void Remember()
    {
        var json = $"{{\"fullAccess\":{FullAccess.ToString().ToLowerInvariant()},\"includeSecurity\":{IncludeSecurity.ToString().ToLowerInvariant()}}}";
        saveChain = saveChain.ContinueWith(_ => service.RunAsync("ui-remember", [$"--state={json}"]),
            TaskScheduler.Default).Unwrap();
        saveChain.ContinueWith(t => Log = $"偏好未保存：{t.Exception?.GetBaseException().Message}",
            TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously);
    }
    private void RefreshCommands() { Notify(nameof(HasNoInstallSelected)); foreach (var c in Commands) c.Refresh(); }
    private void SetBusy(bool value) { busy = value; Notify(nameof(IsIdle)); RefreshCommands(); }
    private Task SafeAction(Action action)
    {
        try { action(); } catch (Exception e) { Status = "操作失败"; Log = e.Message; }
        return Task.CompletedTask;
    }
    private string[] Flags(bool mutate)
    {
        var list = new List<string>();
        var chosen = Installs.Where(i => i.Selected).Select(i => i.Name).ToList();
        // 未勾选任何安装时不做任何写入，避免 --install= 被误解释为“全部”。
        if (Installs.Count > 0 && chosen.Count == 0) throw new InvalidOperationException("请至少勾选一个目标安装。");
        if (Installs.Count > 0) list.Add($"--install={string.Join(",", chosen)}");
        if (IncludeSecurity) list.Add("--security");
        if (!FullAccess) list.Add("--no-full-access");
        if (mutate) { list.Add("--close"); list.Add("--restart"); }
        return [.. list];
    }
    public async Task InitializeAsync()
    {
        SetBusy(true);
        try
        {
            var list = await service.RunAsync("prompts");
            foreach (var f in list.GetProperty("files").EnumerateArray()) if (f.GetProperty("editable").GetBoolean())
                PromptFiles.Add(new(f.GetProperty("name").GetString()!, f.GetProperty("path").GetString()!));
            SelectedPrompt = PromptFiles.FirstOrDefault(p => p.Name == "personal_files_safety.txt");
            await LoadInstallsAsync();
            await LoadPreferencesAsync();
            await RefreshStatusAsync();
            Log = "准备就绪。先保存 WorkBuddy 中的工作，再点击“一键应用”。\n编辑提示词：选择文件 → 编辑 → 保存 → 一键应用。";
        }
        catch (Exception e) { Status = "检查失败"; Log = e.Message; }
        finally { SetBusy(false); }
    }
    private async Task RefreshStatusAsync()
    {
        var data = await service.RunAsync("status", Flags(false));
        var count = data.GetProperty("pendingChanges").GetInt32();
        Status = count == 0 ? "提示词已同步" : $"有 {count} 个文件待同步";
        InstallSummary = string.Join("\n", data.GetProperty("roots").EnumerateArray().Select(x => x.GetString()));
        hasBackup = data.GetProperty("latestBackup").ValueKind != JsonValueKind.Null;
        UpdateSyncVerdict(data, count);
        // 不把 security.fullAccess 回填到开关：开关代表用户意图，磁盘状态只作客观展示。
        // 否则手动改过 preferences.json 或客户端升级重置后，开关会被静默改掉。
        if (data.TryGetProperty("security", out var sec) && sec.TryGetProperty("fullAccess", out var fa))
        {
            FullAccessOnDisk = fa.ValueKind switch
            {
                JsonValueKind.True => "已开启",
                JsonValueKind.False => "未开启",
                JsonValueKind.String => "部分账号已开启",
                _ => "尚无账号配置",
            };
        }
        RefreshCommands();
    }

    /// <summary>
    /// 实时结论：现在要不要点“一键应用”。
    ///
    /// 判定依据是 CLI 的 pendingChanges（逐字节内容比对），它能同时覆盖两种情况：
    /// 客户端升级把模板改回官方内容、用户自己改了 prompts/。
    /// 版本指纹（applyReason=upgraded）只用来解释原因，不单独触发告警：
    /// 否则升级后只要没重新应用，就会永久挂着一条明知内容已同步的假告警。
    /// </summary>
    private void UpdateSyncVerdict(System.Text.Json.JsonElement data, int count)
    {
        var reason = data.TryGetProperty("applyReason", out var r) ? r.GetString() : null;
        // 版本信息不再塞进横幅：改到“目标安装”每行展示（当前版本 + 上次应用版本）。
        UpdateInstallVersions(data);

        NeedApply = count > 0;
        if (count > 0)
        {
            SyncHeadline = $"⚠  检测到 {count} 个文件需要同步，请点“一键应用”";
            SyncDetail = reason == "upgraded"
                ? "客户端版本已变化，官方升级会覆盖模板并换掉旧插件缓存，之前的改动已失效。"
                : "提示词文件与客户端内容不一致（你改过 prompts/，或客户端回写了文件）。";
        }
        else
        {
            SyncHeadline = "✓  客户端已是当前提示词，无需操作";
            SyncDetail = "此状态会自动复查；执行“一键应用”后，或客户端升级后，这里会立即更新。";
        }
    }

    /// <summary>
    /// 把每个安装的“当前版本 / 上次应用版本”回填到对应行。
    /// 用安装根匹配：CLI 的 clientVersions/appliedVersions 以 root 为键，installs 也带 root。
    /// 取不到时保留空字符串，界面会显示“未知 / 无记录”，不伪造数值。
    /// </summary>
    private void UpdateInstallVersions(System.Text.Json.JsonElement data)
    {
        var current = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var applied = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (data.TryGetProperty("clientVersions", out var cv) && cv.ValueKind == JsonValueKind.Object)
            foreach (var p in cv.EnumerateObject()) if (p.Value.ValueKind == JsonValueKind.String) current[p.Name] = p.Value.GetString()!;
        if (data.TryGetProperty("appliedVersions", out var av) && av.ValueKind == JsonValueKind.Object)
            foreach (var p in av.EnumerateObject()) if (p.Value.ValueKind == JsonValueKind.String) applied[p.Name] = p.Value.GetString()!;
        foreach (var inst in Installs)
        {
            inst.CurrentVersion = current.TryGetValue(inst.Root, out var c) ? c : "";
            inst.AppliedVersion = applied.TryGetValue(inst.Root, out var a) ? a : "";
        }
    }

    private string fullAccessOnDisk = "";
    /// <summary>客户端磁盘上的完全访问实际状态（只读展示）。</summary>
    public string FullAccessOnDisk { get => fullAccessOnDisk; private set { fullAccessOnDisk = value; Notify(); } }

    /// <summary>恢复上次勾选；首次运行（无记忆文件）为两个都开启。</summary>
    private async Task LoadPreferencesAsync()
    {
        var data = await service.RunAsync("ui-state");
        // 直接赋值字段，避免触发 Remember() 写回。
        includeSecurity = data.GetProperty("includeSecurity").GetBoolean();
        fullAccess = data.GetProperty("fullAccess").GetBoolean();
        Notify(nameof(IncludeSecurity));
        Notify(nameof(FullAccess));
    }

    /// <summary>
    /// 后台定时复查是否需要重新应用。
    ///
    /// 这是“实时判断”的核心：窗口只要开着，即使什么也不做，也会发现客户端升级／回写
    /// 导致的待同步，不必等用户下次手动打开窗口才发现。
    /// 间隔 20 秒：单次 status 实测约 0.5～0.7 秒；空闲时跳过，不与应用/撤销等写入操作抢锁。
    /// </summary>
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(20);
    private CancellationTokenSource? pollCts;

    public void StartWatching()
    {
        pollCts = new CancellationTokenSource();
        var token = pollCts.Token;
        _ = Task.Run(async () =>
        {
            while (!token.IsCancellationRequested)
            {
                try { await Task.Delay(PollInterval, token); } catch (TaskCanceledException) { return; }
                // 仅在空闲时复查：与 apply/restore 互斥，避免并发读写与按钮状态闪动。
                if (!IsIdle || token.IsCancellationRequested) continue;
                try
                {
                    // Flags() 会读绑定到 UI 的 Installs 集合，必须在 UI 线程上算；
                    // 算完再回到后台跑 CLI，避免跨线程访问 ObservableCollection。
                    var flags = System.Windows.Application.Current?.Dispatcher.Invoke(() => Flags(false));
                    if (flags is null) continue;
                    var data = await service.RunAsync("status", flags);
                    if (token.IsCancellationRequested) return;
                    var count = data.GetProperty("pendingChanges").GetInt32();
                    // 后台线程只算结果，回到 UI 线程再改属性（WPF 绑定要求）。
                    System.Windows.Application.Current?.Dispatcher.Invoke(() =>
                    {
                        if (token.IsCancellationRequested) return;
                        UpdateSyncVerdict(data, count);
                        hasBackup = data.GetProperty("latestBackup").ValueKind != JsonValueKind.Null;
                        RefreshCommands();
                    });
                }
                catch { /* 后台复查失败不打扰用户，下次再试 */ }
            }
        }, token);
    }

    public void StopWatching() => pollCts?.Cancel();

    /// <summary>首次加载安装列表：默认全部勾选，避免漏同步某一套安装的独立缓存副本。</summary>
    private async Task LoadInstallsAsync()
    {
        var data = await service.RunAsync("installs");
        Installs.Clear();
        foreach (var i in data.GetProperty("installs").EnumerateArray())
        {
            var name = i.GetProperty("name").GetString()!;
            var target = new InstallTarget
            {
                Name = name,
                Root = i.GetProperty("root").GetString()!,
                ConfigDir = i.GetProperty("configDir").GetString()!,
                ConfigExists = i.GetProperty("configExists").GetBoolean(),
                Selected = true,
            };
            target.PropertyChanged += (_, _) => RefreshCommands();
            Installs.Add(target);
        }
        if (Installs.Count > 0 && !Installs.Any(i => i.Selected)) Installs[0].Selected = true;
    }
    public bool HasNoInstallSelected => Installs.Count > 0 && !Installs.Any(i => i.Selected);
    private async Task RunAsync(string command)
    {
        if (!IsIdle) return;
        SetBusy(true); Status = command == "preview" ? "正在预览…" : "正在备份、应用并校验…";
        try
        {
            var data = await service.RunAsync(command, Flags(command != "preview"));
            Log = JsonSerializer.Serialize(data, new JsonSerializerOptions { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
            await RefreshStatusAsync();
            if (command == "restore") Status = "已撤销上次应用；提示词源文件保留你的修改";
            else if (command == "apply") Status = "应用完成，校验通过";
        }
        catch (Exception e) { Status = "操作未完成"; Log = e.Message; }
        finally { SetBusy(false); }
    }
}
