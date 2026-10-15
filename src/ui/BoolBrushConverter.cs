using System.Globalization;
using System.Windows.Data;
using System.Windows.Media;

namespace WorkBuddyUnlock;

/// <summary>
/// 把 bool（是否需要一键应用）映射成画刷颜色。
/// 用于同步状态横幅与“一键应用”按钮：需要应用时给告警橙，已同步时给平静绿，
/// 让用户不必逐字阅读就能看出当前状态。
/// </summary>
public sealed class BoolBrushConverter : IValueConverter
{
    public string True { get; set; } = "#000000";
    public string False { get; set; } = "#000000";

    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
    {
        var hex = value is true ? True : False;
        return new SolidColorBrush((Color)ColorConverter.ConvertFromString(hex));
    }

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture)
        => throw new NotSupportedException();
}
