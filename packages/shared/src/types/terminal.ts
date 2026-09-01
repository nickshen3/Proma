/**
 * 本地终端 Tab 的跨进程数据契约。
 *
 * Renderer 只能传递 profile/cwd/尺寸和终端输入，不能指定任意可执行文件，
 * 具体 shell 始终在受控的 Terminal Runtime 中解析。
 */

export const TERMINAL_IPC_CHANNELS = {
  CREATE: 'terminal:create',
  INPUT: 'terminal:input',
  RESIZE: 'terminal:resize',
  KILL: 'terminal:kill',
  SNAPSHOT: 'terminal:snapshot',
  ACK_OUTPUT: 'terminal:ack-output',
  AGENT_OPEN: 'terminal:agent-open',
  AGENT_CLOSE: 'terminal:agent-close',
  OUTPUT: 'terminal:output',
  EXIT: 'terminal:exit',
} as const

export type TerminalProfile = 'default' | 'zsh' | 'bash' | 'pwsh' | 'powershell' | 'cmd' | 'git-bash' | 'wsl'

/**
 * 实际解析出的 shell 家族，决定命令结束 marker 与一次性命令参数的拼法。
 * - posix：zsh / bash / Git Bash / WSL 内的 Linux shell；
 * - powershell：Windows PowerShell 与 PowerShell 7；
 * - cmd：Windows Command Prompt，无法回显控制序列，不支持命令级等待信号。
 */
export type TerminalShellKind = 'posix' | 'powershell' | 'cmd'

export interface TerminalCreateInput {
  terminalId: string
  /** 终端所属 Agent 会话；主进程据此在会话删除时回收 PTY。 */
  sessionId: string
  cwd?: string
  profile?: TerminalProfile
  /**
   * 一次性命令：提供时 PTY 直接以 <shell> -c <command> 运行，命令结束即 shell 退出，
   * 从而获得精确的 exit 信号；不提供时为长驻交互 shell。
   */
  command?: string
  cols: number
  rows: number
}

export interface TerminalInput {
  terminalId: string
  data: string
}

export interface TerminalResizeInput {
  terminalId: string
  cols: number
  rows: number
}

export interface TerminalState {
  terminalId: string
  title: string
  cwd: string
  profile: TerminalProfile
  pid: number
  /** 实际解析出的 shell 家族；供主进程决定命令结束信号的拼法。 */
  shellKind?: TerminalShellKind
  /** 一次性命令终端的原始命令；交互终端不带该字段。 */
  command?: string
}

export interface TerminalOutputEvent {
  terminalId: string
  /** 单终端单调递增，用于重连去重与 ACK。 */
  sequence: number
  data: string
}

export interface TerminalOutputAck {
  terminalId: string
  sequence: number
}

/**
 * 终端视图重挂载时的受控恢复材料。output 是有限滚动缓冲，sequence 表示其末尾。
 */
export interface TerminalSnapshot {
  state: TerminalState
  output: string
  sequence: number
}

/** 主进程通知 Renderer：Agent 已创建一个应呈现在其右侧工作区的终端。 */
export interface AgentTerminalOpenEvent {
  sessionId: string
  terminalId: string
  title: string
  cwd: string
}

export interface AgentTerminalCloseEvent {
  sessionId: string
  terminalId: string
}

export interface TerminalExitEvent {
  terminalId: string
  exitCode: number
  signal?: number
}

export function isTerminalProfile(value: unknown): value is TerminalProfile {
  return value === 'default'
    || value === 'zsh'
    || value === 'bash'
    || value === 'pwsh'
    || value === 'powershell'
    || value === 'cmd'
    || value === 'git-bash'
    || value === 'wsl'
}
