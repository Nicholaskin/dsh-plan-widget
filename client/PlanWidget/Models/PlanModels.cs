using System.Windows;

namespace PlanWidget.Models;

/// <summary>
/// 任务卡片/里程碑的通用状态。
/// 今日、本周、总览三页共用同一套状态枚举，方便统一展示样式。
/// </summary>
public enum TaskState
{
    /// <summary>已完成（历史项，淡显 + ✓）</summary>
    Done,
    /// <summary>当前所处（高亮强调）</summary>
    Current,
    /// <summary>下一项（紧随当前，普通态）</summary>
    Next,
    /// <summary>后续待开始（淡显）</summary>
    Pending
}

/// <summary>
/// 任务卡片数据（今日/本周共用同一结构）。
/// 展示用属性（StateLabel、StateGlyph）为只读计算属性，
/// 方便 XAML DataTemplate 直接绑定，避免在视图层写转换器。
/// </summary>
/// <summary>分组标题视图项（周/总览全列表用）</summary>
public class GroupHeader
{
    public string Heading { get; set; } = "";
}

public class TaskCard
{
    /// <summary>任务标题，如 "资料分析·混合增长率"</summary>
    public string Title { get; set; } = "";
    /// <summary>时间/阶段辅助文案，如 "09:00-12:00" 或 "周三"</summary>
    public string TimeRange { get; set; } = "";
    /// <summary>当前状态</summary>
    public TaskState State { get; set; } = TaskState.Pending;

    /// <summary>完成按钮用的稳定 id（text|time，与待办 TodoItem.Id 同源）</summary>
    public string? DoneId { get; set; }
    /// <summary>全部完成祝贺态</summary>
    public bool AllDone { get; set; }
    /// <summary>是否显示“完成”按钮（今日页=true；周/总览全列表=false=只读）</summary>
    public bool ShowComplete { get; set; } = true;
    /// <summary>“完成”按钮可见性（仅当前未完成卡、非全完成态、且非只读）</summary>
    public Visibility CompleteVisibility => (State == TaskState.Current && ShowComplete && !AllDone) ? Visibility.Visible : Visibility.Collapsed;
    /// <summary>“完成”按钮是否可用（非只读且非全完成态）</summary>
    public bool CanComplete => ShowComplete && !AllDone;

    /// <summary>状态中文文案（用于卡片右侧标签）</summary>
    public string StateLabel => State switch
    {
        TaskState.Done    => "已完成",
        TaskState.Current => "进行中",
        TaskState.Next    => "下一项",
        _                 => "待开始"
    };
    /// <summary>状态图标字符（用于卡片左侧圆形徽标）</summary>
    public string StateGlyph => State switch
    {
        TaskState.Done    => "✓",
        TaskState.Current => "▶",
        TaskState.Next    => "○",
        _                 => "·"
    };
}

/// <summary>
/// 今日页顶部"时段条"数据，表示一天中的一段（如上午/下午/晚上）。
/// IsCurrent 标记当前所处时段，用于高亮。
/// </summary>
public class TimeSlot
{
    /// <summary>时段范围，如 "09:00-12:00"</summary>
    public string TimeRange { get; set; } = "";
    /// <summary>时段主题，如 "资料分析"</summary>
    public string Title { get; set; } = "";
    /// <summary>是否为当前所处时段</summary>
    public bool IsCurrent { get; set; }
}

/// <summary>
/// 总览页里程碑数据，用于展示整体大计划的阶段进度。
/// </summary>
public class Milestone
{
    /// <summary>阶段名称，如 "刷题强化（9月-10月）"</summary>
    public string Name { get; set; } = "";
    /// <summary>阶段说明，如 "重点突破高频题型"</summary>
    public string Detail { get; set; } = "";
    /// <summary>阶段状态（Done/Current/Pending）</summary>
    public TaskState State { get; set; } = TaskState.Pending;
    /// <summary>阶段时间，如 "9月-10月"</summary>
    public string DateText { get; set; } = "";
    /// <summary>状态图文字符（复用 TaskCard 的显示逻辑）</summary>
    public string StateGlyph => State switch
    {
        TaskState.Done    => "✓",
        TaskState.Current => "▶",
        TaskState.Pending => "·",
        _                 => "·"
    };
}

/// <summary>Agent 任务渲染视图(右栏)</summary>
public class AgentTaskView
{
    public required string Title { get; init; }
    public required string ZoneGlyph { get; init; }
    public required string StatusLabel { get; init; }
    public required string TimeLabel { get; init; }
    public string? Zone { get; init; }
    /// <summary>状态圆点色(WPF Brush, 红/黄/绿/蓝/灰)</summary>
    public System.Windows.Media.SolidColorBrush? ZoneBrush { get; init; }
    /// <summary>状态色边框(卡边, 可选)</summary>
    public System.Windows.Media.SolidColorBrush? ZoneBorder { get; init; }
}