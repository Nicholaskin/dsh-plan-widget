/**
 * web-panel.test.js — DSH Web 内置页服务器侧单元测试（node:test）
 *
 * mock ctx.webServer：register 收集路由、tapIndex 收集 transform；
 * 验证 5 类路由存在 + 幂等注入函数 + api handler（plan/session/progress，含 GET/POST、增删/去重/原子写/损坏/参数校验）+ dispose 清理。
 * 不依赖 cordis 实装。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createWebPanel } from '../src/web-panel.js';

function makeMockWebServer() {
  const routes = [];
  const taps = [];
  let disposed = 0;
  return {
    routes, taps,
    register(opts) { routes.push(opts); return () => { disposed++; }; },
    tapIndex(fn) { taps.push(fn); return () => { disposed++; }; },
    disposedCount: () => disposed,
  };
}

function makeMockRes() {
  return {
    status: null, headers: null, body: null,
    writeHead(s, h) { this.status = s; this.headers = h; },
    end(b) { this.body = b; },
  };
}

// mock req：on() 存处理器，emit() 喂 JSON body 并触发 end（驱动 readJsonBody）。
function makeMockReq(bodyObj, method) {
  const h = {};
  return {
    method: method || 'GET',
    on(ev, fn) { h[ev] = fn; },
    emit() { if (h['data']) h['data'](JSON.stringify(bodyObj)); if (h['end']) h['end'](); },
  };
}

function writeTempJson(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgw-web-'));
  const fp = path.join(dir, 'data.json');
  fs.writeFileSync(fp, JSON.stringify(obj), 'utf8');
  return { fp, dir };
}

// 按路径（可选 method）取 handler；GET 路由无 method，POST 路由 method==='POST'。
function handlerFor(ws, p) {
  const r = ws.routes.find((x) => x.path === p);
  return r ? r.handler : null;
}

// 便捷：POST progress 并回读响应。
function postProgress(ws, body) {
  const post = handlerFor(ws, '/plan-widget/api/progress');
  const res = makeMockRes();
  const req = makeMockReq(body, 'POST');
  post(req, res);
  req.emit();
  return JSON.parse(res.body);
}
function getProgress(ws) {
  const res = makeMockRes();
  handlerFor(ws, '/plan-widget/api/progress')({}, res);
  return JSON.parse(res.body);
}

test('1. 注册 4 类路由（widget / api/plan / api/session / api/progress 单路由 GET+POST 分发），均 exact', () => {
  const ws = makeMockWebServer();
  createWebPanel({ webServer: ws }, { planStatePath: null, sessionStatePath: null });
  assert.ok(ws.routes.length >= 4);
  assert.ok(ws.routes.every((r) => r.kind === 'exact'));
  const paths = ws.routes.map((r) => r.path);
  assert.ok(paths.includes('/plan-widget/widget.js'));
  assert.ok(paths.includes('/plan-widget/api/plan'));
  assert.ok(paths.includes('/plan-widget/api/session'));
  const progressRoutes = ws.routes.filter((r) => r.path === '/plan-widget/api/progress');
  assert.equal(progressRoutes.length, 1);
});

test('2. tapIndex 注入脚本到 </body> 前', () => {
  const ws = makeMockWebServer();
  createWebPanel({ webServer: ws }, { planStatePath: null, sessionStatePath: null });
  const out = ws.taps[0]('<html><head></head><body>x</body></html>');
  assert.ok(out.indexOf('<script defer src="/plan-widget/widget.js"></script>') !== -1);
});

test('3. tapIndex 幂等：已含脚本则原样返回', () => {
  const ws = makeMockWebServer();
  createWebPanel({ webServer: ws }, { planStatePath: null, sessionStatePath: null });
  const html = '<html><body><script defer src="/plan-widget/widget.js"></script></body></html>';
  assert.equal(ws.taps[0](html), html);
});

test('4. api/plan 文件缺失 → ok:false；存在 → ok:true,data', () => {
  const ws = makeMockWebServer();
  createWebPanel({ webServer: ws }, { planStatePath: 'D:/no/plan.json', sessionStatePath: null });
  const res = makeMockRes();
  handlerFor(ws, '/plan-widget/api/plan')({}, res);
  assert.equal(JSON.parse(res.body).ok, false);
  const { fp, dir } = writeTempJson({ levels: { daily: { current: { task: { now: '起床' } } } } });
  const ws2 = makeMockWebServer();
  createWebPanel({ webServer: ws2 }, { planStatePath: fp, sessionStatePath: null });
  const res2 = makeMockRes();
  handlerFor(ws2, '/plan-widget/api/plan')({}, res2);
  assert.equal(JSON.parse(res2.body).data.levels.daily.current.task.now, '起床');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('5. api/session 文件缺失 → ok:false；存在 → ok:true,data.main.state', () => {
  const ws = makeMockWebServer();
  createWebPanel({ webServer: ws }, { planStatePath: null, sessionStatePath: 'D:/no/session.json' });
  const resA = makeMockRes();
  handlerFor(ws, '/plan-widget/api/session')({}, resA);
  assert.equal(JSON.parse(resA.body).ok, false);
  const { fp, dir } = writeTempJson({ main: { state: 'working' } });
  const ws2 = makeMockWebServer();
  createWebPanel({ webServer: ws2 }, { planStatePath: null, sessionStatePath: fp });
  const res = makeMockRes();
  handlerFor(ws2, '/plan-widget/api/session')({}, res);
  assert.equal(JSON.parse(res.body).data.main.state, 'working');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('6. GET progress 无文件 → ok:true data:null', () => {
  const ws = makeMockWebServer();
  createWebPanel({ webServer: ws }, { planStatePath: 'D:/no/plan-state.json', sessionStatePath: null });
  const r = getProgress(ws);
  assert.equal(r.ok, true);
  assert.equal(r.data, null);
});

test('7. POST progress 增：ok:true → 再 GET buckets 含该 id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgw-prog-'));
  const planState = path.join(dir, 'plan-state.json');
  fs.writeFileSync(planState, '{}');
  const ws = makeMockWebServer();
  createWebPanel({ webServer: ws }, { planStatePath: planState, sessionStatePath: null });
  assert.equal(postProgress(ws, { date: '2026-08-20', taskId: '晨读|07:00-07:40', done: true }).ok, true);
  const r = getProgress(ws);
  assert.ok(r.ok);
  assert.deepEqual(r.data.buckets['2026-08-20'], ['晨读|07:00-07:40']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('8. POST progress 去重：同 id 两次 add 只保留一项', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgw-prog-'));
  fs.writeFileSync(path.join(dir, 'plan-state.json'), '{}');
  const ws = makeMockWebServer();
  createWebPanel({ webServer: ws }, { planStatePath: path.join(dir, 'plan-state.json'), sessionStatePath: null });
  assert.equal(postProgress(ws, { date: 'D', taskId: 'A|08:00', done: true }).ok, true);
  assert.equal(postProgress(ws, { date: 'D', taskId: 'A|08:00', done: true }).ok, true);
  assert.deepEqual(getProgress(ws).data.buckets['D'], ['A|08:00']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('9. POST progress 删：done:false 移除 → GET 缺该 id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgw-prog-'));
  fs.writeFileSync(path.join(dir, 'progress.json'), JSON.stringify({ $schema: 'plan-widget/progress.v1', buckets: { 'D': ['A|08:00', 'B|09:00'] }, updatedAt: new Date().toISOString() }));
  const ws = makeMockWebServer();
  createWebPanel({ webServer: ws }, { planStatePath: path.join(dir, 'plan-state.json'), sessionStatePath: null });
  assert.equal(postProgress(ws, { date: 'D', taskId: 'A|08:00', done: false }).ok, true);
  assert.deepEqual(getProgress(ws).data.buckets['D'], ['B|09:00']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('10. POST progress 损坏文件 → ok:false + reason；无 .tmp 残留', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgw-prog-'));
  fs.writeFileSync(path.join(dir, 'plan-state.json'), '{}');
  fs.writeFileSync(path.join(dir, 'progress.json'), '{broken'); // 损坏
  const ws = makeMockWebServer();
  createWebPanel({ webServer: ws }, { planStatePath: path.join(dir, 'plan-state.json'), sessionStatePath: null });
  const r = postProgress(ws, { date: 'D', taskId: 'A|08:00', done: true });
  assert.equal(r.ok, false);
  assert.ok((r.reason || '').length > 0);
  const tmps = fs.readdirSync(dir).filter((n) => n.indexOf('.tmp-') !== -1);
  assert.equal(tmps.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('11. POST progress 参数不合法（缺 done）→ ok:false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgw-prog-'));
  fs.writeFileSync(path.join(dir, 'plan-state.json'), '{}');
  const ws = makeMockWebServer();
  createWebPanel({ webServer: ws }, { planStatePath: path.join(dir, 'plan-state.json'), sessionStatePath: null });
  assert.equal(postProgress(ws, { date: 'D', taskId: 'A|08:00' }).ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('12. POST progress 原子写：无 .tmp 残留；$schema + bucket 数组合法', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgw-prog-'));
  fs.writeFileSync(path.join(dir, 'plan-state.json'), '{}');
  const ws = makeMockWebServer();
  createWebPanel({ webServer: ws }, { planStatePath: path.join(dir, 'plan-state.json'), sessionStatePath: null });
  assert.equal(postProgress(ws, { date: '2026-08-20', taskId: '读报|07:00', done: true }).ok, true);
  const tmps = fs.readdirSync(dir).filter((n) => n.indexOf('.tmp-') !== -1);
  assert.equal(tmps.length, 0);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'progress.json'), 'utf8'));
  assert.equal(raw.$schema, 'plan-widget/progress.v1');
  assert.ok(Array.isArray(raw.buckets['2026-08-20']));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('13. widget.js 路由返回脚本内容并带正确响应头', () => {
  const ws = makeMockWebServer();
  createWebPanel({ webServer: ws }, { planStatePath: null, sessionStatePath: null });
  const res = makeMockRes();
  handlerFor(ws, '/plan-widget/widget.js')({}, res);
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'application/javascript; charset=utf-8');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.ok(res.body.indexOf('__kp_') !== -1);
});

test('14. createWebPanel 返回 dispose，调用时清理全部 disposer（5 路由 + 1 tapIndex）', () => {
  const ws = makeMockWebServer();
  const wp = createWebPanel({ webServer: ws }, { planStatePath: null, sessionStatePath: null });
  const before = ws.disposedCount();
  wp.dispose();
  assert.ok(ws.disposedCount() >= before + 5);
});

// 动态路径：resolvePaths getter 每次请求取当前路径（修复 plan_setup 运行期改 planDir 后 api/plan 仍读旧路径）。
test('15. resolvePaths 动态：A 有数据 → 切 B 无文件 → 切回 A 恢复', () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'kgw-dyn-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'kgw-dyn-'));
  const pa = path.join(dirA, 'plan-state.json');
  fs.writeFileSync(pa, JSON.stringify({ today: { tasks: [{ text: 'A任务' }] } }));
  const holder = { planStatePath: pa, sessionStatePath: null };
  const ws = makeMockWebServer();
  createWebPanel({ webServer: ws }, { resolvePaths: () => ({ planStatePath: holder.planStatePath, sessionStatePath: holder.sessionStatePath }) });
  // A：有数据
  let res = makeMockRes();
  handlerFor(ws, '/plan-widget/api/plan')({}, res);
  assert.equal(JSON.parse(res.body).ok, true);
  assert.equal(JSON.parse(res.body).data.today.tasks[0].text, 'A任务');
  // 切到 B（无文件）
  holder.planStatePath = path.join(dirB, 'plan-state.json');
  res = makeMockRes();
  handlerFor(ws, '/plan-widget/api/plan')({}, res);
  assert.equal(JSON.parse(res.body).ok, false);
  // 切回 A：恢复
  holder.planStatePath = pa;
  res = makeMockRes();
  handlerFor(ws, '/plan-widget/api/plan')({}, res);
  assert.equal(JSON.parse(res.body).ok, true);
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
});

test('16. resolvePaths 动态：progress 路径随 planStatePath 切换（随 A 有进度 → 随 B 无进度 data null）', () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'kgw-dyn-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'kgw-dyn-'));
  const pa = path.join(dirA, 'plan-state.json');
  fs.writeFileSync(pa, '{}');
  const holder = { planStatePath: pa, sessionStatePath: null };
  const ws = makeMockWebServer();
  createWebPanel({ webServer: ws }, { resolvePaths: () => ({ planStatePath: holder.planStatePath, sessionStatePath: holder.sessionStatePath }) });
  // 随 A：POST progress 建成 → GET progress 有数据
  let res = makeMockRes();
  const req = makeMockReq({ date: '2026-08-20', taskId: '读报|07:00', done: true }, 'POST');
  handlerFor(ws, '/plan-widget/api/progress')(req, res);
  req.emit();
  assert.equal(JSON.parse(res.body).ok, true);
  res = makeMockRes();
  handlerFor(ws, '/plan-widget/api/progress')({}, res);
  assert.equal(JSON.parse(res.body).data.buckets['2026-08-20'].includes('读报|07:00'), true);
  // 切到 B（无 progress）→ GET progress data null
  holder.planStatePath = path.join(dirB, 'plan-state.json');
  res = makeMockRes();
  handlerFor(ws, '/plan-widget/api/progress')({}, res);
  assert.equal(JSON.parse(res.body).data, null);
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
});

