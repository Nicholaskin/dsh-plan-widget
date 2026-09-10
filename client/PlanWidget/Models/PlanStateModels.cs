namespace PlanWidget.Models;

// =====================================================================
// 计划状态 DTO：与 samples/plan-state.json（$schema plan-widget/plan-state.v1）
// 字段一一对应（System.Text.Json，PropertyNameCaseInsensitive=true 匹配 camelCase）。
// 所有字段可空，保证解析容错（缺字段不抛异常）。
// =====================================================================

public class PlanState
{
    public string? UpdatedAt { get; set; }
    public string? SourceDir { get; set; }
    public string? Schema { get; set; }
    public Levels? Levels { get; set; }
    public TodayState? Today { get; set; }
    public RawState? Raw { get; set; }
    public List<string>? Warnings { get; set; }
    public AgentPlanBlock? AgentPlan { get; set; }
}

public class AgentPlanBlock
{
    public string? UpdatedAt { get; set; }
    public string? Source { get; set; }
    public List<AgentTask>? Tasks { get; set; }
}

public class AgentTask
{
    public string? Title { get; set; }
    public string? Status { get; set; }
    public string? Zone { get; set; }
    public string? Time { get; set; }
    public string? TargetSession { get; set; }
}

public class Levels
{
    public LevelBlock? Daily { get; set; }
    public LevelBlock? Weekly { get; set; }
    public LevelBlock? Total { get; set; }
}

public class LevelBlock
{
    public string? File { get; set; }
    public PeriodBlock? Period { get; set; }
    public CurrentBlock? Current { get; set; }
    /// <summary>可读标题（如“第2周·判断推理攻坚周”）；无则回退文件名。</summary>
    public string? Title { get; set; }
    /// <summary>分组列表（每周/总览）：按分组顺序渲染。</summary>
    public List<GroupBlock>? Groups { get; set; }
    /// <summary>展平任务列表（每项含 group 标注组名）；groups 缺失时用它兜底。</summary>
    public List<LevelTask>? Tasks { get; set; }
}

/// <summary>分组：heading + 该组任务。</summary>
public class GroupBlock
{
    public string? Heading { get; set; }
    public List<LevelTask>? Tasks { get; set; }
}

/// <summary>层级任务项（levels.<key>.groups[].tasks / tasks）。</summary>
public class LevelTask
{
    public string? Text { get; set; }
    public string? Time { get; set; }
    /// <summary>pending / done / unknown</summary>
    public string? Status { get; set; } = "pending";
    /// <summary>所属组名（展平 tasks 时使用）</summary>
    public string? Group { get; set; }
}

public class PeriodBlock
{
    public string? From { get; set; }
    public string? To { get; set; }
}

public class CurrentBlock
{
    public string? Period { get; set; }
    public TaskTriple? Task { get; set; }
}

public class TaskTriple
{
    public string? Prev { get; set; }
    public string? Now { get; set; }
    public string? Next { get; set; }
}

public class TodayState
{
    public string? Date { get; set; }
    public List<TodayTask> Tasks { get; set; } = new();
    public List<string>? Goals { get; set; }
}

public class TodayTask
{
    public string? Text { get; set; }
    public string? Time { get; set; }
    /// <summary>done / pending（其它值按 pending 处理）</summary>
    public string? Status { get; set; } = "pending";
}

public class RawState
{
    public string? Daily { get; set; }
    public string? Weekly { get; set; }
    public string? Total { get; set; }
}