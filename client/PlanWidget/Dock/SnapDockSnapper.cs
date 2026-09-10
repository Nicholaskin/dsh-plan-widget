using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;

namespace PlanWidget.Dock;

/// <summary>
/// 边缘吸附 + 完全隐藏 + 自动展开 + 脱离 状态机（QQ 风格，修订：完全隐藏 + 边缘碰撞）。
/// 修订1：折叠后窗口完全移出屏幕（0px 可见），仅凭"屏幕边缘条带"检测展开。
/// 修订2：拖动期间窗口每边至少保留 24px（边缘碰撞钳制）；吸附判定改为相交判定（更鲁棒）。
/// 对外：OnDragBegin/OnDragEnd（拖动接入）、HandleMouseEnter/HandleMouseLeave、
///       TickCursorProximity（100ms 轮询）、Start/Stop；事件 Folded/Expanded/Detached。
/// </summary>
public class SnapDockSnapper
{
    public enum DockState { None, Left, Right, Top, Bottom, TopLeft, TopRight, BottomLeft, BottomRight }

    // ---- 阈值（与规格一致） ----
    public const double MinVisible = 24;      // 拖动期间窗口每边最少保留的可见 px（边缘碰撞）
    public const double EdgeBand = 28;        // 展开检测：屏幕边缘条带宽度
    public const int FoldDelayMs = 600;       // 贴边稳定多久后完全隐藏
    public const int CollapseDelayMs = 800;   // 鼠标离开窗口体/条带后多久重新隐藏
    public const int AnimMs = 150;            // 折叠/展开动画时长

    public bool Enabled { get; set; } = true;
    public DockState State { get; private set; } = DockState.None;
    public bool IsFolded { get; private set; }
    public bool IsDocked => State != DockState.None;

    private readonly Window _window;
    private readonly DispatcherTimer _foldTimer;
    private readonly DispatcherTimer _collapseTimer;
    private readonly DispatcherTimer _proximityTimer;
    private bool _mouseInside;
    private bool _isUserDrag;   // 仅在"用户拖动中"才做边缘碰撞钳制
    private double _scale = 1.0;

    public event Action? Folded;
    public event Action? Expanded;
    public event Action? Detached;

    public SnapDockSnapper(Window window)
    {
        _window = window;

        _foldTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(FoldDelayMs) };
        _foldTimer.Tick += (_, _) =>
        {
            _foldTimer.Stop();
            if (IsDocked && !IsFolded && !CursorOverWindow()) Fold();
        };
        _collapseTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(CollapseDelayMs) };
        _collapseTimer.Tick += (_, _) =>
        {
            _collapseTimer.Stop();
            if (IsDocked && !IsFolded && !CursorNear()) Fold();
        };
        _proximityTimer = new DispatcherTimer(DispatcherPriority.Background) { Interval = TimeSpan.FromMilliseconds(100) };
        _proximityTimer.Tick += (_, _) => TickCursorProximity();

        // 拖动中监听位置变化，做边缘碰撞钳制
        _window.LocationChanged += (_, _) => { if (_isUserDrag) ClampToScreen(); };
    }

    public void Start() { if (Enabled) _proximityTimer.Start(); }
    public void Stop()  { _proximityTimer.Stop(); _foldTimer.Stop(); _collapseTimer.Stop(); }

    // =====================================================================
    // 拖动接入 + 边缘碰撞钳制
    // =====================================================================
    public void OnDragBegin()
    {
        if (!Enabled) return;
        _isUserDrag = true;
        if (IsDocked) Detach();
    }

    public void OnDragEnd()
    {
        if (!Enabled) return;
        _isUserDrag = false;
        TrySnap();
    }

    /// <summary>拖动中钳制：窗口每边至少保留 MinVisible px 在屏幕内（不能完全拖出屏幕）。</summary>
    private void ClampToScreen()
    {
        var wa = GetMouseWorkArea();
        double w = _window.Width, h = _window.Height;
        double minL = wa.Left - (w - MinVisible);
        double maxL = wa.Right - MinVisible;
        double minT = wa.Top - (h - MinVisible);
        double maxT = wa.Bottom - MinVisible;
        double l = _window.Left, t = _window.Top;
        double cl = Math.Clamp(l, Math.Min(minL, maxL), Math.Max(minL, maxL));
        double ct = Math.Clamp(t, Math.Min(minT, maxT), Math.Max(minT, maxT));
        if (Math.Abs(cl - l) > 0.01) _window.Left = cl;
        if (Math.Abs(ct - t) > 0.01) _window.Top = ct;
    }

    // =====================================================================
    // 吸附（相交判定，更鲁棒）
    // =====================================================================
    private void TrySnap()
    {
        if (!Enabled) { State = DockState.None; return; }
        var wa = GetWorkArea();
        double l = _window.Left, t = _window.Top, w = _window.Width, h = _window.Height;

        bool nearL = l < wa.Left + MinVisible && l + w > wa.Left;
        bool nearR = (l + w) > wa.Right - MinVisible && l < wa.Right;
        bool nearT = t < wa.Top + MinVisible && t + h > wa.Top;
        bool nearB = (t + h) > wa.Bottom - MinVisible && t < wa.Bottom;

        if (!nearL && !nearR && !nearT && !nearB) { State = DockState.None; return; }

        double tx = l, ty = t;
        if (nearL) tx = wa.Left; else if (nearR) tx = wa.Right - w;
        if (nearT) ty = wa.Top; else if (nearB) ty = wa.Bottom - h;

        State = (nearL, nearR, nearT, nearB) switch
        {
            (true, false, true, false)  => DockState.TopLeft,
            (true, false, false, true)  => DockState.BottomLeft,
            (false, true, true, false)  => DockState.TopRight,
            (false, true, false, true)  => DockState.BottomRight,
            (true, false, false, false) => DockState.Left,
            (false, true, false, false) => DockState.Right,
            (false, false, true, false) => DockState.Top,
            (false, false, false, true) => DockState.Bottom,
            _ => DockState.None
        };

        _window.Left = tx; _window.Top = ty;
        if (IsFolded) return;
        _foldTimer.Stop(); _foldTimer.Start();
    }

    // =====================================================================
    // 折叠（完全隐藏：整窗移出屏幕）/ 展开 / 脱离
    // =====================================================================
    public void Fold()
    {
        if (!Enabled || State == DockState.None || IsFolded) return;
        bool left = State is DockState.Left or DockState.TopLeft or DockState.BottomLeft;
        bool right = State is DockState.Right or DockState.TopRight or DockState.BottomRight;
        bool top = State is DockState.Top or DockState.TopLeft or DockState.TopRight;
        bool bottom = State is DockState.Bottom or DockState.BottomLeft or DockState.BottomRight;

        var wa = GetWorkArea();
        // 完全隐藏：多滑 16px 确保 0px 可见（规避 ActualWidth/DPI 舍入与窗口宽度波动）
        double tx = left ? wa.Left - _window.Width - 16 : right ? wa.Right + 16 : _window.Left;
        double ty = top ? wa.Top - _window.Height - 16 : bottom ? wa.Bottom + 16 : _window.Top;

        IsFolded = true;
        _collapseTimer.Stop();
        AnimateTo(tx, ty);
        Folded?.Invoke();
    }

    public void Expand()
    {
        if (!Enabled || !IsFolded) return;
        var (dx, dy) = DockPosition(GetWorkArea());
        IsFolded = false;
        AnimateTo(dx, dy);
        _foldTimer.Stop();
        Expanded?.Invoke();
    }

    public void Detach()
    {
        IsFolded = false;
        State = DockState.None;
        _foldTimer.Stop(); _collapseTimer.Stop(); _mouseInside = false;
        StopAnimations();
        Detached?.Invoke();
    }

    // =====================================================================
    // 鼠标进入/离开（辅助；主要靠边缘条带定时检测）
    // =====================================================================
    public void HandleMouseEnter()
    {
        if (Enabled && IsFolded) Expand();
    }

    public void HandleMouseLeave()
    {
        if (Enabled && IsDocked && !IsFolded)
        {
            _mouseInside = false;
            _collapseTimer.Stop();
            _collapseTimer.Start();
        }
    }

    // =====================================================================
    // 光标接近检测（定时器）：折叠态→条带命中则展开；展开态→离开窗口体且不入条带 800ms 则折叠
    // =====================================================================
    public void TickCursorProximity()
    {
        if (!Enabled || State == DockState.None) return;
        var pos = ToDip(System.Windows.Forms.Cursor.Position);
        var wa = GetWorkArea();
        bool inBand = BandHit(pos, wa, State);

        if (IsFolded)
        {
            if (inBand) Expand();
        }
        else
        {
            bool over = new Rect(_window.Left, _window.Top, _window.Width, _window.Height).Contains(pos);
            if (over || inBand) { _mouseInside = true; _collapseTimer.Stop(); }
            else if (_mouseInside) { _mouseInside = false; _collapseTimer.Start(); }
        }
    }

    /// <summary>吸附边的屏幕边缘条带（0~EdgeBand 宽）；四角=两方向条带合并（任一命中即可）。</summary>
    private static bool BandHit(Point p, Rect wa, DockState st)
    {
        bool left = st is DockState.Left or DockState.TopLeft or DockState.BottomLeft;
        bool right = st is DockState.Right or DockState.TopRight or DockState.BottomRight;
        bool top = st is DockState.Top or DockState.TopLeft or DockState.TopRight;
        bool bottom = st is DockState.Bottom or DockState.BottomLeft or DockState.BottomRight;
        if (left && new Rect(wa.Left, wa.Top, EdgeBand, wa.Height).Contains(p)) return true;
        if (right && new Rect(wa.Right - EdgeBand, wa.Top, EdgeBand, wa.Height).Contains(p)) return true;
        if (top && new Rect(wa.Left, wa.Top, wa.Width, EdgeBand).Contains(p)) return true;
        if (bottom && new Rect(wa.Left, wa.Bottom - EdgeBand, wa.Width, EdgeBand).Contains(p)) return true;
        return false;
    }

    private bool CursorOverWindow()
    {
        var p = ToDip(System.Windows.Forms.Cursor.Position);
        return new Rect(_window.Left, _window.Top, _window.Width, _window.Height).Contains(p);
    }

    private bool CursorNear() => CursorOverWindow() || BandHit(ToDip(System.Windows.Forms.Cursor.Position), GetWorkArea(), State);

    // =====================================================================
    // 位置/动画/DIP/多屏 辅助
    // =====================================================================
    private (double, double) DockPosition(Rect wa)
    {
        double tx = _window.Left, ty = _window.Top, w = _window.Width, h = _window.Height;
        bool left = State is DockState.Left or DockState.TopLeft or DockState.BottomLeft;
        bool right = State is DockState.Right or DockState.TopRight or DockState.BottomRight;
        bool top = State is DockState.Top or DockState.TopLeft or DockState.TopRight;
        bool bottom = State is DockState.Bottom or DockState.BottomLeft or DockState.BottomRight;
        if (left) tx = wa.Left; if (right) tx = wa.Right - w;
        if (top) ty = wa.Top; if (bottom) ty = wa.Bottom - h;
        return (tx, ty);
    }

    private void AnimateTo(double x, double y)
    {
        double fromX = _window.Left;
        double fromY = _window.Top;
        var dur = TimeSpan.FromMilliseconds(AnimMs);
        _window.Left = x; _window.Top = y;   // 基值设为终点，动画结束后保持不变
        var ease = new QuadraticEase { EasingMode = EasingMode.EaseOut };
        _window.BeginAnimation(Window.LeftProperty, new DoubleAnimation(fromX, x, dur) { FillBehavior = FillBehavior.Stop, EasingFunction = ease });
        _window.BeginAnimation(Window.TopProperty, new DoubleAnimation(fromY, y, dur) { FillBehavior = FillBehavior.Stop, EasingFunction = ease });
    }

    private void StopAnimations()
    {
        _window.BeginAnimation(Window.LeftProperty, null);
        _window.BeginAnimation(Window.TopProperty, null);
    }

    private Rect GetWorkArea()
    {
        RefreshDpi();
        try
        {
            var hwnd = new WindowInteropHelper(_window).Handle;
            if (hwnd != IntPtr.Zero)
            {
                var wa = System.Windows.Forms.Screen.FromHandle(hwnd).WorkingArea;
                return new Rect(wa.Left / _scale, wa.Top / _scale, wa.Width / _scale, wa.Height / _scale);
            }
        }
        catch { /* 回退主屏工作区 */ }
        var sw = SystemParameters.WorkArea;
        return new Rect(sw.Left, sw.Top, sw.Width, sw.Height);
    }

    /// <summary>拖动钳制用：鼠标当前所在屏幕的工作区（多屏按鼠标 Screen）。</summary>
    private Rect GetMouseWorkArea()
    {
        RefreshDpi();
        try
        {
            var sc = System.Windows.Forms.Screen.FromPoint(System.Windows.Forms.Cursor.Position);
            var wa = sc.WorkingArea;
            return new Rect(wa.Left / _scale, wa.Top / _scale, wa.Width / _scale, wa.Height / _scale);
        }
        catch { var sw = SystemParameters.WorkArea; return new Rect(sw.Left, sw.Top, sw.Width, sw.Height); }
    }

    private void RefreshDpi()
    {
        try { _scale = Math.Max(0.5, VisualTreeHelper.GetDpi(_window).DpiScaleX); }
        catch { _scale = 1.0; }
    }

    private Point ToDip(System.Drawing.Point p) => new Point(p.X / _scale, p.Y / _scale);

    // ---- 供自检/验收读取 ----
    public Rect CurrentWorkArea => GetWorkArea();
}