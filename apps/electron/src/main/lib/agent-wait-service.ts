import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 服务端条件等待：为"等外部状态变化"（PR 合并、CI 完成、端口就绪、文件出现）
 * 提供事件驱动原语。模型调用 WaitFor 后工具 promise 挂起，由本服务按间隔执行
 * 短检查命令，条件满足瞬间唤醒——不占模型 turn、不受 Bash 工具超时上限约束。
 *
 * 这是对"sleep 凑间隔"反模式的根治：等待时长由条件而非时钟决定。
 */

export interface AgentWaitInput {
  sessionId: string
  /** 检查命令；退出码 0 表示条件满足。应保持快速（<10s）、只读、无副作用。 */
  command: string
  cwd?: string
  /** 两次检查的间隔秒数，clamp 到 [1, 300]，默认 15。 */
  intervalSeconds?: number
  /** 总等待上限毫秒，clamp 到 [1000, 7200000]（2 小时），默认 600000。 */
  timeoutMs?: number
  /** 测试注入的执行器；缺省按平台探测 shell。 */
  shell?: ShellPlan
  /** 中止信号：runtime 取消（会话停止/请求捱线）时立即结束轮询并返回 cancelled。 */
  abortSignal?: AbortSignal
}

export type AgentWaitResult =
  | { status: 'satisfied'; checks: number; elapsedMs: number; lastOutput: string }
  | { status: 'timeout'; checks: number; elapsedMs: number; lastOutput: string }
  | { status: 'cancelled'; checks: number; elapsedMs: number }

export interface ShellPlan {
  file: string
  args: string[]
}

interface ActiveWait {
  sessionId: string
  finish: (result: AgentWaitResult) => void
}

const MIN_INTERVAL_SECONDS = 1
const MAX_INTERVAL_SECONDS = 300
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 7_200_000
const DEFAULT_INTERVAL_SECONDS = 15
const DEFAULT_TIMEOUT_MS = 600_000
const OUTPUT_TAIL_CHARS = 800
/** 单次检查自身的超时：取间隔与 15s 的较大值，防止检查命令挂死整个等待。 */
const CHECK_OVERHEAD_SECONDS = 15

const activeWaits = new Map<number, ActiveWait>()
let nextWaitId = 1

let cachedShell: ShellPlan | undefined

export async function waitForCondition(input: AgentWaitInput): Promise<AgentWaitResult> {
  const command = input.command.trim()
  if (!command || command.length > 8_192) throw new Error('检查命令为空或过长')
  const intervalMs = normalizeIntervalMs(input.intervalSeconds)
  const timeoutMs = normalizeTimeoutMs(input.timeoutMs)
  const shell = input.shell ?? resolveCheckShell()

  return new Promise<AgentWaitResult>((resolve) => {
    const startedAt = Date.now()
    let checks = 0
    let lastOutput = ''
    let waitTimer: ReturnType<typeof setTimeout> | undefined
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    let cancelled = false
    let finished = false

    const waitId = nextWaitId++
    const finish = (result: AgentWaitResult) => {
      if (finished) return
      finished = true
      activeWaits.delete(waitId)
      if (waitTimer) clearTimeout(waitTimer)
      if (deadlineTimer) clearTimeout(deadlineTimer)
      input.abortSignal?.removeEventListener('abort', onAbort)
      resolve(result)
    }

    // runtime 取消（会话停止/通道捱线）时立即收尾，不再占用轮询。
    const onAbort = (): void => {
      cancelled = true
      finish({ status: 'cancelled', checks, elapsedMs: Date.now() - startedAt })
    }
    if (input.abortSignal?.aborted) {
      onAbort()
      return
    }
    input.abortSignal?.addEventListener('abort', onAbort)

    activeWaits.set(waitId, { sessionId: input.sessionId, finish })

    const runCheck = (): void => {
      if (finished || cancelled) return
      executeCheck(shell, command, input.cwd, Math.max(CHECK_OVERHEAD_SECONDS * 1_000, intervalMs))
        .then(({ exitCode, output }) => {
          if (finished || cancelled) return
          checks += 1
          lastOutput = output
          if (exitCode === 0) {
            finish({ status: 'satisfied', checks, elapsedMs: Date.now() - startedAt, lastOutput: tail(lastOutput) })
            return
          }
          if (Date.now() - startedAt >= timeoutMs) {
            finish({ status: 'timeout', checks, elapsedMs: Date.now() - startedAt, lastOutput: tail(lastOutput) })
            return
          }
          waitTimer = setTimeout(runCheck, intervalMs)
        })
        .catch(() => {
          if (finished || cancelled) return
          // 检查命令无法启动（如 shell 缺失）不应无限重试；按超时路径收尾。
          checks += 1
          if (Date.now() - startedAt >= timeoutMs) {
            finish({ status: 'timeout', checks, elapsedMs: Date.now() - startedAt, lastOutput: tail(lastOutput) })
            return
          }
          waitTimer = setTimeout(runCheck, intervalMs)
        })
    }

    deadlineTimer = setTimeout(() => {
      finish({ status: 'timeout', checks, elapsedMs: Date.now() - startedAt, lastOutput: tail(lastOutput) })
    }, timeoutMs + CHECK_OVERHEAD_SECONDS * 1_000)

    runCheck()
  })
}

/** 取消某会话全部进行中的等待；用于会话停止时立即释放挂起的工具调用。 */
export function cancelWaitsForSession(sessionId: string): void {
  for (const [waitId, wait] of activeWaits) {
    if (wait.sessionId !== sessionId) continue
    activeWaits.delete(waitId)
    wait.finish({ status: 'cancelled', checks: 0, elapsedMs: 0 })
  }
}

interface CheckOutcome {
  exitCode: number
  output: string
}

function executeCheck(shell: ShellPlan, command: string, cwd: string | undefined, timeoutMs: number): Promise<CheckOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(shell.file, [...shell.args, command], {
      ...(cwd ? { cwd } : {}),
      env: { ...process.env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve({ exitCode: -1, output: tail(output) + '\n[Proma：检查命令超时]' })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { output += String(chunk) })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code ?? -1, output: tail(output) })
    })
  })
}

/** 检查命令的解释器：优先与 Agent Bash 一致的 POSIX shell（Git Bash），否则系统 shell。 */
function resolveCheckShell(): ShellPlan {
  if (cachedShell) return cachedShell
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
    const candidates = [
      join(programFiles, 'Git', 'bin', 'bash.exe'),
      'D:\\Program Files\\Git\\bin\\bash.exe',
    ]
    const bash = candidates.find((path) => {
      try {
        return existsSync(path)
      } catch {
        return false
      }
    })
    cachedShell = bash ? { file: bash, args: ['-c'] } : { file: process.env.ComSpec || 'cmd.exe', args: ['/c'] }
  } else {
    cachedShell = { file: process.env.SHELL || '/bin/sh', args: ['-c'] }
  }
  return cachedShell
}

function normalizeIntervalMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_INTERVAL_SECONDS * 1_000
  return Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, Math.round(value))) * 1_000
}

function normalizeTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(value)))
}

function tail(output: string): string {
  return output.length > OUTPUT_TAIL_CHARS ? output.slice(output.length - OUTPUT_TAIL_CHARS) : output
}
