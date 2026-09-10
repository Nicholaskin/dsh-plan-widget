# 计划悬浮窗（dsh-plan-widget + PlanWidget 桌面客户端）

> 把任意计划文件夹里的 Markdown 变成可展示、可勾选的计划面板：
> DSH 插件负责**解析与输出数据**，桌面悬浮窗负责**展示与交互**。

**本仓库只包含「计划悬浮窗」组件，不含任何任务看板（dsh-collab-board）内容。**
（任务看板是另一个独立项目；本仓库既不包含它的源码，也不包含它的构建产物。）

## 一、组件

| 目录 | 组件 | 技术 | 版本 |
|---|---|---|---|
| `plan-widget/` | DSH 插件 **dsh-plan-widget** | Node ESM（无需构建） | 0.1.0 |
| `client/PlanWidget/` | 桌面客户端 **PlanWidget.exe** | WPF / .NET 8 | 0.1.4 |

### dsh-plan-widget（插件）
- **计划桥**：监听计划文件夹 `*.md` 变化 → 解析「总计划 / 本周计划 / 今日安排」三级 + 任务链 → 写 `plan-state.json`；
- **会话哨兵**：订阅 DSH 会话事件 → 主会话状态机（工作 / 等待 / 空闲 / 完成）→ 写 `session-status.json`；
- **DSH 工具**：`plan_sync`（刷新并自检计划数据）、`plan_setup`（配置计划目录）；
- **Web 内置页**：源码保留（`src/web-panel.js` + `src/widget.js`），**当前默认停用**（`src/index.js` 中已注释，原能力已迁移到看板的「计划」页）。需要时可取消注释恢复。

### PlanWidget.exe（桌面客户端）
双栏悬浮窗（用户计划 | Agent 计划）/ 时间轴 / 彩色状态灯 / 今日待办勾选（本地进度，**不写回源文件**）/ 边缘吸附折叠 / 深浅主题 / 托盘。

## 二、安装

### 插件
```powershell
dsh plugin --profile <profile> add link:<本仓库绝对路径>\plan-widget
```

### 桌面客户端
1. 安装 **.NET 8 Desktop Runtime（Windows x64）**（客户端为框架依赖发布，不内置运行时）；
2. 解压 Release 附件 `PlanWidget-0.1.4-win-x64.zip`；
3. 双击 `PlanWidget.exe`：首次运行会自动探测计划目录，也可用 `config.json`（放 exe 同目录）显式指定。

客户端读取顺序（简）：插件用户级配置 `%USERPROFILE%\.plan-widget-config.json` 的 `planDir` → `<planDir>\.plan-widget\plan-state.json`；否则回退 `<文档>\计划悬浮窗\.plan-widget\plan-state.json`、exe 同级 `data\`、exe 同级 `.plan-widget\`。

## 三、构建

```powershell
# 插件：纯 ESM 源码，免构建（改完即生效）
# 桌面客户端：
cd client\PlanWidget
dotnet build -c Release      # 产物 bin/Release/net8.0-windows/PlanWidget.exe
# 或直接用仓库根的一键脚本：
.\build-plan-widget.ps1
```

## 四、数据契约（v1）

| 文件 | 写入方 | 内容 |
|---|---|---|
| `<planDir>/.plan-widget/plan-state.json` | 计划桥 | `{ $schema:"plan-widget/plan-state.v1", updatedAt, sourceDir, levels:{daily,weekly,total}, today:{date,tasks[],goals[]}, raw, warnings }` |
| `$DSH_HOME/plan-widget/session-status.json` | 会话哨兵 | `{ $schema:"plan-widget/session-status.v1", updatedAt, instance, main:{...}|null, history }` |

## 五、可选数据源：Agent 计划

`plan-state.json` 里的 `agentPlan` 字段来自同目录的 `agent-plan.json` —— 该文件由**任务看板（dsh-collab-board）**写入。
- 本插件对该文件是**只读、容错**的：不存在或损坏时该字段为 `null`，**不影响**计划解析、哨兵、工具与桌面客户端的任何功能；
- 也就是说：**不装任务看板，本组件完全可用**，只是「Agent 计划」一栏为空。

## 六、许可

MIT（见 `LICENSE`）。

---

更详细的插件说明（功能、配置、计划文件命名约定、给 AI 模型的使用指南）见 [`plan-widget/README.md`](plan-widget/README.md)。
