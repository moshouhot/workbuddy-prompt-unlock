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
