using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;

namespace WorkBuddyUnlock;
public sealed class CliService
{
    public string Root { get; }
    public CliService()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !File.Exists(Path.Combine(dir.FullName, "wb.mjs"))) dir = dir.Parent;
        Root = dir?.FullName ?? throw new InvalidOperationException("找不到 wb.mjs；请保持程序与项目文件在一起。");
    }
    public async Task<JsonElement> RunAsync(string command, params string[] flags)
    {
        var info = new ProcessStartInfo("node")
        {
            WorkingDirectory = Root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        info.ArgumentList.Add(Path.Combine(Root, "wb.mjs")); info.ArgumentList.Add(command);
        info.ArgumentList.Add("--json");
        foreach (var flag in flags) info.ArgumentList.Add(flag);
        using var process = new Process { StartInfo = info };
        try { process.Start(); }
        catch (System.ComponentModel.Win32Exception) { throw new InvalidOperationException("找不到 Node.js；请安装 Node.js LTS，然后重新打开界面。"); }
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        var text = await stdout;
        var detail = await stderr;
        JsonElement result;
        try { using var doc = JsonDocument.Parse(text); result = doc.RootElement.Clone(); }
        catch (JsonException) { throw new InvalidOperationException($"CLI 未返回有效 JSON：{text}\n{detail}"); }
        if (!result.GetProperty("ok").GetBoolean() || process.ExitCode != 0)
        {
            var e = result.GetProperty("error");
            throw new InvalidOperationException($"{e.GetProperty("code").GetString()}: {e.GetProperty("message").GetString()}");
        }
        return result.GetProperty("data").Clone();
    }
    public void EditFile(string file)
    {
        // Bind file names to the CLI-provided list; no shell command interpolation.
        var info = new ProcessStartInfo("notepad.exe") { UseShellExecute = false };
        info.ArgumentList.Add(file); Process.Start(info);
    }
    public void OpenFolder() => Process.Start(new ProcessStartInfo(Path.Combine(Root, "prompts")) { UseShellExecute = true });
}
