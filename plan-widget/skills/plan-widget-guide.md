---
name: plan-widget-guide
description: >
  用户想用「计划悬浮窗」（dsh-plan-widget）插件管理计划时使用：配置计划目录（plan_setup）、
  维护计划文件、调 plan_sync 并读 warnings。「给 AI 模型的话 v5」：覆盖插件简介、新用户三道
  选择题流程（①计划目录 /②软件位置=纯确认+告知 /③快捷方式=A 引导自建 · B 自定义位置(用户授权代建) · C 不要）、
  授权代建细则（允许在用户明确授权+合法目标下走客户端 --create-shortcut 通道代建）、AI 边界、
  plan_setup/plan_sync 用法、红线（未授权不代建、不改快照/进度/客户端本地）、状态语义、默认目录。
  非考试专用，通用计划表工具。
---

# 计划悬浮窗（dsh-plan-widget）· 给 AI 模型的话 v5

## 插件是什么

从**任意计划文件夹**的 Markdown 自动提取「总计划 / 本周计划 / 今日安排」三级计划与任务链，
感知 DSH 主会话状态，输出统一快照，供**桌面悬浮窗（PlanWidget.exe）**与**DSH Web 内置页**展示。
非考试专用：任何用 Markdown 管理计划的场景（学习/工作/健身/项目管理……）都能用。

## 你的职责边界（含授权代建）

- **你（AI 模型）默认只负责计划数据**：配置计划目录（plan_setup）、维护计划文件、调 plan_sync。
- **客户端 exe 的"位置/快捷方式/设置"默认由用户或客户端自身完成**——但【授权代建细则】允许在
  **用户明确授权**且目标合法时，经客户端官方 `--create-shortcut` 通道代为创建快捷方式。
- 因此：**未授权不代建**；你绝不猜测/自行定位 exe 或路径、绝不触碰生产/被禁目录。

### 授权代建细则（快捷方式）

AI **可以**代建桌面/自定义快捷方式，**仅当**同时满足：
1. **用户明确授权**（如用户说"帮我创建/放到 X 目录"），而非 AI 自己判断该做；
2. **目标是用户提供的路径**，或环境内合法目录（如 TEST、工作区、本环境内部）；
3. **调用的是环境内的客户端 exe**（如测试区/亲测 exe/PlanWidget.exe，路径以用户提供或环境内实际为准），
   用其官方参数 `--create-shortcut --shortcut-dir="<用户目录>"`；`--shortcut-dir` 指定 .lnk 落点；
4. 目标**不触碰桌面之外的生产/被禁目录**（生产 DSH、用户主目录随意路径等——以环境红线为准）。

仍**禁止**：猜测/自行定位 exe 与路径、未授权操作、目标在生产/被禁目录、绕过客户端通道手工创建。

## 新用户三道选择题流程（懒人配置）

当用户说「帮我配置计划」「装计划悬浮窗」「计划是空的」时，用**结构化选择题**（推荐项放前、
每项附影响说明，如 `ask_user_question`）依次确认：

1. **计划目录选择题**：
   - A 一键默认（推荐）→ `plan_setup{create_default:true}`（在已配置目录或默认目录生成占位计划，自动探测）
   - B 自定义 → `plan_setup{plan_dir:"<路径>"}`
   - C 跳过 → 仅诊断（`plan_setup{}`），不放占位。
2. **软件位置选择题（纯确认+告知，不操作）**：
   - A 我知道放哪 → 无需操作；
   - B 不确定 → 告知「桌面软件 PlanWidget.exe 需你自行双击运行（新用户一般位于下载包目录；首次运行会自动探测计划并弹设置窗）」；
   - C 还没下载 → 提示获取方式。
   AI 纯确认+告知，**不猜测、不定位、不操作客户端路径**（除非用户按③B 明确授权代建）。
3. **桌面快捷方式选择题**：
   - A 桌面快捷方式（推荐）→ **引导用户自建**：双击 PlanWidget.exe → 设置窗点『创建桌面快捷方式』按钮（用户自建最稳）；
   - B **自定义位置**（如工作区）→ **用户提供目标目录**（用户明确授权 AI 代建）→ AI 可执行：环境内客户端 exe（环境允许）
     调 `--create-shortcut --shortcut-dir="<用户目录>"` 创建，验证 .lnk 生成后汇报；
   - C 不要 → 不创建。

## plan_setup 用法

- 无参数：诊断当前计划目录与快照（mode=only-diagnosed，**纯只读**，不写盘不同步）。
- `plan_dir:"<路径>"`：校验目录存在且可写 → 应用并**持久化**用户配置（`<home>/.plan-widget-config.json`）。
- `create_default:true`：若已配置有效 planDir → **在该目录**生成占位计划（总/周/日）并 syncNow
  （不切换目录、不改配置）；若未配置 → 在默认目录（`<home>/Documents/计划悬浮窗/`）生成。
  **快照为"空壳"（tasks=[]、三 level 无文件）视为未配置，仍会生成占位覆盖。**
- `{plan_dir + create_default}`：在**指定目录**生成占位 + 应用 + 持久化。
- `reset:true`：清除用户级配置（恢复未配置）。
- 返回：`{ok, mode(configured-existing|created-default|only-diagnosed|plan-dir-applied), planDir,
  planSummary:{daily,weekly,total}, createdFiles:[{name,path}], clientHint, warnings}`。

## plan_sync 习惯

- 写/改完计划文件后必调 `plan_sync{}`；无参即刷新已配置 planDir。
- 读返回 `warnings`：如「今日文件缺失→建当日文件」「未能识别任务行→调格式」，
  修正后**再次 plan_sync 直到 warnings 仅剩可接受提示**。
- 临时换目录：`plan_sync{plan_dir:"<路径>"}`。

## 状态语义（会话状态 v1）

- working=工作中；waiting=等待指示（回复完成后 2 秒无新事件→done）；done=已完成；idle=空闲。
- **你的子代理/后台代理不计入**（只显示主会话）。

## 默认目录与配置

- 默认计划目录：`<home>/Documents/计划悬浮窗/`（由 os.homedir() 推导，零硬编码本机路径）。
- 用户级配置：`<home>/.plan-widget-config.json`（`planDir` + `updatedAt`）。
- 快照目录：`<planDir>/.plan-widget/`（plan-state.json / progress.json）。
- 会话状态：`$DSH_HOME/plan-widget/session-status.json`。

## 红线（速记）

- 未授权不代建（快捷方式/客户端操作）；用户授权+合法目标可代建（走 `--create-shortcut` 通道）。
- 不修改 `.plan-widget/` 快照（plan-state.json / progress.json）、`session-status.json`、客户端 `local-progress.json`。
- 不猜测/自行定位 exe 或路径；不触碰生产/被禁目录。

## 使用示例

- 用户「帮我把今天的计划更新一下」→ 重写当日文件 → `plan_sync` → 简报「今日任务已更新：N 项…」。
- 用户「我今天的计划是什么」→ `plan_sync` → 引用返回摘要回答。
- 用户「悬浮窗数据缺失」→ `plan_sync` 诊断 → 确认 planDir/文件 → 修复后再次 `plan_sync`。
- 用户「帮我创建桌面快捷方式」→ 走 ③A 引导自建；「帮我放到工作区快捷方式」→ ③B，用户给目录，AI 授权代建并验证 `--create-shortcut`。
