/**
 * dsh-task-overlay —— 宿主半边。
 *
 * 提供 /task-overlay/control：start / stop / toggle / status，供 GUI 侧栏的
 * 「桌面浮窗」开关调用，用来启停独立的桌面浮窗进程（Windows 专用）。
 *
 * 安全：
 *   * 只接受同源（或桌面端 dsh-app://）的浏览器请求，防止任意网页 CSRF 启停浮窗；
 *   * 只绑定 webServer 自身的监听地址（默认 127.0.0.1）；
 *   * start 只执行包内固定脚本路径，不拼接任何外部输入。
 *
 * 已知的坑（0.2.0-rc.2 实测，勿回退）：
 *   * apply 必须同步（加载器不等待 async apply）；
 *   * spawn 子进程不要用 detached:true（pwsh 会立即退出）；
 *   * 宿主代码改动要热生效需换新包名（Node ESM 按解析路径缓存）。
 *
 * @module dsh-task-overlay
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis 行身份名（与 cordis.patch.yml 的 id 保持一致）。 */
export const name = 'task-overlay'

/** 只需要 webServer。 */
export const inject = ['webServer']

/** 桌面浮窗的桥接端口（与 dsh/client.js 的 BRIDGE_URL、desktop/task-overlay.ps1 的 -Port 一致）。 */
const OVERLAY_PORT = 45123
/** 控制路由路径。 */
const CONTROL_PATH = '/task-overlay/control'

/** 桌面浮窗脚本：位于本包 desktop/ 内（npm 安装后同样成立）。 */
function overlayScript() {
  const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))   // .../dsh-task-overlay
  return join(pkgRoot, 'desktop', 'task-overlay.ps1')
}

/** pwsh：优先绝对路径，退回 PATH 里的 pwsh。 */
function pwshPath() {
  const abs = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
  if (existsSync(abs)) return abs
  return 'pwsh'
}

/** 启动桌面浮窗（隐藏控制台；不用 detached）。 */
function startOverlay() {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(
        pwshPath(),
        ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', overlayScript()],
        { stdio: 'ignore', windowsHide: true },
      )
    } catch (error) {
      resolve(false)
      return
    }
    let settled = false
    const done = (ok) => { if (!settled) { settled = true; resolve(ok) } }
    child.once('error', () => done(false))
    child.once('spawn', () => { child.unref(); done(true) })
  })
}

/** 浮窗是否在运行：桥接端口可否连上。 */
function overlayRunning() {
  return new Promise((resolve) => {
    const sock = connect(OVERLAY_PORT, '127.0.0.1')
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      try { sock.destroy() } catch (error) { /* 已关 */ }
      resolve(value)
    }
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    sock.setTimeout(400, () => done(false))
  })
}

/** 优雅停止：给浮窗桥接端口发 {"cmd":"stop"}，浮窗自行关闭。 */
function stopOverlay() {
  return new Promise((resolve) => {
    const body = JSON.stringify({ cmd: 'stop' })
    const sock = connect(OVERLAY_PORT, '127.0.0.1')
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      try { sock.destroy() } catch (error) { /* 已关 */ }
      resolve(value)
    }
    sock.once('error', () => done(false))
    sock.setTimeout(600, () => done(false))
    sock.once('connect', () => {
      const request = [
        'POST /control HTTP/1.1',
        'Host: 127.0.0.1',
        'Content-Type: text/plain;charset=UTF-8',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        body,
      ].join('\r\n')
      sock.write(request)
      sock.once('close', () => done(true))
      sock.on('data', () => {})
    })
  })
}

/** 轮询等待浮窗进入期望状态。 */
async function waitForRunning(expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const running = await overlayRunning()
    if (running === expected) return running
    if (Date.now() >= deadline) return running
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

/** 读取请求体（上限 64KB）。 */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      chunks.push(chunk)
      size += chunk.length
      if (size > 65536) { req.destroy(); resolve(null) }
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(null))
  })
}

/**
 * 同源校验：浏览器跨站请求必带 Origin，不在白名单一律拒绝（防 CSRF 启停）。
 * 无 Origin 视为本机非浏览器调用（curl / 本地进程）。
 */
function originAllowed(req) {
  const origin = req.headers.origin
  if (origin === undefined || origin === null || origin === '') return true
  if (origin === 'dsh-app://app') return true
  try {
    const parsed = new URL(origin)
    const host = (req.headers.host ?? '').toLowerCase()
    return host !== '' && parsed.host.toLowerCase() === host
  } catch (error) {
    return false
  }
}

/** 控制路由处理器。 */
async function controlHandler(req, res) {
  if (!originAllowed(req)) {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: false, error: 'origin-not-allowed' }))
    return
  }

  const headers = {
    'access-control-allow-origin': req.headers.origin ?? '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  }
  const send = (status, body) => {
    const text = body === undefined ? '' : JSON.stringify(body)
    res.writeHead(status, { ...headers, 'content-length': Buffer.byteLength(text) })
    res.end(text)
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers)
    res.end()
    return
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    const running = await overlayRunning()
    res.writeHead(200, headers)
    res.end(req.method === 'HEAD' ? '' : JSON.stringify({ ok: true, running }))
    return
  }
  if (req.method === 'POST') {
    const raw = await readBody(req)
    let action = 'status'
    try {
      const parsed = raw ? JSON.parse(raw) : {}
      if (typeof parsed.action === 'string') action = parsed.action
    } catch (error) {
      action = 'status'
    }

    let running = await overlayRunning()
    if (action === 'start') {
      if (!running) { const spawned = await startOverlay(); running = spawned ? await waitForRunning(true, 3000) : false }
    } else if (action === 'stop') {
      if (running) { await stopOverlay(); running = await waitForRunning(false, 1500) }
    } else if (action === 'toggle') {
      if (running) { await stopOverlay(); running = await waitForRunning(false, 1500) }
      else { const spawned = await startOverlay(); running = spawned ? await waitForRunning(true, 3000) : false }
    }
    send(200, { ok: true, running })
    return
  }
  send(405, { ok: false, error: 'method-not-allowed' })
}

/**
 * 安装控制路由（同步 apply；路由被占用时优雅跳过）。
 * @param ctx - 宿主 Cordis 上下文。
 */
export function apply(ctx) {
  ctx.effect(() => {
    try {
      return ctx.webServer.register({ kind: 'exact', path: CONTROL_PATH, handler: controlHandler })
    } catch (error) {
      // 本机可能仍装着旧的 dsh-task-overlay-host 开发包占用了同一路径，跳过即可。
      ctx.logger?.warn?.('task-overlay: 控制路由注册失败（可能已被占用）：%s', String(error?.message ?? error))
      return () => {}
    }
  }, 'task-overlay: control route')
}
