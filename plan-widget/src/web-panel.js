/**
 * web-panel.js — DSH Web GUI 内置页（浏览器端计划面板的服务器侧）
 *
 * 在 DSH Web profile 内注册【多个 exact 路由】+ 一次 index.html 注入：
 *   - GET  /plan-widget/widget.js    → 浏览器面板脚本（widget.js 原样文本）
 *   - GET  /plan-widget/api/plan     → 读 plan-state.json（容错）
 *   - GET  /plan-widget/api/session  → 读 session-status.json（容错）
 *   - GET  /plan-widget/api/progress → 读共享进度 progress.json（跨端同步真源）
 *   - POST /plan-widget/api/progress → 写入共享进度（读→改 buckets→原子写；{date,taskId,done} 增量）
 *   - tapIndex：在 </body> 前幂等注入 <script defer src="/plan-widget/widget.js">
 *
 * 【路径动态解析】createWebPanel 接受 options.resolvePaths（getter）或静态
 * planStatePath/sessionStatePath 字符串（兼容包装）。各 API 在【每次请求】时调用
 * getter 取当前路径再读文件，保证 plan_setup 运行期改 planDir 后 api/plan 即时生效
 * （修复引导条不消失、用户误以为配置失败的问题）。
 *
 * 进度文件位置：与 plan-state.json 同目录（path.join(dirname(planStatePath), 'progress.json')）。
 * taskId 规则见跨端进度同步协议 v1：<text>|<time>（0 长度 time 用 text）。
 *
 * @module dsh-plan-widget/web-panel
 */

import { readFileSync, existsSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';

/** 内置面板脚本（widget.js 原样内容，浏览器端为经典脚本，非 module）。
 *  D1 读盘化：不再顶层缓存；每次请求读盘，改 widget.js 免重启插件（本次 plan-bridge 仍需一次性重启）。 */
function loadWidgetJs() {
  return readFileSync(new URL('./widget.js', import.meta.url), 'utf8');
}

/** 注入 index.html 的脚本标签（幂等判断依据）。 */
const WIDGET_TAG = '<script defer src="/plan-widget/widget.js"></script>';

/** 进度文件协议 $schema。 */
const PROGRESS_SCHEMA = 'plan-widget/progress.v1';

/**
 * 构造一个 JSON API 响应函数。
 * @param {object} res - http 响应。
 * @param {number} status - HTTP 状态码。
 * @param {object} obj - 要序列化的对象。
 */
function sendJson(res, status, obj) {
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(obj));
  } catch (e) {
    // 忽略写响应失败（客户端已断开等）。
  }
}

/**
 * 读取请求体并解析 JSON。
 * @param {object} req - http 请求。
 * @param {(body:object|null)=>void} cb - 回调（解析失败传 null）。
 */
function readJsonBody(req, cb) {
  let body = '';
  try {
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { cb(JSON.parse(body || '{}')); } catch (e) { cb(null); }
    });
    req.on('error', () => cb(null));
  } catch (e) {
    cb(null);
  }
}

/**
 * 构造读取/解析某个 JSON 产物文件的 API handler（getter 每次请求取当前路径）。
 * @param {() => string|null} getPath - 返回当前文件路径。
 * @param {string} label - 缺失时的提示名（如 "plan-state 未生成"）。
 * @returns {(req:object, res:object)=>void} handler。
 */
function fileApiHandler(getPath, label) {
  return (req, res) => {
    let filePath = null;
    try { filePath = getPath(); } catch (e) { /* 忽略 getter 异常 */ }
    try {
      if (!filePath || !existsSync(filePath)) {
        sendJson(res, 200, { ok: false, reason: label });
        return;
      }
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      sendJson(res, 200, { ok: true, data });
    } catch (e) {
      sendJson(res, 200, { ok: false, reason: String(e?.message ?? e) });
    }
  };
}

/**
 * 构造 GET progress handler：文件不存在→{ok:true,data:null}；损坏→{ok:false,reason}。
 * @param {() => string|null} getProgressPath - 返回当前共享进度路径。
 * @returns {(req:object, res:object)=>void} handler。
 */
function progressGetHandler(getProgressPath) {
  return (req, res) => {
    let progressPath = null;
    try { progressPath = getProgressPath(); } catch (e) { /* 忽略 getter 异常 */ }
    try {
      if (!progressPath || !existsSync(progressPath)) {
        sendJson(res, 200, { ok: true, data: null });
        return;
      }
      const data = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
      sendJson(res, 200, { ok: true, data });
    } catch (e) {
      sendJson(res, 200, { ok: false, reason: String(e?.message ?? e) });
    }
  };
}

/**
 * 构造 POST progress handler：body {date, taskId, done} 增量改 buckets → 原子写。
 * done=true=去重添加；done=false=移除。损坏/参数不合法→{ok:false,reason}。
 * @param {() => string|null} getProgressPath - 返回当前共享进度路径。
 * @returns {(req:object, res:object)=>void} handler。
 */
function progressPostHandler(getProgressPath) {
  return (req, res) => {
    readJsonBody(req, (body) => {
      // 参数校验：date/taskId 非空字符串，done 为 boolean。
      if (!body || typeof body.date !== 'string' || !body.date.trim()
        || typeof body.taskId !== 'string' || !body.taskId.trim()
        || typeof body.done !== 'boolean') {
        sendJson(res, 200, { ok: false, reason: '参数不合法（需 {date:string, taskId:string, done:boolean}）' });
        return;
      }
      let progressPath = null;
      try { progressPath = getProgressPath(); } catch (e) { /* 忽略 getter 异常 */ }
      if (!progressPath) {
        sendJson(res, 200, { ok: false, reason: 'progressPath 未配置' });
        return;
      }
      try {
        let data;
        if (existsSync(progressPath)) {
          data = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
        } else {
          data = { $schema: PROGRESS_SCHEMA, buckets: {}, updatedAt: new Date().toISOString() };
        }
        // 结构容错：缺 buckets 视为损坏。
        if (!data || typeof data !== 'object' || !data.buckets || typeof data.buckets !== 'object' || Array.isArray(data.buckets)) {
          throw new Error('progress.json 结构损坏（缺 buckets 对象）');
        }
        const date = body.date.trim();
        const taskId = body.taskId.trim();
        const arr = Array.isArray(data.buckets[date]) ? data.buckets[date] : (data.buckets[date] = []);
        if (body.done) {
          if (arr.indexOf(taskId) === -1) arr.push(taskId); // 去重添加
        } else {
          const idx = arr.indexOf(taskId);
          if (idx !== -1) arr.splice(idx, 1); // 移除
        }
        data.updatedAt = new Date().toISOString();
        // 原子写：临时文件 + rename。
        fs.mkdirSync(path.dirname(progressPath), { recursive: true });
        const tmp = progressPath + '.tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tmp, progressPath);
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 200, { ok: false, reason: String(e?.message ?? e) });
      }
    });
  };
}

/**
 * 创建 Web 内置面板（注册路由 + 注入脚本 + 原子清理）。
 * @param {object} ctx - 已注入 webServer 服务的 sctx（ctx.inject(['webServer'], sctx => ...)）。
 * @param {object} [options] - 选项。
 * @param {() => ({planStatePath:string|null, sessionStatePath:string|null})} [options.resolvePaths] - 每次请求动态解析路径的 getter。
 * @param {string|null} [options.planStatePath] - 兼容：静态 plan-state.json 路径（有 resolvePaths 时忽略）。
 * @param {string|null} [options.sessionStatePath] - 兼容：静态 session-status.json 路径。
 * @returns {{dispose:Function}} 面板句柄（dispose 注销全部路由/注入）。
 */
export function createWebPanel(ctx, options = {}) {
  // 路径解析：优先 resolvePaths getter；否则用静态字符串包装（兼容）。
  const resolvePaths = typeof options.resolvePaths === 'function'
    ? options.resolvePaths
    : (() => ({
        planStatePath: typeof options.planStatePath === 'string' ? options.planStatePath : null,
        sessionStatePath: typeof options.sessionStatePath === 'string' ? options.sessionStatePath : null,
      }));
  const getPlanStatePath = () => { const p = resolvePaths(); return (p && p.planStatePath) ?? null; };
  const getSessionStatePath = () => { const p = resolvePaths(); return (p && p.sessionStatePath) ?? null; };
  // 进度文件与 plan-state 同目录（每次请求按当前 planStatePath 推导）。
  const getProgressPath = () => { const ps = getPlanStatePath(); return ps ? path.join(path.dirname(ps), 'progress.json') : null; };

  const disposers = [];

  // -- 1) 面板脚本路由 --
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/plan-widget/widget.js',
    handler: (req, res) => {
      try {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(loadWidgetJs());
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('widget.js 不可用：' + String(e?.message ?? e));
      }
    },
  }));

  // -- 2) plan API（动态路径） --
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/plan-widget/api/plan',
    handler: fileApiHandler(getPlanStatePath, 'plan-state 未生成'),
  }));

  // -- 3) session API（动态路径） --
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/plan-widget/api/session',
    handler: fileApiHandler(getSessionStatePath, 'session-status 未生成'),
  }));

  // -- 4) progress GET/POST（单路由，按 method 分发；动态路径） --
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/plan-widget/api/progress',
    handler: (req, res) => {
      if (req?.method === 'POST') progressPostHandler(getProgressPath)(req, res);
      else progressGetHandler(getProgressPath)(req, res);
    },
  }));

  // -- 6) 幂等注入面板脚本到 index.html --
  disposers.push(ctx.webServer.tapIndex((html) => {
    if (typeof html !== 'string') return html;
    if (html.indexOf('/plan-widget/widget.js') !== -1) return html;
    if (html.indexOf('</body>') !== -1) return html.replace('</body>', WIDGET_TAG + '</body>');
    return html + WIDGET_TAG;
  }));

  return {
    dispose() {
      for (const d of disposers.splice(0)) {
        try { d(); } catch (e) { /* 忽略单个注销失败 */ }
      }
    },
  };
}
