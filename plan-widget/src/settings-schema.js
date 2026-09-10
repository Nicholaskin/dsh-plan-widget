/**
 * settings-schema.js — dsh-plan-widget 配置（字段 schema + 默认值 + 归一化）
 *
 * 本模块【不依赖 dsh-settings / schemastery】——因本插件 peerDependencies 仅声明
 * cordis 与 dsh-session。settings-schema 仅作为纯 JS 配置对象出口：
 *   - settingsSchema      ：描述字段形状（供 dsh-settings 注册时给 schema，若宿主有 settings 服务）
 *   - defaultWidgetSettings：内置默认值
 *   - normalizeWidgetSettings(raw)：把外部读到的原始配置并入默认值并做基础清洗
 *
 * 约定：settings 命名空间为 planWidget（即 ctx.settings.planWidget）。
 *
 * @module dsh-plan-widget/settings-schema
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 设置命名空间标识（供宿主 settings 服务 / 客户端区分）。 */
export const NS = 'planWidget';

/**
 * 字段形状描述（JSON Schema 风格，仅用于说明与潜在校验；不作为运行时强约束）。
 * @type {Object}
 */
export const settingsSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    planDir: { type: 'string', description: '学习计划根目录（空=交给 plan-bridge 决定/读环境）。' },
    watch: { type: 'boolean', description: '是否监听计划文件变化（true/false）。' },
    outputPlanPath: { type: 'string', description: '计划输出 JSON 路径（空=默认）。' },
    sessionStatePath: { type: 'string', description: '会话状态输出路径（空=默认 DSH_HOME/plan-widget/session-status.json）。' },
    mainOnly: { type: 'boolean', description: '是否仅跟踪主会话（true=忽略子代理会话）。' },
    mainSessionMode: { type: 'string', enum: ['auto', 'id'], description: '主会话指定模式：auto=自动（顶层会话取最近活动）；id=按会话 ID 精确指定。' },
    mainSessionId: { type: 'string', description: 'mainSessionMode=id 时指定主会话 ID（从 DSH Web GUI 会话信息或 api/session.list 获取）。' },
  },
};

/** 内置默认配置。 */
export const defaultWidgetSettings = {
  planDir: '',
  watch: true,
  outputPlanPath: '',
  sessionStatePath: '',
  mainOnly: true,
  mainSessionMode: 'auto',
  mainSessionId: '',
};

/**
 * 把外部读到的原始配置并入默认值并做基础清洗。
 * @param {Record<string, unknown>} [raw] - 外部配置（可为 undefined/空对象）。
 * @returns {{planDir:string, watch:boolean, outputPlanPath:string, sessionStatePath:string, mainOnly:boolean}} 归一化配置。
 */
export function normalizeWidgetSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    planDir: typeof r.planDir === 'string' ? r.planDir : defaultWidgetSettings.planDir,
    watch: typeof r.watch === 'boolean' ? r.watch : defaultWidgetSettings.watch,
    outputPlanPath: typeof r.outputPlanPath === 'string' ? r.outputPlanPath : defaultWidgetSettings.outputPlanPath,
    sessionStatePath: typeof r.sessionStatePath === 'string' ? r.sessionStatePath : defaultWidgetSettings.sessionStatePath,
    mainOnly: typeof r.mainOnly === 'boolean' ? r.mainOnly : defaultWidgetSettings.mainOnly,
    mainSessionMode: r.mainSessionMode === 'id' ? 'id' : (r.mainSessionMode === 'auto' ? 'auto' : defaultWidgetSettings.mainSessionMode),
    mainSessionId: typeof r.mainSessionId === 'string' ? r.mainSessionId : defaultWidgetSettings.mainSessionId,
  };
}

/**
 * 解析布尔型环境变量（'0'/'false'/'否' → false，其余真值 → true）。
 * @param {string|undefined} v - 环境变量值。
 * @returns {boolean|undefined} 布尔或 undefined（未设置）。
 */
function envBool(v) {
  if (v === undefined) return undefined;
  if (v === '' || v === '0' || v === 'false' || v === 'off' || v.toLowerCase() === '否' || v.toLowerCase() === '关闭') return false;
  return true;
}

/**
 * 从环境变量读取配置（供无 dsh-settings 时的兜底）。
 * 优先级：显式 settings > env > 默认值（由 normalizeWidgetSettings 统一处理）。
 * @param {NodeJS.ProcessEnv} [env] - 环境变量表（默认 process.env）。
 * @returns {Partial<ReturnType<typeof normalizeWidgetSettings>>} 来自 env 的配置。
 */
export function envWidgetSettings(env = process.env) {
  const out = {};
  // 新命名 PLAN_WIDGET_*（优先）。
  if (env.PLAN_WIDGET_PLAN_DIR !== undefined) out.planDir = env.PLAN_WIDGET_PLAN_DIR;
  if (env.PLAN_WIDGET_WATCH !== undefined) out.watch = envBool(env.PLAN_WIDGET_WATCH);
  if (env.PLAN_WIDGET_PLAN_OUTPUT !== undefined) out.outputPlanPath = env.PLAN_WIDGET_PLAN_OUTPUT;
  if (env.PLAN_WIDGET_SESSION_STATE !== undefined) out.sessionStatePath = env.PLAN_WIDGET_SESSION_STATE;
  if (env.PLAN_WIDGET_MAIN_ONLY !== undefined) out.mainOnly = envBool(env.PLAN_WIDGET_MAIN_ONLY);
  if (env.PLAN_WIDGET_MAIN_SESSION_MODE !== undefined) out.mainSessionMode = env.PLAN_WIDGET_MAIN_SESSION_MODE;
  if (env.PLAN_WIDGET_MAIN_SESSION_ID !== undefined) out.mainSessionId = env.PLAN_WIDGET_MAIN_SESSION_ID;
  // 兼容旧命名 KAOGONG_*（仅当新命名未设置时回退；新优先）。
  if (out.planDir === undefined && env.KAOGONG_PLAN_DIR !== undefined) out.planDir = env.KAOGONG_PLAN_DIR;
  if (out.watch === undefined && env.KAOGONG_PLAN_WATCH !== undefined) out.watch = envBool(env.KAOGONG_PLAN_WATCH);
  if (out.outputPlanPath === undefined && env.KAOGONG_PLAN_OUTPUT !== undefined) out.outputPlanPath = env.KAOGONG_PLAN_OUTPUT;
  if (out.sessionStatePath === undefined && env.KAOGONG_SESSION_STATE !== undefined) out.sessionStatePath = env.KAOGONG_SESSION_STATE;
  if (out.mainOnly === undefined && env.KAOGONG_MAIN_ONLY !== undefined) out.mainOnly = envBool(env.KAOGONG_MAIN_ONLY);
  return out;
}

/**
 * 用户级配置文件路径：%USERPROFILE%/.plan-widget-config.json（plan_setup 持久化用）。
 * @param {string} [homeDir] - 用户主目录（默认 os.homedir()）。
 * @returns {string} 配置文件路径。
 */
export function userConfigPath(homeDir) {
  return path.join(homeDir || os.homedir(), '.plan-widget-config.json');
}

/**
 * 读取用户级配置中的 planDir（优先级：env > 用户配置 > 默认空）。
 * @param {string} [homeDir] - 用户主目录（默认 os.homedir()）。
 * @returns {{planDir?:string}} 来自用户配置的字段（未配置/损坏返回空对象）。
 */
export function userConfigPlanDir(homeDir) {
  try {
    const p = userConfigPath(homeDir);
    if (!p) return {};
    if (!fs.existsSync(p)) return {};
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (obj && typeof obj.planDir === 'string' && obj.planDir) return { planDir: obj.planDir };
    return {};
  } catch {
    return {};
  }
}

/**
 * 原子写用户级配置（临时文件 + rename；UTF-8 无 BOM）。
 * @param {object} obj - 配置对象。
 * @param {string} [homeDir] - 用户主目录（默认 os.homedir()）。
 * @returns {string} 写入路径。
 */
export function writeUserConfig(obj, homeDir) {
  const p = userConfigPath(homeDir);
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = p + '.tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
  return p;
}
