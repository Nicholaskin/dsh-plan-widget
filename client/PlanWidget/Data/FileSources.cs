using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Windows.Threading;
using PlanWidget.Models;
using PlanWidget.Services;

namespace PlanWidget.Data;

// =====================================================================
// 共享 JSON 反序列化选项：属性名大小写不敏感，匹配文件中的 camelCase。
// =====================================================================
internal static class JsonOpt
{
    public static readonly JsonSerializerOptions Options =
        new() { PropertyNameCaseInsensitive = true };

    // 写共享进度文件用 camelCase（与协议 progress.v1 对齐：$schema / buckets / updatedAt）
    public static readonly JsonSerializerOptions WriteOptions =
        new() { PropertyNameCaseInsensitive = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
}

// =====================================================================
// BOM 安全读取：UTF-8 读 + 自动检测 BOM（默认会剥），再手动剥一手 U+FEFF 兜底。
// 用于所有 JSON 读取点，避免带 BOM 的配置/数据文件导致 System.Text.Json 解析失败。
// =====================================================================
public static class JsonFile
{
    public static string ReadAllText(string path)
    {
        using var sr = new StreamReader(path, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
        return sr.ReadToEnd().TrimStart('\uFEFF');   // 兜底剥离首字符 BOM（若检测遗漏）
    }
}

// =====================================================================
// 原子写工具：temp + rename，避免写到一半损坏目标文件。
// =====================================================================
public static class AtomicFile
{
    public static bool Write(string path, string content)
    {
        try
        {
            var tmp = path + ".tmp";
            File.WriteAllText(tmp, content);
            File.Move(tmp, path, overwrite: true);
            return true;
        }
        catch { return false; }
    }
}

// =====================================================================
// 配置解析：读取/保存 exe 同目录 config.json。源码绝不硬编码绝对路径。
// =====================================================================
public static class ConfigResolver
{
    public static string ConfigPath => Path.Combine(AppContext.BaseDirectory, "config.json");

    public static bool ConfigExists() => File.Exists(ConfigPath);

    public static AppConfig Load()
    {
        bool configMissing = !ConfigExists();
        AppConfig cfg;
        if (!configMissing)
        {
            try { cfg = JsonSerializer.Deserialize<AppConfig>(JsonFile.ReadAllText(ConfigPath), JsonOpt.Options) ?? new AppConfig(); }
            catch { cfg = new AppConfig(); }   // 配置损坏按缺省
        }
        else
        {
            cfg = new AppConfig();
        }
        cfg.ConfigMissing = configMissing;

        // 记录用户原始（未探测）配置值，供"原路径无效"提示
        cfg.OrigPlanStatePath = cfg.PlanStatePath;
        cfg.OrigSessionStatusPath = cfg.SessionStatusPath;

        // 解析显式路径（绝对/相对 exe 目录；可能不存在）
        var explicitSession = Resolve(cfg.SessionStatusPath);
        var explicitPlan = Resolve(cfg.PlanStatePath);
        if (explicitPlan == null && !string.IsNullOrWhiteSpace(cfg.PlanFolder))
        {
            var folder = Resolve(cfg.PlanFolder);
            if (folder != null) explicitPlan = Path.Combine(folder, ".plan-widget", "plan-state.json");
        }

        // 自动探测默认路径（配置缺失或显式路径无效时启用）
        var probeHome = GetProbeHome();
        var pr = ResolveOrProbe(explicitPlan, PlanCandidates(probeHome));
        var sr = ResolveOrProbe(explicitSession, SessionCandidates(probeHome));

        cfg.PlanStatePath = pr.path;
        cfg.SessionStatusPath = sr.path;
        cfg.PlanProbed = pr.probed;
        cfg.SessionProbed = sr.probed;
        cfg.PlanInvalidOrig = explicitPlan != null && pr.probed && explicitPlan != pr.path;
        cfg.SessionInvalidOrig = explicitSession != null && sr.probed && explicitSession != sr.path;

        // 共享进度文件路径（显式 progressPath 优先，其次由 planStatePath 推导，最后回退 exe 目录）
        cfg.ProgressPath = ResolveProgressPath(cfg);

        if (cfg.PollMs < 200 || cfg.PollMs > 60000) cfg.PollMs = 1000;
        if (string.IsNullOrWhiteSpace(cfg.Theme)) cfg.Theme = "Light";
        return cfg;
    }

    public static bool Save(AppConfig cfg)
        => AtomicFile.Write(ConfigPath, JsonSerializer.Serialize(cfg, JsonOpt.Options));

    /// <summary>对一条路径解析+探测：显式路径存在→用之；否则探测候选，命中则采用；未命中则返回原显式值（空→null）。</summary>
    private static (string? path, bool probed) ResolveOrProbe(string? explicitPath, IEnumerable<string> candidates)
    {
        if (!string.IsNullOrWhiteSpace(explicitPath) && File.Exists(explicitPath))
            return (explicitPath, false);
        foreach (var cand in candidates)
            if (File.Exists(cand)) return (cand, true);
        return (explicitPath, false);   // 未命中：保持现有首启向导/缺失提示
    }

    /// <summary>计划文件探测候选：①默认目录 <文档>/计划悬浮窗/.plan-widget/plan-state.json ②exe同级 data ③exe同级 .plan-widget。</summary>
    private static IEnumerable<string> PlanCandidates(string probeHome)
    {
        var exe = AppContext.BaseDirectory;
        // ① 跟随插件用户级配置（.plan-widget-config.json 的 planDir）——插件配置真源，客户端跟随
        var planDir = ReadPlanDirFromUserConfig(probeHome);
        if (!string.IsNullOrWhiteSpace(planDir))
            yield return Path.Combine(planDir, ".plan-widget", "plan-state.json");
        // ②③④ 默认目录 / exe同级 data / exe同级 .plan-widget
        yield return Path.Combine(probeHome, "Documents", "计划悬浮窗", ".plan-widget", "plan-state.json");
        yield return Path.Combine(exe, "data", "plan-state.json");
        yield return Path.Combine(exe, ".plan-widget", "plan-state.json");
    }

    /// <summary>读取插件用户级配置 {probeHome}\.plan-widget-config.json 的 planDir（插件 plan_setup create_default 所写）。</summary>
    /// <remarks><b>红线</b>：.plan-widget-config.json 是<u>插件自身</u>的用户级文件（planDir=用户自己的计划文件夹）；探测该文件与 planDir 一并走 probeHome 隔离；<b>严禁</b>回退/追加任何 .dsh / DSH_HOME / 生产实例目录探测。</remarks>
    private static string? ReadPlanDirFromUserConfig(string probeHome)
    {
        try
        {
            var cfgPath = Path.Combine(probeHome, ".plan-widget-config.json");
            if (!File.Exists(cfgPath)) return null;
            var doc = JsonSerializer.Deserialize<PlanUserConfig>(JsonFile.ReadAllText(cfgPath), JsonOpt.Options);
            return string.IsNullOrWhiteSpace(doc?.PlanDir) ? null : doc.PlanDir;
        }
        catch { return null; }
    }

    private class PlanUserConfig
    {
        public string? PlanDir { get; set; }
    }

    /// <summary>会话状态探测候选：仅 exe同级 data\session-status.json → exe同级 .plan-widget\session-status.json；无 → null。</summary>
    /// <remarks><b>红线</b>：<b>严禁</b>探测 %USERPROFILE%\.dsh（=生产 DSH_HOME 3080）、DSH_HOME、或任何生产实例目录；session 不可用时面板一律显示"无会话状态"。</remarks>
    private static IEnumerable<string> SessionCandidates(string probeHome)
    {
        var exe = AppContext.BaseDirectory;
        yield return Path.Combine(exe, "data", "session-status.json");
        yield return Path.Combine(exe, ".plan-widget", "session-status.json");
    }

    /// <summary>探测根：--test-home=&lt;dir&gt; 优先（测试隔离），再 PLAN_WIDGET_PROBE_HOME 环境变量，最后 %USERPROFILE%。</summary>
    private static string GetProbeHome()
    {
        var testHome = CliOptions.Current?.Get("test-home");
        if (!string.IsNullOrWhiteSpace(testHome)) return testHome;
        var env = Environment.GetEnvironmentVariable("PLAN_WIDGET_PROBE_HOME");
        if (!string.IsNullOrWhiteSpace(env)) return env;
        return Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    }

    /// <summary>共享进度文件路径：显式 progressPath 优先；否则由 planStatePath 推导同目录 progress.json；都无→回退 exe 目录 local-progress.json。</summary>
    private static string ResolveProgressPath(AppConfig cfg)
    {
        var explicitPath = Resolve(cfg.ProgressPath);
        if (explicitPath != null) return explicitPath;
        if (cfg.PlanStatePath != null)
        {
            var dir = Path.GetDirectoryName(cfg.PlanStatePath);
            if (!string.IsNullOrEmpty(dir)) return Path.Combine(dir, "progress.json");
        }
        return Path.Combine(AppContext.BaseDirectory, "local-progress.json");
    }

    // 相对路径按 exe 目录解析；绝对路径原样返回；空返回 null。
    private static string? Resolve(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return null;
        return Path.IsPathRooted(path) ? path : Path.Combine(AppContext.BaseDirectory, path);
    }
}

// =====================================================================
// 计划数据源（文件轮询）。
// =====================================================================
public class FilePlanSource : IPlanSource
{
    private readonly string _path;
    private readonly int _pollMs;
    private DateTime _lastWriteUtc;
    private DispatcherTimer? _timer;
    private Action? _onChange;

    public FilePlanSource(string path, int pollMs = 1000) { _path = path; _pollMs = pollMs; }

    public LoadResult<PlanState> LoadPlanState()
    {
        if (string.IsNullOrWhiteSpace(_path) || !File.Exists(_path))
            return LoadResult<PlanState>.Missing();
        try
        {
            var json = JsonFile.ReadAllText(_path);
            var data = JsonSerializer.Deserialize<PlanState>(json, JsonOpt.Options);
            return data == null ? LoadResult<PlanState>.Corrupt() : LoadResult<PlanState>.Ok(data);
        }
        catch { return LoadResult<PlanState>.Corrupt(); }
    }

    public void Subscribe(Action onChange)
    {
        _onChange = onChange;
        _lastWriteUtc = File.Exists(_path) ? File.GetLastWriteTimeUtc(_path) : DateTime.MinValue;
        _timer ??= new DispatcherTimer(DispatcherPriority.Background, Dispatcher.CurrentDispatcher)
        {
            Interval = TimeSpan.FromMilliseconds(_pollMs)
        };
        _timer.Tick += (_, _) => Poll();
        _timer.Start();
    }

    private void Poll()
    {
        // 文件消失：若此前存在过 → 通知，触发"文件不存在"提示
        if (!File.Exists(_path))
        {
            if (_lastWriteUtc != DateTime.MinValue)
            {
                _lastWriteUtc = DateTime.MinValue;
                _onChange?.Invoke();
            }
            return;
        }
        // 文件重新出现（恢复）→ 通知
        if (_lastWriteUtc == DateTime.MinValue)
        {
            _lastWriteUtc = File.GetLastWriteTimeUtc(_path);
            _onChange?.Invoke();
            return;
        }
        var write = File.GetLastWriteTimeUtc(_path);
        if (write == _lastWriteUtc) return;   // mtime 未变则跳过
        _lastWriteUtc = write;
        _onChange?.Invoke();
    }

    public void Stop() => _timer?.Stop();
}

// =====================================================================
// 会话状态数据源（文件轮询），逻辑同 FilePlanSource。
// =====================================================================
public class FileStatusSource : IStatusSource
{
    private readonly string _path;
    private readonly int _pollMs;
    private DateTime _lastWriteUtc;
    private DispatcherTimer? _timer;
    private Action? _onChange;

    public FileStatusSource(string path, int pollMs = 1000) { _path = path; _pollMs = pollMs; }

    public LoadResult<SessionState> LoadStatus()
    {
        if (string.IsNullOrWhiteSpace(_path) || !File.Exists(_path))
            return LoadResult<SessionState>.Missing();
        try
        {
            var json = JsonFile.ReadAllText(_path);
            var data = JsonSerializer.Deserialize<SessionState>(json, JsonOpt.Options);
            return data == null ? LoadResult<SessionState>.Corrupt() : LoadResult<SessionState>.Ok(data);
        }
        catch { return LoadResult<SessionState>.Corrupt(); }
    }

    public void Subscribe(Action onChange)
    {
        _onChange = onChange;
        _lastWriteUtc = File.Exists(_path) ? File.GetLastWriteTimeUtc(_path) : DateTime.MinValue;
        _timer ??= new DispatcherTimer(DispatcherPriority.Background, Dispatcher.CurrentDispatcher)
        {
            Interval = TimeSpan.FromMilliseconds(_pollMs)
        };
        _timer.Tick += (_, _) => Poll();
        _timer.Start();
    }

    private void Poll()
    {
        // 文件消失：若此前存在过 → 通知，触发"文件不存在"提示
        if (!File.Exists(_path))
        {
            if (_lastWriteUtc != DateTime.MinValue)
            {
                _lastWriteUtc = DateTime.MinValue;
                _onChange?.Invoke();
            }
            return;
        }
        // 文件重新出现（恢复）→ 通知
        if (_lastWriteUtc == DateTime.MinValue)
        {
            _lastWriteUtc = File.GetLastWriteTimeUtc(_path);
            _onChange?.Invoke();
            return;
        }
        var write = File.GetLastWriteTimeUtc(_path);
        if (write == _lastWriteUtc) return;   // mtime 未变则跳过
        _lastWriteUtc = write;
        _onChange?.Invoke();
    }

    public void Stop() => _timer?.Stop();
}
// =====================================================================
// 跨端共享进度：默认写共享文件（planStatePath 同目录 progress.json，协议 progress.v1）；
// 升级为"共享为主 + 本地兜底 + 一次性迁移"。任务id = "text|time"（与待办/完成按钮同源）。
// =====================================================================
public class LocalProgressStore
{
    /// <summary>共享进度文件路径（当真源，与 plan-state.json 同目录）。</summary>
    public string SharedPath { get; }
    /// <summary>本地兜底文件（exe 目录 local-progress.json；旧行为）。</summary>
    public string LocalFallbackPath { get; }

    public Dictionary<string, List<string>> Buckets { get; } = new();
    public bool Corrupt { get; private set; }
    /// <summary>最近一次写共享失败（已落到本地兜底）——供 UI 提示"同步失败，本地暂存"。</summary>
    public bool LastWriteUsedFallback { get; private set; }

    private DateTime _lastSharedMtime = DateTime.MinValue;

    public LocalProgressStore(string sharedPath, string localFallbackPath)
    {
        SharedPath = sharedPath;
        LocalFallbackPath = localFallbackPath;
        Load();
    }

    /// <summary>加载：优先读共享（真源）；缺共享但有旧本地 → 一次性迁移（并集写共享 + 旧文件 .bak）。</summary>
    public void Load()
    {
        Buckets.Clear();
        Corrupt = false;
        if (File.Exists(SharedPath))
        {
            TryLoad(SharedPath);
            _lastSharedMtime = File.GetLastWriteTimeUtc(SharedPath);
        }
        else if (File.Exists(LocalFallbackPath))
        {
            MigrateFromLocal();
        }
    }

    /// <summary>轮询检测共享文件变化；变了则重读并入内存，返回是否有实质变化（供 UI 重渲染）。</summary>
    public bool Reload()
    {
        if (!File.Exists(SharedPath)) return false;
        var m = File.GetLastWriteTimeUtc(SharedPath);
        if (m == _lastSharedMtime) return false;
        _lastSharedMtime = m;
        var before = Snapshot();
        Buckets.Clear();
        TryLoad(SharedPath);
        return before != Snapshot();
    }

    private string Snapshot()
        => string.Join("|", Buckets.OrderBy(kv => kv.Key).Select(kv => kv.Key + ":" + string.Join(",", kv.Value.OrderBy(x => x))));

    public bool IsDone(string date, string id)
        => Buckets.TryGetValue(date, out var list) && list.Contains(id);

    /// <summary>勾选/取消：更新内存 → 写共享；失败 → 落到本地兜底并置 LastWriteUsedFallback。</summary>
    public void SetDone(string date, string id, bool done)
    {
        if (!Buckets.TryGetValue(date, out var list)) { list = new List<string>(); Buckets[date] = list; }
        if (done) { if (!list.Contains(id)) list.Add(id); }
        else { list.Remove(id); }

        LastWriteUsedFallback = false;
        if (SaveShared())
        {
            _lastSharedMtime = File.GetLastWriteTimeUtc(SharedPath);   // 本端写入，避免轮询误判为外部变化
        }
        else
        {
            LastWriteUsedFallback = true;
            SaveLocal();
        }
    }

    private bool TryLoad(string path)
    {
        try
        {
            var doc = JsonSerializer.Deserialize<ProgressDoc>(JsonFile.ReadAllText(path), JsonOpt.Options);
            if (doc?.Buckets == null) return false;
            foreach (var kv in doc.Buckets) Buckets[kv.Key] = kv.Value ?? new List<string>();
            Corrupt = false;
            return true;
        }
        catch { Corrupt = true; Buckets.Clear(); return false; }
    }

    /// <summary>一次性迁移：读旧本地 → 与现有并集 → 写共享 → 旧文件改名 .bak。</summary>
    private void MigrateFromLocal()
    {
        var local = new Dictionary<string, List<string>>();
        try
        {
            var doc = JsonSerializer.Deserialize<ProgressDoc>(JsonFile.ReadAllText(LocalFallbackPath), JsonOpt.Options);
            if (doc?.Buckets != null)
                foreach (var kv in doc.Buckets) local[kv.Key] = kv.Value ?? new List<string>();
        }
        catch { /* 旧文件损坏：忽略，仅迁移可用部分 */ }

        foreach (var kv in local)
        {
            if (!Buckets.TryGetValue(kv.Key, out var list)) { list = new List<string>(); Buckets[kv.Key] = list; }
            foreach (var id in kv.Value) if (!list.Contains(id)) list.Add(id);
        }

        if (SaveShared()) _lastSharedMtime = File.GetLastWriteTimeUtc(SharedPath);
        try { File.Move(LocalFallbackPath, LocalFallbackPath + ".bak", overwrite: true); } catch { }
    }

    private bool SaveShared() => AtomicFile.Write(SharedPath, Serialize());
    private void SaveLocal() => AtomicFile.Write(LocalFallbackPath, Serialize());

    private string Serialize()
    {
        var doc = new ProgressDoc { Schema = "plan-widget/progress.v1", Buckets = Buckets, UpdatedAt = DateTimeOffset.UtcNow.ToString("o") };
        return JsonSerializer.Serialize(doc, JsonOpt.WriteOptions);
    }

    /// <summary>进度文件协议：$schema / buckets / updatedAt（camelCase，键名与协议一致）。</summary>
    private class ProgressDoc
    {
        [JsonPropertyName("$schema")] public string? Schema { get; set; }
        public Dictionary<string, List<string>> Buckets { get; set; } = new();
        public string? UpdatedAt { get; set; }
    }
}