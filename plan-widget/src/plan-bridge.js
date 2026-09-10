// =============================================================================
// plan-bridge.js —— 计划悬浮窗插件「计划桥」模块
//
// 职责：读取用户的计划悬浮窗文件夹（Markdown 计划文件），解析出可执行任务与目标，
//       汇总为「快照协议 v1」JSON（客户端已按该 schema 渲染），并写入磁盘。
//
// 要点：
//  - 纯 Node.js ESM（Node >= 20），零第三方依赖（不用 chokidar，只用 node:fs 原生）。
//  - 复用 GATE-2 验证过的那套解析逻辑（层级识别/任务解析/时间提取/容错）。
//  - 基线 = 「精确可执行任务」为主线（带排期时间或完成标记的任务）；
//    纯文本目标（无状态、无时间的列表项）归入 goals（“今日目标”折叠数据）。
//  - fs.watch(planDir, { recursive: false }) + 300ms 防抖 -> syncNow()。
//  - 目录不存在、单文件解析失败等均为容错路径，不抛异常，只写 warnings。
//  - 源码零硬编码路径；路径全部来自 options 参数。
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = 'plan-widget/plan-state.v1';
const RAW_LIMIT = 2000;
const DEFAULT_EXCLUDE = ['复盘', '模板', '讲义', '答案', '错题', '课程要点'];
const WATCH_DEBOUNCE_MS = 300;

function pad2(n) { return String(n).padStart(2, '0'); }
function fmtYMD(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); }

// 规范化「参考日期」输入：Date 对象、YYYY-MM-DD 字符串、或 undefined（取当日）
function toYMD(ref) {
  if (ref instanceof Date && !Number.isNaN(ref.getTime())) {
    return { year: ref.getFullYear(), month: ref.getMonth() + 1, day: ref.getDate() };
  }
  if (typeof ref === 'string') {
    const m = ref.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return { year: +m[1], month: +m[2], day: +m[3] };
  }
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

// 层级识别（按文件名 -> daily / weekly / total / other）
function detectLevel(name, content) {
  if (/^\d{1,2}月\d{1,2}日.*(执行总览|执行卡|执行|安排|当日复盘|日程)/i.test(name)) return 'daily';
  if (/^\d{1,2}\/\d{1,2}.*(执行总览|执行卡|执行|安排|当日复盘|日程)/i.test(name)) return 'daily';
  if (/(本周|下周|上周)计划-/.test(name)) return 'weekly';
  if (/第\d+周计划/.test(name)) return 'weekly';
  if (/周计划模板/.test(name)) return 'weekly';
  if (/周计划/.test(name) && /(至|~|—|到|\d{4}-\d{2}-\d{2})/.test(name)) return 'weekly';
  if (/国考复习计划|总计划|复习计划与每日打卡/.test(name)) return 'total';
  if (/(2026国考|国考复习计划|总复习计划|复习计划与每日打卡)/i.test(content) && /目标|阶段/.test(content)) return 'total';
  return 'other';
}

// 周期解析（文件名 -> {from, to}）
function extractDate(fileName, year) {
  let m = fileName.match(/(\d{1,2})月(\d{1,2})日/);
  if (m) return { year, month: +m[1], day: +m[2] };
  m = fileName.match(/(\d{1,2})\/(\d{1,2})\b/);
  if (m) return { year, month: +m[1], day: +m[2] };
  return null;
}
function extractRange(fileName, year) {
  const m = fileName.match(/(\d{4})[年-](\d{1,2})[月-](\d{1,2})日?\s*(?:至|~|—|到)\s*(\d{1,2})[月-](\d{1,2})日?/);
  if (m) return { from: m[1] + '-' + pad2(m[2]) + '-' + pad2(m[3]), to: m[1] + '-' + pad2(m[4]) + '-' + pad2(m[5]) };
  const m2 = fileName.match(/(\d{1,2})月(\d{1,2})日?-\s*(\d{1,2})月(\d{1,2})日?/);
  if (m2) return { from: year + '-' + pad2(+m2[1]) + '-' + pad2(+m2[2]), to: year + '-' + pad2(+m2[3]) + '-' + pad2(+m2[4]) };
  const m3 = fileName.match(/(\d{1,2})\/(\d{1,2})\s*-\s*(\d{1,2})\/(\d{1,2})/);
  if (m3) return { from: year + '-' + pad2(+m3[1]) + '-' + pad2(+m3[2]), to: year + '-' + pad2(+m3[3]) + '-' + pad2(+m3[4]) };
  return null;
}
function detectPeriod(fileName, year) {
  const rng = extractRange(fileName, year);
  if (rng) return rng;
  const d = extractDate(fileName, year);
  if (d) return { from: fmtYMD(d.year, d.month, d.day), to: null };
  return { from: null, to: null };
}

// 时间提取
function extractTime(text) {
  if (!text) return null;
  const range = text.match(/(\d{1,2})[:：](\d{2})\s*[-~—–至到]\s*(\d{1,2})[:：](\d{2})/);
  if (range) return { start: pad2(+range[1]) + ':' + range[2], end: pad2(+range[3]) + ':' + range[4] };
  const single = text.match(/\b(\d{1,2})[:：](\d{2})\b/);
  if (single) return { start: pad2(+single[1]) + ':' + single[2], end: null };
  const period = text.match(/(上午|下午|晚上|清晨|中午|晚间|夜间|睡前)/);
  if (period) return { start: period[1], end: null };
  return null;
}
function hasExplicitTime(text) { return /\d{1,2}[:：]\d{2}/.test(text); }
function fmtTime(t) { return (t && t.start) ? (t.end ? (t.start + '-' + t.end) : t.start) : null; }
function timeSortKey(t) {
  if (t && t.start) {
    const mm = t.start.match(/^(\d{1,2}):(\d{2})$/);
    if (mm) return (+mm[1]) * 60 + (+mm[2]);
    const P = { 清晨: 120, 上午: 420, 中午: 720, 下午: 840, 晚间: 1140, 晚上: 1140, 夜间: 1200, 睡前: 1320 };
    if (P[t.start] != null) return P[t.start];
  }
  return 24 * 60 + 100000;
}

// 任务标题清洗
function cleanTitle(text) {
  let t = (text || '').trim();
  t = t.replace(/\[[ xX]\]/g, ' ');
  t = t.replace(/^\s*(\d{1,3})[.、)]\s*/, '');
  t = t.replace(/\d{1,2}[:：]\d{2}\s*[-~—–至到]\s*\d{1,2}[:：]\d{2}/g, ' ');
  t = t.replace(/\d{1,2}[:：]\d{2}/g, ' ');
  t = t.replace(/\*\*/g, '');
  t = t.replace(/[\s·•\-~—–]+$/g, '');
  return t.trim();
}

// 列表项解析
function parseListLine(line) {
  let status = null, body = null, matched = false;
  let m = line.match(/^\s*[-*+]?\s*\[([ xX])\]\s*(.*)$/);
  if (m) { matched = true; status = (m[1] === ' ' || m[1] === '') ? 'pending' : 'done'; body = m[2]; }
  else {
    m = line.match(/^\s*(?:[-*+]\s*)?\d{1,3}[.、)]\s*(.*)$/);
    if (m && m[1] && m[1].trim()) { matched = true; body = m[1]; status = null; }
    else {
      m = line.match(/^\s*[-*+]\s+(.+)$/);
      if (m && m[1].trim()) { matched = true; body = m[1]; status = null; }
    }
  }
  if (!matched) return null;
  return { status, body: body.trim() };
}

// 表格处理
function splitCells(row) {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map(c => c.trim());
}
function isSepRow(row) { const c = splitCells(row); return c.length > 0 && c.every(x => /^\s*:?-{2,}:?\s*$/.test(x)); }

function processTableBlock(rows, currentHeading, ensureGroup) {
  // B1：整表排除——表头任意单元格含 作息|模板|参考|说明 → 该表不产出任务（避免把作息/模板表当任务）。
  const header0 = rows[0] ? splitCells(rows[0]) : [];
  if (header0.some((c) => /作息|模板|参考|说明/.test(c))) return;
  const tasks = [];
  const header = splitCells(rows[0]);
  let timeColIdx = -1;
  header.forEach((h, i) => { if (/时间|时段|时间块|时刻|时间安排|开始时间/.test(h)) timeColIdx = i; });
  const skipCols = new Set();
  header.forEach((h, i) => { if (/说明|要点|备注|材料|依据|提示|参考|配套/.test(h)) skipCols.add(i); });
  const dataRows = rows.slice(2);
  if (timeColIdx >= 0) {
    const hasReal = dataRows.some(row => { if (isSepRow(row)) return false; const c = splitCells(row)[timeColIdx]; return c && hasExplicitTime(c); });
    if (!hasReal) timeColIdx = -1;
  }
  for (const row of dataRows) {
    if (isSepRow(row)) continue;
    const cells = splitCells(row);
    let rowTime = null;
    if (timeColIdx >= 0 && cells[timeColIdx] && hasExplicitTime(cells[timeColIdx])) { rowTime = extractTime(cells[timeColIdx]); }
    else { for (const c of cells) { if (hasExplicitTime(c)) { rowTime = extractTime(c); break; } } }
    const produced = [];
    if (timeColIdx >= 0) {
      const taskIdx = timeColIdx + 1;
      if (taskIdx < cells.length && !skipCols.has(taskIdx)) {
        const cell = cells[taskIdx];
        if (cell && cell.trim()) {
          const segs = cell.split(/[；;]/).map(s => s.trim()).filter(Boolean);
          const hasRange = segs.some(s => /^\s*\d{1,2}[:：]\d{2}\s*[-~—–至到]/.test(s));
          if (hasRange) {
            for (const seg of segs) {
              const t2 = extractTime(seg);
              const title = cleanTitle(seg);
              if (title && t2) produced.push({ text: title, time: t2, status: 'unknown' });
            }
          } else {
            const title = cleanTitle(cell);
            if (title) produced.push({ text: title, time: rowTime, status: 'unknown' });
          }
        }
      }
    } else {
      for (let i = 0; i < cells.length; i++) {
        if (skipCols.has(i)) continue;
        const cell = cells[i];
        if (!cell || !cell.trim()) continue;
        if (/^(注[：:]?|材料|见文末|附|—|none|无|详情见)/i.test(cell)) continue;
        if (/不安排|零学习|无安排|有事/.test(cell) && !hasExplicitTime(cell)) continue;
        const segs = cell.split(/[；;]/).map(s => s.trim()).filter(Boolean);
        for (const seg of segs) {
          if (/^(注[：:]?|见文末|—|none|无$|详情见)/i.test(seg)) continue;
          const t2 = extractTime(seg);
          const title = cleanTitle(seg);
          if (title && t2) produced.push({ text: title, time: t2, status: 'unknown' });
        }
      }
    }
    if (produced.length === 0 && rowTime && timeColIdx >= 0 && cells[timeColIdx + 1]) {
      const title = cleanTitle(cells[timeColIdx + 1]);
      if (title) produced.push({ text: title, time: rowTime, status: 'unknown' });
    }
    tasks.push(...produced);
  }
  for (const t of tasks) { if (t.text) ensureGroup(currentHeading).push(t); }
}

// 单文件解析
function parseFile(filePath, fileName, opts) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const level = detectLevel(fileName, content);
  const period = detectPeriod(fileName, opts.year);
  if (!period.from) {
    const dm = content.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (dm) { period.from = fmtYMD(+dm[1], +dm[2], +dm[3]); }
  }

  const groups = [], groupMap = new Map();
  const goals = [];
  let title = null;
  // B1：分区标记——遇到 <!-- plan-tasks --> 后仅解析到此 <!-- /plan-tasks --> 之间；无标记=回退现有启发式（向后兼容）。
  const hasPartition = content.indexOf('<!-- plan-tasks -->') !== -1 && content.indexOf('<!-- /plan-tasks -->') !== -1;
  let inPartition = !hasPartition;
  let currentHeading = '（文件头）';
  function ensureGroup(heading) {
    if (!groupMap.has(heading)) { groupMap.set(heading, []); groups.push({ heading, tasks: groupMap.get(heading) }); }
    return groupMap.get(heading);
  }
  const isNoteHeading = (h) => /说明|配套|注意|要点|原则|备注|提醒|技巧|策略|依据|背景|落点|必改/.test(h);

  let tableBlock = [];
  const flushTable = () => { if (tableBlock.length) { processTableBlock(tableBlock, currentHeading, ensureGroup); tableBlock = []; } };

  for (const raw of lines) {
    const line = raw.replace(/\r?$/, '');
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^\s*<!--\s*plan-tasks\s*-->\s*$/.test(trimmed)) { inPartition = true; continue; }
    if (/^\s*<!--\s*\/plan-tasks\s*-->\s*$/.test(trimmed)) { flushTable(); inPartition = false; continue; }
    if (!inPartition) continue; // 分区模式下，标记区间外内容（作息/模板等）一律跳过
    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (h) { if (h[1].length === 1 && !title) title = h[2].replace(/[*_#]/g, '').trim(); flushTable(); currentHeading = h[2].replace(/[*_#]/g, '').trim(); continue; }
    if (/^\|/.test(trimmed)) { tableBlock.push(trimmed); continue; }
    flushTable();
    const li = parseListLine(trimmed);
    if (li) {
      const time = extractTime(li.body);
      if (li.status) {
        ensureGroup(currentHeading).push({ text: cleanTitle(li.body), time, status: li.status === 'done' ? 'done' : 'pending' });
      } else if (hasExplicitTime(li.body) && !isNoteHeading(currentHeading)) {
        // 含显式 HH:MM 且非说明性小节 -> 排期任务（status unknown）
        ensureGroup(currentHeading).push({ text: cleanTitle(li.body), time, status: 'unknown' });
      } else if (li.body && !isNoteHeading(currentHeading)) {
        // 无复选框、无显式 HH:MM 的纯文本列表项 -> 目标；即使含"上午/下午"时段词也算（无精确排期）
        const g = cleanTitle(li.body);
        if (g) goals.push(g);
      }
    }
  }
  flushTable();

  const allTasks = [];
  for (const g of groups) allTasks.push(...g.tasks);
  allTasks.sort((a, b) => timeSortKey(a.time) - timeSortKey(b.time));

  return { name: fileName, filePath, level, period, title: title || path.basename(fileName, '.md'), groups, tasks: allTasks, goals };
}

// 目录解析
function parseDir(planDir, opts) {
  const warnings = [];
  let entries;
  try { entries = fs.readdirSync(planDir); }
  catch (e) { return { files: [], warnings: ['计划文件夹不存在或不可读: ' + e.message] }; }

  const files = [];
  for (const name of entries) {
    if (!/\.md$/i.test(name)) continue;
    if (isExcludedFile(name, opts.excludePatterns)) continue;
    if (name.startsWith('.plan-widget') || /plan-state\.json$/.test(name)) continue;
    const full = path.join(planDir, name);
    try { files.push(parseFile(full, name, opts)); }
    catch (e) { warnings.push('单文件解析失败: ' + name + ' -> ' + e.message); }
  }
  return { files, warnings };
}

function isExcludedFile(name, patterns) {
  return patterns.some(p => name.includes(p));
}

// 快照构建
function normalizeExclude(input) {
  if (Array.isArray(input)) return input.map(String).filter(Boolean);
  if (typeof input === 'string') return input.split('|').map(s => s.trim()).filter(Boolean);
  return [...DEFAULT_EXCLUDE];
}
function dateStr(ymd) { return fmtYMD(ymd.year, ymd.month, ymd.day); }

function pickFile(levelFiles, todayStr) {
  if (!levelFiles || levelFiles.length === 0) return { file: null, warning: null };
  const exact = levelFiles.find(f => f.period && f.period.from === todayStr);
  if (exact) return { file: exact, warning: null };
  const contains = levelFiles.find(f => f.period && f.period.from && f.period.to && f.period.from <= todayStr && todayStr <= f.period.to);
  if (contains) return { file: contains, warning: null };
  const sorted = [...levelFiles].sort((a, b) => String(a.period?.from ?? '').localeCompare(String(b.period?.from ?? '')));
  const recent = [...sorted].reverse().find(f => f.period && f.period.from && f.period.from <= todayStr);
  const chosen = recent || sorted[sorted.length - 1] || sorted[0];
  return { file: chosen, warning: '未找到覆盖今日的计划，显示最近: ' + chosen.name };
}

// deriveCurrent：按 groups 文档序（不做全局时间排序）取第一个未完成任务作为 now。
// prev=其前一任务（允许跨组前一）；next=其后任务；本周全 done → 落到下一组（如下周预告）。
// 全部完成或空 → now=null（此时 prev/next 也为 null）。
function deriveCurrent(file) {
  if (!file) return { period: null, task: { prev: null, now: null, next: null } };
  const groups = file.groups || [];
  const flat = [];
  for (const g of groups) for (const t of g.tasks) flat.push(t);
  if (flat.length === 0) return { period: null, task: { prev: null, now: null, next: null } };
  const nowIdx = flat.findIndex((t) => t.status !== 'done');
  if (nowIdx === -1) return { period: null, task: { prev: null, now: null, next: null } };
  const now = flat[nowIdx];
  const prev = nowIdx > 0 ? flat[nowIdx - 1] : null;
  const next = nowIdx < flat.length - 1 ? flat[nowIdx + 1] : null;
  const tm = fmtTime(now.time);
  return {
    period: tm ? (tm + ' ' + now.text) : now.text,
    task: { prev: prev ? prev.text : null, now: now.text, next: next ? next.text : null }
  };
}

function buildToday(file, todayStr) {
  if (!file) return { date: todayStr, tasks: [], goals: [] };
  const tasks = file.tasks.map(t => ({
    text: t.text,
    time: fmtTime(t.time),
    status: t.status === 'done' ? 'done' : 'pending'
  }));
  return { date: todayStr, tasks, goals: (file.goals || []).slice(0, 20) };
}

function buildLevelBlock(file, warnings, fallbackText) {
  if (!file) { warnings.push(fallbackText); return { file: null, period: { from: null, to: null }, current: null }; }
  // A1：扩展输出——保留 groups（含 heading/文档序）与展平 tasks（含 group 字段），并输出 title（首个 H1 或 base 名）。
  const groups = (file.groups || []).map((g) => ({
    heading: g.heading,
    tasks: g.tasks.map((t) => ({ text: t.text, time: fmtTime(t.time), status: t.status })),
  }));
  const tasks = [];
  for (const g of groups) for (const t of g.tasks) tasks.push({ text: t.text, time: fmtTime(t.time), status: t.status, group: g.heading });
  return {
    file: file.name,
    period: { from: file.period?.from ?? null, to: file.period?.to ?? null },
    title: file.title || path.basename(file.name, '.md') || file.name,
    groups,
    tasks,
    current: deriveCurrent(file),
  };
}

function buildSnapshot(parsed, opts) {
  const warnings = [...parsed.warnings];
  const todayStr = dateStr(toYMD(opts.today));
  const byLevel = { daily: [], weekly: [], total: [] };
  for (const f of parsed.files) { if (byLevel[f.level]) byLevel[f.level].push(f); }

  const dp = pickFile(byLevel.daily, todayStr);
  if (dp.warning) warnings.push(dp.warning);
  const levels = { daily: buildLevelBlock(dp.file, warnings, '未找到日计划') };

  const wp = pickFile(byLevel.weekly, todayStr);
  if (wp.warning) warnings.push(wp.warning);
  levels.weekly = buildLevelBlock(wp.file, warnings, '未找到周计划');

  const tp = byLevel.total[0] || null;
  levels.total = buildLevelBlock(tp, warnings, '未找到总计划');

  // [整合 2026-09-06] agent 计划板块: 读取任务看板同步的 agent-plan.json(只读镜像, 与用户计划完全隔离)
  const agentPlan = readAgentPlan(opts);
  return {
    $schema: SCHEMA,
    updatedAt: new Date().toISOString(),
    sourceDir: opts.planDir,
    levels,
    today: buildToday(dp.file, todayStr),
    // agent 计划(与 levels/today 平级隔离; 来自任务看板, 非用户 .md)
    ...(agentPlan === null ? {} : { agentPlan }),
    raw: {
      daily: dp.file ? fs.readFileSync(dp.file.filePath, 'utf8').slice(0, RAW_LIMIT) : '',
      weekly: wp.file ? fs.readFileSync(wp.file.filePath, 'utf8').slice(0, RAW_LIMIT) : '',
      total: tp ? fs.readFileSync(tp.filePath, 'utf8').slice(0, RAW_LIMIT) : ''
    },
    warnings
  };
}

/** 读取任务看板 agent 计划(agent-plan.json, 只读镜像; 不存在/损坏返回 null) */
function readAgentPlan(opts) {
  try {
    const apPath = path.join(path.dirname(opts.outputPath), 'agent-plan.json');
    if (!fs.existsSync(apPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(apPath, 'utf8'));
    if (!parsed || parsed.$schema !== 'collab-board/agent-plan.v1') return null;
    return {
      $schema: 'plan-widget/agent-plan.v1',
      updatedAt: parsed.updatedAt || null,
      source: parsed.source || 'dsh-collab-board',
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks.map((t) => ({
        id: String(t.id ?? ''),
        title: String(t.title ?? ''),
        status: String(t.status ?? ''),
        zone: String(t.zone ?? ''),
        targetSession: t.targetSession ? String(t.targetSession) : undefined,
        time: t.time ? String(t.time) : undefined,
      })).filter((t) => t.title !== '') : [],
    };
  } catch {
    return null;
  }
}

// 原子写盘（临时文件 + rename）
function atomicWrite(outPath, obj) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = outPath + '.tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, outPath);
  return outPath;
}

// 主构造
export function createPlanBridge(options) {
  if (!options || !options.planDir) throw new Error('createPlanBridge: 缺少必填项 planDir');

  const opts = {
    planDir: path.resolve(options.planDir),
    watch: options.watch !== false,
    outputPath: options.outputPath
      ? path.resolve(options.outputPath)
      : path.join(path.resolve(options.planDir), '.plan-widget', 'plan-state.json'),
    excludePatterns: normalizeExclude(options.excludePatterns),
    year: options.year ?? new Date().getFullYear(),
    today: options.today ?? toYMD()
  };

  let watcher = null;
  let debounceTimer = null;
  let running = false;
  let syncing = false;

  let agentWatcher = null;
  function syncNow() {
    if (syncing) return null;
    syncing = true;
    try {
      // 构建快照（目录缺失/解析失败均已容错，只产生 warnings）
      let parsed, snap;
      if (!fs.existsSync(opts.planDir)) {
        parsed = { files: [], warnings: ['计划文件夹不存在: ' + opts.planDir] };
        snap = buildSnapshot(parsed, opts);
      } else {
        parsed = parseDir(opts.planDir, opts);
        snap = buildSnapshot(parsed, opts);
      }
      // 原子写盘；若目标文件被占用（Windows 常见）则记 warning，不向上抛
      try { atomicWrite(opts.outputPath, snap); }
      catch (e) { snap.warnings.push('写入快照失败(可能被占用): ' + e.message); }
      return snap;
    } finally { syncing = false; }
  }

  function start() {
    if (!opts.watch || watcher) return;
    try {
      watcher = fs.watch(opts.planDir, { recursive: false }, (eventType, filename) => {
        const fn = filename ? String(filename) : '';
        if (fn.startsWith('.plan-widget') || fn.endsWith('plan-state.json')) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => { try { syncNow(); } catch { /* 容错 */ } }, WATCH_DEBOUNCE_MS);
      });
      watcher.on('error', () => { /* 监听出错不影响主流程 */ });
    } catch { /* 目录不存在等：监听失败不致命 */ }
    // [2026-09-06] Agent 计划同步: 监听 .plan-widget/agent-plan.json(任务看板写入)
    try {
      const apDir = path.join(opts.planDir, '.plan-widget');
      if (fs.existsSync(apDir)) {
        agentWatcher = fs.watch(apDir, { recursive: false }, (eventType, filename) => {
          const fn = filename ? String(filename) : '';
          if (fn === 'agent-plan.json') {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => { try { syncNow(); } catch { /* 容错 */ } }, WATCH_DEBOUNCE_MS);
          }
        });
        agentWatcher.on('error', () => {});
      }
    } catch { /* 容错 */ }
  }

  function stop() {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (watcher) { try { watcher.close(); } catch { /* 忽略 */ } watcher = null; }
    if (agentWatcher) { try { agentWatcher.close(); } catch { /* 忽略 */ } agentWatcher = null; }
  }

  return { start, stop, syncNow, _opts: opts };
}