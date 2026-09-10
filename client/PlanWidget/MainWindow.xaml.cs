using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using PlanWidget.Data;
using PlanWidget.Models;
using PlanWidget.Dock;
using PlanWidget.Services;
using PlanWidget.Settings;

namespace PlanWidget;

/// <summary>
/// 主窗口（计划悬浮窗，正式版）。
/// 数据来自文件轮询（IPlanSource / IStatusSource）；带配置对话框、本地勾选回写、
/// 分级容错、浅/深主题、托盘、DEBUG/验收自检。
/// </summary>
public partial class MainWindow : Window
{
    // ---------- 数据源与状态 ----------
    private AppConfig _config = new();
    private IPlanSource _planSource = null!;
    private IStatusSource _statusSource = null!;
    private PlanState? _plan;             // 当前计划（损坏时保留上一次有效）
    private PlanState? _lastGoodPlan;     // 上一次有效计划（容错缓存）
    private SessionState? _status;
    private LocalProgressStore _localProgress = null!;
    private string _todayDate = DateTime.Now.ToString("yyyy-MM-dd");

    // ---------- 待办 ----------
    private readonly List<TodoItem> _todos = new();
    private bool _suppressTodo;          // 重建待办时抑制 OnTodoChanged（避免勾选写入触发重写）
    private string _currentNowTitle = "";  // 当前任务卡标题（自检用）
    private bool _allDone;               // 今日全部完成（自检用）
    private string _weekNow = "";       // 本周当前任务（自检用）
    private string _totalNow = "";      // 总览当前任务（自检用）
    private DispatcherTimer? _progressPollTimer;   // 共享进度外部变化轮询（热重载）
    private DispatcherTimer? _toastTimer;          // 非阻塞提示自动隐藏

    // ---------- 托盘 ----------
    private System.Windows.Forms.NotifyIcon? _tray;
    private bool _allowClose;             // 仅"退出"菜单时允许真正关闭
    private SnapDockSnapper _snapper = null!;   // 边缘吸附/折叠状态机（QQ 风格）

    // ---------- 页签防重入 ----------
    private bool _tabsUpdating;

    // ---------- 层级三态 ----------
    private int _layerLevel;

    // ---------- 容错状态 ----------
    private enum DataWarn { None, Missing, Corrupt }
    private DataWarn _warn = DataWarn.None;

    // ---------- 验收自检 ----------
    private bool _verifyEnabled;

    public MainWindow()
    {
        InitializeComponent();

        // 窗口图标 = 品牌 logo（多尺寸 ico）
        try { Icon = BitmapFrame.Create(new Uri("pack://application:,,,/Resources/plan-widget.ico")); }
        catch { /* 图标缺失不影响运行 */ }

        _config = ConfigResolver.Load();
        InitSources();

        _verifyEnabled = CliOptions.Current?.HasFlag("verify") == true;

        // 边缘吸附状态机（受 snapEnabled 控制）
        _snapper = new SnapDockSnapper(this) { Enabled = _config.SnapEnabled };
        _snapper.Folded += OnFolded;
        _snapper.Expanded += OnExpanded;
        _snapper.Detached += OnDetached;
    }

    private void InitSources()
    {
        _planSource = new FilePlanSource(_config.PlanStatePath ?? "", _config.PollMs);
        _statusSource = new FileStatusSource(_config.SessionStatusPath ?? "", _config.PollMs);
        // 共享进度：共享文件路径（config.progressPath / planStatePath 同目录 progress.json）+ 本地兜底（exe 目录 local-progress.json）
        _localProgress = new LocalProgressStore(_config.ProgressPath!, Path.Combine(AppContext.BaseDirectory, "local-progress.json"));
        StartProgressPoll();
    }

    /// <summary>轮询共享进度文件：外部（Web/其他端）改动 → 热重载并入内存 → 触发重渲染（无需重启）。</summary>
    private void StartProgressPoll()
    {
        _progressPollTimer?.Stop();
        _progressPollTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(Math.Max(200, _config.PollMs)) };
        _progressPollTimer.Tick += (_, _) =>
        {
            if (_localProgress.Reload()) { RenderPlan(); EmitVerify(); }
        };
        _progressPollTimer.Start();
    }

    /// <summary>非阻塞提示（Toast）：写共享失败时提示“本地暂存”。</summary>
    private void ShowToast(string msg)
    {
        ToastText.Text = msg;
        ToastOverlay.Visibility = Visibility.Visible;
        _toastTimer?.Stop();
        _toastTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2.6) };
        _toastTimer.Tick += (_, _) => { _toastTimer.Stop(); ToastOverlay.Visibility = Visibility.Collapsed; };
        _toastTimer.Start();
    }

    /// <summary>写共享失败提示。</summary>
    private void SyncProgressHint()
    {
        if (_localProgress.LastWriteUsedFallback) ShowToast("同步失败，本地暂存");
    }

    // =====================================================================
    // 窗口加载：定位 → 首启设置向导（如需）→ 初始加载 → 订阅 → 托盘/自检
    // =====================================================================
    private void Window_Loaded(object sender, RoutedEventArgs e)
    {
        var workArea = SystemParameters.WorkArea;
        if (!TryRestoreWindowLayout())
        {
            Left = workArea.Right - Width - 20;
            Top = workArea.Top + 20;
        }

        // 首次运行：未配置数据路径才弹设置向导（自动探测命中则直接加载数据）
        if (!_config.IsConfigured)
        {
            OpenSettings();
        }

        ApplyPlan(_planSource.LoadPlanState());
        ApplyStatus(_statusSource.LoadStatus());
        SubscribeSources();
        SelectTab(0);

        if (_config.StartupShowSession)
        {
            SessionPanel.Visibility = Visibility.Visible;
            RenderStatus();
        }

        SetupTray();
        if (_config.SnapEnabled) _snapper.Start(); else _snapper.Stop();

        if (_verifyEnabled)
        {
            // 测试钩子：--check=<idx> 模拟勾选第 idx 项，走真实写回路径（仅 --verify 模式生效）
            var idx = ParseCheckIndex();
            if (idx.HasValue && idx.Value >= 0 && idx.Value < _todos.Count) _todos[idx.Value].IsChecked = true;

            // --drag=x,y 模拟拖到该位置后松开（触发吸附/折叠）
            var drag = ParseDragPoint();
            if (drag.HasValue)
            {
                _snapper.OnDragBegin();          // 置 _isUserDrag=true，定位时触发 LocationChanged 边缘碰撞钳制
                Left = drag.Value.X;
                Top = drag.Value.Y;
                _snapper.OnDragEnd();             // 相交吸附
            }
            // --detach 延时 900ms 脱离（模拟拖出恢复层级）
            if (CliOptions.Current?.HasFlag("detach") == true)
            {
                var dt = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(900) };
                dt.Tick += (_, _) => { dt.Stop(); _snapper.OnDragBegin(); };
                dt.Start();
            }
            // --expand 延时 900ms 展开（模拟鼠标靠近把手/边缘）
            if (CliOptions.Current?.HasFlag("expand") == true)
            {
                var et = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(900) };
                et.Tick += (_, _) => { et.Stop(); _snapper.HandleMouseEnter(); };
                et.Start();
            }
            // --complete=<n> 完成当前任务 n 次（推进到下一任务；全部完成自动停）
            var n = ParseCompleteCount();
            if (n > 0)
            {
                var ct = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(100) };
                int remaining = n;
                ct.Tick += (_, _) =>
                {
                    if (remaining <= 0 || !CompleteCurrentTask()) { ct.Stop(); return; }
                    remaining--;
                };
                ct.Start();
            }

            var vt = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
            vt.Tick += (_, _) => EmitVerify();
            vt.Start();
        }
    }

    private void SubscribeSources()
    {
        _planSource.Subscribe(() =>
        {
            ApplyPlan(_planSource.LoadPlanState());
            EmitVerify();
        });
        _statusSource.Subscribe(() =>
        {
            ApplyStatus(_statusSource.LoadStatus());
            EmitVerify();
        });
    }

    // =====================================================================
    // 加载与容错
    // =====================================================================
    private void ApplyPlan(LoadResult<PlanState> res)
    {
        switch (res.Status)
        {
            case LoadStatus.Ok:
                _lastGoodPlan = res.Data;
                _plan = res.Data;
                SetWarn(DataWarn.None);
                break;
            case LoadStatus.Missing:
                _plan = _lastGoodPlan;      // 保留上次有效数据
                SetWarn(DataWarn.Missing);
                break;
            default: // Corrupt
                _plan = _lastGoodPlan;
                SetWarn(DataWarn.Corrupt);
                break;
        }
        RenderPlan();
    }

    private void ApplyStatus(LoadResult<SessionState> res)
    {
        _status = res.Status == LoadStatus.Ok ? res.Data : null;
        RenderStatus();
    }

    private void SetWarn(DataWarn w)
    {
        _warn = w;
        switch (w)
        {
            case DataWarn.Missing:
                WarnText.Text = "未找到 plan-state.json：请检查设置或用此按钮选择文件";
                WarnBanner.Visibility = Visibility.Visible;
                break;
            case DataWarn.Corrupt:
                WarnText.Text = "数据文件损坏，显示上次快照";
                WarnBanner.Visibility = Visibility.Visible;
                break;
            default:
                WarnBanner.Visibility = Visibility.Collapsed;
                break;
        }
    }

    // =====================================================================
    // 渲染：计划
    // =====================================================================
    private void RenderPlan()
    {
        var plan = _plan;
        var tasks = plan?.Today?.Tasks ?? new List<TodayTask>();
        _todayDate = plan?.Today?.Date ?? DateTime.Now.ToString("yyyy-MM-dd");

        // 今日
        var daily = plan?.Levels?.Daily?.Current;
        TodayStageText.Text = BuildBanner("当前所处时段", daily?.Period, daily?.Task?.Now);
        var cards = BuildTaskChain(tasks, _todayDate);
        TodayTasks.ItemsSource = cards;
        TodaySlots.ItemsSource = BuildSlots(tasks, cards);
        BindAgentTasks(_plan);
        TodayGoals.ItemsSource = plan?.Today?.Goals ?? new List<string>();
        SetTodayMeta(cards);

        // 本周：分组完整列表（groups/tasks 存在 → 只读全列表；否则旧三行）
        var weeklyLv = plan?.Levels?.Weekly;
        var weeklyCur = weeklyLv?.Current;
        WeekTitleText.Text = FirstNonEmpty(weeklyLv?.Title, weeklyLv?.File, "本周");
        WeekStageText.Text = BuildLevelStage(weeklyLv, weeklyCur);
        WeekFileText.Text = weeklyLv?.File ?? "";
        _weekNow = weeklyCur?.Task?.Now ?? "";
        WeekTasks.ItemsSource = HasFullList(weeklyLv) ? BuildFullList(weeklyLv!) : BuildTriple(weeklyCur?.Task);

        // 总览：分组完整列表（存在 → 只读全列表；否则旧里程碑三节点）
        var totalLv = plan?.Levels?.Total;
        var totalCur = totalLv?.Current;
        OverviewStageText.Text = BuildReadableBanner(totalLv, totalCur, "总览");
        OverviewFileText.Text = totalLv?.File ?? "";
        _totalNow = totalCur?.Task?.Now ?? "";
        MilestoneList.ItemsSource = HasFullList(totalLv) ? BuildFullList(totalLv!) : BuildMilestones(totalCur?.Task, totalCur?.Period);

        // 待办
        RenderTodo(tasks);
    }

    private void RenderTodo(List<TodayTask> tasks)
    {
        _suppressTodo = true;   // 抑制重建时的勾选写入
        var items = new List<TodoItem>();
        foreach (var t in tasks)
        {
            var id = TaskId(t);
            var todo = new TodoItem
            {
                Id = id,
                Title = t.Text ?? "",
                IsChecked = IsTaskDone(t) || _localProgress.IsDone(_todayDate, id)
            };
            todo.PropertyChanged += OnTodoChanged;
            items.Add(todo);
        }
        _todos.Clear();
        _todos.AddRange(items);
        TodoList.ItemsSource = _todos;
        UpdateTodoSummary();
        _suppressTodo = false;
    }

    /// <summary>勾选变化：写 local-progress（可能失败→提示），并同步今日任务链与统计。</summary>
    private void OnTodoChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (_suppressTodo) return;   // 重建勾选不触发写回
        if (e.PropertyName != nameof(TodoItem.IsChecked)) return;
        if (sender is not TodoItem item || item.Id == null) return;

        _localProgress.SetDone(_todayDate, item.Id, item.IsChecked);   // 写共享；失败自动落本地兜底
        SyncProgressHint();

        UpdateTodoSummary();
        RebuildTodayChain();
    }

    private void RebuildTodayChain()
    {
        var tasks = _plan?.Today?.Tasks ?? new List<TodayTask>();
        var cards = BuildTaskChain(tasks, _todayDate);
        TodayTasks.ItemsSource = cards;
        TodaySlots.ItemsSource = BuildSlots(tasks, cards);
        SetTodayMeta(cards);
    }

    private static string TaskId(TodayTask t) => (t.Text ?? "") + "|" + (t.Time ?? "");
    private static bool IsTaskDone(TodayTask t)
        => string.Equals(t.Status?.Trim(), "done", StringComparison.OrdinalIgnoreCase);

    private List<TaskCard> BuildTaskChain(List<TodayTask> tasks, string date)
    {
        // 统一推导：now = 第一个未完成；其前=已完成；其后一个未完成=next；全部完成→祝贺态
        int curIdx = -1;
        for (int i = 0; i < tasks.Count; i++)
            if (!IsTaskDone(tasks[i]) && !_localProgress.IsDone(date, TaskId(tasks[i])))
            { curIdx = i; break; }

        if (curIdx == -1)
        {
            // 全部完成 → 祝贺态（完成按钮禁用）
            return new List<TaskCard>
            {
                new TaskCard { Title = "今日全部完成 🎉", TimeRange = "所有任务已完成", State = TaskState.Current, AllDone = true }
            };
        }

        var cards = new List<TaskCard>(tasks.Count);
        for (int i = 0; i < tasks.Count; i++)
        {
            bool done = IsTaskDone(tasks[i]) || _localProgress.IsDone(date, TaskId(tasks[i]));
            TaskState st;
            if (done) st = TaskState.Done;
            else if (i == curIdx) st = TaskState.Current;
            else if (i == curIdx + 1) st = TaskState.Next;
            else st = TaskState.Pending;
            cards.Add(new TaskCard { Title = tasks[i].Text ?? "", TimeRange = tasks[i].Time ?? "", State = st, DoneId = TaskId(tasks[i]) });
        }
        return cards;
    }

    private static List<TimeSlot> BuildSlots(List<TodayTask> tasks, List<TaskCard> cards)
    {
        var slots = new List<TimeSlot>();
        for (int i = 0; i < tasks.Count; i++)
        {
            if (string.IsNullOrWhiteSpace(tasks[i].Time)) continue;   // 无时间的验收项不进时段条
            slots.Add(new TimeSlot
            {
                TimeRange = tasks[i].Time!,
                Title = tasks[i].Text ?? "",
                IsCurrent = cards.Count > i && cards[i].State == TaskState.Current,
            });
        }
        return slots;
    }

    private static List<TaskCard> BuildTriple(TaskTriple? t)
        => new()
        {
            new() { Title = t?.Prev ?? "—", TimeRange = "上一项", State = TaskState.Done },
            new() { Title = t?.Now  ?? "—", TimeRange = "当前",   State = TaskState.Current },
            new() { Title = t?.Next ?? "—", TimeRange = "下一项", State = TaskState.Next },
        };

    private static List<Milestone> BuildMilestones(TaskTriple? t, string? period)
        => new()
        {
            new() { Name = t?.Prev ?? "—", Detail = "上一阶段", DateText = period ?? "", State = TaskState.Done },
            new() { Name = t?.Now  ?? "—", Detail = "当前阶段", DateText = period ?? "", State = TaskState.Current },
            new() { Name = t?.Next ?? "—", Detail = "下一阶段", DateText = period ?? "", State = TaskState.Pending },
        };
    // =====================================================================
    // 周/总览 分组完整列表（只读）
    // =====================================================================
    /// <summary>该层级是否有 groups/tasks（有则优先全列表，否则回退三行/里程碑）。</summary>
    private static bool HasFullList(LevelBlock? lv)
        => (lv?.Groups != null && lv.Groups.Count > 0) || (lv?.Tasks != null && lv.Tasks.Count > 0);

    /// <summary>构建分组完整列表（GroupHeader + TaskCard 平铺），按 groups 顺序；无 groups 用展平 tasks。</summary>
    private static List<object> BuildFullList(LevelBlock lv)
    {
        var result = new List<object>();
        var now = lv.Current?.Task?.Now;
        if (lv.Groups != null && lv.Groups.Count > 0)
        {
            foreach (var g in lv.Groups)
            {
                if (!string.IsNullOrWhiteSpace(g?.Heading))
                    result.Add(new GroupHeader { Heading = g.Heading.Trim() });
                var gt = g?.Tasks;
                if (gt != null) foreach (var t in gt) result.Add(TaskCardFromLevel(t, now));
            }
        }
        else if (lv.Tasks != null)
        {
            foreach (var t in lv.Tasks) result.Add(TaskCardFromLevel(t, now));
        }
        return result;
    }

    /// <summary>层级任务项 → TaskCard：done→Done(灰显+✓)；当前(与 current.task.now 双向模糊匹配)→Current(高亮)；其余→Pending。只读（ShowComplete=false）。</summary>
    private static TaskCard TaskCardFromLevel(LevelTask t, string? now)
    {
        bool done = string.Equals(t.Status?.Trim(), "done", StringComparison.OrdinalIgnoreCase);
        bool isNow = !done && IsNowMatch(t.Text, now);
        var state = done ? TaskState.Done : (isNow ? TaskState.Current : TaskState.Pending);
        var meta = t.Time ?? "";
        if (!string.IsNullOrWhiteSpace(t.Group)) meta = (meta.Length > 0 ? meta + " · " : "") + t.Group;
        return new TaskCard { Title = t.Text ?? "", TimeRange = meta, State = state, DoneId = null, ShowComplete = false };
    }

    /// <summary>当前项判断：双向模糊匹配（先去空白，再互含），防止 data 侧 current.task.now 与任务文本格式差异（时间前缀/空格）漏高亮。</summary>
    private static bool IsNowMatch(string? text, string? now)
    {
        if (string.IsNullOrWhiteSpace(text) || string.IsNullOrWhiteSpace(now)) return false;
        var a = text.Replace(" ", "").Replace("\t", "");
        var b = now.Replace(" ", "").Replace("\t", "");
        if (a.Length == 0 || b.Length == 0) return false;
        return a.Contains(b) || b.Contains(a);
    }

    private static string FirstNonEmpty(params string?[] vals)
    {
        foreach (var v in vals) if (!string.IsNullOrWhiteSpace(v)) return v!;
        return "";
    }

    /// <summary>周期文案：period.from~to，否则 current.period。</summary>
    private static string LevelPeriod(LevelBlock? lv, CurrentBlock? cur)
    {
        if (lv?.Period?.From != null) return lv.Period.From + (lv.Period.To != null ? " ~ " + lv.Period.To : "");
        if (cur?.Period != null) return cur.Period;
        return "";
    }

    /// <summary>本周/总览横幅周期副行：period + now。</summary>
    private static string BuildLevelStage(LevelBlock? lv, CurrentBlock? cur)
    {
        var parts = new List<string>();
        var period = LevelPeriod(lv, cur);
        if (!string.IsNullOrWhiteSpace(period)) parts.Add(period);
        var now = cur?.Task?.Now;
        if (!string.IsNullOrWhiteSpace(now)) parts.Add(now);
        return string.Join(" · ", parts);
    }

    /// <summary>总览横幅（含 title + period + now），无 title 回退文件名。</summary>
    private static string BuildReadableBanner(LevelBlock? lv, CurrentBlock? cur, string def)
    {
        var parts = new List<string>();
        var title = lv?.Title;
        var file = lv?.File;
        var period = LevelPeriod(lv, cur);
        parts.Add(FirstNonEmpty(title, file, period, def));
        if (!string.IsNullOrWhiteSpace(period) && period != parts[0]) parts.Add(period);
        var now = cur?.Task?.Now;
        if (!string.IsNullOrWhiteSpace(now)) parts.Add(now);
        return string.Join(" · ", parts);
    }

    // =====================================================================
    // 渲染：会话状态面板
    // =====================================================================
    private void RenderStatus()
    {
        var main = _status?.Main;
        var map = MapState(main?.State);
        SessionDot.Fill = map.color;
        SessionText.Text = map.name;
        LatestText.Text = Truncate(main?.Latest?.Text, 30);
        SinceText.Text = FormatSince(main?.Since);
        PortText.Text = _status?.Instance?.Port is int p ? "端口 " + p : "端口 —";
        UpdateTrayStatus(map.key);   // 托盘图标随主会话状态变色
    }

    private static (string key, string name, System.Windows.Media.Brush color) MapState(string? raw)
        => raw?.Trim().ToLowerInvariant() switch
        {
            "working" => ("working", "工作中",       Make(0x22, 0xC5, 0x5E)),
            "idle"    => ("idle",    "空闲",         Make(0x9C, 0xA3, 0xAF)),
            "done"    => ("done",    "工作已完成",   Make(0x3B, 0x82, 0xF6)),
            "waiting" => ("waiting", "等待用户指示", Make(0xF5, 0x9E, 0x0B)),
            _         => ("idle",    "空闲",         Make(0x9C, 0xA3, 0xAF)),
        };
    private static System.Windows.Media.Brush Make(byte r, byte g, byte b) => new SolidColorBrush(Color.FromRgb(r, g, b));

    // =====================================================================
    // 层级三态 / 拖动 / 关闭 / 页签
    // =====================================================================
    private void LayerButton_Click(object sender, RoutedEventArgs e)
    {
        _layerLevel = (_layerLevel + 1) % 3;
        ApplyLayerState();
    }

    /// <summary>应用用户所选层级；折叠态强制最上层（脱离时由 OnDetached 恢复）。</summary>
    private void ApplyLayerState()
    {
        if (_snapper is { IsFolded: true })
        {
            Topmost = true;
            LayerBtn.Content = _layerLevel switch { 0 => "正常", 1 => "上移", _ => "置顶" };
            return;
        }
        switch (_layerLevel)
        {
            case 0: Topmost = false; LayerBtn.Content = "正常"; break;
            case 1: Topmost = false; Activate(); LayerBtn.Content = "上移"; break;
            default: Topmost = true; LayerBtn.Content = "置顶"; break;
        }
    }

    /// <summary>
    /// 整窗拖动：根级 MouseLeftButtonDown——窗口任意空白/文本区域均可拖动悬浮窗；
    /// 交互控件（按钮/页签/勾选框/单选/滚动条/输入框/滑杆等）命中时放行，不影响点击。
    /// </summary>
    private void Root_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        // resize 把手命中时不走整窗拖动（Thumb 自行处理 DragDelta）
        if (e.OriginalSource is System.Windows.Controls.Primitives.Thumb) return;
        // ButtonBase 覆盖：按钮、页签(RadioButton)、勾选框(CheckBox)、单选等；再排除滚动条/输入/滑杆
        if (e.OriginalSource is System.Windows.Controls.Primitives.ButtonBase
            || e.OriginalSource is ScrollBar
            || e.OriginalSource is TextBoxBase
            || e.OriginalSource is System.Windows.Controls.Primitives.Track
            || e.OriginalSource is ComboBox)
        {
            return;
        }
        if (e.ButtonState == MouseButtonState.Pressed)
        {
            _snapper.OnDragBegin();
            DragMove();
            _snapper.OnDragEnd();
            SaveWindowLayout(); // 拖动结束保存位置
        }
    }

    // =====================================================================
    // 窗口布局：位置/尺寸持久化（config.json）+ resize 把手 + 双击头部重置
    // =====================================================================

    /// <summary>保存窗口位置与尺寸到 config.json（exe 同目录，客户端自有配置，不触碰 DSH 生产路径）。</summary>
    private void SaveWindowLayout()
    {
        _config.WinLeft = Left;
        _config.WinTop = Top;
        _config.WinWidth = Width;
        _config.WinHeight = Height;
        ConfigResolver.Save(_config);
    }

    /// <summary>从 config.json 恢复窗口位置/尺寸；越界自动校正到当前工作区（防止多屏切换后锁在屏外）。</summary>
    private bool TryRestoreWindowLayout()
    {
        if (_config.WinWidth is not double w || _config.WinHeight is not double h ||
            _config.WinLeft is not double l || _config.WinTop is not double t) return false;
        var wa = _snapper.CurrentWorkArea;
        double minW = MinWidth, minH = MinHeight;
        double maxW = Math.Max(minW, wa.Width - 48);
        double maxH = Math.Max(minH, wa.Height - 48);
        Width = Math.Clamp(w, minW, maxW);
        Height = Math.Clamp(h, minH, maxH);
        Left = Math.Clamp(l, wa.Left, Math.Max(wa.Left, wa.Right - Width - 24));
        Top = Math.Clamp(t, wa.Top, Math.Max(wa.Top, wa.Bottom - Height - 24));
        return true;
    }

    /// <summary>右下角 resize 把手：拖动调整尺寸（min=MinWidth/MinHeight，max=工作区-48px；配合空气墙永不越出屏幕）。</summary>
    private void ResizeGrip_DragDelta(object sender, System.Windows.Controls.Primitives.DragDeltaEventArgs e)
    {
        double minW = MinWidth, minH = MinHeight;
        var wa = _snapper.CurrentWorkArea;
        double maxW = Math.Max(minW, wa.Width - 48);
        double maxH = Math.Max(minH, wa.Height - 48);
        Width = Math.Clamp(Width + e.HorizontalChange, minW, maxW);
        Height = Math.Clamp(Height + e.VerticalChange, minH, maxH);
        SaveWindowLayout();
    }

    /// <summary>双击头部（非按钮区域）：重置为默认尺寸 360x600 并回到右下默认位置。</summary>
    private void HeaderArea_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount != 2) return;
        if (e.OriginalSource is System.Windows.Controls.Primitives.ButtonBase) return;
        ResetWindowLayout();
        e.Handled = true;
    }

    /// <summary>重置窗口布局：默认 360x600，右下角默认位（与网页版双击把手行为一致）。</summary>
    private void ResetWindowLayout()
    {
        Width = 360; Height = 600;
        var wa = _snapper.CurrentWorkArea;
        Left = wa.Right - Width - 20;
        Top = wa.Top + 20;
        SaveWindowLayout();
    }

    private void CloseButton_Click(object sender, RoutedEventArgs e) => HideToTray();

    private void Window_Closing(object? sender, CancelEventArgs e)
    {
        // 点 X / Alt+F4 → 最小化到托盘（除非从托盘"退出"）
        if (!_allowClose) { e.Cancel = true; HideToTray(); }
    }

    private void Tab_Checked(object sender, RoutedEventArgs e)
    {
        if (_tabsUpdating) return;
        if (sender is not RadioButton rb || rb.IsChecked != true) return;
        if (int.TryParse((string)rb.Tag, out int idx)) ShowTab(idx);
    }

    private void SelectTab(int idx)
    {
        _tabsUpdating = true;
        var tabs = new[] { TabToday, TabWeek, TabOverview, TabTodo };
        for (int i = 0; i < tabs.Length; i++) tabs[i].IsChecked = (i == idx);
        _tabsUpdating = false;
        ShowTab(idx);
    }

    private void ShowTab(int idx)
    {
        PanelToday.Visibility    = idx == 0 ? Visibility.Visible : Visibility.Collapsed;
        PanelWeek.Visibility     = idx == 1 ? Visibility.Visible : Visibility.Collapsed;
        PanelOverview.Visibility = idx == 2 ? Visibility.Visible : Visibility.Collapsed;
        PanelTodo.Visibility     = idx == 3 ? Visibility.Visible : Visibility.Collapsed;
    }

    // =====================================================================
    // 会话开关 / 设置
    // =====================================================================
    private void SessionToggle_Click(object sender, RoutedEventArgs e)
    {
        bool show = SessionPanel.Visibility != Visibility.Visible;
        SessionPanel.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
        if (show) RenderStatus();
    }

    private void Settings_Click(object sender, RoutedEventArgs e) => OpenSettings();
    private void WarnSet_Click(object sender, RoutedEventArgs e) => OpenSettings();

    private void OpenSettings()
    {
        var win = new SettingsWindow(_config) { Owner = this };
        bool ok = win.ShowDialog() == true;
        if (ok) ReloadConfig();
    }

    private void ReloadConfig()
    {
        _planSource.Stop();
        _statusSource.Stop();
        _config = ConfigResolver.Load();
        InitSources();
        PlanWidget.Theming.ThemeManager.Apply(_config.Theme);
        ApplyPlan(_planSource.LoadPlanState());
        ApplyStatus(_statusSource.LoadStatus());
        SubscribeSources();
    }

    // =====================================================================
    // 托盘
    // =====================================================================
    private void SetupTray()
    {
        if (_tray != null) return;
        System.Drawing.Icon icon;
        try
        {
            var res = Application.GetResourceStream(new Uri("pack://application:,,,/Resources/logo.ico"));
            icon = new System.Drawing.Icon(res!.Stream);
        }
        catch { icon = System.Drawing.SystemIcons.Application; }

        var menu = new System.Windows.Forms.ContextMenuStrip();
        menu.Items.Add("显示", null, (_, _) => ShowFromTray());
        menu.Items.Add("设置", null, (_, _) => OpenSettings());
        menu.Items.Add(new System.Windows.Forms.ToolStripSeparator());
        menu.Items.Add("退出", null, (_, _) => Quit());

        _tray = new System.Windows.Forms.NotifyIcon
        {
            Text = "计划悬浮窗",
            Icon = icon,
            Visible = true,
            ContextMenuStrip = menu,
        };
        _tray.DoubleClick += (_, _) => ShowFromTray();
    }

    // =====================================================================
    // 托盘图标随主会话状态变色（完全隐藏时用户可看托盘状态点）
    // =====================================================================
    private readonly Dictionary<string, System.Drawing.Icon> _trayIcons = new();

    /// <summary>按状态键更新托盘图标为对应颜色圆点（working绿/idle灰/done蓝/waiting橙/未知灰白）。</summary>
    private void UpdateTrayStatus(string key)
    {
        if (_tray == null) return;
        _tray.Icon = GetStatusIcon(key);
    }

    private System.Drawing.Icon GetStatusIcon(string key)
    {
        if (_trayIcons.TryGetValue(key, out var ic)) return ic;
        var color = key switch
        {
            "working" => System.Drawing.Color.FromArgb(0x22, 0xC5, 0x5E),
            "idle"    => System.Drawing.Color.FromArgb(0x9C, 0xA3, 0xAF),
            "done"    => System.Drawing.Color.FromArgb(0x3B, 0x82, 0xF6),
            "waiting" => System.Drawing.Color.FromArgb(0xF5, 0x9E, 0x0B),
            _         => System.Drawing.Color.FromArgb(0xD1, 0xD5, 0xDB),   // 未知→灰白
        };
        var icon = MakeDotIcon(color);
        _trayIcons[key] = icon;
        return icon;
    }

    /// <summary>用 System.Drawing 生成 16x16 圆点图标。</summary>
    private static System.Drawing.Icon MakeDotIcon(System.Drawing.Color c)
    {
        using var bmp = new System.Drawing.Bitmap(16, 16);
        using var g = System.Drawing.Graphics.FromImage(bmp);
        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        g.Clear(System.Drawing.Color.Transparent);
        g.FillEllipse(new System.Drawing.SolidBrush(c), 2, 2, 12, 12);
        var h = bmp.GetHicon();
        using (var tmp = System.Drawing.Icon.FromHandle(h))
        {
            var owned = (System.Drawing.Icon)tmp.Clone();
            return owned;
        }
    }

    private void HideToTray()
    {
        Hide();
        if (_tray != null) _tray.Visible = true;
    }

    private void ShowFromTray()
    {
        Show();
        Activate();
    }

    private void Quit()
    {
        _allowClose = true;
        if (_tray != null) _tray.Visible = false;
        _tray?.Dispose();
        Application.Current.Shutdown();
    }

    // =====================================================================
    // 工具方法
    // =====================================================================
    private static bool Matches(string? text, string? now)
    {
        if (string.IsNullOrWhiteSpace(text) || string.IsNullOrWhiteSpace(now)) return false;
        return string.Equals(text.Trim(), now.Trim(), StringComparison.OrdinalIgnoreCase)
            || text.Contains(now, StringComparison.OrdinalIgnoreCase)
            || now.Contains(text, StringComparison.OrdinalIgnoreCase);
    }

    private static string BuildBanner(string prefix, string? period, string? nowTask)
    {
        var main = !string.IsNullOrWhiteSpace(period) ? period : nowTask;
        if (string.IsNullOrWhiteSpace(main)) main = "暂无数据";
        return prefix + "：" + main;
    }

    private static string Truncate(string? s, int max)
    {
        if (string.IsNullOrEmpty(s)) return "（无摘要）";
        if (s.Length <= max) return s;
        return s[..max] + "…";
    }

    private static string FormatSince(string? since)
    {
        if (string.IsNullOrWhiteSpace(since)) return "since —";
        if (DateTimeOffset.TryParse(since, out var dto)) return "since " + dto.LocalDateTime.ToString("HH:mm:ss");
        return "since " + since;
    }

    private void UpdateTodoSummary()
    {
        int total = _todos.Count;
        int done = _todos.Count(t => t.IsChecked);
        int allDone = _plan?.Today?.Tasks?.Count ?? 0;
        TodoSummary.Text = $"已完成 {done} / {total}";
    }

    // =====================================================================
    // “完成当前任务”按钮
    // =====================================================================
    private void CompleteTask_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button { DataContext: TaskCard card } || card.DoneId == null) return;
        _localProgress.SetDone(_todayDate, card.DoneId, true);   // 写共享；失败自动落本地兜底
        SyncProgressHint();
        RenderPlan();   // 任务链自动推进 + 待办同步（勾选自动一致）
    }

    /// <summary>完成当前（第一个未完成）任务，推进任务链；返回是否成功完成了一项。</summary>
    private bool CompleteCurrentTask()
    {
        var tasks = _plan?.Today?.Tasks ?? new List<TodayTask>();
        for (int i = 0; i < tasks.Count; i++)
        {
            var id = TaskId(tasks[i]);
            if (!IsTaskDone(tasks[i]) && !_localProgress.IsDone(_todayDate, id))
            {
                try { _localProgress.SetDone(_todayDate, id, true); }
                catch (IOException) { ShowWriteFail(); return false; }
                RenderPlan();
                return true;
            }
        }
        return false;   // 全部完成
    }

    /// <summary>记录当前任务标题/是否全完成（供自检与 UI 辅助）。</summary>
    private void SetTodayMeta(List<TaskCard> cards)
    {
        var cur = cards.FirstOrDefault(x => x.State == TaskState.Current);
        _currentNowTitle = cur?.Title ?? "";
        _allDone = cards.Count == 1 && cards[0].AllDone;
    }

    private void ShowWriteFail()
    {
        System.Windows.MessageBox.Show("本地勾选进度写入失败，请检查目录写入权限。", "计划悬浮窗",
            System.Windows.MessageBoxButton.OK, System.Windows.MessageBoxImage.Warning);
    }

    // =====================================================================
    // 验收自检：--verify 启动时每 1s 把关键渲染结果写为 exe 同目录 verify.jsonl
    // =====================================================================
    // =====================================================================
    // 边缘吸附 / 折叠 / 展开 / 脱离（QQ 风格）
    // =====================================================================
    private void Window_MouseEnter(object sender, MouseEventArgs e) => _snapper.HandleMouseEnter();
    private void Window_MouseLeave(object sender, MouseEventArgs e) => _snapper.HandleMouseLeave();

    /// <summary>已完全隐藏（整窗出屏 0px 可见）：强制最上层，隐藏主体内容（不可见）。</summary>
    private void OnFolded()
    {
        Topmost = true;
        ContentHost.Visibility = Visibility.Collapsed;
    }

    /// <summary>已展开回贴边原位：保持置顶、恢复主体。</summary>
    private void OnExpanded()
    {
        Topmost = true;
        ContentHost.Visibility = Visibility.Visible;
    }

    /// <summary>已脱离：恢复用户层级、恢复主体。</summary>
    private void OnDetached()
    {
        ContentHost.Visibility = Visibility.Visible;
        ApplyLayerState();
    }

    private static System.Drawing.Point? ParseDragPoint()
    {
        var v = CliOptions.Current?.Get("drag");
        if (string.IsNullOrWhiteSpace(v)) return null;
        var parts = v.Split(',');
        if (parts.Length == 2 && double.TryParse(parts[0], out var x) && double.TryParse(parts[1], out var y))
            return new System.Drawing.Point((int)x, (int)y);
        return null;
    }

    private static int ParseCompleteCount()
    {
        var v = CliOptions.Current?.Get("complete");
        return int.TryParse(v, out var n) && n > 0 ? n : 0;
    }

    private static int? ParseCheckIndex()
    {
        var v = CliOptions.Current?.Get("check");
        return int.TryParse(v, out var idx) ? idx : null;
    }

    private void EmitVerify()
    {
        if (!_verifyEnabled) return;
        try
        {
            var line = new
            {
                t = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"),
                todayItems = (TodayTasks.ItemsSource as IEnumerable<TaskCard>)?.Count() ?? 0,
                todayBanner = TodayStageText.Text,
                weekBanner = WeekStageText.Text,
                totalBanner = OverviewStageText.Text,
                statusPanel = MapState(_status?.Main?.State).key,
                warn = _warn.ToString().ToLowerInvariant(),
                todoDone = _todos.Count(t => t.IsChecked),
                todoTotal = _todos.Count,
                todayDate = _todayDate,
                todayNow = _currentNowTitle,
                todayAllDone = _allDone,
                weekItems = (WeekTasks.ItemsSource as IEnumerable<object>)?.OfType<TaskCard>().Count() ?? 0,
                totalItems = (MilestoneList.ItemsSource as IEnumerable<object>)?.OfType<TaskCard>().Count() ?? 0,
                weekNow = _weekNow,
                totalNow = _totalNow,
                weekCurrent = (WeekTasks.ItemsSource as IEnumerable<object>)?.OfType<TaskCard>().Count(c => c.State == TaskState.Current) ?? 0,
                totalCurrent = (MilestoneList.ItemsSource as IEnumerable<object>)?.OfType<TaskCard>().Count(c => c.State == TaskState.Current) ?? 0,
                snap = _snapper.State.ToString(),
                folded = _snapper.IsFolded,
                winLeft = Math.Round(Left),
                winTop = Math.Round(Top),
                winW = Math.Round(Width),
                winH = Math.Round(Height),
                topmost = Topmost,
                screenW = Math.Round(_snapper.CurrentWorkArea.Width),
                screenH = Math.Round(_snapper.CurrentWorkArea.Height),
            };
            var json = JsonSerializer.Serialize(line);
            File.AppendAllText(Path.Combine(AppContext.BaseDirectory, "verify.jsonl"), json + Environment.NewLine);
        }
        catch { /* 自检失败不影响主流程 */ }
    }

    /// <summary>绑定 Agent 计划(右栏·任务看板同步)。</summary>
    private void BindAgentTasks(PlanState? plan)
    {
        var agent = plan?.AgentPlan;
        var items = new List<AgentTaskView>();
        if (agent?.Tasks != null)
        {
            foreach (var t in agent.Tasks)
            {
                if (string.IsNullOrEmpty(t.Title)) continue;
                var (glyph, status) = AgentStatusFor(t.Zone, t.Status, t.Time);
                var brush = ZoneBrushFor(t.Zone);
                items.Add(new AgentTaskView
                {
                    Title = t.Title,
                    ZoneGlyph = glyph,
                    StatusLabel = status,
                    TimeLabel = string.IsNullOrEmpty(t.Time) ? "" : "⏰ " + t.Time,
                    Zone = t.Zone,
                    ZoneBrush = brush,
                    ZoneBorder = brush,
                });
            }
        }
        AgentTasks.ItemsSource = items;
        AgentMetaText.Text = agent != null
            ? (agent.Tasks?.Count > 0 ? "任务看板同步 · " + agent.Tasks.Count + " 项 · 只读" : "任务看板同步 · 暂无任务")
            : "任务看板未生成 Agent 计划";
    }

    /// <summary>Agent 状态 → 图标/标签(与看板 zone 色系一致)。</summary>
    private (string glyph, string status) AgentStatusFor(string? zone, string? status, string? time)
    {
        var z = zone ?? "";
        return z switch
        {
            "running" => ("●", "运行中"),
            "blocked" => ("●", "受阻"),
            "done" => ("●", "完成"),
            "failed" => ("●", "失败"),
            "todo-scheduled" => ("●", "定时"),
            _ => ("●", "待办"),
        };
    }

    /// <summary>Zone → 彩色圆点(红灯/黄灯/绿灯, 与看板色系一致)。</summary>
    private static System.Windows.Media.SolidColorBrush? ZoneBrushFor(string? zone)
    {
        var color = zone switch
        {
            "running" => "#3b6ef6",
            "blocked" => "#eba01e",
            "done" => "#1ea860",
            "failed" => "#dc3c3c",
            "todo-scheduled" => "#8a93a5",
            _ => "#a0a8b4",
        };
        try
        {
            var conv = new System.Windows.Media.BrushConverter();
            var b = (System.Windows.Media.Brush?)conv.ConvertFromString(color);
            return new System.Windows.Media.SolidColorBrush(((System.Windows.Media.SolidColorBrush)b!).Color);
        }
        catch { return System.Windows.Media.Brushes.Gray; }
    }

}