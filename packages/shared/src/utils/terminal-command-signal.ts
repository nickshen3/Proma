/**
 * 终端命令级结束信号工具。
 *
 * Agent 终端默认是长驻交互 shell，PTY 只有 shell 级 exit 信号；为了让主进程在
 * “单条命令结束”时立即得到通知，这里提供两条互补路径：
 * 1. marker 回显：把一条 OSC 633 私有序列回显拼在用户命令之后。xterm.js 不渲染
 *    未知 OSC（用户终端无感），readTerminalOutput 的 normalize 也会剥掉控制序列
 *    （模型读不到脏数据），只有主进程在 raw 流上扫描它。
 * 2. one-shot spawn：让 PTY 直接运行 <shell> -c <command>，命令结束即 shell 退出，
 *    复用现成的 shell 级 exit 事件即可拿到精确退出码。
 *
 * 本模块保持纯函数、不依赖 node API，可同时被打进 main 与 terminal runtime bundle。
 */

import type { TerminalShellKind } from '../types/terminal'

/** marker 形如 ESC ] 633 ; proma-done ; <id> : <exitCode> BEL */
const MARKER_HEAD = '\x1b]633;proma-done;'
const MARKER_TAIL = '\x07'
/** 扫描缓冲只保留末尾一小段，防止跨 chunk 分片漏检的同时避免无限增长。 */
const MAX_SCAN_BUFFER_CHARS = 512

/** shell 家族 + 一次性命令的完整解析输入；wsl 在 win32 下需要特殊处理。 */
export type OneShotShellKind = TerminalShellKind | 'wsl'

/** 生成一次性 marker ID；只需在单个终端生命周期内唯一，用于隔离连续多次等待。 */
export function generateCommandMarkerId(): string {
  return Math.random().toString(36).slice(2, 10)
}

/**
 * 返回拼在用户命令末尾的 marker 回显指令；cmd 无法回显控制序列，返回 undefined。
 */
export function buildCommandMarkerEcho(shellKind: TerminalShellKind, markerId: string): string | undefined {
  if (!/^[a-z0-9]{1,32}$/.test(markerId)) throw new Error('marker ID 无效')
  if (shellKind === 'posix') {
    // POSIX printf 认八进制转义：\033 = ESC，\007 = BEL。
    return `; printf '\\033]633;proma-done;${markerId}:%s\\007' "$?"`
  }
  if (shellKind === 'powershell') {
    // PS 5.1 兼容：用 [char]27/[char]7 拼 ESC/BEL。0 + $LASTEXITCODE 保证未跑过原生
    // 命令（$LASTEXITCODE 为 $null）时回退为 0，而不是拼出空串导致 marker 无法解析。
    return `; Write-Host -NoNewline ("$([char]27)]633;proma-done;${markerId}:" + (0 + $LASTEXITCODE) + "$([char]7)")`
  }
  return undefined
}

export interface CommandMarkerHit {
  exitCode: number
}

/**
 * 创建针对指定 markerId 的增量扫描器：逐 chunk 喂入 raw PTY 输出，
 * 命中该 marker 时返回退出码。缓冲会截断到末尾 MAX_SCAN_BUFFER_CHARS，
 * 因此超过该长度的分片不可能被拼回完整 marker（实际 marker 远短于该阈值）。
 */
export function createCommandMarkerScanner(markerId: string): (chunk: string) => CommandMarkerHit | undefined {
  if (!/^[a-z0-9]{1,32}$/.test(markerId)) throw new Error('marker ID 无效')
  const pattern = new RegExp(`${escapeRegExp(`${MARKER_HEAD}${markerId}:`)}(-?\\d+)${escapeRegExp(MARKER_TAIL)}`)
  let buffer = ''
  return (chunk: string) => {
    buffer = `${buffer}${chunk}`.slice(-MAX_SCAN_BUFFER_CHARS)
    const match = pattern.exec(buffer)
    if (!match) return undefined
    const exitCode = Number.parseInt(match[1] ?? '', 10)
    return Number.isFinite(exitCode) ? { exitCode } : { exitCode: 0 }
  }
}

export interface ShellSpawnPlan {
  file: string
  args: string[]
}

export interface OneShotSpawnInput {
  shellKind: OneShotShellKind
  platform: NodePlatform
  command: string
  interactive: ShellSpawnPlan
}

/** 进程平台；仅区分 win32 与其他平台。 */
export type NodePlatform = 'win32' | 'other'

/**
 * 由交互 shell 的解析结果推导一次性命令的 spawn 参数。
 *
 * Windows 下 node-pty 的 argsToCommandLine 会对数组参数做标准 MSVCRT 转义
 * （含空格的参数自动加引号、内部双引号转义为 \"），因此这里必须传裸命令；
 * 若在此处自行加引号会造成双重引号，真实 shell 解析必错。
 */
export function buildOneShotSpawnPlan(input: OneShotSpawnInput): ShellSpawnPlan {
  const { shellKind, platform, command, interactive } = input
  if (platform === 'other') {
    if (shellKind === 'powershell') return { file: interactive.file, args: [...interactive.args, '-Command', command] }
    return { file: interactive.file, args: [...interactive.args, '-c', command] }
  }
  if (shellKind === 'powershell') {
    return { file: interactive.file, args: [...interactive.args, '-Command', command] }
  }
  if (shellKind === 'cmd') {
    return { file: interactive.file, args: ['/c', command] }
  }
  if (shellKind === 'wsl') {
    // wsl.exe 转发给默认发行版内的 bash；argv 转义由 MSVCRT 规则统一处理。
    return { file: interactive.file, args: ['bash', '-lc', command] }
  }
  // Git Bash：交互模式带 -i（强制交互），一次性命令需去掉。
  return {
    file: interactive.file,
    args: [...interactive.args.filter((arg) => arg !== '-i'), '-c', command],
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
