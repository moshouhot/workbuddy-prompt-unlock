using System.ComponentModel;
using System.Reflection;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.IO;

namespace WorkBuddyUnlock;
public partial class MainWindow : Window
{
    private readonly MainViewModel model;
    public MainWindow()
    {
        InitializeComponent(); model = new MainViewModel(new CliService()); DataContext = model;
        // 标题栏：软件名 + 版本号 + 实际实现语言。版本取自程序集元数据，
        // 而程序集版本又由 package.json 生成，因此全链只有一个版本来源。
        var version = Assembly.GetExecutingAssembly().GetName().Version;
        Title = $"WorkBuddy Prompt Unlock v{version?.Major}.{version?.Minor}.{version?.Build} · C#";
        if (Environment.GetCommandLineArgs().Contains("--compact")) { Width = MinWidth; Height = MinHeight; }
        Loaded += async (_, _) =>
        {
            await model.InitializeAsync();
            var args = Environment.GetCommandLineArgs();
            var screenshot = Array.IndexOf(args, "--screenshot");
            if (screenshot >= 0 && args.Length > screenshot + 1)
            {
                // Read-only acceptance mode: production UI; never invokes apply/restore.
                UpdateLayout();
                var root = (FrameworkElement)Content;
                var dpi = args.Contains("--scale150") ? 144d : 96d;
                var bmp = new RenderTargetBitmap((int)Math.Ceiling(root.ActualWidth * dpi / 96),
                    (int)Math.Ceiling(root.ActualHeight * dpi / 96), dpi, dpi, PixelFormats.Pbgra32);
                var visual = new DrawingVisual();
                using (var dc = visual.RenderOpen())
                {
                    var rect = new Rect(0, 0, root.ActualWidth, root.ActualHeight);
                    dc.DrawRectangle(Background, null, rect);
                    dc.DrawRectangle(new VisualBrush(root) { Stretch = Stretch.Fill }, null, rect);
                }
                bmp.Render(visual);
                var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bmp));
                using (var f = File.Create(args[screenshot + 1])) encoder.Save(f);
                Close();
            }
        };
    }
    protected override void OnClosing(CancelEventArgs e)
    {
        if (!model.IsIdle) { e.Cancel = true; return; } // Never abandon a file transaction halfway.
        base.OnClosing(e);
    }
}
