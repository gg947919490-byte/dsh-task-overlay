// dsh-task-overlay —— 浏览器半边（手写 lazy-CJS bundle，无需构建步骤）。
//
// 协议依据（DSH 0.2.0-rc.2 实测）：
//   * 客户端 bundle 用 window.__ModuleLoader__.load({ id, factory }) 注册，
//     id 必须是包名本身——宿主按包名查找这个 bundle。
//   * factory 里能 require 的只有平台种子模块表：
//     react / react/jsx-runtime / react-dom / react-dom/client /
//     @deepseek-ai/cordis / @deepseek-ai/dsh-client-store /
//     @deepseek-ai/dsh-client-ui-slots / @deepseek-ai/dsh-client-ui-primitives /
//     @deepseek-ai/dsh-client-ui-dockkit
//     本插件只 require('react') 与 require('react-dom')，数据全部来自 slot
//     标准 props 与 cordis service（只读）。
//
// 数据来源：
//   * props.useSessions()      -> { ids, byId: { id, displayTitle, running, retainedBy, updatedAt } }
//   * props.useSessionStatus() -> Map<sessionId, { running, pendingInteraction, completionUnread }>
//   * ctx.sessions.binding(id).session.projections.faceOf('goal' | 'todos')
//        goal  -> { goal: { id, revision, phase, objective, maxGoalRounds, blockedReason? }, roundsStarted }
//        todos -> [{ content, status: 'pending' | 'in_progress' | 'completed' }] | null
//
// shell.overlay 本身是 click-through 的，条目要自己 opt-in pointer-events。

window.__ModuleLoader__.load({
  id: 'dsh-task-overlay',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement

    /**
     * 是否在 DSH GUI 里也显示悬浮窗。
     * 默认 false：GUI 内不出现任何浮层，本插件只把状态推给独立的桌面浮窗。
     * 想恢复 GUI 内浮窗把它改成 true（同时 client.js 会重新注册 shell.overlay 条目）。
     */
    var SHOW_GUI_OVERLAY = false

    /* ------------------------------------------------------------------ *
     * 样式（全部走主题 token，浅色/深色都成立）
     * ------------------------------------------------------------------ */

    var STYLE_ID = 'dsh-task-overlay/overlay.css'
    var CSS = [
      // 定位基准是 shell.overlay 所在的 AppFrame（position:relative），
      // 因此用 absolute 而不是 fixed/portal，避免被 frame 的 overflow:hidden 裁掉。
      '.tov-card{position:absolute;pointer-events:auto;box-sizing:border-box;width:308px;z-index:10;',
      'font-family:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#e6e6e6);',
      'background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1,rgba(32,33,36,.94)));',
      'backdrop-filter:var(--dsw-menu-backdrop-filter,blur(14px));',
      'border:.5px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l4,rgba(255,255,255,.14)));',
      'border-radius:var(--dsw-radius-lg,12px);box-shadow:var(--dsw-elevation-panel,0 8px 28px rgba(0,0,0,.32));',
      'overflow:hidden;user-select:none}',
      '.tov-head{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:grab;touch-action:none}',
      '.tov-head:active{cursor:grabbing}',
      '.tov-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-caption,#8a8f98)}',
      '.tov-dot[data-state="running"]{background:var(--dsw-alias-state-business-primary,#4d8dff);animation:tov-pulse 1.4s ease-in-out infinite}',
      '.tov-dot[data-state="waiting"]{background:var(--dsw-alias-state-warning-primary,#e0a11b)}',
      '.tov-dot[data-state="done"]{background:var(--dsw-alias-state-success-primary,#3fb950)}',
      '@keyframes tov-pulse{0%,100%{opacity:1}50%{opacity:.3}}',
      '.tov-title{flex:1;min-width:0;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.tov-chip{flex:none;padding:1px 7px;border-radius:999px;font-size:11px;line-height:16px;',
      'border:.5px solid var(--dsw-alias-border-l4,rgba(255,255,255,.16));color:var(--dsw-alias-label-tertiary,#9aa0a6)}',
      '.tov-chip[data-tone="running"]{color:var(--dsw-alias-state-business-primary,#4d8dff);border-color:currentColor}',
      '.tov-chip[data-tone="waiting"]{color:var(--dsw-alias-state-warning-primary,#e0a11b);border-color:currentColor}',
      '.tov-chip[data-tone="done"]{color:var(--dsw-alias-state-success-primary,#3fb950);border-color:currentColor}',
      '.tov-icon{flex:none;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;',
      'border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#9aa0a6);',
      'cursor:pointer;font:inherit;font-size:13px;line-height:1;padding:0}',
      '.tov-icon:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#e6e6e6)}',
      '.tov-icon:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#4d8dff);outline-offset:1px}',
      '.tov-body{display:flex;flex-direction:column;gap:10px;padding:0 12px 12px;max-height:52vh;overflow:auto}',
      '.tov-sep{height:.5px;background:var(--dsw-alias-border-l4,rgba(255,255,255,.12));margin:0 -12px}',
      '.tov-block{display:flex;flex-direction:column;gap:6px}',
      '.tov-label{display:flex;align-items:center;gap:6px;font-size:11px;letter-spacing:.02em;',
      'color:var(--dsw-alias-label-caption,#8a8f98);text-transform:uppercase}',
      '.tov-session{display:flex;align-items:baseline;gap:8px}',
      '.tov-session-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.tov-time{flex:none;font-size:11px;color:var(--dsw-alias-label-caption,#8a8f98)}',
      '.tov-goal-head{display:flex;align-items:center;gap:6px}',
      '.tov-goal-phase{font-size:11px;padding:1px 6px;border-radius:999px;border:.5px solid currentColor}',
      '.tov-goal-phase[data-phase="active"]{color:var(--dsw-alias-state-business-primary,#4d8dff)}',
      '.tov-goal-phase[data-phase="paused"]{color:var(--dsw-alias-label-tertiary,#9aa0a6)}',
      '.tov-goal-phase[data-phase="blocked"]{color:var(--dsw-alias-state-error-primary,#f85149)}',
      '.tov-goal-phase[data-phase="complete"]{color:var(--dsw-alias-state-success-primary,#3fb950)}',
      '.tov-goal-text{color:var(--dsw-alias-label-primary-dimmed,var(--dsw-alias-label-primary,#e6e6e6));',
      'display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
      '.tov-goal-note{font-size:11px;color:var(--dsw-alias-state-error-primary,#f85149);word-break:break-word}',
      '.tov-bar{height:5px;border-radius:999px;background:var(--dsw-alias-border-l4,rgba(255,255,255,.14));overflow:hidden}',
      '.tov-bar-fill{height:100%;border-radius:999px;background:var(--dsw-alias-state-business-primary,#4d8dff);transition:width .2s ease}',
      '.tov-todos{display:flex;flex-direction:column;gap:4px}',
      '.tov-todo{display:flex;align-items:flex-start;gap:7px;font-size:12px;line-height:18px}',
      '.tov-todo-mark{flex:none;width:14px;text-align:center;color:var(--dsw-alias-label-caption,#8a8f98)}',
      '.tov-todo-text{min-width:0;word-break:break-word}',
      '.tov-todo[data-status="completed"] .tov-todo-text{color:var(--dsw-alias-label-caption,#8a8f98);text-decoration:line-through}',
      '.tov-todo[data-status="in_progress"] .tov-todo-text{color:var(--dsw-alias-label-primary,#e6e6e6);font-weight:500}',
      '.tov-todo[data-status="in_progress"] .tov-todo-mark{color:var(--dsw-alias-state-business-primary,#4d8dff)}',
      '.tov-more{font-size:11px;color:var(--dsw-alias-label-caption,#8a8f98)}',
      '.tov-alert{display:flex;align-items:flex-start;gap:7px;padding:6px 8px;border-radius:8px;font-size:12px;line-height:18px}',
      '.tov-alert[data-kind="waiting"]{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#e0a11b) 16%,transparent);',
      'color:var(--dsw-alias-state-warning-primary,#e0a11b)}',
      '.tov-alert[data-kind="done"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#3fb950) 16%,transparent);',
      'color:var(--dsw-alias-state-success-primary,#3fb950)}',
      '.tov-rowlist{display:flex;flex-direction:column;gap:3px}',
      '.tov-row{display:flex;align-items:baseline;gap:7px;font-size:12px;line-height:18px}',
      '.tov-row-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
      'color:var(--dsw-alias-label-primary-dimmed,var(--dsw-alias-label-primary,#e6e6e6))}',
      '.tov-row-state{flex:none;font-size:11px;color:var(--dsw-alias-label-caption,#8a8f98)}',
      '.tov-row-state[data-state="waiting"]{color:var(--dsw-alias-state-warning-primary,#e0a11b)}',
      '.tov-row-state[data-state="running"]{color:var(--dsw-alias-state-business-primary,#4d8dff)}',
      '.tov-row-state[data-state="done"]{color:var(--dsw-alias-state-success-primary,#3fb950)}',
      '.tov-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;',
      'font-size:11px;color:var(--dsw-alias-label-caption,#8a8f98)}',
      // 桌面浮窗「开关」：放在侧栏底部（sidebar.footer.action，设置旁），不遮挡任何内容
      '.tov-toggle{display:flex;align-items:center;gap:7px;width:100%;box-sizing:border-box;',
      'padding:6px 8px;border:0;border-radius:6px;background:transparent;',
      'color:var(--dsw-alias-label-primary,#e6e6e6);font-size:12.5px;line-height:18px;',
      'cursor:pointer;font-family:inherit;text-align:left}',
      '.tov-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}',
      '.tov-toggle-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-caption,#8a8f98);flex:none}',
      '.tov-toggle-dot[data-on="1"]{background:var(--dsw-alias-state-success-primary,#3fb950)}',
      '.tov-toggle-state{margin-left:auto;color:var(--dsw-alias-label-tertiary,#9aa0a6);font-size:11px}',
    ].join('')

    if (typeof document !== 'undefined'
      && document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') === null) {
      var styleTag = document.createElement('style')
      styleTag.dataset.plugin = 'dsh-task-overlay'
      styleTag.dataset.pluginCss = STYLE_ID
      styleTag.textContent = CSS
      document.head.appendChild(styleTag)
    }

    /* ------------------------------------------------------------------ *
     * 本地持久化与位置计算
     * ------------------------------------------------------------------ */

    var POS_KEY = 'dsh-task-overlay/position'
    var COLLAPSE_KEY = 'dsh-task-overlay/collapsed'
    var CARD_WIDTH = 308
    var CARD_MARGIN = 16

    /* ---- 桌面浮窗桥接 ------------------------------------------------ *
     * GUI 里的客户端拥有完整状态（会话/运行/待确认/goal/todos），而独立桌面
     * 浮窗进程拿不到这些（宿主侧的投影注册在会话作用域里，root 上下文读不到）。
     * 所以由这里把压缩后的快照 POST 给桌面浮窗自带的 TCP 监听：
     *   * 固定端口 45123，text/plain + no-cors → 简单请求，不触发 CORS 预检；
     *   * 优先 sendBeacon（关页面也能送出最后一帧），退化到 fetch；
     *   * 2 秒心跳，桌面浮窗超过 6 秒没收到就显示「DSH 未运行」。
     * ------------------------------------------------------------------ */
    var BRIDGE_URL = 'http://127.0.0.1:45123/task-overlay'
    /**
     * 宿主控制接口（启停桌面浮窗）。用相对路径：桌面端 dsh-app://app/* 的
     * 非静态路径会被转发到宿主 webserver，Web 端则天然同源——两种形态都
     * 不依赖具体端口。
     */
    var CONTROL_URL = '/task-overlay/control'
    var BRIDGE_MIN_GAP_MS = 250
    var BRIDGE_HEARTBEAT_MS = 2000
    var bridgeLastSentAt = 0
    var bridgeLastSignature = ''

    function pushBridge(snapshot) {
      try {
        var now = Date.now()
        if (now - bridgeLastSentAt < BRIDGE_MIN_GAP_MS) return
        var body = JSON.stringify(snapshot)
        var stale = now - bridgeLastSentAt >= BRIDGE_HEARTBEAT_MS
        if (!stale && body === bridgeLastSignature) return
        bridgeLastSentAt = now
        bridgeLastSignature = body
        if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
          navigator.sendBeacon(BRIDGE_URL, body)
          return
        }
        if (typeof fetch === 'function') {
          fetch(BRIDGE_URL, {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'content-type': 'text/plain;charset=UTF-8' },
            body: body,
            keepalive: true,
          }).catch(noop)
        }
      } catch (error) {
        /* 桌面浮窗没在运行时忽略即可 */
      }
    }


    function readStored(key, fallback) {
      try {
        var raw = window.localStorage.getItem(key)
        if (raw === null) return fallback
        var parsed = JSON.parse(raw)
        return parsed === null || parsed === undefined ? fallback : parsed
      } catch (error) {
        return fallback
      }
    }

    function writeStored(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value))
      } catch (error) {
        /* 隐私模式或配额问题：忽略，不影响浮窗 */
      }
    }

    /** 默认停在右下角，越界时夹回视口内。 */
    function clampPosition(position) {
      var width = typeof window === 'undefined' ? 1280 : window.innerWidth
      var height = typeof window === 'undefined' ? 800 : window.innerHeight
      var maxX = Math.max(CARD_MARGIN, width - CARD_WIDTH - CARD_MARGIN)
      var maxY = Math.max(CARD_MARGIN, height - 72)
      var x = position !== null && position !== undefined && typeof position.x === 'number' ? position.x : maxX
      var y = position !== null && position !== undefined && typeof position.y === 'number'
        ? position.y
        : Math.max(CARD_MARGIN, height - 340)
      return { x: Math.min(Math.max(CARD_MARGIN, x), maxX), y: Math.min(Math.max(CARD_MARGIN, y), maxY) }
    }

    /* ------------------------------------------------------------------ *
     * 纯函数：把快照整理成渲染模型
     * ------------------------------------------------------------------ */

    var identity = function (snapshot) { return snapshot }
    var noop = function () {}

    var GOAL_PHASE_LABEL = { active: '进行中', paused: '已暂停', blocked: '受阻', complete: '已完成' }
    var TODO_MARK = { completed: '✔', in_progress: '◐', pending: '○' }

    /** 当前主视图会话：retainedBy.mainView > 0 的那一个（与官方 ui-session 判定一致）。 */
    function pickCurrentSessionId(list) {
      if (list === undefined || list === null || list.byId === undefined || list.byId === null) return null
      var order = Array.isArray(list.ids) && list.ids.length > 0 ? list.ids : Object.keys(list.byId)
      for (var i = 0; i < order.length; i += 1) {
        var row = list.byId[order[i]]
        if (row !== undefined && row !== null && row.retainedBy !== undefined
          && (row.retainedBy.mainView ?? 0) > 0) return row.id
      }
      return null
    }

    /** 汇总所有会话的提醒信号（跨会话，不只当前会话）。 */
    function collectSignals(list, statuses) {
      var running = []
      var waiting = []
      var done = []
      if (statuses !== undefined && statuses !== null && typeof statuses.forEach === 'function') {
        statuses.forEach(function (status, id) {
          if (status === undefined || status === null) return
          if (status.pendingInteraction !== undefined && status.pendingInteraction !== null) waiting.push(id)
          else if (status.running === true) running.push(id)
          if (status.completionUnread === true) done.push(id)
        })
      }
      if (list !== undefined && list !== null && list.byId !== undefined && list.byId !== null) {
        Object.keys(list.byId).forEach(function (id) {
          var row = list.byId[id]
          if (row === undefined || row === null || row.running !== true) return
          if (running.indexOf(id) === -1 && waiting.indexOf(id) === -1) running.push(id)
        })
      }
      var recency = function (id) {
        var row = list !== undefined && list !== null && list.byId !== undefined ? list.byId[id] : undefined
        return row !== undefined && row !== null && typeof row.updatedAt === 'number' ? row.updatedAt : 0
      }
      var byRecency = function (a, b) { return recency(b) - recency(a) }
      return { running: running.sort(byRecency), waiting: waiting.sort(byRecency), done: done.sort(byRecency) }
    }

    function cardStateOf(signals) {
      if (signals.waiting.length > 0) return 'waiting'
      if (signals.running.length > 0) return 'running'
      if (signals.done.length > 0) return 'done'
      return 'idle'
    }

    function titleOf(list, id) {
      var row = list !== undefined && list !== null && list.byId !== undefined ? list.byId[id] : undefined
      var title = row !== undefined && row !== null ? (row.displayTitle ?? row.title) : undefined
      if (typeof title === 'string' && title !== '') return title
      return typeof id === 'string' && id.length > 8 ? id.slice(0, 8) : String(id)
    }

    function relativeTime(updatedAt) {
      if (typeof updatedAt !== 'number' || updatedAt <= 0) return ''
      var seconds = Math.max(0, Math.round((Date.now() - updatedAt) / 1000))
      if (seconds < 60) return seconds + ' 秒前'
      var minutes = Math.round(seconds / 60)
      if (minutes < 60) return minutes + ' 分钟前'
      var hours = Math.round(minutes / 60)
      if (hours < 24) return hours + ' 小时前'
      return Math.round(hours / 24) + ' 天前'
    }

    /**
     * 订阅一个会话投影。会话未被 retain 时 binding 为 undefined；nonce 取列表快照里的
     * retainedBy.mainView 计数，retain 建立后它会变化，从而重算数据源。
     */
    function useSessionProjection(sessions, sessionId, key, nonce) {
      var source = React.useMemo(function () {
        if (sessions === undefined || sessions === null || typeof sessionId !== 'string') return null
        try {
          var binding = sessions.binding(sessionId)
          if (binding === undefined || binding === null) return null
          var face = binding.session?.projections?.faceOf?.(key)
          return face === undefined || face === null ? null : face
        } catch (error) {
          return null
        }
      }, [sessions, sessionId, key, nonce])

      var subscribe = React.useCallback(function (listener) {
        if (source === null) return noop
        try {
          return source.subscribe(listener)
        } catch (error) {
          return noop
        }
      }, [source])

      var getSnapshot = React.useCallback(function () {
        if (source === null) return null
        try {
          var value = source.getSnapshot()
          return value === undefined ? null : value
        } catch (error) {
          return null
        }
      }, [source])

      return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    }

    /* ------------------------------------------------------------------ *
     * 子视图
     * ------------------------------------------------------------------ */

    function TodoList(props) {
      var todos = props.todos
      if (!Array.isArray(todos) || todos.length === 0) return null
      var completed = 0
      var inProgress = 0
      for (var i = 0; i < todos.length; i += 1) {
        if (todos[i]?.status === 'completed') completed += 1
        if (todos[i]?.status === 'in_progress') inProgress += 1
      }
      var percent = Math.round((completed / todos.length) * 100)
      var weight = { in_progress: 0, pending: 1, completed: 2 }
      var ordered = todos.slice().sort(function (a, b) {
        return (weight[a?.status] ?? 3) - (weight[b?.status] ?? 3)
      })
      var visible = ordered.slice(0, 6)
      return h('div', { className: 'tov-block' },
        h('div', { className: 'tov-label' },
          h('span', null, '进度'),
          h('span', null, completed + '/' + todos.length + (inProgress > 0 ? ' · ' + inProgress + ' 进行中' : ''))),
        h('div', { className: 'tov-bar' }, h('div', { className: 'tov-bar-fill', style: { width: percent + '%' } })),
        h('div', { className: 'tov-todos' }, visible.map(function (todo, index) {
          return h('div', {
            className: 'tov-todo',
            'data-status': todo?.status ?? 'pending',
            key: (todo?.content ?? '') + index,
          },
            h('span', { className: 'tov-todo-mark' }, TODO_MARK[todo?.status] ?? '○'),
            h('span', { className: 'tov-todo-text', title: todo?.content ?? '' }, todo?.content ?? ''))
        })),
        ordered.length > visible.length
          ? h('div', { className: 'tov-more' }, '还有 ' + (ordered.length - visible.length) + ' 项')
          : null)
    }

    function GoalBlock(props) {
      var goalView = props.goalView
      var goal = goalView !== null && goalView !== undefined ? goalView.goal : undefined
      if (goal === undefined || goal === null) return null
      var phase = typeof goal.phase === 'string' ? goal.phase : 'active'
      var rounds = goalView !== null && typeof goalView.roundsStarted === 'number' ? goalView.roundsStarted : null
      var cap = typeof goal.maxGoalRounds === 'number' ? goal.maxGoalRounds : null
      return h('div', { className: 'tov-block' },
        h('div', { className: 'tov-label' },
          h('span', null, '目标'),
          h('span', { className: 'tov-goal-phase', 'data-phase': phase }, GOAL_PHASE_LABEL[phase] ?? phase),
          rounds !== null && cap !== null ? h('span', null, '第 ' + rounds + '/' + cap + ' 轮') : null),
        h('div', { className: 'tov-goal-text', title: goal.objective ?? '' }, goal.objective ?? ''),
        phase === 'blocked' && goal.blockedReason !== undefined && goal.blockedReason !== null
          ? h('div', { className: 'tov-goal-note' }, String(goal.blockedReason.message ?? goal.blockedReason))
          : null)
    }

    function AlertRows(props) {
      var signals = props.signals
      var list = props.list
      var renderRows = function (ids, state, stateLabel) {
        return h('div', { className: 'tov-rowlist' }, ids.slice(0, 4).map(function (id) {
          var name = titleOf(list, id)
          return h('div', { className: 'tov-row', key: id },
            h('span', { className: 'tov-row-name', title: name }, name),
            h('span', { className: 'tov-row-state', 'data-state': state }, stateLabel))
        }))
      }
      var hasAlerts = signals.waiting.length > 0 || signals.done.length > 0
      return h('div', { className: 'tov-block' },
        signals.waiting.length > 0
          ? h('div', { className: 'tov-alert', 'data-kind': 'waiting' },
            h('span', null, '⚠'),
            h('span', null, signals.waiting.length + ' 个会话等待你确认'))
          : null,
        signals.waiting.length > 0 ? renderRows(signals.waiting, 'waiting', '待确认') : null,
        signals.done.length > 0
          ? h('div', { className: 'tov-alert', 'data-kind': 'done' },
            h('span', null, '✓'),
            h('span', null, signals.done.length + ' 个会话已完成（未查看）'))
          : null,
        signals.done.length > 0 ? renderRows(signals.done, 'done', '已完成') : null,
        hasAlerts && signals.running.length > 0 ? renderRows(signals.running, 'running', '执行中') : null)
    }

    /** 捕获子树渲染异常：把问题显示在屏幕上，而不是静默消失。 */
    var OverlayErrorCatcher = class extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false, message: '' }
      }
      static getDerivedStateFromError(error) {
        return { failed: true, message: String(error && error.message ? error.message : error) }
      }
      componentDidCatch(error) {
        console.error('[task-overlay] 渲染失败：', error)
      }
      render() {
        if (!this.state.failed) return this.props.children
        return h('div', {
          className: 'tov-card',
          style: { right: '16px', bottom: '16px', borderColor: 'var(--dsw-alias-state-error-primary,#f85149)' },
        },
          h('div', { className: 'tov-head' },
            h('span', { className: 'tov-dot', 'data-state': 'idle' }),
            h('span', { className: 'tov-title' }, '任务悬浮窗渲染出错')),
          h('div', { className: 'tov-body' },
            h('div', { className: 'tov-goal-note' }, this.state.message)))
      }
    }

    /* ------------------------------------------------------------------ *
     * 悬浮窗主体
     * ------------------------------------------------------------------ */

    function makeTaskOverlay(sessions) {
      return function TaskOverlay(props) {
        // root 作用域标准 hooks：会话列表 + 会话状态（另有 useWorkspaces 等，本插件不用）
        var list = props.useSessions !== undefined ? props.useSessions(identity) : null
        var statuses = props.useSessionStatus !== undefined ? props.useSessionStatus(identity) : null

        var currentId = pickCurrentSessionId(list)
        var signals = collectSignals(list, statuses)
        var cardState = cardStateOf(signals)

        var currentRow = currentId !== null && list !== null && list.byId !== undefined ? list.byId[currentId] ?? null : null
        var nonce = currentRow !== null && currentRow.retainedBy !== undefined ? currentRow.retainedBy.mainView ?? 0 : 0
        var goalView = useSessionProjection(sessions, currentId, 'goal', nonce)
        var todos = useSessionProjection(sessions, currentId, 'todos', nonce)

        var positionState = React.useState(function () { return clampPosition(readStored(POS_KEY, null)) })
        var position = positionState[0]
        var setPosition = positionState[1]

        var collapsedState = React.useState(function () { return readStored(COLLAPSE_KEY, false) === true })
        var collapsed = collapsedState[0]
        var setCollapsed = collapsedState[1]

        var dragRef = React.useRef(null)

        // 出现新的提醒（待确认 / 完成未读）时自动展开一次，确保提示被看到
        var alertSignature = signals.waiting.join(',') + '|' + signals.done.join(',')
        var lastAlertRef = React.useRef(alertSignature)
        React.useEffect(function () {
          if (lastAlertRef.current === alertSignature) return
          lastAlertRef.current = alertSignature
          if (alertSignature !== '|' && collapsed) {
            setCollapsed(false)
            writeStored(COLLAPSE_KEY, false)
          }
        }, [alertSignature, collapsed, setCollapsed])

        React.useEffect(function () {
          var onResize = function () { setPosition(function (previous) { return clampPosition(previous) }) }
          window.addEventListener('resize', onResize)
          return function () { window.removeEventListener('resize', onResize) }
        }, [setPosition])

        var onPointerDown = React.useCallback(function (event) {
          if (event.button !== 0) return
          var target = event.target
          if (target !== null && target !== undefined && typeof target.closest === 'function' && target.closest('button') !== null) return
          dragRef.current = { startX: event.clientX, startY: event.clientY, origin: position }
          if (typeof event.currentTarget.setPointerCapture === 'function') {
            event.currentTarget.setPointerCapture(event.pointerId)
          }
          event.preventDefault()
        }, [position])

        var onPointerMove = React.useCallback(function (event) {
          var drag = dragRef.current
          if (drag === null) return
          setPosition(clampPosition({
            x: drag.origin.x + (event.clientX - drag.startX),
            y: drag.origin.y + (event.clientY - drag.startY),
          }))
        }, [setPosition])

        var onPointerUp = React.useCallback(function (event) {
          if (dragRef.current === null) return
          dragRef.current = null
          if (typeof event.currentTarget.releasePointerCapture === 'function') {
            try {
              event.currentTarget.releasePointerCapture(event.pointerId)
            } catch (error) {
              /* 已自行释放 */
            }
          }
          setPosition(function (current) {
            writeStored(POS_KEY, current)
            return current
          })
        }, [setPosition])

        var toggleCollapsed = React.useCallback(function () {
          setCollapsed(function (previous) {
            writeStored(COLLAPSE_KEY, !previous)
            return !previous
          })
        }, [setCollapsed])

        var runningCount = signals.running.length
        var badge = cardState === 'waiting'
          ? signals.waiting.length + ' 待确认'
          : cardState === 'running'
            ? runningCount + ' 执行中'
            : cardState === 'done'
              ? signals.done.length + ' 完成'
              : '空闲'

        // 折叠成小胶囊时也带一个 Todo 进度，方便瞟一眼
        var todoProgress = Array.isArray(todos) && todos.length > 0
          ? todos.filter(function (todo) { return todo?.status === 'completed' }).length + '/' + todos.length
          : null

        var currentStatus = currentId !== null && statuses !== null && typeof statuses.get === 'function'
          ? statuses.get(currentId) ?? null
          : null
        var currentStateLabel = currentId === null
          ? '无会话'
          : currentStatus !== null && currentStatus.pendingInteraction !== undefined && currentStatus.pendingInteraction !== null
            ? '待确认'
            : (currentRow !== null && currentRow.running === true) || (currentStatus !== null && currentStatus.running === true)
              ? '执行中'
              : '空闲'

        // 发给桌面浮窗的压缩快照（2 秒心跳，变化即时推送，节流在 pushBridge 内）
        var bridgeSessions = []
        var pushBridgeRow = function (ids, state) {
          for (var i = 0; i < ids.length && bridgeSessions.length < 12; i += 1) {
            var row = list !== null && list.byId !== undefined ? list.byId[ids[i]] : undefined
            bridgeSessions.push({
              id: ids[i],
              title: titleOf(list, ids[i]),
              state: state,
              subagent: row !== undefined && row !== null && row.origin === 'subagent',
            })
          }
        }
        pushBridgeRow(signals.waiting, 'waiting')
        pushBridgeRow(signals.running, 'running')
        pushBridgeRow(signals.done, 'done')

        var goalOfView = goalView !== null && goalView !== undefined ? goalView.goal : null
        var bridgeSnapshot = {
          v: 1,
          sentAt: Date.now(),
          page: typeof location !== 'undefined' && location.origin ? location.origin : null,
          state: cardState,
          counts: {
            running: signals.running.length,
            waiting: signals.waiting.length,
            done: signals.done.length,
          },
          current: currentId === null ? null : {
            id: currentId,
            title: titleOf(list, currentId),
            state: currentStateLabel === '待确认' ? 'waiting' : currentStateLabel === '执行中' ? 'running' : 'idle',
            updatedAt: currentRow !== null ? (currentRow.updatedAt ?? null) : null,
          },
          goal: goalOfView !== null && goalOfView !== undefined
            ? {
                phase: typeof goalOfView.phase === 'string' ? goalOfView.phase : 'active',
                objective: goalOfView.objective ?? '',
                roundsStarted: goalView !== null && typeof goalView.roundsStarted === 'number' ? goalView.roundsStarted : null,
                maxGoalRounds: typeof goalOfView.maxGoalRounds === 'number' ? goalOfView.maxGoalRounds : null,
                blocked: goalOfView.blockedReason !== undefined && goalOfView.blockedReason !== null
                  ? String(goalOfView.blockedReason.message ?? goalOfView.blockedReason)
                  : null,
              }
            : null,
          todos: Array.isArray(todos)
            ? {
                total: todos.length,
                completed: todos.filter(function (todo) { return todo?.status === 'completed' }).length,
                inProgress: todos.filter(function (todo) { return todo?.status === 'in_progress' }).length,
                items: todos.slice(0, 12).map(function (todo) {
                  return { content: todo?.content ?? '', status: todo?.status ?? 'pending' }
                }),
              }
            : null,
          sessions: bridgeSessions,
        }
        React.useEffect(function () { pushBridge(bridgeSnapshot) })

        // 独立心跳：即使没有渲染（例如 DSH 最小化、界面静止），也按固定节奏推送，
        // 让桌面浮窗知道 GUI 还活着，而不是误判成「DSH 未运行」。
        var bridgeRef = React.useRef(bridgeSnapshot)
        bridgeRef.current = bridgeSnapshot
        React.useEffect(function () {
          var timer = window.setInterval(function () { pushBridge(bridgeRef.current) }, BRIDGE_HEARTBEAT_MS)
          return function () { window.clearInterval(timer) }
        }, [])

        var body = collapsed ? null : h('div', { className: 'tov-body' },
          currentId === null
            ? h('div', { className: 'tov-label' }, h('span', null, '当前没有打开的会话'))
            : h('div', { className: 'tov-block' },
              h('div', { className: 'tov-label' },
                h('span', null, '当前会话'),
                h('span', null, currentStateLabel)),
              h('div', { className: 'tov-session' },
                h('span', { className: 'tov-session-name', title: titleOf(list, currentId) }, titleOf(list, currentId)),
                h('span', { className: 'tov-time' }, relativeTime(currentRow !== null ? currentRow.updatedAt : 0)))),
          h('div', { className: 'tov-sep' }),
          h(GoalBlock, { goalView: goalView }),
          h(TodoList, { todos: todos }),
          signals.waiting.length > 0 || signals.done.length > 0
            ? h(AlertRows, { signals: signals, list: list })
            : null,
          h('div', { className: 'tov-foot' },
            h('span', null, runningCount > 0 ? runningCount + ' 个会话执行中' : '无执行中的会话'),
            h('span', null, (props.useSessions !== undefined && props.useSessionStatus !== undefined ? '' : '缺 hooks · ') + 'v0.1.0')))

        var card = h('div', {
          className: 'tov-card',
          style: { left: position.x + 'px', top: position.y + 'px' },
          'data-state': cardState,
        },
          h('div', {
            className: 'tov-head',
            onPointerDown: onPointerDown,
            onPointerMove: onPointerMove,
            onPointerUp: onPointerUp,
            onPointerCancel: onPointerUp,
            title: '拖动可移动位置',
          },
            h('span', { className: 'tov-dot', 'data-state': cardState }),
            h('span', { className: 'tov-title' }, '任务悬浮窗'),
            collapsed && todoProgress !== null
              ? h('span', { className: 'tov-chip' }, todoProgress)
              : null,
            h('span', { className: 'tov-chip', 'data-tone': cardState }, badge),
            h('button', {
              type: 'button',
              className: 'tov-icon',
              title: collapsed ? '展开' : '折叠',
              'aria-expanded': collapsed ? 'false' : 'true',
              onClick: toggleCollapsed,
            }, collapsed ? '▸' : '▾')),
          body)

        var tree = h(OverlayErrorCatcher, null, card)
        return tree
      }
    }

    /* ------------------------------------------------------------------ *
     * 无 React 的状态采集与推送（桌面浮窗的数据源）
     * ------------------------------------------------------------------ */

    /**
     * 订阅会话列表 / 会话状态 / 当前会话的 goal+todos 投影，把压缩快照推给桌面浮窗。
     * 不依赖 React，也不占用任何 slot——GUI 里不会出现浮窗。
     * @param ctx - 客户端 Cordis 上下文。
     * @returns 停止订阅与心跳的清理函数。
     */
    function startBridge(ctx) {
      var sessions = ctx.sessions
      var statusSource = ctx.uiSession !== undefined && ctx.uiSession !== null
        ? ctx.uiSession.sessionStatus
        : null
      var stops = []
      var faceStops = []
      var faceSessionId = null
      var timer = null

      function readValue(source) {
        if (source === null || source === undefined) return null
        try {
          var value = source.getSnapshot()
          return value === undefined ? null : value
        } catch (error) {
          return null
        }
      }

      function faceOf(sessionId, key) {
        if (typeof sessionId !== 'string') return null
        try {
          var binding = sessions.binding(sessionId)
          if (binding === undefined || binding === null) return null
          var face = binding.session?.projections?.faceOf?.(key)
          return face === undefined || face === null ? null : face
        } catch (error) {
          return null
        }
      }

      /** 会话切换时重建投影订阅，让 goal/todos 变化也能立即推送。 */
      function ensureFaces(sessionId) {
        if (sessionId === faceSessionId) return
        faceSessionId = sessionId
        for (var i = 0; i < faceStops.length; i += 1) {
          try { faceStops[i]() } catch (error) { /* 已释放 */ }
        }
        faceStops = []
        if (sessionId === null) return
        var keys = ['goal', 'todos']
        for (var k = 0; k < keys.length; k += 1) {
          var face = faceOf(sessionId, keys[k])
          if (face === null || typeof face.subscribe !== 'function') continue
          try { faceStops.push(face.subscribe(sync)) } catch (error) { /* 订阅失败忽略 */ }
        }
      }

      /** 组装一帧给桌面浮窗的快照。 */
      function build() {
        var list = readValue(sessions.list)
        var statuses = readValue(statusSource)
        var currentId = pickCurrentSessionId(list)
        ensureFaces(currentId)

        var signals = collectSignals(list, statuses)
        var cardState = cardStateOf(signals)
        var currentRow = currentId !== null && list !== null && list.byId !== undefined
          ? list.byId[currentId] ?? null
          : null
        var currentStatus = currentId !== null && statuses !== null && typeof statuses.get === 'function'
          ? statuses.get(currentId) ?? null
          : null
        var currentState = currentId === null
          ? 'idle'
          : currentStatus !== null && currentStatus.pendingInteraction !== undefined && currentStatus.pendingInteraction !== null
            ? 'waiting'
            : (currentRow !== null && currentRow.running === true) || (currentStatus !== null && currentStatus.running === true)
              ? 'running'
              : 'idle'

        var goalView = readValue(faceOf(currentId, 'goal'))
        var goal = goalView !== null && goalView !== undefined ? goalView.goal ?? null : null
        var todos = readValue(faceOf(currentId, 'todos'))

        var rows = []
        var pushRows = function (ids, state) {
          for (var i = 0; i < ids.length && rows.length < 12; i += 1) {
            var row = list !== null && list.byId !== undefined ? list.byId[ids[i]] : undefined
            rows.push({
              id: ids[i],
              title: titleOf(list, ids[i]),
              state: state,
              subagent: row !== undefined && row !== null && row.origin === 'subagent',
            })
          }
        }
        pushRows(signals.waiting, 'waiting')
        pushRows(signals.running, 'running')
        pushRows(signals.done, 'done')

        return {
          v: 1,
          // 宿主端口：桌面浮窗用它做存活探测（DSH 端口会变，不能写死）。
          // 桌面端是 dsh-app:// 协议时 location.port 为空 → 浮窗按"存活"处理。
          hp: (typeof location !== 'undefined' && location.port) ? String(location.port) : '',
          state: cardState,
          counts: {
            running: signals.running.length,
            waiting: signals.waiting.length,
            done: signals.done.length,
          },
          current: currentId === null ? null : {
            id: currentId,
            title: titleOf(list, currentId),
            state: currentState,
            updatedAt: currentRow !== null ? (currentRow.updatedAt ?? null) : null,
          },
          goal: goal !== null && goal !== undefined
            ? {
                phase: typeof goal.phase === 'string' ? goal.phase : 'active',
                objective: goal.objective ?? '',
                roundsStarted: typeof goalView.roundsStarted === 'number' ? goalView.roundsStarted : null,
                maxGoalRounds: typeof goal.maxGoalRounds === 'number' ? goal.maxGoalRounds : null,
                blocked: goal.blockedReason !== undefined && goal.blockedReason !== null
                  ? String(goal.blockedReason.message ?? goal.blockedReason)
                  : null,
              }
            : null,
          todos: Array.isArray(todos)
            ? {
                total: todos.length,
                completed: todos.filter(function (todo) { return todo?.status === 'completed' }).length,
                inProgress: todos.filter(function (todo) { return todo?.status === 'in_progress' }).length,
                items: todos.slice(0, 12).map(function (todo) {
                  return { content: todo?.content ?? '', status: todo?.status ?? 'pending' }
                }),
              }
            : null,
          sessions: rows,
        }
      }

      function sync() {
        try { pushBridge(build()) } catch (error) { /* 快照失败不影响界面 */ }
      }

      try { if (sessions.list !== undefined) stops.push(sessions.list.subscribe(sync)) } catch (error) { /* 忽略 */ }
      try { if (statusSource !== null) stops.push(statusSource.subscribe(sync)) } catch (error) { /* 忽略 */ }

      sync()
      timer = window.setInterval(sync, BRIDGE_HEARTBEAT_MS)

      return function () {
        if (timer !== null) window.clearInterval(timer)
        for (var i = 0; i < stops.length; i += 1) {
          try { stops[i]() } catch (error) { /* 已释放 */ }
        }
        for (var k = 0; k < faceStops.length; k += 1) {
          try { faceStops[k]() } catch (error) { /* 已释放 */ }
        }
        stops = []
        faceStops = []
      }
    }

    /* ------------------------------------------------------------------ *
     * 桌面浮窗「开关」小胶囊
     * ------------------------------------------------------------------ */

    /**
     * 常驻侧栏底部的开关：显示桌面浮窗运行状态，点击调宿主控制接口启停。
     * @param props - 槽位注入的 { wide }（侧栏是否宽模式；false 表示 56px 窄栏）。
     */
    function ControlToggle(props) {
      var wide = props !== undefined && props !== null && props.wide !== false
      var state = React.useState(null)   // null=未知 true=开 false=关
      var running = state[0]
      var setRunning = state[1]

      var refresh = React.useCallback(function () {
        if (typeof fetch !== 'function') return
        fetch(CONTROL_URL, { method: 'GET', mode: 'cors', cache: 'no-store' })
          .then(function (response) { return response.json() })
          .then(function (data) {
            if (data !== null && data !== undefined && typeof data.running === 'boolean') setRunning(data.running)
          })
          .catch(function () { /* 宿主接口不可达时忽略 */ })
      }, [setRunning])

      React.useEffect(function () {
        refresh()
        var timer = window.setInterval(refresh, 5000)
        return function () { window.clearInterval(timer) }
      }, [refresh])

      var toggle = React.useCallback(function () {
        if (typeof fetch !== 'function') return
        fetch(CONTROL_URL, {
          method: 'POST',
          mode: 'cors',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'toggle' }),
        })
          .then(function (response) { return response.json() })
          .then(function (data) {
            if (data !== null && data !== undefined && typeof data.running === 'boolean') setRunning(data.running)
          })
          .catch(function () {})
      }, [setRunning])

      var label = running === true ? '开' : running === false ? '关' : '…'
      return h('button', {
        type: 'button',
        className: 'tov-toggle',
        onClick: toggle,
        title: running === true ? '桌面浮窗运行中，点击关闭' : running === false ? '桌面浮窗未运行，点击开启' : '正在获取桌面浮窗状态…',
      },
        h('span', { className: 'tov-toggle-dot', 'data-on': running === true ? '1' : '0' }),
        wide ? h('span', null, '桌面浮窗') : null,
        wide ? h('span', { className: 'tov-toggle-state' }, label) : null)
    }

    /* ------------------------------------------------------------------ *
     * 插件注册
     * ------------------------------------------------------------------ */

    /**
     * 安装浏览器半边：默认只做状态推送（桌面浮窗的数据源），并在侧栏底部
     * 常驻一个「桌面浮窗」开关。把 SHOW_GUI_OVERLAY 改成 true 可再恢复
     * 完整的 GUI 内悬浮窗（状态卡）。
     * @param ctx - 客户端 Cordis 上下文。
     */
    function apply(ctx) {
      var stopBridge = startBridge(ctx)
      ctx.effect(function () { return stopBridge }, 'task-overlay: desktop bridge')

      // 常驻开关：放在侧栏底部（设置旁），不遮挡内容
      ctx.slots.inject('sidebar.footer.action', function* () {
        yield ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'task-overlay-toggle',
          order: 10,
          label: '桌面浮窗',
        }, ControlToggle)
      })

      if (SHOW_GUI_OVERLAY) {
        var Overlay = makeTaskOverlay(ctx.sessions)
        ctx.slots.inject('shell.overlay', function* () {
          yield ctx.slots.register({
            name: 'shell.overlay',
            id: 'task-overlay',
            order: 60,
            label: '任务悬浮窗',
          }, Overlay)
        })
      }
    }

    exports.apply = apply
    exports.inject = ['sessions', 'uiSession', 'slots']
    return module.exports
  },
})
