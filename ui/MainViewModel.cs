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
    private bool busy, includeSecurity, hasBackup;
    private string status = "正在检查客户端…", log = "", installSummary = "";
    private PromptFile? selectedPrompt;
    public event PropertyChangedEventHandler? PropertyChanged;
    public ObservableCollection<PromptFile> PromptFiles { get; } = [];
    public bool IsIdle => !busy;
    public bool IncludeSecurity { get => includeSecurity; set { includeSecurity = value; Notify(); } }
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
        ApplyCommand = new(() => RunAsync("apply"), () => IsIdle);
        PreviewCommand = new(() => RunAsync("preview"), () => IsIdle);
        RestoreCommand = new(() => RunAsync("restore"), () => IsIdle && hasBackup);
        EditCommand = new(() => SafeAction(() => service.EditFile(SelectedPrompt!.Path)), () => IsIdle && SelectedPrompt != null);
        FolderCommand = new(() => SafeAction(service.OpenFolder), () => IsIdle);
    }
    private void Notify([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new(name));
    private void RefreshCommands() { foreach (var c in Commands) c.Refresh(); }
    private void SetBusy(bool value) { busy = value; Notify(nameof(IsIdle)); RefreshCommands(); }
    private Task SafeAction(Action action)
    {
        try { action(); } catch (Exception e) { Status = "操作失败"; Log = e.Message; }
        return Task.CompletedTask;
    }
    private string[] Flags(bool mutate) => [.. (IncludeSecurity ? new[] { "--security" } : Array.Empty<string>()), .. (mutate ? new[] { "--close", "--restart" } : Array.Empty<string>())];
    public async Task InitializeAsync()
    {
        SetBusy(true);
        try
        {
            var list = await service.RunAsync("prompts");
            foreach (var f in list.GetProperty("files").EnumerateArray()) if (f.GetProperty("editable").GetBoolean())
                PromptFiles.Add(new(f.GetProperty("name").GetString()!, f.GetProperty("path").GetString()!));
            SelectedPrompt = PromptFiles.FirstOrDefault(p => p.Name == "personal_files_safety.txt");
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
        RefreshCommands();
    }
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
