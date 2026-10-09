# dsh-task-overlay · 任务悬浮窗

在 **DSH 窗口之外**放一个桌面悬浮窗，实时显示当前任务状态；并在 DSH 侧栏提供一个启停开关。

- **目标状态**：phase（进行中 / 已暂停 / 受阻 / 已完成）、objective、第 N/M 轮、受阻原因
- **Todo 进度**：进度条 + 清单（✔ 已完成 / ◐ 进行中 / ○ 待办）
- **提醒**：N 个会话等待你确认、N 个会话已完成未查看（跨所有会话）
- 最小化或关闭 DSH 后，桌面浮窗依然存在；DSH 完全退出后它会显示「DSH 未运行」但窗口不消失

> 桌面浮窗（PowerShell + WPF）**仅支持 Windows**；DSH 内的开关与状态推送跨平台。

## 安装

**插件市场（推荐）**：先安装市场插件 [dshmarket](https://github.com/dsh-market/dsh-market)，
然后在 DSH 里 **设置 → Plugin Market** 搜索 `dsh-task-overlay` 一键安装。

**DSH 官方插件页**：安装框填 `github:gg947919490-byte/dsh-task-overlay`，
或贴 Release 里 `dsh-task-overlay.tgz` 的直链。

**CLI**：

```sh
dsh plugin add gg947919490-byte/dsh-task-overlay
```

安装后 **刷新一次 DSH 页面**（F5）即可在侧栏底部看到「桌面浮窗」开关。

## 使用

| 入口 | 操作 |
|---|---|
| DSH 侧栏底部「桌面浮窗」开关 | 点击启停桌面浮窗（绿点=运行中） |
| 浮窗标题栏 `▾` / `▸` | 展开详情 / 收成 190×32 迷你胶囊 |
| 拖动浮窗标题栏 | 移动位置（位置与折叠状态会记住） |
| 浮窗 `✕` | 关闭浮窗进程（可在 DSH 侧栏开关重新打开） |

首次手动启动（不经 DSH 开关）：双击 `desktop\launch-overlay.cmd` 或 `desktop\launch-overlay.vbs`。
开机自启：把 `launch-overlay.vbs` 的快捷方式放进 `shell:startup`。

## 工作原理

```
DSH GUI（客户端插件，拥有完整会话状态）
   │  POST 压缩快照 → 127.0.0.1:45123（2 秒心跳，变化即时推送）
   ▼
桌面浮窗（独立 WPF 进程 + 内置 TCP 监听）
   ▲
   │  侧栏开关 → 同源相对路径 /task-overlay/control（start/stop/toggle/status）
DSH 宿主（本包宿主半边）—— start 用 spawn 拉起浮窗，stop 发 {"cmd":"stop"} 优雅关闭
```

- 数据不来自宿主投影（root 上下文读不到会话作用域的 `todos`/`goal`），而由 GUI 客户端推送。
- 浮窗判断 DSH 存活用三段式：≤20 秒实时；>20 秒保留最后一帧并标注数据年龄；>150 秒且宿主端口拒连才显示「DSH 未运行」。

## 配置项

| 位置 | 参数 | 默认 | 说明 |
|---|---|---|---|
| `dsh/client.js` | `BRIDGE_URL` | `http://127.0.0.1:45123/task-overlay` | 客户端推送地址，需与浮窗 `-Port` 一致 |
| `desktop/task-overlay.ps1` | `-Port` | `45123` | 桥接监听端口 |
| 同上 | `-DshPort` | `19387` | 宿主端口，用于存活探测 |
| 同上 | `-Width` | `300` | 展开态宽度（200–520） |
| 同上 | `-StateFile` | `~/.dsh/task-overlay/desktop-window.json` | 位置/折叠记忆 |

## 安全说明

- 宿主控制接口只绑定 webServer 自身监听地址（默认 `127.0.0.1`），并校验请求 `Origin` 为同源或 `dsh-app://app`，防止任意网页 CSRF 启停。
- `start` 只执行包内固定脚本路径，不接受任何外部输入拼接。
- 桥接端口（45123）无鉴权，仅绑定回环；本机进程可伪造显示数据或触发关闭，属已知限制。

## 排查

- 最近一帧快照：`~/.dsh/task-overlay/last-payload.json`
- 浮窗没出现：确认 DSH 已刷新（F5）、侧栏开关显示「开」；或手动跑 `desktop\launch-overlay.cmd`
- 端口被占：改 `-Port` 并同步 `dsh/client.js` 的 `BRIDGE_URL`

## 开发备注（DSH 0.2.0-rc.2 实测）

- 客户端 bundle 为**手写零构建**：`window.__ModuleLoader__.load({ id: 包名, factory })`，只 require 平台种子模块。
- 宿主行必须指向**包根**；`apply` 必须**同步**；宿主代码热生效需**换新包名**（Node ESM 按解析路径缓存）。
- 宿主 `spawn` 子进程**不要用 `detached: true`**（pwsh 会立即退出）。
- 本包不声明 peer，避免版本兼容校验把整包判为不兼容。

## License

MIT
