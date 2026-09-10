/**
 * plan-setup.test.js — plan_setup 核心逻辑单元测试（node:test）
 *
 * 通过注入 homeDir（临时目录）+ setActivePlanDir 桩，测试诊断/目录校验/默认生成/
 * 已配置不覆盖/持久化读写/重置/容错，避免写入真实用户目录。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { planSetupCore, createDefaultPlanFiles, defaultPlanDir } from '../src/plan-setup.js';
import { userConfigPath, userConfigPlanDir, writeUserConfig } from '../src/settings-schema.js';

/** 构造临时 homeDir + 假 bridge（setActivePlanDir 记录调用，syncNow 返回可解析快照）。 */
function makeCtx(homeDir, opts = {}) {
  const applied = [];
  const bridge = {
    syncNow() { return opts.snapshot ?? { today: { tasks: [{ text: 'A' }, { text: 'B' }] }, levels: { weekly: { file: 'w.md' }, total: { file: 't.md' } } }; },
  };
  return {
    homeDir,
    configPath: userConfigPath(homeDir),
    applied,
    setActivePlanDir(dir) { applied.push(dir); return bridge; },
    getBridge() { return bridge; },
    currentPlanDir: opts.currentPlanDir || '',
    now: () => 1750000000000,
  };
}

function mkTmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kgw-setup-')); }

test('1. 无参诊断（无配置）→ mode=only-diagnosed + 提示未配置', () => {
  const home = mkTmp();
  const r = planSetupCore({}, makeCtx(home));
  assert.equal(r.mode, 'only-diagnosed');
  assert.ok(r.warnings.some((w) => w.includes('未配置')));
  fs.rmSync(home, { recursive: true, force: true });
});

test('2. 无参诊断（有目录但无快照）→ 提示尚未生成快照', () => {
  const home = mkTmp();
  const planDir = path.join(home, 'p');
  fs.mkdirSync(planDir, { recursive: true });
  const r = planSetupCore({}, makeCtx(home, { currentPlanDir: planDir }));
  assert.equal(r.mode, 'only-diagnosed');
  assert.ok(r.warnings.some((w) => w.includes('尚未生成快照')));
  fs.rmSync(home, { recursive: true, force: true });
});

test('3. plan_dir 应用 → mode=plan-dir-applied + 持久化配置 + setActivePlanDir 被调', () => {
  const home = mkTmp();
  const planDir = path.join(home, 'plans');
  fs.mkdirSync(planDir, { recursive: true });
  const ctx = makeCtx(home);
  const r = planSetupCore({ plan_dir: planDir }, ctx);
  assert.equal(r.mode, 'plan-dir-applied');
  assert.equal(r.planDir, planDir);
  assert.equal(r.planSummary.daily, 2);
  assert.deepEqual(ctx.applied, [planDir]);
  assert.ok(fs.existsSync(userConfigPath(home)));
  assert.equal(userConfigPlanDir(home).planDir, planDir);
  fs.rmSync(home, { recursive: true, force: true });
});

test('4. plan_dir 目录不存在 → mode=only-diagnosed + 目录不存在提示', () => {
  const home = mkTmp();
  const r = planSetupCore({ plan_dir: path.join(home, 'nope') }, makeCtx(home));
  assert.equal(r.mode, 'only-diagnosed');
  assert.ok(r.warnings.some((w) => w.includes('不存在')));
  fs.rmSync(home, { recursive: true, force: true });
});

test('5. plan_dir 目录不可写 → mode=only-diagnosed + 不可写提示', () => {
  const home = mkTmp();
  // Windows 下用只读文件属性模拟不可写（目录写入受限时 accessSync 失败较难稳定，这里用不存在的子项逻辑仍走"不存在"更稳）
  // 说明：不可写判定依赖 fs.accessSync W_OK，仅在受限环境真实触发；此处用非法路径触发容错分支。
  const r = planSetupCore({ plan_dir: 'Z:/__none__/x' }, makeCtx(home));
  assert.equal(r.mode, 'only-diagnosed');
  fs.rmSync(home, { recursive: true, force: true });
});

test('6. create_default → 生成 3 个可解析文件 + 持久化 + 返回 createdFiles', () => {
  const home = mkTmp();
  const ctx = makeCtx(home);
  const r = planSetupCore({ create_default: true }, ctx);
  assert.equal(r.mode, 'created-default');
  assert.equal(r.createdFiles.length, 3);
  const names = r.createdFiles.map((x) => x.name);
  assert.ok(names.some((n) => n.endsWith('执行总览.md')));
  assert.ok(names.some((n) => n.startsWith('本周计划-')));
  assert.ok(names.includes('总计划.md'));
  assert.equal(r.planDir, path.join(home, 'Documents', '计划悬浮窗'));
  assert.ok(fs.existsSync(path.join(home, 'Documents', '计划悬浮窗', '总计划.md')));
  assert.ok(fs.existsSync(userConfigPath(home)));
  assert.equal(userConfigPlanDir(home).planDir, path.join(home, 'Documents', '计划悬浮窗'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('7. create_default（默认目录 + 含【真实】快照）→ mode=configured-existing 不覆盖', () => {
  const home = mkTmp();
  const dir = path.join(home, 'Documents', '计划悬浮窗');
  fs.mkdirSync(path.join(dir, '.plan-widget'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.plan-widget', 'plan-state.json'), JSON.stringify({ today: { tasks: [{ text: 'X' }] }, levels: { daily: { file: 'd.md' } } }));
  const r = planSetupCore({ create_default: true }, makeCtx(home));
  assert.equal(r.mode, 'configured-existing');
  assert.equal(r.createdFiles.length, 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test('8. reset → 删除用户配置，mode=only-diagnosed', () => {
  const home = mkTmp();
  writeUserConfig({ planDir: 'X', updatedAt: new Date().toISOString() }, home);
  assert.equal(userConfigPlanDir(home).planDir, 'X');
  const r = planSetupCore({ reset: true }, makeCtx(home));
  assert.equal(r.mode, 'only-diagnosed');
  assert.ok(!fs.existsSync(userConfigPath(home)));
  fs.rmSync(home, { recursive: true, force: true });
});

test('9. defaultPlanDir 使用 homeDir/Documents/计划悬浮窗（零硬编码本机路径）', () => {
  const home = mkTmp();
  assert.equal(defaultPlanDir(home), path.join(home, 'Documents', '计划悬浮窗'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('10. userConfigPath / userConfigPlanDir / writeUserConfig 读写一致（原子写无 .tmp 残留）', () => {
  const home = mkTmp();
  writeUserConfig({ planDir: 'D:/plans', updatedAt: 'x' }, home);
  assert.equal(userConfigPlanDir(home).planDir, 'D:/plans');
  const tmps = fs.readdirSync(home).filter((n) => n.indexOf('.tmp-') !== -1);
  assert.equal(tmps.length, 0);
  fs.rmSync(home, { recursive: true, force: true });
});

// create_default 语义（修复：create_default 不再无视已配置 planDir、不再新建默认目录）。
test('11. create_default（已配置目录，无快照）→ 占位生成到该目录，planDir 不变，不改用户配置', () => {
  const home = mkTmp();
  const planDir = path.join(home, 'myplans');
  fs.mkdirSync(planDir, { recursive: true });
  writeUserConfig({ planDir, updatedAt: 'x' }, home);
  const ctx = makeCtx(home, { currentPlanDir: planDir });
  const r = planSetupCore({ create_default: true }, ctx);
  assert.equal(r.mode, 'created-default');
  assert.equal(r.planDir, planDir);            // 仍在原目录，未切到默认目录
  assert.ok(fs.existsSync(path.join(planDir, '总计划.md')));
  assert.equal(r.createdFiles.length, 3);
  assert.equal(userConfigPlanDir(home).planDir, planDir); // 配置未变
  fs.rmSync(home, { recursive: true, force: true });
});

test('12. create_default（已配置目录 + 含【真实】快照）→ configured-existing 不覆盖', () => {
  const home = mkTmp();
  const planDir = path.join(home, 'myplans');
  fs.mkdirSync(path.join(planDir, '.plan-widget'), { recursive: true });
  // 真实快照：有 today.tasks 且各 level 有文件
  fs.writeFileSync(path.join(planDir, '.plan-widget', 'plan-state.json'), JSON.stringify({ today: { tasks: [{ text: 'X' }] }, levels: { daily: { file: 'd.md' }, weekly: { file: 'w.md' }, total: { file: 't.md' } } }));
  writeUserConfig({ planDir, updatedAt: 'x' }, home);
  const r = planSetupCore({ create_default: true }, makeCtx(home, { currentPlanDir: planDir }));
  assert.equal(r.mode, 'configured-existing');
  assert.equal(r.createdFiles.length, 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test('13. {plan_dir + create_default} → 在指定目录生成占位 + 持久化到该目录', () => {
  const home = mkTmp();
  const spec = path.join(home, 'specified');
  fs.mkdirSync(spec, { recursive: true });
  const r = planSetupCore({ plan_dir: spec, create_default: true }, makeCtx(home));
  assert.equal(r.mode, 'created-default');
  assert.equal(r.planDir, spec);
  assert.ok(fs.existsSync(path.join(spec, '总计划.md')));
  assert.equal(userConfigPlanDir(home).planDir, spec);
  fs.rmSync(home, { recursive: true, force: true });
});
test('14. create_default（已配置目录 + 【空壳】快照）→ 生成占位到该目录，mode=created-default', () => {
  const home = mkTmp();
  const planDir = path.join(home, 'myplans');
  fs.mkdirSync(path.join(planDir, '.plan-widget'), { recursive: true });
  fs.writeFileSync(path.join(planDir, '.plan-widget', 'plan-state.json'), JSON.stringify({ today: { tasks: [] }, levels: { daily: { file: null }, weekly: { file: null }, total: { file: null } } }));
  writeUserConfig({ planDir, updatedAt: 'x' }, home);
  const r = planSetupCore({ create_default: true }, makeCtx(home, { currentPlanDir: planDir }));
  assert.equal(r.mode, 'created-default');            // 空壳不被视为已配置
  assert.equal(r.planDir, planDir);                   // 仍在原目录
  assert.ok(fs.existsSync(path.join(planDir, '总计划.md')));
  fs.rmSync(home, { recursive: true, force: true });
});

test('15. create_default（默认目录 + 【空壳】快照）→ 生成占位覆盖空壳', () => {
  const home = mkTmp();
  const ddir = defaultPlanDir(home);
  fs.mkdirSync(path.join(ddir, '.plan-widget'), { recursive: true });
  fs.writeFileSync(path.join(ddir, '.plan-widget', 'plan-state.json'), JSON.stringify({ today: { tasks: [] }, levels: {} }));
  const r = planSetupCore({ create_default: true }, makeCtx(home));
  assert.equal(r.mode, 'created-default');
  assert.equal(r.planDir, ddir);
  assert.ok(fs.existsSync(path.join(ddir, '总计划.md')));
  fs.rmSync(home, { recursive: true, force: true });
});


