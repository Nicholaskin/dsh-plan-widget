using System.Windows;
using PlanWidget.Data;
using PlanWidget.Services;
using PlanWidget.Theming;

namespace PlanWidget.Settings;

/// <summary>
/// 设置窗口：编辑计划/会话状态文件路径、轮询间隔、主题、状态面板默认开关。
/// 保存后写 exe 同目录 config.json 并即时应用主题。
/// </summary>
public partial class SettingsWindow : Window
{
    private readonly AppConfig _config;

    /// <summary>是否点"确定"保存（供调用方判断后续热重载）。</summary>
    public bool Saved { get; private set; }

    public SettingsWindow(AppConfig config)
    {
        InitializeComponent();
        _config = config;
        Populate();
    }

    private void Populate()
    {
        // 优先展示显式文件路径；否则展示计划文件夹（若有）
        TxtPlanState.Text = _config.PlanStatePath
                            ?? (_config.PlanFolder != null ? _config.PlanFolder + "（文件夹）" : "");
        TxtSessionStatus.Text = _config.SessionStatusPath ?? "";

        // 自动发现 / 原路径无效 提示
        PlanHint.Visibility = _config.PlanProbed ? Visibility.Visible : Visibility.Collapsed;
        PlanHint.Text = _config.PlanInvalidOrig
            ? "⚠ 原计划路径无效，已自动发现；可在此手动覆盖"
            : "◎ 已自动发现；可在此手动覆盖";
        SessionHint.Visibility = _config.SessionProbed ? Visibility.Visible : Visibility.Collapsed;
        SessionHint.Text = _config.SessionInvalidOrig
            ? "⚠ 原会话路径无效，已自动发现；可在此手动覆盖"
            : "◎ 已自动发现；可在此手动覆盖";

        TxtPollMs.Text = _config.PollMs.ToString();
        CmbTheme.SelectedIndex = string.Equals(_config.Theme, "Dark", StringComparison.OrdinalIgnoreCase) ? 1 : 0;
        ChkSessionDefault.IsChecked = _config.StartupShowSession;
        ChkSnap.IsChecked = _config.SnapEnabled;
    }

    // ---- 浏览/选择 ----
    private void BrowsePlanFile_Click(object sender, RoutedEventArgs e)
    {
        var dlg = new Microsoft.Win32.OpenFileDialog
        {
            Filter = "JSON 文件 (*.json)|*.json|所有文件 (*.*)|*.*",
            Title = "选择计划状态文件（plan-state.json）"
        };
        if (dlg.ShowDialog(this) == true) TxtPlanState.Text = dlg.FileName;
    }

    private void BrowsePlanFolder_Click(object sender, RoutedEventArgs e)
    {
        var dlg = new System.Windows.Forms.FolderBrowserDialog
        {
            Description = "选择计划文件夹（将自动定位为 .plan-widget\\plan-state.json）"
        };
        if (dlg.ShowDialog() == System.Windows.Forms.DialogResult.OK)
        {
            TxtPlanState.Text = System.IO.Path.Combine(dlg.SelectedPath, ".plan-widget", "plan-state.json");
        }
    }

    private void BrowseSessionFile_Click(object sender, RoutedEventArgs e)
    {
        var dlg = new Microsoft.Win32.OpenFileDialog
        {
            Filter = "JSON 文件 (*.json)|*.json|所有文件 (*.*)|*.*",
            Title = "选择会话状态文件（session-status.json）"
        };
        if (dlg.ShowDialog(this) == true) TxtSessionStatus.Text = dlg.FileName;
    }

    // ---- 确定 / 取消 ----
    private void Ok_Click(object sender, RoutedEventArgs e)
    {
        if (!int.TryParse(TxtPollMs.Text, out var poll) || poll < 200 || poll > 60000)
        {
            System.Windows.MessageBox.Show("轮询间隔需在 200-60000 毫秒之间。", "设置",
                System.Windows.MessageBoxButton.OK, System.Windows.MessageBoxImage.Warning);
            return;
        }

        _config.PlanStatePath = string.IsNullOrWhiteSpace(TxtPlanState.Text) ? null : TxtPlanState.Text.Trim();
        _config.PlanFolder = null;   // 统一以显式文件路径持久化
        _config.SessionStatusPath = string.IsNullOrWhiteSpace(TxtSessionStatus.Text) ? null : TxtSessionStatus.Text.Trim();
        _config.PollMs = poll;
        _config.Theme = CmbTheme.SelectedIndex == 1 ? "Dark" : "Light";
        _config.StartupShowSession = ChkSessionDefault.IsChecked == true;
        _config.SnapEnabled = ChkSnap.IsChecked == true;

        if (!ConfigResolver.Save(_config))
        {
            System.Windows.MessageBox.Show("保存配置失败，请检查目录写入权限。", "设置",
                System.Windows.MessageBoxButton.OK, System.Windows.MessageBoxImage.Error);
            return;
        }

        // 即时应用主题
        ThemeManager.Apply(_config.Theme);
        Saved = true;
        DialogResult = true;
    }

    private void CreateShortcut_Click(object sender, RoutedEventArgs e)
    {
        var res = ShortcutHelper.CreateDesktopShortcut();
        System.Windows.MessageBox.Show(res.message, "创建桌面快捷方式",
            System.Windows.MessageBoxButton.OK,
            res.ok ? System.Windows.MessageBoxImage.Information : System.Windows.MessageBoxImage.Warning);
    }

    private void Cancel_Click(object sender, RoutedEventArgs e) => DialogResult = false;
    private void Close_Click(object sender, RoutedEventArgs e) => DialogResult = false;
}