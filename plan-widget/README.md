# 计划悬浮窗（dsh-plan-widget）

> 通用计划表插件：从**任意计划文件夹**的 Markdown 中自动提取「总计划 / 本周计划 / 今日安排」三级计划与任务链，
> 感知 DSH 主会话状态，输出统一快照，供**桌面悬浮窗客户端（PlanWidget.exe）**与**DSH Web 内置页**展示。
> 非考试专用：任何用 Markdown 管理计划的场景（学习、工作、健身、项目管理……）都能用。

## 一、功能

- **计划桥**：监听计划文件夹 *.md 变化 → 解析为三级计划（daily/weekly/total）→ 写入 plan-state.json
- **会话哨兵**：订阅 DSH 会话事件 → 主会话状态机（工作/等待/空闲/完成）→ 写入 session-status.json
- **DSH 工具**：plan_sync —— 模型（AI）在任何会话中均可调用的“刷新计划”工具
- **Web 内置页**：DSH Web GUI 右下角「计划悬浮窗」面板（三级计划 / 任务链 / 今日待办 / 会话状态）
- **桌面客户端**：PlanWidget.exe（同数据源，悬浮窗展示 + 待办勾选 + 吸附折叠）

## 二、安装（DSH 插件）

    dsh plugin --profile web add link:<本目录绝对路径>

启动后可在 DSH Web GUI（浏览器）右下角看到「计划悬浮窗」面板。

> 内置技能 plan-widget-guide（含「给 AI 模型的话」）随插件 skills/ 目录提供，DSH 会自动发现；
> 若需作为用户级技能使用，可将其复制到 $DSH_HOME/skills/plan-widget-guide.md（DSH 用户技能目录，与 ~/.dsh/skills 同机制）。

## 三、配置

| 项 | 说明 | 默认 |
|---|---|---|
| planDir | 计划文件夹（必配：存总/周/日 Markdown 计划的目录） | 无 |
| watch | 是否监听文件夹变化 | true |
| outputPath | plan-state.json 输出路径 | planDir/.plan-widget/plan-state.json |
| sessionStatePath | session-status.json 输出路径 | $DSH_HOME/plan-widget/session-status.json |
| mainOnly | 是否只跟踪主会话（自动排除子代理） | true |
| excludePatterns | 扫描排除的文件名关键词（复盘/模板/讲义/答案/错题/课程要点） | 见左 |

配置优先级：环境变量（PLAN_WIDGET_PLAN_DIR / PLAN_WIDGET_WATCH）→ 插件默认值。
工具也可临时指定：plan_sync{plan_dir: "..."}。

## 四、计划文件约定（模型与用户都可遵循）

**文件名自动识别**（正则匹配）：
- 日计划：8月20日执行总览.md、8-20 计划.md、含“执行卡/安排/当日/任务”的日期文件
- 周计划：本周计划-2026-08-25至08-31.md、下周计划*、第2周计划*
- 总计划：含“总计划/复习计划/长期计划”的覆盖长期文件

**任务条目格式**（推荐）：

    ## 上午
    - [ ] 07:00-07:40 晨读（时政+常识）
    - [x] 09:00-11:00 资料分析限时组
    - 今日目标：完成速算 30 题      ← 纯文本目标（无时间）归入「今日目标」

- 复选框 [x]/[ ] 决定完成状态；时间 HH:MM-HH:MM 自动提取；表格（时间列+任务列）也支持
- 文件名命中排除规则（复盘/模板/讲义/答案/错题/课程要点）的文件不参与计划解析

## 五、数据契约（v1）

- plan-state.json：{ $schema:"plan-widget/plan-state.v1", updatedAt, sourceDir, levels:{daily,weekly,total}, today:{date,tasks[],goals[]}, raw, warnings }
- session-status.json：{ $schema:"plan-widget/session-status.v1", updatedAt, instance, main:{sessionId,state,since,reasons,latest}|null, history }

## 六、桌面客户端（PlanWidget.exe）

读取上述两份 JSON（config.json 指定路径）→ 悬浮窗展示：三级计划页 / 今日待办勾选（本地 local-progress.json，不写回源文件）/ 会话状态面板 / 边缘吸附折叠 / 深浅主题。

---

# 🤖 给 AI 模型的话（模型使用本插件指南）

> 你（AI 模型）在 DSH 会话中运行。本插件把“计划”从你写的 Markdown 变成可展示的数据。
> 你不需要直接操作客户端——你负责**让计划文件保持正确**，其余（解析/展示/状态）由插件自动完成。

## 你的职责

0. **新用户配置**（用户说“帮我配置计划/装计划悬浮窗/计划是空的”时）：用结构化选择题（①②③）依次引导：
   - ① 计划目录：A 一键默认（plan_setup{create_default:true}）/ B 自定义（plan_setup{plan_dir:"<路径>"}）/ C 跳过。
   - ② 软件位置：A 我知道放哪（无需操作）/ B 不确定（告知：需自行双击运行 PlanWidget.exe，首次运行自动探测计划并弹设置窗）/ C 还没下载（提示获取方式）——AI **纯确认+告知，绝不定位/操作客户端路径**。
   - ③ 桌面快捷方式：A 桌面快捷方式（推荐，引导用户双击 exe → 设置窗点『创建桌面快捷方式』按钮，用户自建）/ B 自定义位置（如工作区→**用户提供目标目录并明确授权**→AI 可代建：环境内客户端 exe 调 --create-shortcut --shortcut-dir="<用户目录>"，验证 .lnk 后汇报）/ C 不要。
   - **AI 边界（含授权代建）**：plan_setup / plan_sync 只负责**计划数据**；客户端 exe 的"位置/快捷方式/设置"默认由用户或客户端自身完成。**授权代建细则**：仅当 ①用户明确授权 ②目标是用户提供的路径/环境内合法目录 ③调用环境内客户端 exe 的官方 --create-shortcut --shortcut-dir="<目录>" 通道 ④不触碰生产/被禁目录时，AI 才可代为创建快捷方式；未授权不代建，绝不猜测/自行定位 exe 与路径。

1. **维护用户的计划文件**（在 planDir 计划文件夹内，按上文“计划文件约定”创建/更新）：
   - 总计划：长期目标与阶段（如“强化期 8/14-8/17”）
   - 周计划：一周安排（大到每日模块，小到单日任务）
   - 日计划：当日执行总览（精确到时间的任务 + 今日目标）
2. **每次写/改完计划文件后，调用 plan_sync**：
   - 无参数：重新解析已配置的 planDir，返回 {ok, warnings, planSummary}
   - 临时换目录：plan_sync{plan_dir:"<路径>"}
3. **读返回并自检**：
   - ok:true → 数据已刷新，客户端/内置页会看到
   - warnings 非空 → 按其中诊断修正格式（如“今日文件缺失”→建当日文件；“未能识别任务行”→调格式），然后**再次 plan_sync 直到 warnings 仅剩可接受提示**
4. **理解会话状态语义**（你自己的工作状态）：
   - 正在回复/调用工具 = 工作中（working）
   - 回复完成等待用户输入 = 等待指示（waiting）；2 秒无新事件 = 已完成（done）
   - 长时间无交互 = 空闲（idle）
   - 你的子代理/后台代理不计入（只显示主会话）
5. **不要**：修改 .plan-widget/ 下快照文件（插件会覆盖）；不要直接改客户端 local-progress.json。

## 使用示例

- 用户说“帮我把今天的计划更新一下” → 重写当日文件 → plan_sync → 简报“今日任务已更新：N 项，上午为……”
- 用户说“我今天的计划是什么” → plan_sync 取摘要后引用结果回答
- 用户报告“悬浮窗数据缺失” → 用 plan_sync 诊断（ok:false 会说明原因）→ 确认 planDir/文件后修复 → 再次 plan_sync

## 默认排除（解析时跳过）

文件名包含：复盘 / 模板 / 讲义 / 答案 / 错题 / 课程要点（参考资料非计划；用户视为计划可改 excludePatterns）。

---

## 七、常见问题

- 今日看不到任务：当日文件缺失/命名不识别 → 看 warnings“今日文件缺失”，创建当日计划文件
- JSON 损坏：重新 plan_sync 或恢复源文件
- 会话状态总为 null：无主会话（如隔离环境无会话）；正常实例有值

## 八、变更与发布

- CHANGELOG 见项目根；发布遵循“README 最新一期”惯例（本文件随版本更新）