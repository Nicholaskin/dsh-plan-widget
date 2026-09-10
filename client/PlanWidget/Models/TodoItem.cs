using System.ComponentModel;

namespace PlanWidget.Models;

/// <summary>
/// 今日待办清单项。
/// 原型阶段仅保存在内存中；通过 INotifyPropertyChanged
/// 让 UI 在勾选切换时刷新（行删除线、已完成统计等）。
/// </summary>
public class TodoItem : INotifyPropertyChanged
{
    private bool _isChecked;

    /// <summary>待办标题</summary>
    public string Title { get; set; } = "";
    public string? Id { get; set; }

    /// <summary>是否已完成（勾选状态），用于绑定 CheckBox</summary>
    public bool IsChecked
    {
        get => _isChecked;
        set
        {
            _isChecked = value;
            OnPropertyChanged(nameof(IsChecked));
        }
    }

    /// <summary>属性变更通知</summary>
    public event PropertyChangedEventHandler? PropertyChanged;

    private void OnPropertyChanged(string name)
        => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}