# 任务悬浮窗 —— 独立桌面浮窗（无需管理员权限，无需安装任何依赖）
#
# 组成：
#   * 一个无边框、置顶、不进任务栏的 WPF 窗口（可拖动、可折叠、可关闭）
#   * 一个内置 TCP 监听（127.0.0.1:45123），接收 DSH GUI 里客户端插件推来的状态快照
#   * 20 秒无推送＝标注数据年龄；超过 150 秒且 DSH 端口也拒连才显示「DSH 未运行」，
#     窗口本身在任何情况下都不会消失
#
# 用法：pwsh -NoProfile -STA -ExecutionPolicy Bypass -File task-overlay.ps1 [-Port 45123] [-DshPort 19387] [-Width 300]
param(
  [int]$Port = 45123,
  [int]$DshPort = 19387,
  [int]$Width = 300,
  [string]$StateFile = "$env:USERPROFILE\.dsh\task-overlay\desktop-window.json"
)

# 单实例保护：已有一个浮窗在跑就静默退出，避免重复双击快捷方式开出第二个窗口
# （第二个实例会因 45123 被占用而变成无效窗口）。
$singleInstanceName = 'DSH.TaskOverlay.SingleInstance'
$alreadyRunning = $false
try {
  [void][System.Threading.Mutex]::OpenExisting($singleInstanceName)
  $alreadyRunning = $true
} catch [System.Threading.WaitHandleCannotBeOpenedException] {
  $alreadyRunning = $false
}
if ($alreadyRunning) { exit 0 }
$script:OverlayMutex = New-Object System.Threading.Mutex($true, $singleInstanceName)

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Xaml

# 用 Continue 而不是 Stop：这是常驻 GUI 脚本，任何一个事件处理器里的意外错误
# 都不该把整个进程/窗口带崩；关键路径已各自 try/catch。
$ErrorActionPreference = 'Continue'

# ---------------------------------------------------------------- 共享状态（跨 runspace）
$bag = [hashtable]::Synchronized(@{
  stop      = $false
  close     = $false      # 收到宿主控制命令「stop」后置 true，UI 据此关闭窗口
  payload   = ''
  at        = 0            # 收到时间：[Environment]::TickCount64
  listening = $false
  error     = ''
  requests  = 0
})

# ---------------------------------------------------------------- 监听 runspace
$listenerScript = {
  param($port, $bag)
  $listener = $null
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
    $listener.Start()
    $bag['listening'] = $true
  } catch {
    $bag['error'] = $_.Exception.Message
    return
  }
  $buffer = New-Object byte[] 262144
  while (-not $bag['stop']) {
    try {
      if (-not $listener.Pending()) { Start-Sleep -Milliseconds 100; continue }
      $client = $listener.AcceptTcpClient()
      try {
        $stream = $client.GetStream()
        $stream.ReadTimeout = 1500
        $read = $stream.Read($buffer, 0, $buffer.Length)
        if ($read -le 0) { continue }
        $text = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)
        $split = $text.IndexOf("`r`n`r`n")
        if ($split -lt 0) { continue }
        $head = $text.Substring(0, $split)
        $body = $text.Substring($split + 4)
        if ($head -match '(?im)^Content-Length:\s*(\d+)') {
          $need = [int]$Matches[1]
          $have = [System.Text.Encoding]::UTF8.GetByteCount($body)
          while ($have -lt $need) {
            $more = $stream.Read($buffer, 0, $buffer.Length)
            if ($more -le 0) { break }
            $body += [System.Text.Encoding]::UTF8.GetString($buffer, 0, $more)
            $have = [System.Text.Encoding]::UTF8.GetByteCount($body)
          }
        }
        if ($body.Trim().Length -gt 0) {
          # 控制命令（来自宿主控制接口）：{"cmd":"stop"} 之类；其余按状态快照处理
          $isCmd = $false
          try {
            $obj = $body | ConvertFrom-Json
            if ($null -ne $obj.cmd) {
              $isCmd = $true
              if ($obj.cmd -eq 'stop' -or $obj.cmd -eq 'exit') {
                $bag['close'] = $true
                $bag['stop'] = $true
              }
            }
          } catch { $isCmd = $false }
          if (-not $isCmd) {
            $bag['payload'] = $body
            $bag['at'] = [Environment]::TickCount64
            $bag['requests'] = [int]$bag['requests'] + 1
          }
        }
        $reply = [System.Text.Encoding]::UTF8.GetBytes("HTTP/1.1 204 No Content`r`nAccess-Control-Allow-Origin: *`r`nConnection: close`r`n`r`n")
        $stream.Write($reply, 0, $reply.Length)
        $stream.Flush()
      } catch {
      } finally {
        try { $client.Close() } catch {}
      }
    } catch {
      Start-Sleep -Milliseconds 200
    }
  }
  try { if ($listener) { $listener.Stop() } } catch {}
}

$runspace = [runspacefactory]::CreateRunspace()
$runspace.ApartmentState = 'MTA'
$runspace.ThreadOptions = 'ReuseThread'
$runspace.Open()
$ps = [powershell]::Create()
$ps.Runspace = $runspace
[void]$ps.AddScript($listenerScript).AddArgument($Port).AddArgument($bag)
$async = $ps.BeginInvoke()

# ---------------------------------------------------------------- 窗口
$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        Topmost="True" ShowInTaskbar="False" ResizeMode="NoResize"
        SizeToContent="Height" Width="300" FontFamily="Microsoft YaHei UI, Segoe UI"
        Title="任务悬浮窗" SnapsToDevicePixels="True">
  <Border x:Name="Card" CornerRadius="10" Background="#F2161719" BorderBrush="#33FFFFFF" BorderThickness="1">
    <Border.Effect>
      <DropShadowEffect BlurRadius="16" ShadowDepth="2" Direction="270" Opacity="0.45" Color="#000000"/>
    </Border.Effect>
    <StackPanel>
      <Grid x:Name="Header" Height="30" Background="Transparent">
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="Auto"/>
          <ColumnDefinition Width="*"/>
          <ColumnDefinition Width="Auto"/>
          <ColumnDefinition Width="Auto"/>
          <ColumnDefinition Width="Auto"/>
        </Grid.ColumnDefinitions>
        <Ellipse x:Name="Dot" Grid.Column="0" Width="7" Height="7" Fill="#8A8F98" Margin="11,0,7,0" VerticalAlignment="Center"/>
        <TextBlock x:Name="HeaderTitle" Grid.Column="1" Text="任务悬浮窗" Foreground="#E9E9E9" FontSize="12" FontWeight="SemiBold" VerticalAlignment="Center"/>
        <Border x:Name="ChipBox" Grid.Column="2" CornerRadius="8" BorderThickness="1" BorderBrush="#44FFFFFF" Padding="6,0" Margin="5,0,2,0" VerticalAlignment="Center">
          <TextBlock x:Name="ChipText" Text="等待连接" Foreground="#9AA0A6" FontSize="10.5"/>
        </Border>
        <Border x:Name="CollapseBtn" Grid.Column="3" Width="22" Height="20" CornerRadius="5" Background="Transparent" Cursor="Hand" VerticalAlignment="Center">
          <TextBlock x:Name="CollapseGlyph" Text="▾" Foreground="#9AA0A6" FontSize="11" HorizontalAlignment="Center" VerticalAlignment="Center"/>
        </Border>
        <Border x:Name="CloseBtn" Grid.Column="4" Width="22" Height="20" CornerRadius="5" Background="Transparent" Cursor="Hand" Margin="2,0,7,0" VerticalAlignment="Center">
          <TextBlock Text="✕" Foreground="#9AA0A6" FontSize="10" HorizontalAlignment="Center" VerticalAlignment="Center"/>
        </Border>
      </Grid>
      <StackPanel x:Name="Body" Margin="11,0,11,10">
        <TextBlock x:Name="SessionLabel" Text="当前会话" Foreground="#8A8F98" FontSize="10"/>
        <TextBlock x:Name="SessionText" Text="—" Foreground="#E9E9E9" FontSize="11.5" TextTrimming="CharacterEllipsis" Margin="0,1,0,0"/>
        <StackPanel x:Name="GoalBlock">
          <TextBlock x:Name="GoalLabel" Text="目标" Foreground="#8A8F98" FontSize="10" Margin="0,8,0,0"/>
          <TextBlock x:Name="GoalText" Text="" Foreground="#CFCFCF" FontSize="11" TextWrapping="Wrap" MaxHeight="42" Margin="0,1,0,0" TextTrimming="CharacterEllipsis"/>
        </StackPanel>
        <StackPanel x:Name="TodoBlock">
          <TextBlock x:Name="TodoLabel" Text="进度" Foreground="#8A8F98" FontSize="10" Margin="0,8,0,0"/>
          <Grid x:Name="BarTrack" Height="4" Margin="0,4,0,0">
            <Border CornerRadius="2" Background="#33FFFFFF"/>
            <Border x:Name="BarFill" CornerRadius="2" Background="#4D8DFF" HorizontalAlignment="Left" Width="0"/>
          </Grid>
          <StackPanel x:Name="TodoList" Margin="0,5,0,0"/>
        </StackPanel>
        <TextBlock x:Name="AlertText" Text="" Foreground="#E0A11B" FontSize="11" TextWrapping="Wrap" Margin="0,7,0,0"/>
        <TextBlock x:Name="FootText" Text="等待 DSH GUI 推送…" Foreground="#767B84" FontSize="10" Margin="0,7,0,0" TextWrapping="Wrap"/>
      </StackPanel>
    </StackPanel>
  </Border>
</Window>
'@

$window = [Windows.Markup.XamlReader]::Parse($xaml)
$name = { param($n) $window.FindName($n) }
$Card = & $name 'Card'; $Header = & $name 'Header'; $Dot = & $name 'Dot'
$ChipBox = & $name 'ChipBox'; $ChipText = & $name 'ChipText'
$CollapseBtn = & $name 'CollapseBtn'; $CollapseGlyph = & $name 'CollapseGlyph'; $CloseBtn = & $name 'CloseBtn'
$Body = & $name 'Body'; $SessionText = & $name 'SessionText'; $SessionLabel = & $name 'SessionLabel'
$GoalBlock = & $name 'GoalBlock'; $GoalText = & $name 'GoalText'; $GoalLabel = & $name 'GoalLabel'
$TodoBlock = & $name 'TodoBlock'; $BarTrack = & $name 'BarTrack'; $BarFill = & $name 'BarFill'; $TodoList = & $name 'TodoList'; $TodoLabel = & $name 'TodoLabel'
$AlertText = & $name 'AlertText'; $FootText = & $name 'FootText'; $HeaderTitle = & $name 'HeaderTitle'

if ($Width -lt 200) { $Width = 240 }
if ($Width -gt 520) { $Width = 520 }
$window.Width = $Width
$MiniWidth = 190

# 是否显示「刚完成」的本地记忆：sessionId -> tick
$completedAt = @{}
$lastSeenRunning = @{}
$collapsed = $false
# 迷你胶囊里的标题（如「任务 5/6」），由每帧快照更新
$script:miniTitle = '任务'
# 进度条宽度计算的缓存值，先初始化避免 ConvertFrom-Json 意外字段时 [int]$null 报错
$script:lastTotal = 0
$script:lastDone = 0

# DSH 端口探测状态（推送稀疏时用它判断 DSH 是否还在运行）
$script:lastProbeAt = 0
$script:hostAlive = $true

# 探测 DSH 宿主端口是否还在监听（页面最小化会节流推送，不能只凭推送判断存活）
function Test-PageHost {
  $client = $null
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $task = $client.ConnectAsync('127.0.0.1', [int]$DshPort)
    $completed = $task.Wait(400)
    return ($completed -and $client.Connected)
  } catch {
    return $false
  } finally {
    if ($null -ne $client) { try { $client.Close() } catch {} }
  }
}

# ---- 位置与折叠状态持久化
function Load-WindowState {
  try {
    if (Test-Path $StateFile) {
      $s = Get-Content $StateFile -Raw | ConvertFrom-Json
      if ($null -ne $s.left) { $window.Left = [double]$s.left }
      if ($null -ne $s.top) { $window.Top = [double]$s.top }
      if ($s.collapsed -eq $true) { Set-Collapsed $true }
      $script:collapsed = ($s.collapsed -eq $true)
    }
    # 夹回工作区：防止上次存的位置在新分辨率 / 新显示器下跑到屏幕外（窗口“丢了”）
    $wa = [System.Windows.SystemParameters]::WorkArea
    $winW = [double]$window.Width
    if ($window.Left -lt $wa.Left - 40) { $window.Left = $wa.Left + 16 }
    if ($window.Top -lt $wa.Top - 20) { $window.Top = $wa.Top + 16 }
    if (($window.Left + $winW) -gt ($wa.Right + 40)) { $window.Left = $wa.Right - $winW - 16 }
    if ($window.Top -gt ($wa.Bottom - 24)) { $window.Top = $wa.Bottom - 72 }
  } catch {}
}
function Save-WindowState {
  try {
    $dir = Split-Path -Parent $StateFile
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    @{ left = [math]::Round($window.Left, 0); top = [math]::Round($window.Top, 0); collapsed = $script:collapsed } |
      ConvertTo-Json -Compress | Set-Content -Path $StateFile -Encoding UTF8
  } catch {}
}
function Set-Collapsed($value) {
  $script:collapsed = $value
  if ($value) {
    # 迷你胶囊：只剩标题栏（状态点 + 进度/状态 + 展开/关闭），宽度收到 ~190
    $Body.Visibility = 'Collapsed'
    $CollapseGlyph.Text = '▸'
    $window.Width = $MiniWidth
    $HeaderTitle.Text = if ($script:miniTitle) { $script:miniTitle } else { '任务' }
  } else {
    $Body.Visibility = 'Visible'
    $CollapseGlyph.Text = '▾'
    $window.Width = $Width
    $HeaderTitle.Text = '任务悬浮窗'
  }
}

# 默认位置：右下角（首次运行时）
$screen = [System.Windows.SystemParameters]::WorkArea
$window.Left = $screen.Right - $Width - 24
$window.Top = $screen.Bottom - 240
Load-WindowState

# ---- 拖动：点在折叠/关闭按钮上时不启动拖拽，让按钮的点击事件正常触发
$Header.Add_MouseLeftButtonDown({ param($sender, $e)
  $hit = $false
  $cur = $e.OriginalSource
  for ($i = 0; $i -lt 12 -and $null -ne $cur; $i++) {
    if ($cur -eq $CollapseBtn -or $cur -eq $CloseBtn) { $hit = $true; break }
    try { $cur = $cur.Parent } catch { $cur = $null }
  }
  if (-not $hit) { try { $window.DragMove() } catch {} }
})
$Header.Add_MouseLeftButtonUp({ Save-WindowState })
$Header.Cursor = 'SizeAll'

# ---- 折叠 / 关闭
$CollapseBtn.Add_MouseLeftButtonUp({ Set-Collapsed (-not $script:collapsed); Save-WindowState })
$CloseBtn.Add_MouseLeftButtonUp({ $bag['stop'] = $true; $window.Close() })

# ---- 悬停反馈（事件处理里 $this 即发送者）
$CollapseBtn.Add_MouseEnter({ $this.Background = '#1FFFFFFF' })
$CollapseBtn.Add_MouseLeave({ $this.Background = 'Transparent' })
$CloseBtn.Add_MouseEnter({ $this.Background = '#1FFFFFFF' })
$CloseBtn.Add_MouseLeave({ $this.Background = 'Transparent' })

# ---------------------------------------------------------------- UI 更新
function New-TodoLine($item) {
  $row = New-Object Windows.Controls.StackPanel
  $row.Orientation = 'Horizontal'
  $row.Margin = '0,1,0,1'
  $mark = New-Object Windows.Controls.TextBlock
  $mark.FontSize = 11.5
  $mark.Width = 15
  $mark.Text = if ($item.status -eq 'completed') { '✔' } elseif ($item.status -eq 'in_progress') { '◐' } else { '○' }
  $mark.Foreground = switch ($item.status) {
    'completed' { '#7A7F88' }
    'in_progress' { '#4D8DFF' }
    default { '#8A8F98' }
  }
  $text = New-Object Windows.Controls.TextBlock
  $text.FontSize = 11.5
  $text.Text = [string]$item.content
  $text.TextTrimming = 'CharacterEllipsis'
  $text.MaxWidth = [math]::Max(120, $Width - 52)
  if ($item.status -eq 'completed') { $text.Foreground = '#7A7F88'; $text.TextDecorations = [Windows.TextDecorations]::Strikethrough }
  elseif ($item.status -eq 'in_progress') { $text.Foreground = '#F0F0F0'; $text.FontWeight = 'SemiBold' }
  else { $text.Foreground = '#C7CBD1' }
  [void]$row.Children.Add($mark)
  [void]$row.Children.Add($text)
  return $row
}

function Update-FromPayload($raw) {
  $data = $raw | ConvertFrom-Json
  $state = [string]$data.state
  $counts = $data.counts

  # 状态点与徽标
  $dotColor = switch ($state) {
    'running' { '#4D8DFF' }
    'waiting' { '#E0A11B' }
    'done' { '#3FB950' }
    default { '#8A8F98' }
  }
  $Dot.Fill = $dotColor
  $ChipBox.BorderBrush = $dotColor
  $ChipText.Foreground = $dotColor

  $badge = switch ($state) {
    'waiting' { "$($counts.waiting) 待确认" }
    'running' { "$($counts.running) 执行中" }
    'done' { "$($counts.done) 完成" }
    default { '空闲' }
  }
  $ChipText.Text = $badge
  $Card.BorderBrush = '#33FFFFFF'

  # 当前会话
  if ($null -ne $data.current) {
    $SessionText.Text = [string]$data.current.title
    $stateLabel = switch ([string]$data.current.state) {
      'running' { '执行中' }
      'waiting' { '待确认' }
      default { '空闲' }
    }
    $SessionLabel.Text = "当前会话 · $stateLabel"
  } else {
    $SessionText.Text = '没有打开的会话'
    $SessionLabel.Text = '当前会话'
  }

  # 目标
  if ($null -ne $data.goal -and [string]$data.goal.objective -ne '') {
    $GoalBlock.Visibility = 'Visible'
    $phaseLabel = switch ([string]$data.goal.phase) {
      'active' { '进行中' }
      'paused' { '已暂停' }
      'blocked' { '受阻' }
      'complete' { '已完成' }
      default { [string]$data.goal.phase }
    }
    $rounds = if ($null -ne $data.goal.roundsStarted -and $null -ne $data.goal.maxGoalRounds) {
      " · 第 $($data.goal.roundsStarted)/$($data.goal.maxGoalRounds) 轮"
    } else { '' }
    $GoalLabel.Text = "目标 · $phaseLabel$rounds"
    $GoalText.Text = [string]$data.goal.objective
    if ($null -ne $data.goal.blocked) { $GoalText.Text = "$($data.goal.objective)`n⚠ $($data.goal.blocked)" }
  } else {
    $GoalBlock.Visibility = 'Collapsed'
  }

  # Todo 进度
  if ($null -ne $data.todos -and [int]$data.todos.total -gt 0) {
    $TodoBlock.Visibility = 'Visible'
    $total = [int]$data.todos.total
    $done = [int]$data.todos.completed
    $inProgress = [int]$data.todos.inProgress
    $TodoLabel.Text = "进度 · $done/$total" + $(if ($inProgress -gt 0) { " · $inProgress 进行中" } else { '' })
    $ratio = if ($total -gt 0) { $done / $total } else { 0 }
    $script:lastTotal = $total
    $script:lastDone = $done
    $BarFill.Width = [math]::Max(0, [double]$BarTrack.ActualWidth * $ratio)
    if ($BarTrack.ActualWidth -le 0) { $BarFill.Width = 280 * $ratio }
    $TodoList.Children.Clear()
    $shown = 0
    foreach ($item in $data.todos.items) {
      if ($shown -ge 5) { break }
      [void]$TodoList.Children.Add((New-TodoLine $item))
      $shown++
    }
    if ($total -gt $shown) {
      $more = New-Object Windows.Controls.TextBlock
      $more.Text = "还有 $($total - $shown) 项"
      $more.FontSize = 10.5
      $more.Foreground = '#767B84'
      $more.Margin = '15,2,0,0'
      [void]$TodoList.Children.Add($more)
    }
  } else {
    $TodoBlock.Visibility = 'Collapsed'
  }

  # 迷你胶囊里的标题（折叠状态只显示这一行）：有 Todo 就显示进度，状态交给右侧徽标
  if ($null -ne $data.todos -and [int]$data.todos.total -gt 0) {
    $script:miniTitle = "任务 $([int]$data.todos.completed)/$([int]$data.todos.total)"
  } else {
    $script:miniTitle = '任务'
  }
  if ($script:collapsed) { $HeaderTitle.Text = $script:miniTitle }

  # 提醒
  $lines = @()
  if ($counts.waiting -gt 0) { $lines += "⚠ $($counts.waiting) 个会话等待你确认" }
  if ($counts.done -gt 0) { $lines += "✓ $($counts.done) 个会话已完成（未查看）" }
  foreach ($s in $data.sessions) {
    if ($lines.Count -ge 5) { break }
    $mark = switch ([string]$s.state) {
      'waiting' { '待确认' }
      'running' { '执行中' }
      'done' { '已完成' }
      default { '' }
    }
    if ($mark -ne '') {
      $prefix = if ($s.subagent -eq $true) { '子代理 · ' } else { '' }
      $lines += "· $prefix$($s.title) — $mark"
    }
  }
  $AlertText.Text = ($lines -join "`n")

  # 页脚
  $FootText.Text = "已连接 · 端口 $Port · 收到 $($bag['requests']) 次推送"
}

function Update-Disconnected {
  $Dot.Fill = '#F85149'
  $ChipBox.BorderBrush = '#F85149'
  $ChipText.Foreground = '#F85149'
  $ChipText.Text = '未连接'
  $SessionLabel.Text = '当前会话'
  $SessionText.Text = 'DSH 未运行'
  $GoalBlock.Visibility = 'Collapsed'
  $TodoBlock.Visibility = 'Collapsed'
  $AlertText.Text = ''
  $err = [string]$bag['error']
  if ($err -ne '') {
    $FootText.Text = "端口 $Port 监听失败：$err"
  } else {
    $FootText.Text = "等待 DSH GUI 推送（端口 $Port）… 关闭或最小化 DSH 后本窗口仍在"
  }
}

# ---------------------------------------------------------------- 定时刷新
$lastAt = -1
$lastPayload = ''
$stale = $true
$script:closed = $false
$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(250)
$timer.Add_Tick({
  # 收到宿主控制命令「stop」后关闭窗口
  if ($bag['close'] -and -not $script:closed) {
    $script:closed = $true
    $window.Close()
    return
  }
  $at = [long]$bag['at']
  if ($at -ne $script:lastAt) {
    $script:lastAt = $at
    # 供排查用的轻量状态文件（推送计数 + 最后一帧），每收到一帧就更新
    try {
      $dir = Split-Path -Parent $StateFile
      if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
      @{ at = [DateTime]::UtcNow.ToString('o'); requests = [int]$bag['requests']; payload = [string]$bag['payload'] } |
        ConvertTo-Json -Compress -Depth 8 | Set-Content -Path (Join-Path $dir 'last-payload.json') -Encoding UTF8
    } catch {}
    $payload = [string]$bag['payload']
    if ($payload -ne $script:lastPayload) {
      $script:lastPayload = $payload
      try { Update-FromPayload $payload; $script:stale = $false }
      catch { $FootText.Text = "快照解析失败：$($_.Exception.Message)" }
    }
  }
  $age = if ($at -eq 0) { [double]::MaxValue } else { ([Environment]::TickCount64 - $at) / 1000.0 }
  # 三段式：20 秒内＝实时；超过 20 秒保留最后一帧只标注数据年龄；
  # 超过 150 秒且 DSH 端口也拒连（或一直没等到任何推送）才判定「DSH 未运行」。
  if ($age -gt 20) {
    if (([Environment]::TickCount64 - $script:lastProbeAt) -gt 5000) {
      $script:lastProbeAt = [Environment]::TickCount64
      $script:hostAlive = Test-PageHost
    }
    $dead = ($age -gt 150) -and (-not $script:hostAlive)
    if ($dead) {
      if (-not $script:stale) { $script:stale = $true; Update-Disconnected }
    } elseif ($script:stale -and $at -gt 0) {
      $script:stale = $false
      try { Update-FromPayload ([string]$bag['payload']) } catch {}
    }
  } elseif ($script:stale -and $at -gt 0) {
    $script:stale = $false
    try { Update-FromPayload ([string]$bag['payload']) } catch {}
  }
  if (-not $script:stale) {
    if ($age -le 20) {
      $FootText.Text = "已连接 · 端口 $Port · $([int]$age) 秒前更新 · 收到 $($bag['requests']) 次推送"
    } elseif ($script:hostAlive) {
      $FootText.Text = "DSH 运行中 · 数据 $([int]$age) 秒未更新 · 端口 $Port"
    } else {
      $FootText.Text = "数据 $([int]$age) 秒未更新（DSH 端口 $DshPort 未响应）"
    }
  }
  # 进度条宽度跟随窗口尺寸
  if ($BarTrack.ActualWidth -gt 0 -and $TodoBlock.Visibility -eq 'Visible') {
    $total = [int]$script:lastTotal
    if ($total -gt 0) { $BarFill.Width = [math]::Max(0, [double]$BarTrack.ActualWidth * ([double]$script:lastDone / $total)) }
  }
})
$timer.Start()

$window.Add_Closed({
  $bag['stop'] = $true
  $timer.Stop()
  try { $ps.Stop() } catch {}
  try { $runspace.Close() } catch {}
  # 没有 WPF Application 时，窗口关闭并不会让 Dispatcher.Run() 返回、进程也不会退出，
  # 从而留下占用单实例互斥量的僵尸进程（会挡住后续「启动」）。这里显式结束进程。
  [Environment]::Exit(0)
})

$window.Add_Closing({ Save-WindowState })

[void]$window.Show()
[void]$window.Activate()
Update-Disconnected
[Windows.Threading.Dispatcher]::Run()
