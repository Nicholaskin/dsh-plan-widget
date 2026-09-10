using PlanWidget.Models;

namespace PlanWidget.Data;

// =====================================================================
// 数据源抽象：正式版支持"任意文件夹"，路径一律由 config.json 注入。
// 读取返回 LoadResult，以便区分"正常 / 文件不存在 / JSON 损坏"做分级容错。
// =====================================================================

/// <summary>读取结果状态（用于分级容错）。</summary>
public enum LoadStatus { Ok, Missing, Corrupt }

/// <summary>带状态的加载结果。</summary>
public class LoadResult<T>
{
    public T? Data { get; init; }
    public LoadStatus Status { get; init; }

    public static LoadResult<T> Ok(T data) => new() { Data = data, Status = LoadStatus.Ok };
    public static LoadResult<T> Missing() => new() { Data = default, Status = LoadStatus.Missing };
    public static LoadResult<T> Corrupt() => new() { Data = default, Status = LoadStatus.Corrupt };
}

/// <summary>计划数据源。</summary>
public interface IPlanSource
{
    /// <summary>读取当前计划状态，返回带状态的加载结果。</summary>
    LoadResult<PlanState> LoadPlanState();
    /// <summary>订阅数据变化（轮询检测到文件变更时回调）。</summary>
    void Subscribe(Action onChange);
    /// <summary>停止轮询（供热重载释放旧定时器）。</summary>
    void Stop();
}

/// <summary>会话状态数据源。</summary>
public interface IStatusSource
{
    /// <summary>读取当前会话状态，返回带状态的加载结果。</summary>
    LoadResult<SessionState> LoadStatus();
    /// <summary>订阅数据变化。</summary>
    void Subscribe(Action onChange);
    /// <summary>停止轮询。</summary>
    void Stop();
}

/// <summary>
/// 运行时配置：从 exe 同目录 config.json 读取（用户可注入的运行时参数）。
/// 支持"计划文件夹"或"计划状态文件"两种表达；主题/状态面板默认开关也在此持久化。
/// </summary>
public class AppConfig
{
    /// <summary>计划文件夹（可选）：若设置，则计划文件为 &lt;folder&gt;\.plan-widget\plan-state.json</summary>
    public string? PlanFolder { get; set; }
    /// <summary>计划状态文件路径（可选）：优先于 PlanFolder。</summary>
    public string? PlanStatePath { get; set; }
    /// <summary>会话状态文件路径。</summary>
    public string? SessionStatusPath { get; set; }
    /// <summary>共享进度文件路径（可选）：不设则由 planStatePath 推导同目录 progress.json。</summary>
    public string? ProgressPath { get; set; }

    // ---- 自动探测状态（运行时产生，供设置窗显示） ----
    /// <summary>config.json 文件本身缺失（首启）。</summary>
    public bool ConfigMissing { get; set; }
    /// <summary>计划文件是否由自动探测采用。</summary>
    public bool PlanProbed { get; set; }
    /// <summary>会话状态文件是否由自动探测采用。</summary>
    public bool SessionProbed { get; set; }
    /// <summary>原配置的计划路径无效（已被自动发现替代，或探测未命中）。</summary>
    public bool PlanInvalidOrig { get; set; }
    /// <summary>原配置的会话状态路径无效。</summary>
    public bool SessionInvalidOrig { get; set; }
    /// <summary>配置中原始的计划路径（未探测前），供“原路径无效”提示。</summary>
    public string? OrigPlanStatePath { get; set; }
    /// <summary>配置中原始的会话状态路径。</summary>
    public string? OrigSessionStatusPath { get; set; }
    /// <summary>轮询间隔毫秒（200-60000）。</summary>
    public int PollMs { get; set; } = 1000;
    /// <summary>主题：Light / Dark。</summary>
    public string? Theme { get; set; } = "Light";
    /// <summary>启动时是否默认展开会话状态面板。</summary>
    public bool StartupShowSession { get; set; }
    /// <summary>是否启用边缘吸附+折叠（QQ 风格）；默认 true。</summary>
    public bool SnapEnabled { get; set; } = true;

    // ---- 窗口位置/尺寸持久化（null=未保存，使用默认右下布局） ----
    /// <summary>窗口 Left（DIP）。</summary>
    public double? WinLeft { get; set; }
    /// <summary>窗口 Top（DIP）。</summary>
    public double? WinTop { get; set; }
    /// <summary>窗口宽度（DIP）。</summary>
    public double? WinWidth { get; set; }
    /// <summary>窗口高度（DIP）。</summary>
    public double? WinHeight { get; set; }

    /// <summary>是否已配置计划文件路径（用于判断是否首启需弹设置）。</summary>
    public bool IsConfigured => !string.IsNullOrWhiteSpace(PlanStatePath);
}