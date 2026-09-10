using System.IO;
using System.Runtime.InteropServices;

namespace PlanWidget.Services;

/// <summary>
/// 创建桌面快捷方式（COM WScript.Shell 写 .lnk，Windows 内置）。
/// 默认桌面；--shortcut-dir=&lt;dir&gt; 可重定向（测试隔离）。
/// </summary>
public static class ShortcutHelper
{
    /// <summary>创建桌面快捷方式（目录取自 CliOptions 的 shortcut-dir，无则桌面）。返回 (是否成功, 提示)。</summary>
    public static (bool ok, string message) CreateDesktopShortcut()
        => CreateDesktopShortcut(CliOptions.Current?.Get("shortcut-dir"));

    /// <summary>创建桌面快捷方式：Target=当前 exe，Icon=exe，Name=计划悬浮窗，WorkDir=exe 目录。dir 为空→桌面。返回 (是否成功, 提示)。</summary>
    public static (bool ok, string message) CreateDesktopShortcut(string? dir)
    {
        dir = string.IsNullOrWhiteSpace(dir) ? Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory) : dir;
        if (!Directory.Exists(dir)) return (false, "快捷方式目录不存在：" + dir);

        var exe = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(exe)) return (false, "无法定位程序路径");

        var lnk = Path.Combine(dir, "计划悬浮窗.lnk");
        bool existed = File.Exists(lnk);

        try
        {
            // 用 COM WScript.Shell 创建 .lnk（Windows 内置，无需第三方包）
            var shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null) return (false, "WScript.Shell COM 组件不可用");
            dynamic shell = Activator.CreateInstance(shellType)!;
            dynamic shortcut = shell.CreateShortcut(lnk);
            shortcut.TargetPath = exe;
            shortcut.WorkingDirectory = Path.GetDirectoryName(exe);
            shortcut.IconLocation = exe + ",0";
            shortcut.Description = "计划悬浮窗";
            shortcut.Save();
            Marshal.ReleaseComObject(shortcut);
            Marshal.ReleaseComObject(shell);
            return (true, existed ? "已更新桌面快捷方式" : "已创建桌面快捷方式");
        }
        catch (Exception ex)
        {
            return (false, "创建快捷方式失败：" + ex.Message);
        }
    }

}