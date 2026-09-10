/**
 * index.js — dsh-plan-widget 插件骨架入口
 *
 * 组成：
 *   - plan-bridge（可选集成）：动态 import('./plan-bridge.js')，A 子代理提供
 *     createPlanBridge(options) 工厂（返回 {start, stop, syncNow}）。
 *     若模块缺失或未配置 planDir，则记录日志警告并让状态功能照常工作（不阻断启动）。
 *   - 会话哨兵（session-sentinel）：监听会话状态流，按输出协议 v1 原子写 JSON。
 *   - DSH 工具 plan_sync：供 AI 自查学习计划同步结果（调用 planBridge.syncNow()）。
 *
 * 运行时的服务注入：sessions（会话存储，供哨兵订阅）、tools（工具注册）。
 * 工具注册形态参照 vision-exp-tile：裸工具对象 + ctx.tools.register。
 *
 * @module dsh-plan-widget
 */

import { normalizeWidgetSettings, envWidgetSettings, userConfigPlanDir, userConfigPath } from './settings-schema.js';
import { createSessionSentinel } from './session-sentinel.js';
import { createWebPanel } from './web-panel.js';
import { planSetupCore } from './plan-setup.js';
import path from 'node:path';
import os from 'node:os';

/** 插件名（供 DSH 加载器识别，须与 cordis.patch.yml 的 name 一致）。 */
export const name = 'dsh-plan-widget';

/** 运行时需要的服务注入：sessions（哨兵用）+ tools（工具注册用）。 */
export const inject = ['sessions', 'tools'];

/**
 * 从 syncNow 结果归一化出计划统计。
 * @param {unknown} result - plan-bridge.syncNow() 的返回（快照协议 v1 或 {planSummary} 形）。
 * @param {string[]} warnings - 收集警告。
 * @returns {{daily:number, weekly:number, total:number}} 计划统计。
 */
function normalizePlanSummary(result, warnings) {
  if (!result || typeof result !== 'object') {
    warnings.push('syncNow 返回为空，未能解析计划统计');
    return { daily: 0, weekly: 0, total: 0 };
  }
  // 若已是 planSummary 形，直接取。
  const ps = result.planSummary && typeof result.planSummary === 'object' ? result.planSummary : null;
  if (ps) {
    return { daily: ps.daily ?? 0, weekly: ps.weekly ?? 0, total: ps.total ?? 0 };
  }
  // 否则从快照协议 v1 推导：daily=今日任务数；weekly/total=对应层级是否已解析出文件(1/0)。
  const daily = Array.isArray(result.today?.tasks) ? result.today.tasks.length : 0;
  const weekly = result.levels?.weekly?.file ? 1 : 0;
  const total = result.levels?.total?.file ? 1 : 0;
  warnings.push('planSummary 由快照协议 v1 推导（daily=今日任务数；weekly/total=对应层级文件存在标记 0/1）');
  return { daily, weekly, total };
}

/**
 * 创建 plan_sync 工具的裸工具对象。
 * @param {() => object|null} getBridge - 返回已加载的 plan-bridge 实例（未就绪返回 null）。
 * @param {object} settings - 归一化后的插件配置。
 * @returns {object} 工具对象。
 */
function makePlanSyncTool(getBridge, settings) {
  const toolName = 'plan_sync';
  return {
    name: toolName,
    description: [
      '同步/刷新计划表，返回计划概览（daily/weekly/total）供 AI 自查。',
      '参数：planDir（可选，学习计划根目录，覆盖默认）；force（可选布尔，是否强制重新同步）。',
      '返回：{ ok, warnings[], planSummary:{daily,weekly,total} }。'
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        planDir: { type: 'string', description: '学习计划根目录（可选；覆盖默认）。' },
        plan_dir: { type: 'string', description: '同 planDir（兼容小写别名）。' },
        force: { type: 'boolean', description: '是否强制重新同步（忽略缓存）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          warnings: { type: 'array', items: { type: 'string' } },
          planSummary: {
            type: 'object',
            additionalProperties: true,
            properties: { daily: { type: 'integer' }, weekly: { type: 'integer' }, total: { type: 'integer' } },
          },
        },
        required: ['ok'],
      },
      // 把返回 JSON 渲染成模型可读文本。
      render: (args, value) => {
        if (!value || value.ok !== true) {
          const msg = (value?.warnings && value.warnings.length ? value.warnings.join('；') : '未知原因');
          return [{ type: 'text', text: toolName + ' 未成功：' + msg }];
        }
        const ps = value.planSummary ?? {};
        const extra = value.warnings && value.warnings.length ? ('；warnings=' + value.warnings.join('；')) : '';
        return [{ type: 'text', text: toolName + ' 完成：daily=' + ps.daily + ', weekly=' + ps.weekly + ', total=' + ps.total + extra }];
      },
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: toolName + '：' + String(args.planDir ?? args.plan_dir ?? '(默认计划)'),
      kind: 'read',
    }),
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw new Error(toolName + ': 已取消');
      const warnings = [];
      const bridge = getBridge();
      if (!bridge) {
        return { ok: false, warnings: ['plan-bridge 未就绪（未加载或未配置 planDir），跳过同步'], planSummary: null };
      }
      const planDir = args?.planDir ?? args?.plan_dir;
      if (planDir) {
        if (typeof bridge.setPlanDir === 'function') {
          bridge.setPlanDir(String(planDir));
        } else {
          warnings.push('已传 planDir 但 plan-bridge 无 setPlanDir，忽略该参数');
        }
      }
      if (args?.force) {
        if (typeof bridge.forceSync === 'function') bridge.forceSync();
        else warnings.push('已传 force 但 plan-bridge 无 forceSync，忽略');
      }
      if (typeof bridge.syncNow !== 'function') {
        return { ok: false, warnings: ['plan-bridge.syncNow 不可用'], planSummary: null };
      }
      try {
        const result = await bridge.syncNow();
        return { ok: true, warnings, planSummary: normalizePlanSummary(result, warnings) };
      } catch (e) {
        warnings.push('syncNow 失败：' + String(e?.message ?? e));
        return { ok: false, warnings, planSummary: null };
      }
    },
  };
}

/**
 * 创建 plan_setup 工具的裸工具对象（懒人配置：诊断/应用目录/一键生成默认/重置）。
 * @param {() => object|null} getBridge - 返回已加载的 plan-bridge 实例。
 * @param {object} settings - 归一化后的插件配置。
 * @param {(dir:string)=>object|null} setActivePlanDir - 把计划目录应用到 plan-bridge（重建）。
 * @param {() => string} getCurrentPlanDir - 返回当前生效计划目录（用于诊断）。
 * @returns {object} 工具对象。
 */
function makePlanSetupTool(getBridge, settings, setActivePlanDir, getCurrentPlanDir) {
  const toolName = 'plan_setup';
  return {
    name: toolName,
    description: [
      '懒人配置计划：诊断当前计划目录 / 应用指定目录 / 一键生成默认占位计划 / 重置用户配置。',
      '参数：plan_dir（可选，计划根目录，应用并持久化）；create_default（可选布尔，在默认目录生成占位计划）；reset（可选布尔，清除用户级配置）。',
      '返回：{ ok, mode(configured-existing|created-default|only-diagnosed|plan-dir-applied), planDir, planSummary:{daily,weekly,total}, createdFiles, clientHint, warnings }。'
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        plan_dir: { type: 'string', description: '计划根目录（可选；应用并持久化到用户配置）。' },
        planDir: { type: 'string', description: '同 plan_dir（兼容小写别名）。' },
        create_default: { type: 'boolean', description: '在用户默认目录（Documents/计划悬浮窗）生成占位计划。' },
        reset: { type: 'boolean', description: '清除用户级配置（恢复未配置状态）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          mode: { type: 'string' },
          planDir: { type: 'string' },
          planSummary: { type: 'object', additionalProperties: true, properties: { daily: { type: 'integer' }, weekly: { type: 'integer' }, total: { type: 'integer' } } },
          createdFiles: { type: 'array', items: { type: 'object', additionalProperties: true } },
          clientHint: { type: 'string' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['ok', 'mode'],
      },
      render: (args, value) => {
        const v = value || {};
        const modeText = {
          'configured-existing': '使用已配置的默认目录（未覆盖）',
          'created-default': '已创建默认占位计划',
          'only-diagnosed': '诊断（当前未配置或待配置）',
          'plan-dir-applied': '已应用计划目录',
        }[v.mode] || v.mode;
        const ps = v.planSummary ?? {};
        const created = (v.createdFiles || []).map((x) => x && x.name).filter(Boolean).join('、');
        const lines = [toolName + ' 结果：' + modeText + '；计划目录=' + (v.planDir || '(未配置)') + '；daily=' + ps.daily + ', weekly=' + ps.weekly + ', total=' + ps.total];
        if (created) lines.push('已创建文件：' + created);
        if (v.clientHint) lines.push(v.clientHint);
        if (v.warnings && v.warnings.length) lines.push('warnings：' + v.warnings.join('；'));
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: toolName + '：' + (args?.reset ? '重置' : args?.create_default ? '一键生成默认计划' : (args?.plan_dir || args?.planDir ? '应用目录' : '诊断')),
      kind: 'read',
    }),
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw new Error(toolName + ': 已取消');
      const homeDir = (process.env.DSH_HOME || os.homedir());
      const configPath = userConfigPath(homeDir);
      const res = planSetupCore(args || {}, {
        currentPlanDir: getCurrentPlanDir(),
        getBridge,
        setActivePlanDir,
        homeDir,
        configPath,
      });
      return { ok: true, mode: res.mode, planDir: res.planDir, planSummary: res.planSummary, createdFiles: res.createdFiles, clientHint: res.clientHint, warnings: res.warnings };
    },
  };
}

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis 上下文。
 */
export function apply(ctx) {
  // ---- 读设置 ----
  // 读配置：优先 env 兜底（PLAN_WIDGET_PLAN_DIR 等；旧 KAOGONG_* 仍作兼容别名），再并入宿主 settings（若提供）。
  // 注意：不直接访问 ctx.settings —— cordis 对未注入的服务取值会抛 "without inject"。
  // 显式 settings 覆盖由下面的 ctx.inject(['settings'], ...) 懒读完成（若 settings 服务可用）。
  const settings = normalizeWidgetSettings({ ...userConfigPlanDir((process.env.DSH_HOME || os.homedir())), ...envWidgetSettings(process.env) });
  // 2026-08-26 修复：生产启动（手动 dsh web / restart 脚本）无 DSH_HOME 环境变量时，
  // 用用户主目录 .dsh 兜底（DSH 默认 DSH_HOME = %USERPROFILE%\.dsh），保证哨兵与 Web 面板路径一致。
  const dshHome = process.env.DSH_HOME
    ?? (typeof process.env.USERPROFILE === 'string' ? path.join(process.env.USERPROFILE, '.dsh') : null);

  // ---- 缓存：已创建的 plan-bridge 实例（start/stop/syncNow） ----
  let bridge = null;
  let planBridgeFactory = null;
  let activePlanDir = settings.planDir; // 运行期生效的计划目录（setActivePlanDir 更新）

  // 当前生效的计划目录（供 plan_sync/plan_setup 与 Web 面板共享的同一 getter）。
  const getCurrentPlanDir = () => activePlanDir || settings.planDir || userConfigPlanDir((process.env.DSH_HOME || os.homedir())).planDir || '';

  // ---- 把计划目录应用到 plan-bridge（重建，避免依赖 setPlanDir；供 plan_setup 的 plan-dir-applied 模式） ----
  function setActivePlanDir(dir) {
    activePlanDir = dir;
    try { bridge?.stop?.(); } catch {}
    if (!planBridgeFactory) return bridge;
    try {
      bridge = planBridgeFactory({ planDir: dir, watch: settings.watch, outputPath: settings.outputPlanPath || undefined });
      bridge.start?.();
      return bridge;
    } catch (e) {
      bridge = null;
      return null;
    }
  }

  // ---- 动态集成 plan-bridge（容错：模块缺失或未配置 planDir 则不创建，状态功能照常） ----
  import('./plan-bridge.js')
    .then((mod) => {
      const factory = mod?.createPlanBridge ?? mod?.default?.createPlanBridge;
      planBridgeFactory = factory;
      if (typeof factory !== 'function') {
        console.log('[dsh-plan-widget] plan-bridge 模块存在但无 createPlanBridge 导出');
        return;
      }
      if (!settings.planDir) {
        console.log('[dsh-plan-widget] plan-bridge 已加载但未配置 planDir，跳过创建（仅状态功能生效）');
        return;
      }
      try {
        bridge = factory({
          planDir: settings.planDir,
          watch: settings.watch,
          outputPath: settings.outputPlanPath || undefined,
        });
        bridge.start?.();
        console.log('[dsh-plan-widget] plan-bridge 已加载并启动：planDir=' + settings.planDir);
        // 启动后立即同步一次，生成初始 plan-state.json（plan-bridge 仅在文件变化/显式调用时同步）。
        try {
          const snap = bridge.syncNow?.();
          const dailyFile = snap?.levels?.daily?.file ? snap.levels.daily.file : '(今日无)';
          console.log('[dsh-plan-widget] 初始 plan-state 同步完成：daily=' + dailyFile + ', warnings=' + (snap?.warnings?.length ?? 0));
        } catch (err) {
          console.log('[dsh-plan-widget] 初始 syncNow 失败：' + String(err?.message ?? err));
        }
      } catch (e) {
        bridge = null;
        console.log('[dsh-plan-widget] 创建 plan-bridge 失败：' + String(e?.message ?? e));
      }
    })
    .catch((e) => {
      console.log('[dsh-plan-widget] plan-bridge 尚未安装（未找到 ./plan-bridge.js）：' + String(e?.message ?? e));
    });

  // ---- 创建会话哨兵（只读监听，原子写 session-status.v1） ----
  // 2026-08-26 容错强化：哨兵创建失败只告警不阻断插件树（生产曾因未注入服务取值导致整个 profile 启动失败）
  let sentinel = null;
  try {
    sentinel = createSessionSentinel(ctx, {
      outputPath: settings.sessionStatePath || undefined,
      mainOnly: settings.mainOnly,
      mainSessionMode: settings.mainSessionMode,
      mainSessionId: settings.mainSessionId,
      dshHome,
      port: process.env.DSH_PORT,
    });
  } catch (e) {
    console.log('[dsh-plan-widget] 会话哨兵创建失败（状态面板不可用）：' + String(e?.message ?? e));
  }

  // ---- 注册 DSH 工具 plan_sync + plan_setup ----
  try {
    ctx.tools.register(makePlanSyncTool(() => bridge, settings));
    console.log('[dsh-plan-widget] 已注册 DSH 工具：plan_sync');
  } catch (e) {
    console.log('[dsh-plan-widget] 注册 plan_sync 失败：' + String(e?.message ?? e));
  }
  try {
    ctx.tools.register(makePlanSetupTool(() => bridge, settings, setActivePlanDir, getCurrentPlanDir));
    console.log('[dsh-plan-widget] 已注册 DSH 工具：plan_setup');
  } catch (e) {
    console.log('[dsh-plan-widget] 注册 plan_setup 失败：' + String(e?.message ?? e));
  }

  if (sentinel) sentinel.start();

  // ---- 启动日志（便于验收） ----
  const statePath = settings.sessionStatePath
    || (dshHome ? path.join(dshHome, 'plan-widget', 'session-status.json') : '(未知)');
  const banner = '[dsh-plan-widget] active: planDir=' + (settings.planDir || '(默认)')
    + ', watch=' + settings.watch
    + ', sessionState=' + statePath
    + ', mainOnly=' + settings.mainOnly;
  console.log(banner);

  // ---- [整合需求 2026-09-06] 内置 Web 面板已移除 ----
  // 计划功能已内置到任务看板(读取 plan-state.json)；本插件作为"纯外置数据程序"：
  // 仅保留 plan-bridge(解析 Markdown→plan-state.json) + 会话哨兵(session-status.json) + 工具。
  // 若需恢复 Web 面板, 取消注释下方代码(createWebPanel 已导入)。
  // const webDisposers = [];
  // try {
  //   ctx.inject(['webServer'], (sctx) => { ... createWebPanel ... });
  // } catch (e) { ... }
  console.log('[dsh-plan-widget] Web 面板已移除(集成到任务看板)；保留数据桥/哨兵/工具(纯外置数据程序)');

  // ---- 清理 ----
  ctx.on('dispose', () => {
    if (sentinel) sentinel.stop();
    try { bridge?.stop?.(); } catch {}
    // 2026-09-10 修复：原此处为 `for (const d of webDisposers) { try { d(); } catch {} }`，
    // 而 `const webDisposers = []` 已随 Web 面板一起被注释掉（见上方 "Web 面板已移除" 段），
    // 于是插件卸载 / 热重载时必然抛 ReferenceError: webDisposers is not defined。
    // Web 面板当前停用 → 本就没有 disposer 需要清理，故删除该行；
    // 若将来恢复 Web 面板，请连同上面的 webDisposers 声明与其 for 循环一起取消注释。
  });
}