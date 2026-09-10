namespace PlanWidget.Services;

/// <summary>
/// 命令行参数统一解析：兼容 --key value 与 --key=value 两种形式。
/// 已知布尔旗标：create-shortcut / verify / detach / expand；已知取值参数：shortcut-dir / test-home / check / complete / drag。
/// 未知参数 / 取值缺失会记录到 Unknowns / MissingValues，供调用方 stderr 告警 + 非零码退出。
/// </summary>
public class CliOptions
{
    public static CliOptions? Current { get; private set; }

    /// <summary>解析并设为当前（App.OnStartup 最先调用）。</summary>
    public static CliOptions ParseOrCurrent(string[] args)
    {
        Current = Parse(args);
        return Current;
    }

    private static readonly HashSet<string> _flags = new() { "create-shortcut", "verify", "detach", "expand" };
    private static readonly HashSet<string> _values = new() { "shortcut-dir", "test-home", "check", "complete", "drag" };

    public HashSet<string> Flags { get; } = new();
    public Dictionary<string, string> Values { get; } = new();
    public List<string> Unknowns { get; } = new();
    public List<string> MissingValues { get; } = new();

    public bool HasFlag(string key) => Flags.Contains(key);
    public string? Get(string key) => Values.TryGetValue(key, out var v) ? v : null;
    public bool HasUnknown => Unknowns.Count > 0;
    public bool HasMissingValue => MissingValues.Count > 0;

    public static CliOptions Parse(string[] args)
    {
        var o = new CliOptions();
        for (int i = 0; i < args.Length; i++)
        {
            var a = args[i];
            if (string.IsNullOrEmpty(a) || !a.StartsWith("--")) continue;   // 非自定义参数（首参为程序路径等）忽略

            string key; string value; bool hasValue;
            int eq = a.IndexOf('=');
            if (eq >= 0) { key = a.Substring(2, eq - 2); value = a.Substring(eq + 1); hasValue = true; }
            else { key = a.Substring(2); value = ""; hasValue = false; }

            if (_flags.Contains(key))
            {
                if (hasValue) o.Unknowns.Add(a);   // 旗标不该带值
                else o.Flags.Add(key);
                continue;
            }
            if (_values.Contains(key))
            {
                if (hasValue) o.Values[key] = value;
                else if (i + 1 < args.Length && !args[i + 1].StartsWith("--"))
                    o.Values[key] = args[++i];      // --key value（空格形式，值为下一 token）
                else
                    o.MissingValues.Add(key);       // --key 后无值 → 缺失
                continue;
            }
            o.Unknowns.Add(a);
        }
        return o;
    }
}