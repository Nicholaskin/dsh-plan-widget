// =============================================================================
// plan-bridge.test.js —— plan-bridge 模块单元测试（node:test，Node >= 20）
// 运行：node --test plugin/tests/plan-bridge.test.js
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlanBridge } from '../src/plan-bridge.js';

// ---------- 测试工具 ----------
function mkTmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kg-bridge-')); }
function write(dir, name, content) { fs.writeFileSync(path.join(dir, name), content, 'utf8'); }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

// ---------- 样例内容（脱敏，仅演示解析；用数组拼接，避免模板反引号） ----------
const DAILY = [
  '# 8/20（周四）全天执行总览',
  '',
  '## 📌 今日目标',
  '',
  '1. 晨读 40 分钟（常识 + 成语）',
  '2. 上午学习块：资料分析强化',
  '3. 下午学习块：言语理解精练',
  '',
  '## ⏰ 时间块（±15min）',
  '',
  '| 时间 | 任务 | 说明 |',
  '| :--- | :--- | :--- |',
  '| 07:00-07:40 | **晨读** | 常识 10 题 |',
  '| 08:30-10:30 | **资料分析限时组** | 2 组 × 20 题 |',
  '| 14:00-15:30 | **申论精练** | 对策题重做 |',
  '',
  '## ✅ 验收（睡前打勾）',
  '',
  '- [x] 晨读完成',
  '- [ ] 资料组正确率 ≥85%',
  ''
].join('\n');

const WEEKLY = [
  '# 下周计划（第 2 周）｜执行期：2026-08-25 至 08-31',
  '',
  '> 演示用脱敏样例：判断推理攻坚周。',
  '',
  '## 二、每日填充表',
  '',
  '| 日期 | 上午 | 下午 | 晚间 |',
  '| :--- | :--- | :--- | :--- |',
  '| 8/26 周三 | 09:30 类比推理入门精讲 | 14:00 类比 20 题+订正；15:40 错题复盘+速算 20min | 锻炼 |',
  '| 8/27 周四 | 09:30 逻辑判断精讲 | **14:00 申论精练①词句理解** | 锻炼 |',
  ''
].join('\n');

const TOTAL = [
  '# 2026国考复习计划与每日打卡',
  '',
  '> 适用周期：2026年8月14日 ~ 11月下旬国考笔试。',
  '> 演示用脱敏样例。',
  '',
  '## 二、全职期每日作息表（8月18日起）',
  '',
  '| 时段 | 内容 |',
  '| :--- | :--- |',
  '| 06:30-07:00 | 起床、洗漱 |',
  '| 07:00-07:40 | 晨读：时政 + 常识 + 成语 |',
  '| 08:30-11:30 | 上午大块：行测模块精讲 |',
  ''
].join('\n');

// =============================================================================
// 1) 必填校验
// =============================================================================
test('缺 planDir 抛错', () => {
  assert.throws(() => createPlanBridge({}), /planDir/);
  assert.throws(() => createPlanBridge(), /planDir/);
});

// =============================================================================
// 2) 层级识别（daily/weekly/total 归位，排除 other）
// =============================================================================
test('层级识别：daily/weekly/total 分别归位并可排除', () => {
  const d = mkTmp();
  write(d, '8月20日执行总览.md', DAILY);
  write(d, '下周计划-2026-08-25至08-31.md', WEEKLY);
  write(d, '2026国考复习计划与每日打卡.md', TOTAL);
  write(d, '8月20日当日复盘.md', '# 复盘');
  write(d, '资料分析讲义.md', '# 讲义');
  const b = createPlanBridge({ planDir: d, watch: false, today: '2026-08-20', year: 2026 });
  const s = b.syncNow();
  assert.equal(s.levels.daily.file, '8月20日执行总览.md');
  assert.equal(s.levels.weekly.file, '下周计划-2026-08-25至08-31.md');
  assert.equal(s.levels.total.file, '2026国考复习计划与每日打卡.md');
  const all = [s.levels.daily.file, s.levels.weekly.file, s.levels.total.file];
  assert.ok(!all.includes('8月20日当日复盘.md'));
  assert.ok(!all.includes('资料分析讲义.md'));
});

// =============================================================================
// 3) 任务解析：标题/时间/状态
// =============================================================================
test('任务解析：时间块+复选框，标题/时间/状态正确', () => {
  const d = mkTmp();
  write(d, '8月20日执行总览.md', DAILY);
  const b = createPlanBridge({ planDir: d, watch: false, today: '2026-08-20', year: 2026 });
  const s = b.syncNow();
  const tasks = s.today.tasks;
  assert.equal(tasks.length, 5);
  const chen = tasks.find(t => t.text === '晨读');
  assert.equal(chen.time, '07:00-07:40');
  assert.equal(chen.status, 'pending');
  const done = tasks.find(t => t.text === '晨读完成');
  assert.equal(done.status, 'done');
  const data = tasks.find(t => t.text === '资料分析限时组');
  assert.equal(data.time, '08:30-10:30');
});

// =============================================================================
// 4) goals 归集
// =============================================================================
test('goals 归集：今日目标进入 goals', () => {
  const d = mkTmp();
  write(d, '8月20日执行总览.md', DAILY);
  const b = createPlanBridge({ planDir: d, watch: false, today: '2026-08-20', year: 2026 });
  const s = b.syncNow();
  assert.equal(s.today.goals.length, 3);
  assert.ok(s.today.goals.includes('晨读 40 分钟（常识 + 成语）'));
  assert.ok(s.today.goals.includes('上午学习块：资料分析强化'));
  assert.ok(s.today.goals.includes('下午学习块：言语理解精练'));
});

// =============================================================================
// 5) current 推导
// =============================================================================
test('current 推导：prev/now/next 正确', () => {
  const d = mkTmp();
  write(d, '8月20日执行总览.md', DAILY);
  const b = createPlanBridge({ planDir: d, watch: false, today: '2026-08-20', year: 2026 });
  const s = b.syncNow();
  const cur = s.levels.daily.current;
  assert.equal(cur.task.prev, null);
  assert.equal(cur.task.now, '晨读');
  assert.equal(cur.task.next, '资料分析限时组');
  assert.equal(cur.period, '07:00-07:40 晨读');
});

// =============================================================================
// 6) 今日文件缺失回退
// =============================================================================
test('今日文件缺失回退最近并写 warning', () => {
  const d = mkTmp();
  write(d, '8月20日执行总览.md', DAILY);
  const b = createPlanBridge({ planDir: d, watch: false, today: '2026-08-26', year: 2026 });
  const s = b.syncNow();
  assert.equal(s.today.date, '2026-08-26');
  assert.equal(s.levels.daily.file, '8月20日执行总览.md');
  assert.ok(s.warnings.some(w => /未找到覆盖今日的计划/.test(w)));
});

// =============================================================================
// 7) 容错
// =============================================================================
test('容错：目录不存在 -> 空 levels + warning，不抛错', () => {
  const ghost = path.join(os.tmpdir(), 'ghost-plan-' + Date.now());
  const b = createPlanBridge({ planDir: ghost, watch: false, today: '2026-08-20', year: 2026 });
  const s = b.syncNow();
  assert.equal(s.levels.daily.file, null);
  assert.equal(s.levels.total.file, null);
  assert.ok(s.warnings.some(w => /计划文件夹不存在/.test(w)));
});

test('容错：缺少某层级 -> current 为 null + 提示', () => {
  const d = mkTmp();
  write(d, '8月20日执行总览.md', DAILY);
  const b = createPlanBridge({ planDir: d, watch: false, today: '2026-08-20', year: 2026 });
  const s = b.syncNow();
  assert.equal(s.levels.weekly.file, null);
  assert.equal(s.levels.weekly.current, null);
  assert.equal(s.levels.total.file, null);
  assert.ok(s.warnings.some(w => /未找到周计划/.test(w)));
  assert.ok(s.warnings.some(w => /未找到总计划/.test(w)));
});

// =============================================================================
// 8) 排除规则
// =============================================================================
test('排除规则：自定义 excludePatterns 生效', () => {
  const d = mkTmp();
  write(d, '8月20日执行总览.md', DAILY);
  write(d, '8月20日晨读速记卡.md', '# 卡片');
  const b = createPlanBridge({ planDir: d, watch: false, today: '2026-08-20', year: 2026, excludePatterns: ['速记卡'] });
  const s = b.syncNow();
  assert.equal(s.levels.daily.file, '8月20日执行总览.md');
  assert.ok(!JSON.stringify(s).includes('速记卡'));
});
test('排除规则：字符串 "a|b" 形式', () => {
  const d = mkTmp();
  write(d, '8月20日执行总览.md', DAILY);
  const b = createPlanBridge({ planDir: d, watch: false, today: '2026-08-20', year: 2026, excludePatterns: '无关|其他' });
  const s = b.syncNow();
  assert.equal(s.levels.daily.file, '8月20日执行总览.md');
});

// =============================================================================
// 9) 原子写
// =============================================================================
test('原子写：JSON 合法、无残留 tmp、自动建父目录', () => {
  const d = mkTmp();
  write(d, '8月20日执行总览.md', DAILY);
  const out = path.join(d, 'nested', 'dir', 'plan-state.json');
  const b = createPlanBridge({ planDir: d, watch: false, today: '2026-08-20', year: 2026, outputPath: out });
  b.syncNow();
  const s = readJson(out);
  assert.equal(s.$schema, 'plan-widget/plan-state.v1');
  assert.equal(s.today.date, '2026-08-20');
  const leftovers = fs.readdirSync(path.dirname(out)).filter(f => f.includes('.tmp-'));
  assert.equal(leftovers.length, 0);
});

// =============================================================================
// 10) 快照协议字段完备
// =============================================================================
test('快照协议字段完备', () => {
  const d = mkTmp();
  write(d, '8月20日执行总览.md', DAILY);
  write(d, '下周计划-2026-08-25至08-31.md', WEEKLY);
  write(d, '2026国考复习计划与每日打卡.md', TOTAL);
  const b = createPlanBridge({ planDir: d, watch: false, today: '2026-08-20', year: 2026 });
  const s = b.syncNow();
  assert.equal(typeof s.updatedAt, 'string');
  assert.equal(typeof s.sourceDir, 'string');
  assert.ok(s.raw.daily.length > 0);
  assert.ok(s.raw.weekly.length > 0);
  assert.ok(s.raw.total.length > 0);
  assert.ok(Array.isArray(s.warnings));
  assert.equal(s.levels.daily.period.from, '2026-08-20');
  assert.equal(s.levels.weekly.period.to, '2026-08-31');
  assert.equal(s.levels.total.period.from, '2026-08-14');
});

// =============================================================================
// 11) 防抖监听
// =============================================================================
test('防抖监听：新增今日文件自动触发 syncNow', async () => {
  const d = mkTmp();
  write(d, '8月20日执行总览.md', DAILY);
  const out = path.join(d, '.plan-widget', 'plan-state.json');
  const b = createPlanBridge({ planDir: d, watch: true, today: '2026-08-26', year: 2026, outputPath: out });
  b.syncNow();
  assert.equal(readJson(out).levels.daily.file, '8月20日执行总览.md');
  b.start();
  await delay(80);
  write(d, '8月26日执行总览.md', DAILY);
  let hit = false;
  for (let i = 0; i < 25; i++) {
    await delay(120);
    try { if (readJson(out).levels.daily.file === '8月26日执行总览.md') { hit = true; break; } } catch { /* 原子写瞬间可忽略 */ }
  }
  b.stop();
  assert.ok(hit, '监听未在预期时间内触发再同步');
});
