using System.Windows;
using PlanWidget.Data;
using PlanWidget.Services;
using PlanWidget.Theming;

namespace PlanWidget;

/// <summary>应用入口：解析命令行 → 校验未知/缺失 → --create-shortcut → 应用主题。</summary>
public partial class App : System.Windows.Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        // 统一解析命令行（兼容 --key value 与 --key=value）
        CliOptions.ParseOrCurrent(e.Args);

        // 命令行带未知参数 / 取值缺失 → stderr 告警 + 非零码退出（仅 CLI；GUI 正常启动不受影响）
        if (CliOptions.Current!.HasUnknown || CliOptions.Current.HasMissingValue)
        {
            foreach (var u in CliOptions.Current.Unknowns) Console.Error.WriteLine("unknown option " + u);
            foreach (var m in CliOptions.Current.MissingValues) Console.Error.WriteLine("missing value for --" + m);
            Shutdown(2);
            return;
        }

        // --create-shortcut：创建桌面快捷方式后立即退出（成功=0；失败=stderr 原因 + 1）
        if (CliOptions.Current.HasFlag("create-shortcut"))
        {
            var res = ShortcutHelper.CreateDesktopShortcut(CliOptions.Current.Get("shortcut-dir"));
            if (!res.ok)
            {
                Console.Error.WriteLine(res.message);
                Shutdown(1);
                return;
            }
            Shutdown(0);
            return;
        }

        // 应用已保存的主题（config.json 缺失时用默认 Light）
        var cfg = ConfigResolver.Load();
        ThemeManager.Apply(cfg.Theme ?? "Light");
    }
}
