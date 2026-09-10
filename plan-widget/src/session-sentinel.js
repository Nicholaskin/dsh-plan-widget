/**
 * session-sentinel.js — 会话哨兵（只读监听，不注入事件）
 *
 * 在 DSH 进程内监听 session/created、session/event、session/disposed，
 * 按"最近活动主会话"跑一个最小会话状态机，并把状态按【输出协议 v1】
 * 原子写入 JSON 文件，供客户端（悬浮窗）轮询渲染。
 *
 * 本模块【不 append 事件、不修改会话】——只读订阅；生产依赖仅 cordis，
 * 通过 ctx.on('session/event', fn) 订阅（与 GATE-1b 探针一致的注入方式）。
 *
 * GATE-1b 已落地的结论：
 *   - 主会话过滤：header.origin==='subagent' 或 delegationDepth>0 → 忽略；
 *     多个主会话时按"最近活动"（lastActivity 降序，平局按 createdAt 降序）取其一。
 *   - 状态机：turn/start→working；turn/end completed→waiting（doneAfterMs 无新事件→done），
 *     其他 reason→done；user/message 无 open turn→waiting；模型产出/工具(open turn)→working。
 *   - 忽略 harness 自动事件：permission/preset、sandbox/mode、approval/policy、session/title。
 *   - step/start、step/end 不改状态（仅调试记录）。
 *   - 无主会话 → main=null；waiting 超 idleAfterMs→idle。
 *
 * @module dsh-plan-widget/session-sentinel
 */

import path from 'node:path';
import fs from 'node:fs';

/** 不入状态机的 harness 自动事件类型。 */
const IGNORED_EVENT_TYPES = new Set(['permission/preset', 'sandbox/mode', 'approval/policy', 'session/title']);
/** 仅调试记录、不改状态的事件类型。 */
const DEBUG_ONLY_EVENT_TYPES = new Set(['step/start', 'step/end']);
/** 会话状态历史最大保留条数。 */
const HISTORY_LIMIT = 10;
/** "最后一条助手文本"的最大展示长度。 */
const LATEST_TEXT_LIMIT = 80;

/**
 * 计算默认输出路径：DSH_HOME + '/plan-widget/session-status.json'。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} options - 创建选项。
 * @param {string|null} dshHome - 已解析的 DSH_HOME。
 * @returns {string|null} 输出路径（无法确定时返回 null）。
 */
function defaultOutputPath(ctx, options, dshHome) {
  // 2026-08-26 修复：只读 process.env.DSH_HOME（cordis 对未注入服务（ctx.env）取值会抛 "without inject"，
  // 且生产启动方式（手动 dsh web）不设 DSH_HOME 环境变量——取不到时用用户主目录下的 .dsh 兜底（DSH 默认）。
  const base = dshHome || process.env.DSH_HOME || (typeof process.env.USERPROFILE === 'string' ? path.join(process.env.USERPROFILE, '.dsh') : null);
  return base ? path.join(base, 'plan-widget', 'session-status.json') : null;
}

/**
 * 从一条 assistant/message 事件里抽取可见文本块并拼接。
 * @param {object} message - 事件里的 message 对象（含 content 数组）。
 * @returns {string} 拼接后的文本（可能为空串）。
 */
function extractAssistantText(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content
    .filter((b) => b && b.type === 'text')
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .join(' ');
}

/**
 * 创建会话哨兵。
 * @param {object} ctx - Cordis 上下文（需支持 ctx.on(...)，mock 用 EventEmitter 模拟）。
 * @param {object} [options] - 选项。
 * @param {string} [options.outputPath] - 输出 JSON 路径（缺省按 DSH_HOME 推断）。
 * @param {boolean} [options.mainOnly=true] - 是否仅跟踪主会话。
 * @param {number} [options.idleAfterMs=30000] - waiting 超过此时长(无事件)→idle。
 * @param {number} [options.doneAfterMs=2000] - completed turn 后无新事件→done 的时长。
 * @param {number} [options.writeIntervalMs=2000] - 周期性写盘间隔（<=0 则只手动写）。
 * @param {number|string} [options.port] - 实例端口（缺省读 env/DSH_PORT）。
 * @param {string} [options.dshHome] - DSH_HOME 覆盖值。
 * @param {string} [options.instanceName] - 实例显示名。
 * @param {() => number} [options.now] - 可注入时钟（测试用，默认 Date.now）。
 * @returns {{start:Function, stop:Function, getStatus:Function}} 哨兵句柄。
 */
export function createSessionSentinel(ctx, options = {}) {
  // ---- 解析选项 ----
  const now = options.now ?? (() => Date.now());
  const idleAfterMs = options.idleAfterMs ?? 30000;
  const doneAfterMs = options.doneAfterMs ?? 2000;
  const writeIntervalMs = options.writeIntervalMs ?? 2000;
  const mainOnly = options.mainOnly ?? true;
  const mainSessionMode = options.mainSessionMode === 'id' ? 'id' : 'auto';
  const mainSessionId = typeof options.mainSessionId === 'string' ? options.mainSessionId : '';
  const rawPort = options.port ?? process.env.DSH_PORT ?? process.env.PORT;
  const port = rawPort === undefined || rawPort === null || rawPort === '' ? null : Number(rawPort);
  // 2026-08-26 修复：不经 ctx.env 读 DSH_HOME（cordis 对未注入服务取值会抛 "without inject"，生产环境已验证）
  const dshHome = options.dshHome ?? (process.env.DSH_HOME ?? null);
  const instanceName = options.instanceName ?? 'dsh-plan-widget';
  const outputPath = (options.outputPath && String(options.outputPath).trim())
    ? String(options.outputPath).trim()
    : defaultOutputPath(ctx, options, dshHome);

  /** 各会话的哨兵记录（按 session.header.id 键控）。 */
  const sessions = new Map();
  /** 主会话状态变化历史（最近 HISTORY_LIMIT 条 {at,state}）。 */
  const history = [];
  /** 周期写盘定时器句柄。 */
  let writeTimer = null;
  /** 订阅的反注销函数集合（stop 时统一清理）。 */
  const unsubscribers = [];

  /** 新建一条会话记录。 */
  function newRecord(header) {
    const t = now();
    return {
      id: header.id,
      header: { ...header },
      state: 'idle',
      stateSince: t,
      turnOpen: false,
      lastCompleted: false,
      queued: false,
      lastEventType: '',
      lastActivity: t,
      latestText: '',
      reason: '',
    };
  }

  /** 取/建某会话记录。 */
  function getRecord(header) {
    const id = header?.id ?? String(header?.id);
    if (!sessions.has(id)) {
      sessions.set(id, newRecord(header ?? { id }));
      const rec = sessions.get(id);
      if (isMainSession(rec.header)) pushHistory(rec.state, now());
    }
    return sessions.get(id);
  }

  /** 是否主会话（非子代理）。 */
  function isMainSession(header) {
    const origin = header?.origin;
    const depth = header?.delegationDepth ?? 0;
    if (origin === 'subagent' || (Number(depth) > 0)) return false;
    return true;
  }

  /** 是否应纳入 Main 视图（mainOnly 时仅主会话）。 */
  function eligibleForMain(header) {
    return mainOnly ? isMainSession(header) : true;
  }

  /** 追加一条主会话状态历史。 */
  function pushHistory(state, t) {
    history.push({ at: new Date(t).toISOString(), state });
    if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
  }

  /**
   * 状态迁移：更新 state/stateSince + reason，并在（主）会话上追加历史。
   * @param {object} rec - 会话记录。
   * @param {string} newState - 目标状态。
   * @param {number} t - 时间戳。
   * @param {string} [reason] - 附带原因。
   */
  function transition(rec, newState, t, reason = '') {
    if (rec.state === newState) {
      if (reason) rec.reason = reason;
      return;
    }
    rec.state = newState;
    rec.stateSince = t;
    rec.reason = reason;
    if (eligibleForMain(rec.header)) pushHistory(newState, t);
  }

  /**
   * 处理一条会话事件：更新状态机。
   * @param {object} session - 会话对象。
   * @param {object} event - 事件对象。
   */
  function handleEvent(session, event) {
    const header = session?.header ?? {};
    const rec = getRecord(header);
    const type = event?.type ?? '';
    const data = event?.data ?? {};
    const t = now();

    // 任何事件都视为"活动"，刷新最后活动时间与最近事件类型。
    rec.lastActivity = t;
    rec.lastEventType = type;

    // harness 自动事件：不改状态（仅更新活动时间/类型）。
    if (IGNORED_EVENT_TYPES.has(type)) return;

    if (type === 'turn/start') {
      rec.turnOpen = true;
      rec.lastCompleted = false;
      rec.queued = false;
      transition(rec, 'working', t);

    } else if (type === 'turn/end') {
      rec.turnOpen = false;
      const kind = data.reason?.kind;
      if (kind === 'completed') {
        rec.lastCompleted = true;
        rec.queued = false;
        transition(rec, 'waiting', t);
      } else {
        rec.lastCompleted = false;
        transition(rec, 'done', t, kind);
      }

    } else if (type === 'user/message') {
      // 用户消息：无 open turn → 排队等待指示（后续 turn/start 会转 working）。
      if (data.source?.kind === 'user' && !rec.turnOpen) {
        rec.queued = true;
        rec.lastCompleted = false; // 用户已给指示，不再因"completed 后静默"而自动 done
        transition(rec, 'waiting', t);
      }

    } else if (type === 'assistant/chunk' || type === 'assistant/message' || type === 'tool/call') {
      if (rec.turnOpen) transition(rec, 'working', t);
      if (type === 'assistant/message') rec.latestText = extractAssistantText(data.message);

    } else if (type === 'assistant/message') {
      rec.latestText = extractAssistantText(data.message);
    }
    // DEBUG_ONLY_EVENT_TYPES（step/start、step/end）与其余事件：不改状态，仅上面更新了活动时间。
  }

  /**
   * 评估超时驱动的状态迁移（waiting→done / waiting|working→idle）。
   * 在 getStatus 与周期性写盘前调用，保证返回的状态已反映超时。
   */
  function evaluateTimers() {
    const t = now();
    for (const rec of sessions.values()) {
      const quiet = t - rec.lastActivity;
      if (rec.state === 'waiting') {
        if (rec.lastCompleted && quiet >= doneAfterMs) {
          transition(rec, 'done', rec.lastActivity + doneAfterMs);
        } else if (quiet >= idleAfterMs) {
          transition(rec, 'idle', rec.lastActivity + idleAfterMs);
        }
      } else if (rec.state === 'working' && quiet >= idleAfterMs) {
        transition(rec, 'idle', rec.lastActivity + idleAfterMs);
      }
    }
  }

  /**
   * 挑选"最近活动"的主会话。
   * @returns {object|null} 选中的记录。
   */
  function selectMain() {
    evaluateTimers();
    const candidates = [];
    for (const rec of sessions.values()) {
      if (eligibleForMain(rec.header)) candidates.push(rec);
    }
    // 指定模式：仅接受指定会话 ID（找不到则返回 null 并提示一次）。
    if (mainSessionMode === 'id') {
      const hit = candidates.find((c) => c.id === mainSessionId);
      if (hit) return hit;
      console.log('[dsh-plan-widget] 指定主会话模式：未找到会话 ID=' + mainSessionId + '（检索 ' + candidates.length + ' 个候选，检查 PLAN_WIDGET_MAIN_SESSION_ID）');
      return null;
    }
    if (candidates.length === 0) return null;
    // 最近活动优先（lastActivity 降序），平局按 createdAt 降序。
    return candidates.slice().sort((a, b) => {
      const d = (b.lastActivity || 0) - (a.lastActivity || 0);
      return d !== 0 ? d : ((b.header?.createdAt || 0) - (a.header?.createdAt || 0));
    })[0];
  }

  /** 把一条记录序列化为 MainSession 协议对象。 */
  function toMain(rec) {
    return {
      sessionId: rec.id,
      state: rec.state,
      since: new Date(rec.stateSince).toISOString(),
      reasons: { turnOpen: rec.turnOpen, lastEventType: rec.lastEventType },
      latest: { text: rec.latestText.slice(0, LATEST_TEXT_LIMIT) },
    };
  }

  /**
   * 生成输出协议 v1 对象。
   * @returns {object} session-status v1。
   */
  function getStatus() {
    const main = selectMain();
    return {
      $schema: 'plan-widget/session-status.v1',
      updatedAt: new Date(now()).toISOString(),
      instance: { port, dshHome, name: instanceName },
      main: main ? toMain(main) : null,
      history: history.slice(),
    };
  }

  /**
   * 原子写盘：临时文件 + rename。
   * @param {object} status - 状态对象。
   * @returns {boolean} 是否成功写入。
   */
  function writeStatus(status) {
    if (!outputPath) return false;
    try {
      const dir = path.dirname(outputPath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = outputPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(status, null, 2), 'utf8');
      fs.renameSync(tmp, outputPath);
      return true;
    } catch (e) {
      try {
        console.log('[dsh-plan-widget] 写 session-status 失败：' + String(e?.message ?? e));
      } catch {}
      return false;
    }
  }

  // ---- 订阅（哨兵只读监听，不注入事件） ----
  const subCreate = ctx.on('session/created', (session) => {
    const header = session?.header ?? {};
    getRecord(header);
  });
  const subEvent = ctx.on('session/event', (session, event) => handleEvent(session, event));
  const subDisposed = ctx.on('session/disposed', (session) => {
    const header = session?.header ?? {};
    const rec = sessions.get(header?.id);
    if (rec) transition(rec, 'done', now());
  });
  // ctx.on 可能返回反注销函数，也可能返回 void（mock 可返回函数）。
  const pushUnsub = (f) => { if (typeof f === 'function') unsubscribers.push(f); };
  pushUnsub(subCreate); pushUnsub(subEvent); pushUnsub(subDisposed);

  /**
   * 启动：写一次初始状态 + 周期写盘。
   */
  function start() {
    if (outputPath) writeStatus(getStatus());
    if (writeIntervalMs > 0 && !writeTimer) {
      writeTimer = setInterval(() => {
        try { writeStatus(getStatus()); } catch {}
      }, writeIntervalMs);
      if (typeof writeTimer.unref === 'function') writeTimer.unref();
    }
  }

  /**
   * 停止：清理定时器与订阅。
   */
  function stop() {
    if (writeTimer) { clearInterval(writeTimer); writeTimer = null; }
    for (const unsub of unsubscribers.splice(0)) {
      try { unsub(); } catch {}
    }
  }

  return { start, stop, getStatus };
}
