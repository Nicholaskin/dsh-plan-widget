using System.Linq;
using System.Windows;

namespace PlanWidget.Theming;

/// <summary>
/// 主题管理器：通过替换 Application.Resources 中的主题 ResourceDictionary 实现换肤。
/// 控件统一使用 DynamicResource 引用颜色键，Swap 后即时刷新。
/// </summary>
public static class ThemeManager
{
    public static void Apply(string? theme)
    {
        var key = string.Equals(theme, "Dark", StringComparison.OrdinalIgnoreCase) ? "Dark" : "Light";
        var app = Application.Current;
        if (app == null) return;

        var dict = new ResourceDictionary
        {
            Source = new Uri($"Resources/Themes/{key}.xaml", UriKind.Relative)
        };

        // 移除旧主题字典，避免叠加
        var existing = app.Resources.MergedDictionaries
            .FirstOrDefault(d => d.Source?.OriginalString.Contains("Themes/", StringComparison.OrdinalIgnoreCase) == true);
        if (existing != null) app.Resources.MergedDictionaries.Remove(existing);

        app.Resources.MergedDictionaries.Add(dict);
    }
}