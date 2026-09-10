namespace PlanWidget.Models;

// =====================================================================
// 会话状态 DTO：与 samples/session-status.json（$schema plan-widget/session-status.v1）
// 字段一一对应（System.Text.Json）。
// =====================================================================

public class SessionState
{
    public string? UpdatedAt { get; set; }
    public InstanceInfo? Instance { get; set; }
    public MainSession? Main { get; set; }
    public List<HistoryItem>? History { get; set; }
}

public class InstanceInfo
{
    public int? Port { get; set; }
    public string? DshHome { get; set; }
    public string? Name { get; set; }
}

public class MainSession
{
    public string? SessionId { get; set; }
    /// <summary>working / idle / done / waiting；未知值映射为 idle。</summary>
    public string? State { get; set; }
    public string? Since { get; set; }
    public SessionReasons? Reasons { get; set; }
    public LatestText? Latest { get; set; }
}

public class SessionReasons
{
    public bool? TurnOpen { get; set; }
    public string? LastEventType { get; set; }
}

public class LatestText
{
    public string? Text { get; set; }
}

public class HistoryItem
{
    public string? At { get; set; }
    public string? State { get; set; }
}