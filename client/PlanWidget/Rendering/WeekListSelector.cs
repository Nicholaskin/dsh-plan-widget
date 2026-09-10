using System.Windows;
using System.Windows.Controls;
using PlanWidget.Models;

namespace PlanWidget.Rendering;

/// <summary>
/// 周/总览页模板选择器：GroupHeader→分组标题模板；TaskCard→任务卡模板（done 灰显/当前高亮）；
/// Milestone→里程碑模板（总览旧数据三节点回退）。
/// </summary>
public class WeekListSelector : DataTemplateSelector
{
    public DataTemplate? GroupHeader { get; set; }
    public DataTemplate? TaskCard { get; set; }
    public DataTemplate? Milestone { get; set; }

    public override DataTemplate? SelectTemplate(object item, DependencyObject container)
        => item is GroupHeader ? GroupHeader
           : item is Milestone ? Milestone
           : TaskCard;
}