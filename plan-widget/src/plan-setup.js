/**
 * plan-setup.js — 懒人配置：计划目录诊断 / 应用 / 默认生成 / 重置（plan_setup 工具核心逻辑）
 *
 * 与 DSH 工具 plan_setup 的注册（在 index.js）分离，便于单测注入 homeDir / configPath；
 * 生产默认 homeDir=os.homedir()，测试传临时目录，避免写入真实用户目录。
 *
 * 目录约定（零硬编码本机路径，全部由 homeDir 推导）：
 *   - 用户级配置：<homeDir>/.plan-widget-config.json（见 settings-schema.js）
 *   - 默认计划目录：<homeDir>/Documents/计划悬浮窗/
 *
 * 由本模块生成三个占位计划文件（文件名与 plan-bridge 的层级识别正则保持一致，保证可解析）：
 *   - <M月D日>执行总览.md        （daily）
 *   - 本周计划-<周一>至<周日>.md  （weekly）
 *   - 总计划.md                  （total）
 *
 * @module dsh-plan-widget/plan-setup
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 内部：用户级配置文件路径。 */
function userConfigPath(homeDir) {
  return path.join(homeDir || os.homedir(), '.plan-widget-config.json');
}

/** 默认计划目录：<homeDir>/Documents/计划悬浮窗/。 */
export function defaultPlanDir(homeDir) {
  return path.join(homeDir || os.homedir(), 'Documents', '计划悬浮窗');
}

/** 由快照协议 v1 推导计划统计（daily=今日任务数；weekly/total=对应层级是否存在文件）。 */
export function snapshotSummary(snap) {
  if (!snap || typeof snap !== 'object') return { daily: 0, weekly: 0, total: 0 };
  const daily = Array.isArray(snap.today?.tasks) ? snap.today.tasks.length : 0;
  const weekly = snap.levels?.weekly?.file ? 1 : 0;
  const total = snap.levels?.total?.file ? 1 : 0;
  return { daily, weekly, total };
}

/**
 * 判断快照是否含真实计划（today.tasks 非空 或 任一 level 有文件）。
 * 空壳快照（tasks=[]、三 level 均无文件）视为"未配置"，可被 create_default 覆盖。
 * @param {object|null} snap - plan-state 快照。
 * @returns {boolean} true=有真实计划；false=空对象/空壳。
 */
export function hasRealPlan(snap) {
  if (!snap || typeof snap !== 'object') return false;
  if (Array.isArray(snap.today?.tasks) && snap.today.tasks.length > 0) return true;
  return !!(snap.levels?.daily?.file || snap.levels?.weekly?.file || snap.levels?.total?.file);
}

/** 安全读取并解析 JSON（不存在/损坏返回 null）。 */
function readJsonSafe(p) {
  try { if (!fs.existsSync(p)) return null; return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return null; }
}

/** 日期格式化。 */
function ymd(date) { return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0'); }
function ymdCn(date) { return date.getFullYear() + '年' + String(date.getMonth() + 1).padStart(2, '0') + '月' + String(date.getDate()).padStart(2, '0') + '日'; }
function mdCn(date) { return String(date.getMonth() + 1) + '月' + String(date.getDate()) + '日'; }

/** 计算某天的本周一与周日。 */
function weekRange(ref) {
  const d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  const day = (d.getDay() + 6) % 7; // 周一=0 … 周日=6
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return { monday, sunday };
}

/**
 * 生成三个占位计划文件。
 * @param {string} dir - 计划目录（会自动创建）。
 * @param {Date} [now] - 当前日期（默认 new Date()）。
 * @returns {{name:string, path:string}[]} 创建的文件清单。
 */
export function createDefaultPlanFiles(dir, now = new Date()) {
  fs.mkdirSync(dir, { recursive: true });
  const created = [];
  const write = (name, text) => {
    const full = path.join(dir, name);
    fs.writeFileSync(full, text, 'utf8'); // 占位文件，无需 BOM
    created.push({ name, path: full });
  };

  // 总计划（total）
  write('总计划.md', [
    '# 总计划',
    '> 占位模板，替换成你的计划。',
    '## 阶段一',
    '- [ ] 阶段一目标：描述你要达成的目标（替换成你的计划）',
    '## 阶段二',
    '- [ ] 阶段二目标：描述你要达成的目标（替换成你的计划）',
    '## 里程碑',
    '- [ ] 里程碑：描述关键节点（替换成你的计划）',
  ].join('\n'));

  // 本周计划（weekly）：文件名用「至」便于 plan-bridge 范围解析。
  const { monday, sunday } = weekRange(now);
  const weekName = '本周计划-' + ymd(monday) + '至' + ymd(sunday) + '.md';
  write(weekName, [
    '# 本周计划（' + ymd(monday) + ' 至 ' + ymd(sunday) + '）',
    '> 占位模板，替换成你的计划。',
    '## 本周目标',
    '- [ ] 本周核心目标一：替换成你的计划',
    '- [ ] 本周核心目标二：替换成你的计划',
    '## 每日安排（示例）',
    '- [ ] 09:00-10:00 每日固定模块一',
    '- [ ] 14:00-15:00 每日固定模块二',
  ].join('\n'));

  // 今日执行总览（daily）：文件名用 <M月D日>执行总览.md 以保证 plan-bridge 识别为 daily。
  const dayName = mdCn(now) + '执行总览.md';
  write(dayName, [
    '# ' + mdCn(now) + ' 执行总览（' + ymdCn(now) + '）',
    '> 占位模板，替换成你的计划。',
    '## 上午',
    '- [ ] 09:00-10:00 任务一（示例：核心训练）',
    '- [ ] 10:00-11:00 任务二（示例：复盘上一日）',
    '## 下午',
    '- [ ] 14:00-15:00 任务三（示例：专题练习）',
    '## 晚上',
    '- [ ] 19:00-20:00 任务四（示例：总结）',
    '- 今日目标：完成一项核心任务（替换成你的目标）',
  ].join('\n'));

  return created;
}

/**
 * plan_setup 核心逻辑（通过注入 ctx 便于测试）。
 * @param {object} args - 工具参数 {plan_dir?, create_default?, reset?}。
 * @param {object} ctx - 执行上下文。
 * @param {string} ctx.currentPlanDir - 当前生效计划目录（可为空）。
 * @param {() => object|null} ctx.getBridge - 取当前 plan-bridge 实例（未就绪返回 null）。
 * @param {(dir:string)=>object|null} ctx.setActivePlanDir - 把计划目录应用到 bridge，返回 bridge。
 * @param {string} ctx.homeDir - 用户主目录（生产=os.homedir()，测试注入临时目录）。
 * @param {string} ctx.configPath - 用户级配置文件路径。
 * @param {() => number} [ctx.now] - 时间（默认 Date.now）。
 * @returns {{mode:string, planDir:string, planSummary:object, createdFiles:Array, clientHint:string, warnings:string[]}}
 */
export function planSetupCore(args, ctx) {
  const warnings = [];
  const homeDir = ctx.homeDir || os.homedir();
  const configPath = ctx.configPath || path.join(homeDir, '.plan-widget-config.json');
  const nowFn = ctx.now || (() => Date.now());
  const currentPlanDir = ctx.currentPlanDir || '';

  // reset：清用户级配置，重新诊断。
  if (args?.reset) {
    try { if (configPath && fs.existsSync(configPath)) fs.unlinkSync(configPath); }
    catch (e) { warnings.push('重置失败：' + String(e?.message ?? e)); }
    return { mode: 'only-diagnosed', planDir: '', planSummary: { daily: 0, weekly: 0, total: 0 }, createdFiles: [], clientHint: '已清除用户级配置，可重新 plan_setup 配置。', warnings };
  }


  // create_default：生成占位计划。目标目录优先级：plan_dir 指定 > 已配置 planDir > 默认目录。
  if (args?.create_default) {
    const explicitDir = (args?.plan_dir || args?.planDir) ? String(args.plan_dir || args.planDir) : null;
    let dir;
    let useDefaultDir = false;
    if (explicitDir) dir = explicitDir;
    else if (currentPlanDir) dir = currentPlanDir;
    else { dir = defaultPlanDir(homeDir); useDefaultDir = true; }

    // 目标目录已含【真实】快照（非空壳）→ 视为已配置，不覆盖现有计划；空壳快照视为未配置，继续生成占位覆盖。
    const planStatePath = path.join(dir, '.plan-widget', 'plan-state.json');
    if (fs.existsSync(dir) && fs.existsSync(planStatePath) && hasRealPlan(readJsonSafe(planStatePath))) {
      return { mode: 'configured-existing', planDir: dir, planSummary: { daily: 0, weekly: 0, total: 0 }, createdFiles: [], clientHint: '计划目录已含真实计划（快照非空壳），不覆盖现有计划。', warnings };
    }

    let createdFiles = [];
    try { createdFiles = createDefaultPlanFiles(dir, new Date(nowFn())); }
    catch (e) { warnings.push('创建计划文件失败：' + String(e?.message ?? e)); }

    let bridge = null;
    try { bridge = ctx.setActivePlanDir ? ctx.setActivePlanDir(dir) : ctx.getBridge(); }
    catch (e) { warnings.push('设置计划目录失败：' + String(e?.message ?? e)); }

    let snap = null;
    try { if (bridge && typeof bridge.syncNow === 'function') snap = bridge.syncNow(); }
    catch (e) { warnings.push('syncNow 失败：' + String(e?.message ?? e)); }

    // 持久化：显式指定目录 或 用默认目录 → 写用户配置；用已配置目录（未显式指定）→ 保持既有配置（不切换、不改配置）。
    if (explicitDir || useDefaultDir) {
      try { fs.writeFileSync(configPath, JSON.stringify({ planDir: dir, updatedAt: new Date(nowFn()).toISOString() }, null, 2), 'utf8'); }
      catch (e) { warnings.push('持久化用户配置失败：' + String(e?.message ?? e)); }
    }
    return { mode: 'created-default', planDir: dir, planSummary: snapshotSummary(snap), createdFiles, clientHint: '占位计划已就绪，桌面软件将自动探测。', warnings };
  }

  // plan_dir：应用指定目录。
  if (args?.plan_dir || args?.planDir) {
    const dir = String(args.plan_dir || args.planDir);
    if (!fs.existsSync(dir)) {
      warnings.push('目录不存在：' + dir);
      return { mode: 'only-diagnosed', planDir: currentPlanDir, planSummary: { daily: 0, weekly: 0, total: 0 }, createdFiles: [], clientHint: '', warnings };
    }
    try { fs.accessSync(dir, fs.constants.W_OK); }
    catch (e) {
      warnings.push('目录不可写：' + dir);
      return { mode: 'only-diagnosed', planDir: currentPlanDir, planSummary: { daily: 0, weekly: 0, total: 0 }, createdFiles: [], clientHint: '', warnings };
    }
    let bridge = null;
    try { bridge = ctx.setActivePlanDir ? ctx.setActivePlanDir(dir) : ctx.getBridge(); }
    catch (e) { warnings.push('设置计划目录失败：' + String(e?.message ?? e)); }
    let snap = null;
    try { if (bridge && typeof bridge.syncNow === 'function') snap = bridge.syncNow(); }
    catch (e) { warnings.push('syncNow 失败：' + String(e?.message ?? e)); }
    try { fs.writeFileSync(configPath, JSON.stringify({ planDir: dir, updatedAt: new Date(nowFn()).toISOString() }, null, 2), 'utf8'); }
    catch (e) { warnings.push('持久化用户配置失败：' + String(e?.message ?? e)); }
    return { mode: 'plan-dir-applied', planDir: dir, planSummary: snapshotSummary(snap), createdFiles: [], clientHint: '计划目录已应用并持久化，桌面软件下次启动将探测该目录。', warnings };
  }

  // 无参：诊断。
  if (!currentPlanDir) {
    warnings.push('未配置计划目录：可在 DSH 会话说「帮我配置计划」，或 plan_setup{create_default:true} 一键生成。');
  } else {
    const ps = path.join(currentPlanDir, '.plan-widget', 'plan-state.json');
    if (!fs.existsSync(ps)) warnings.push('计划目录 ' + currentPlanDir + ' 尚未生成快照（可 plan_sync 或等待）。');
  }
  return { mode: 'only-diagnosed', planDir: currentPlanDir, planSummary: { daily: 0, weekly: 0, total: 0 }, createdFiles: [], clientHint: '', warnings };
}

export default { defaultPlanDir, createDefaultPlanFiles, planSetupCore, snapshotSummary, hasRealPlan };
