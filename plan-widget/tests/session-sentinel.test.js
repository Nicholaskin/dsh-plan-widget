/**
 * session-sentinel.test.js — 会话哨兵单元测试（node:test）
 *
 * 用 mock ctx（EventEmitter 模拟）替代 cordis 实装，验证 createSessionSentinel：
 *   1) 主会话过滤（subagent/深度>0 忽略）
 *   2) 状态机状态转换（working/waiting/done）
 *   3) 忽略 harness 自动事件（permission/preset 等不改状态）
 *   4) done 定时（completed 后 doneAfterMs 无新事件→done）与 idle 定时
 *   5) 输出协议 v1 字段
 *   6) 原子写盘（临时文件+rename）
 *   7) 无会话 → main=null
 *   8) 多个主会话 → 取最近活动者
 *   9) lastEventType / latest.text（assistant 文本截断 80 字）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createSessionSentinel } from '../src/session-sentinel.js';

/** 构造一个 EventEmitter 型 mock ctx（支持 on / emit / logger）。 */
function makeMockCtx() {
  const emitter = new EventEmitter();
  return {
    on: (ev, fn) => { emitter.on(ev, fn); return () => emitter.off(ev, fn); },
    emit: (ev, ...args) => emitter.emit(ev, ...args),
    env: {},
    logger: { info() {}, warn() {}, error() {} },
  };
}

/** 构造一个可控制时钟。 */
function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, ahead: (ms) => { t += ms; } };
}

/** 会话对象（带 header）。 */
function sess(id, headerExtra = {}) {
  return { header: { id, createdAt: 1, ...headerExtra } };
}

/** 事件对象。 */
function ev(type, data = {}) {
  return { type, data };
}

/** 构造哨兵（默认不写盘、不开周期定时，用可控制时钟）。 */
function makeSentinel(ctx, clock, overrides = {}) {
  return createSessionSentinel(ctx, {
    now: clock.now,
    mainOnly: true,
    idleAfterMs: 30000,
    doneAfterMs: 2000,
    writeIntervalMs: 0,
    dshHome: null,
    ...overrides,
  });
}

/** 用户消息事件（source.kind=user）。 */
const userMsg = (text) => ev('user/message', {
  id: 'msg-u', role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
});

/** 助手消息事件（source.kind=model）。 */
const asstMsg = (text) => ev('assistant/message', {
  turn: 1, step: 1,
  message: { id: 'msg-a', role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' } },
});

test('1. 主会话过滤：subagent/深度>0 被忽略', () => {
  const ctx = makeMockCtx();
  const clock = makeClock();
  const s = makeSentinel(ctx, clock);
  s.start();
  // 创建主会话与子会话
  ctx.emit('session/created', sess('main-A'));
  ctx.emit('session/created', sess('sub-B', { origin: 'subagent', delegationDepth: 1 }));
  ctx.emit('session/created', sess('sub-C', { delegationDepth: 1 }));
  // 给子会话注入活动（应被忽略）
  ctx.emit('session/event', sess('sub-B', { origin: 'subagent', delegationDepth: 1 }), ev('turn/start'));
  ctx.emit('session/event', sess('sub-C', { delegationDepth: 1 }), ev('turn/start'));
  ctx.emit('session/event', sess('main-A'), ev('turn/start'));
  const status = s.getStatus();
  assert.equal(status.main.sessionId, 'main-A');
  assert.equal(status.main.state, 'working');
});

test('2. 状态机转换：working→waiting(completed)→done，blocked→done', () => {
  const ctx = makeMockCtx();
  const clock = makeClock();
  const s = makeSentinel(ctx, clock);
  s.start();
  ctx.emit('session/created', sess('M'));
  ctx.emit('session/event', sess('M'), ev('turn/start', { turn: 1 }));
  assert.equal(s.getStatus().main.state, 'working');           // turn/start → working
  ctx.emit('session/event', sess('M'), ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  assert.equal(s.getStatus().main.state, 'waiting');           // completed → waiting
  clock.ahead(2500);
  assert.equal(s.getStatus().main.state, 'done');              // doneAfterMs 后 → done
  // blocked 直接 done
  const s2 = (() => { const c = makeMockCtx(); const clk = makeClock(); const x = makeSentinel(c, clk); x.start(); return { c, clk, x }; })();
  s2.c.emit('session/created', sess('M2'));
  s2.c.emit('session/event', sess('M2'), ev('turn/start', { turn: 1 }));
  s2.c.emit('session/event', sess('M2'), ev('turn/end', { turn: 1, reason: { kind: 'blocked' } }));
  assert.equal(s2.x.getStatus().main.state, 'done');
});

test('3. 忽略 harness 自动事件：状态保持 idle', () => {
  const ctx = makeMockCtx();
  const clock = makeClock();
  const s = makeSentinel(ctx, clock);
  s.start();
  ctx.emit('session/created', sess('M'));
  // 注入 harne ss 自动事件
  ctx.emit('session/event', sess('M'), ev('permission/preset'));
  ctx.emit('session/event', sess('M'), ev('sandbox/mode'));
  ctx.emit('session/event', sess('M'), ev('approval/policy'));
  ctx.emit('session/event', sess('M'), ev('session/title'));
  const status = s.getStatus();
  assert.equal(status.main.state, 'idle');                     // 未被 harness 事件改状态
});

test('4. user/message 无 open turn → waiting(排队)；assistant 有 open turn → working', () => {
  const ctx = makeMockCtx();
  const clock = makeClock();
  const s = makeSentinel(ctx, clock);
  s.start();
  ctx.emit('session/created', sess('M'));
  // 无 open turn 的用户消息 → 排队 waiting
  ctx.emit('session/event', sess('M'), userMsg('今天做什么？'));
  assert.equal(s.getStatus().main.state, 'waiting');
  // 随后 turn/start → working
  ctx.emit('session/event', sess('M'), ev('turn/start', { turn: 1 }));
  assert.equal(s.getStatus().main.state, 'working');
  // assistant/message（open turn）→ working
  ctx.emit('session/event', sess('M'), asstMsg('今天先做资料分析。'));
  assert.equal(s.getStatus().main.state, 'working');
});

test('5. done/idle 定时：waiting 超 idleAfterMs → idle', () => {
  const ctx = makeMockCtx();
  const clock = makeClock();
  const s = makeSentinel(ctx, clock, { idleAfterMs: 30000, doneAfterMs: 2000 });
  s.start();
  ctx.emit('session/created', sess('M'));
  // 用户消息排队 → waiting（非 lastCompleted）
  ctx.emit('session/event', sess('M'), userMsg('排队中'));
  assert.equal(s.getStatus().main.state, 'waiting');
  clock.ahead(31000); // 超过 idleAfterMs
  assert.equal(s.getStatus().main.state, 'idle');
});

test('6. 输出协议 v1 字段齐全', () => {
  const ctx = makeMockCtx();
  const clock = makeClock();
  const s = makeSentinel(ctx, clock, { port: 3084, dshHome: 'D:/dsh-home' });
  s.start();
  ctx.emit('session/created', sess('M'));
  ctx.emit('session/event', sess('M'), ev('turn/start', { turn: 1 }));
  ctx.emit('session/event', sess('M'), asstMsg('今天先做资料分析，然后做判断推理。'));
  const status = s.getStatus();
  assert.equal(status.$schema, 'plan-widget/session-status.v1');
  assert.ok(typeof status.updatedAt === 'string');
  assert.equal(status.instance.port, 3084);
  assert.equal(status.instance.dshHome, 'D:/dsh-home');
  assert.ok('name' in status.instance);
  assert.equal(status.main.sessionId, 'M');
  assert.equal(status.main.state, 'working');
  assert.equal(status.main.reasons.turnOpen, true);
  assert.equal(status.main.reasons.lastEventType, 'assistant/message');
  assert.ok(Array.isArray(status.history));
});

test('7. 无会话 → main=null', () => {
  const ctx = makeMockCtx();
  const clock = makeClock();
  const s = makeSentinel(ctx, clock);
  s.start();
  const status = s.getStatus();
  assert.equal(status.main, null);
});

test('8. 多个主会话 → 取最近活动者', () => {
  const ctx = makeMockCtx();
  const clock = makeClock();
  const s = makeSentinel(ctx, clock);
  s.start();
  ctx.emit('session/created', sess('main-A'));
  clock.ahead(500);
  ctx.emit('session/created', sess('main-B'));
  // A 先活动
  ctx.emit('session/event', sess('main-A'), ev('turn/start', { turn: 1 }));
  clock.ahead(5000);
  // B 后活动（更最近）
  ctx.emit('session/event', sess('main-B'), ev('turn/start', { turn: 1 }));
  assert.equal(s.getStatus().main.sessionId, 'main-B');
});

test('9. latest.text 截断 80 字 + 原子写盘', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgw-'));
  const out = path.join(tmpDir, 'session-status.json');
  const ctx = makeMockCtx();
  const clock = makeClock();
  const s = makeSentinel(ctx, clock, { outputPath: out, writeIntervalMs: 50 });
  s.start();
  ctx.emit('session/created', sess('M'));
  const longText = '甲'.repeat(120);
  ctx.emit('session/event', sess('M'), asstMsg(longText));
  await new Promise((r) => setTimeout(r, 150)); // 等一次周期写盘
  const parsed = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(parsed.main.latest.text.length, 80); // 截断到 80 字
  assert.ok(!fs.existsSync(out + '.tmp'));         // 原子写后无残留 .tmp
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
