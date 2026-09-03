import { randomUUID } from 'node:crypto'
import {
  TERMINAL_IPC_CHANNELS,
  buildCommandMarkerEcho,
  createCommandMarkerScanner,
  generateCommandMarkerId,
  type AgentTerminalCloseEvent,
  type AgentTerminalOpenEvent,
  type CommandMarkerHit,
  assertTerminalProfileSupported,
  parseTerminalProfile,
  type TerminalCreateInput,
  type TerminalInput,
  type TerminalOutputAck,
  type TerminalProfile,
  type TerminalResizeInput,
  type TerminalShellKind,
  type TerminalSnapshot,
  type TerminalState,
} from '@proma/shared'
import { getMainWindow } from './main-window-store'
import {
  appendTerminalOutput,
  readTerminalOutput,
  type TerminalOutputBuffer,
  type TerminalOutputReadOptions,
  type TerminalOutputReadResult,
} from './terminal-output-buffer'
import { resolveAgentTerminalCwd } from './terminal-agent-policy'
import { requireTerminalCwd, resolveTerminalCwd } from './terminal-cwd'
import { terminalRuntimeClient } from './terminal-runtime-client'

const terminals = new Map<string, TerminalState>()
const pendingTerminals = new Map<string, Promise<TerminalState>>()
const cancelledPendingTerminalIds = new Set<string>()
const terminalSessionOwners = new Map<string, string>()
const terminalOutputBuffers = new Map<string, TerminalOutputBuffer>()
const agentTerminals = new Map<string, AgentTerminalRecord>()
/** 终端 → 正在等待命令结束信号的等待器集合。 */
const commandWaiters = new Map<string, Set<CommandWaiter>>()
/** 终端 → 当前 pending marker 的增量扫描器；一次性/无信号终端不登记。 */
const markerScanners = new Map<string, (chunk: string) => CommandMarkerHit | undefined>()
const MAX_REPLAY_CHARS = 1_000_000
let initialized = false

export interface AgentTerminalRecord {
  sessionId: string
  terminalId: string
  title: string
  cwd: string
  profile: TerminalProfile
  status: 'running' | 'exited'
  exitCode?: number
  /** 最近一次 TerminalExecute 命令的结束信号状态；纯交互终端无该字段。 */
  command?: AgentTerminalCommandState
}

export interface AgentTerminalCommandState {
  /** oneshot：一次性命令终端，等 shell 退出；marker：交互终端，等回显标记；interactive：未注册信号。 */
  mode: 'oneshot' | 'marker' | 'interactive'
  startedAt: number
  finished: boolean
  exitCode?: number
  /** marker 模式下用于识别回显的 ID。 */
  markerId?: string
}

export type AgentTerminalCommandWaitResult =
  | { status: 'finished'; exitCode: number | undefined; outputTail: string }
  | { status: 'running' }
  | { status: 'terminated' }

interface CommandWaiter {
  finish: (result: AgentTerminalCommandWaitResult) => void
  timer: ReturnType<typeof setTimeout>
}

const MIN_WAIT_MS = 1_000
const MAX_WAIT_MS = 120_000
const COMMAND_TAIL_CHARS = 4_000

function initialize(): void {
  if (initialized) return
  initialized = true
  terminalRuntimeClient.onOutput((event) => {
    if (!terminals.has(event.terminalId) && !pendingTerminals.has(event.terminalId)) return
    appendOutputBuffer(event)
    scanPendingCommandMarker(event.terminalId, event.data)
    getMainWindow()?.webContents.send(TERMINAL_IPC_CHANNELS.OUTPUT, event)
  })
  terminalRuntimeClient.onExit((event) => {
    terminals.delete(event.terminalId)
    markerScanners.delete(event.terminalId)
    const agentTerminal = agentTerminals.get(event.terminalId)
    if (agentTerminal) {
      // Agent 可在命令退出后读取结果；缓冲会随显式关闭或会话回收一并释放。
      agentTerminal.status = 'exited'
      agentTerminal.exitCode = event.exitCode
      if (agentTerminal.command) {
        agentTerminal.command.finished = true
        agentTerminal.command.exitCode = agentTerminal.command.exitCode ?? event.exitCode
      }
      resolveCommandWaiters(event.terminalId, buildFinishedWaitResult(event.terminalId, agentTerminal.command?.exitCode ?? event.exitCode))
    } else {
      terminalOutputBuffers.delete(event.terminalId)
    }
    getMainWindow()?.webContents.send(TERMINAL_IPC_CHANNELS.EXIT, event)
  })
}

export async function createTerminal(
  input: TerminalCreateInput,
  options: { strictCwd?: boolean } = {},
): Promise<TerminalState> {
  initialize()
  validateTerminalId(input.terminalId)
  const existing = terminals.get(input.terminalId)
  if (existing) return existing
  const pending = pendingTerminals.get(input.terminalId)
  if (pending) return pending
  const cwd = options.strictCwd ? requireTerminalCwd(input.cwd) : resolveTerminalCwd(input.cwd)

  // Record ownership before spawning so a concurrent session deletion can cancel it.
  terminalSessionOwners.set(input.terminalId, input.sessionId)
  // Initialize the replay buffer before the runtime can emit the first shell output.
  terminalOutputBuffers.set(input.terminalId, { output: '', sequence: 0, startOffset: 0, endOffset: 0 })
  const creation = terminalRuntimeClient.create({
    ...input,
    cwd,
    cols: normalizeDimension(input.cols),
    rows: normalizeDimension(input.rows),
  }, options).then((state) => {
    if (cancelledPendingTerminalIds.delete(state.terminalId)) {
      terminalRuntimeClient.kill(state.terminalId)
      throw new Error('终端已在创建完成前关闭')
    }
    terminals.set(state.terminalId, state)
    return state
  })
  pendingTerminals.set(input.terminalId, creation)
  void creation.then(
    () => pendingTerminals.delete(input.terminalId),
    () => {
      pendingTerminals.delete(input.terminalId)
      cancelledPendingTerminalIds.delete(input.terminalId)
      terminalSessionOwners.delete(input.terminalId)
      terminalOutputBuffers.delete(input.terminalId)
    },
  )
  return creation
}

export async function writeTerminal(input: TerminalInput): Promise<void> {
  initialize()
  validateTerminalId(input.terminalId)
  if (typeof input.data !== 'string' || input.data.length > 64 * 1024) throw new Error('终端输入无效或过长')
  if (!terminals.has(input.terminalId)) throw new Error('终端不存在')
  await terminalRuntimeClient.input(input)
}

export async function resizeTerminal(input: TerminalResizeInput): Promise<void> {
  initialize()
  validateTerminalId(input.terminalId)
  if (!terminals.has(input.terminalId)) return
  await terminalRuntimeClient.resize({
    terminalId: input.terminalId,
    cols: normalizeDimension(input.cols),
    rows: normalizeDimension(input.rows),
  })
}

export function killTerminal(terminalId: string): void {
  validateTerminalId(terminalId)
  if (pendingTerminals.has(terminalId)) cancelledPendingTerminalIds.add(terminalId)
  terminals.delete(terminalId)
  terminalSessionOwners.delete(terminalId)
  terminalOutputBuffers.delete(terminalId)
  agentTerminals.delete(terminalId)
  markerScanners.delete(terminalId)
  resolveCommandWaiters(terminalId, { status: 'terminated' })
  terminalRuntimeClient.kill(terminalId)
}

/** 为 Agent 创建其会话归属的可见终端，目录仍受现有文件授权范围限制；profile 决定交互 shell。 */
export async function openAgentTerminal(input: {
  sessionId: string
  cwd?: string
  title?: string
  profile?: unknown
  /** 仅用于未显式指定的 Windows 历史 profile；创建失败时安全回退到 default。 */
  fallbackToDefaultProfile?: boolean
  agentCwd?: string
  allowedRoots?: string[]
  /** 提供时创建一次性命令终端：命令结束即 shell 退出，产生精确 exit 信号。 */
  command?: string
}): Promise<AgentTerminalRecord> {
  const cwd = resolveAgentTerminalCwd(input)
  const profile = assertTerminalProfileSupported(parseTerminalProfile(input.profile), process.platform)
  const terminalId = randomUUID()
  const title = input.title?.trim().slice(0, 80) || 'Agent 终端'
  let resolvedProfile = profile
  try {
    await createTerminal({
      terminalId,
      sessionId: input.sessionId,
      cwd,
      profile: resolvedProfile,
      cols: 80,
      rows: 24,
      ...(input.command === undefined ? {} : { command: input.command }),
    }, { strictCwd: true })
  } catch (error) {
    // 一次性命令终端依赖显式 shell 语义，失败时直接报错；仅交互终端安全回退到 default。
    if (!input.fallbackToDefaultProfile || profile === 'default' || input.command !== undefined) throw error
    resolvedProfile = 'default'
    await createTerminal({
      terminalId,
      sessionId: input.sessionId,
      cwd,
      profile: resolvedProfile,
      cols: 80,
      rows: 24,
    }, { strictCwd: true })
  }
  const record: AgentTerminalRecord = {
    sessionId: input.sessionId,
    terminalId,
    title,
    cwd,
    profile: resolvedProfile,
    status: 'running',
    ...(input.command === undefined ? {} : { command: { mode: 'oneshot', startedAt: Date.now(), finished: false } }),
  }
  agentTerminals.set(terminalId, record)
  notifyAgentTerminalOpen(record)
  return record
}

/**
 * 直接向 Agent 所属终端写入一条完整命令。该动作由 Pi 既有 permission mode 保护，
 * 不会读取或回传终端正文；用户始终能在右侧可见终端中中断它。
 *
 * waitMs：提供时为本次命令注册命令级结束信号并按该时长等待——
 * - 复用交互终端：命令末尾追加 OSC 633 marker 回显，扫描命中即结束；
 * - 新开终端：直接以一次性命令 spawn，shell 退出即结束（cmd 也可用）。
 * 不提供时保持旧行为：写入后立即返回，不注册信号。
 */
export async function executeAgentTerminal(input: {
  sessionId: string
  command: string
  /** 指定时复用当前 Agent 会话中仍在运行的可见 PTY；省略时创建新终端。 */
  terminalId?: string
  /** 仅在创建新终端时生效；复用已有终端时必须与其 profile 一致。 */
  profile?: unknown
  /** 仅在新建终端且使用 Windows 历史 profile 时生效。 */
  fallbackToDefaultProfile?: boolean
  cwd?: string
  title?: string
  agentCwd?: string
  allowedRoots?: string[]
  /** 命令级结束信号等待时长（毫秒）；省略时不等待。 */
  waitMs?: number
}): Promise<AgentTerminalRecord> {
  const command = input.command.trim()
  if (!command || command.length > 64 * 1024) throw new Error('终端命令为空或过长')
  const waitMs = normalizeWaitMs(input.waitMs)
  const profile = assertTerminalProfileSupported(parseTerminalProfile(input.profile), process.platform)
  const profileWasSpecified = input.profile !== undefined && input.profile !== null && input.profile !== ''

  const requestedTerminalId = input.terminalId?.trim()
  if (requestedTerminalId) {
    const record = getOwnedAgentTerminal(input.sessionId, requestedTerminalId)
    if (record.status !== 'running') throw new Error('终端已退出，不能复用')
    if (profileWasSpecified && record.profile !== profile) {
      throw new Error(`终端 ${requestedTerminalId} 运行在 ${record.profile}，不能以 ${profile} 复用；请省略 terminalId 另开新终端`)
    }
    if (waitMs === undefined) {
      record.command = { mode: 'interactive', startedAt: Date.now(), finished: false }
      markerScanners.delete(record.terminalId)
    } else {
      const shellKind = terminals.get(record.terminalId)?.shellKind ?? 'posix'
      const markerId = generateCommandMarkerId()
      const echo = buildCommandMarkerEcho(shellKind, markerId)
      if (!echo) throw new Error('当前 shell（cmd）无法产生命令结束信号；请新开终端执行或改用输出判断')
      record.command = { mode: 'marker', startedAt: Date.now(), finished: false, markerId }
      markerScanners.set(record.terminalId, createCommandMarkerScanner(markerId))
      await writeTerminal({ terminalId: record.terminalId, data: `${command}${echo}\r` })
      return record
    }
    await writeTerminal({ terminalId: record.terminalId, data: `${command}\r` })
    return record
  }

  const title = input.title?.trim() || `Agent · ${command.replace(/\s+/g, ' ').slice(0, 48)}`
  const terminalSeed = {
    sessionId: input.sessionId,
    cwd: input.cwd,
    title,
    agentCwd: input.agentCwd,
    allowedRoots: input.allowedRoots,
    profile,
    fallbackToDefaultProfile: input.fallbackToDefaultProfile,
  }
  if (waitMs !== undefined) {
    // 显式传 command，避免把 input 展开误作一次性命令语义的一部分。
    return openAgentTerminal({ ...terminalSeed, command })
  }
  const record = await openAgentTerminal(terminalSeed)
  record.command = { mode: 'interactive', startedAt: Date.now(), finished: false }
  await writeTerminal({ terminalId: record.terminalId, data: `${command}\r` })
  return record
}

/**
 * 等待 Agent 终端当前命令的结束信号（一次性终端等 exit，marker 终端等回显命中）。
 * 结束立即返回 finished（含退出码与输出尾部）；超时返回 running；终端被关闭返回 terminated。
 */
export async function waitForAgentTerminalCommand(
  sessionId: string,
  terminalId: string,
  timeoutMs: number,
): Promise<AgentTerminalCommandWaitResult> {
  const record = getOwnedAgentTerminal(sessionId, terminalId)
  if (!record.command || record.command.mode === 'interactive') {
    throw new Error('该终端没有可等待的命令结束信号；请用 TerminalExecute 携带 waitMs 重新执行，或读取输出判断')
  }
  if (record.command.finished) return buildFinishedWaitResult(terminalId, record.command.exitCode)
  if (record.status === 'exited') return buildFinishedWaitResult(terminalId, record.exitCode)
  const waitMs = normalizeWaitMs(timeoutMs) ?? MIN_WAIT_MS
  return new Promise<AgentTerminalCommandWaitResult>((resolve) => {
    const waiter: CommandWaiter = {
      finish: (result) => {
        clearTimeout(waiter.timer)
        commandWaiters.get(terminalId)?.delete(waiter)
        resolve(result)
      },
      timer: setTimeout(() => waiter.finish({ status: 'running' }), waitMs),
    }
    const waiters = commandWaiters.get(terminalId) ?? new Set<CommandWaiter>()
    waiters.add(waiter)
    commandWaiters.set(terminalId, waiters)
  })
}

export function listAgentTerminals(sessionId: string): AgentTerminalRecord[] {
  return [...agentTerminals.values()].filter((record) => record.sessionId === sessionId)
}

/** 读取当前 Agent 会话拥有的终端输出；只暴露有限内存回放缓冲，不读取其他会话或系统终端。 */
export function readAgentTerminalOutput(
  sessionId: string,
  terminalId: string,
  options: TerminalOutputReadOptions = {},
): { terminal: AgentTerminalRecord; read: TerminalOutputReadResult } {
  const terminal = getOwnedAgentTerminal(sessionId, terminalId)
  const buffer = terminalOutputBuffers.get(terminalId)
  if (!buffer) throw new Error('终端输出已不可用')
  return { terminal, read: readTerminalOutput(buffer, options) }
}

export async function interruptAgentTerminal(sessionId: string, terminalId: string): Promise<void> {
  const record = getOwnedAgentTerminal(sessionId, terminalId)
  if (record.status !== 'running') return
  await writeTerminal({ terminalId, data: '\u0003' })
}

export function closeAgentTerminal(sessionId: string, terminalId: string): void {
  getOwnedAgentTerminal(sessionId, terminalId)
  killTerminal(terminalId)
  const event: AgentTerminalCloseEvent = { sessionId, terminalId }
  getMainWindow()?.webContents.send(TERMINAL_IPC_CHANNELS.AGENT_CLOSE, event)
}

/** 终止并回收指定 Agent 会话的全部交互和 Agent 执行终端。 */
export function closeTerminalsForSession(sessionId: string): void {
  for (const [terminalId, ownerSessionId] of terminalSessionOwners) {
    if (ownerSessionId === sessionId) killTerminal(terminalId)
  }
}

export function getTerminalSnapshot(terminalId: string): TerminalSnapshot {
  validateTerminalId(terminalId)
  const state = terminals.get(terminalId)
  if (!state) throw new Error('终端不存在')
  const buffer = terminalOutputBuffers.get(terminalId) ?? { output: '', sequence: 0, startOffset: 0, endOffset: 0 }
  return { state, ...buffer }
}

export function acknowledgeTerminalOutput(input: TerminalOutputAck): void {
  validateTerminalId(input.terminalId)
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) throw new Error('终端输出序号无效')
  if (!terminals.has(input.terminalId)) return
  terminalRuntimeClient.acknowledgeOutput(input)
}

export async function stopAllTerminals(): Promise<void> {
  terminals.clear()
  pendingTerminals.clear()
  cancelledPendingTerminalIds.clear()
  terminalSessionOwners.clear()
  terminalOutputBuffers.clear()
  agentTerminals.clear()
  for (const terminalId of [...commandWaiters.keys()]) {
    resolveCommandWaiters(terminalId, { status: 'terminated' })
  }
  commandWaiters.clear()
  markerScanners.clear()
  await terminalRuntimeClient.stop()
}

/** 当前活跃终端（PTY）数量；退出确认提醒用。 */
export function getActiveTerminalCount(): number {
  return terminals.size
}

function notifyAgentTerminalOpen(record: AgentTerminalRecord): void {
  const event: AgentTerminalOpenEvent = {
    sessionId: record.sessionId,
    terminalId: record.terminalId,
    title: record.title,
    cwd: record.cwd,
    profile: record.profile,
  }
  getMainWindow()?.webContents.send(TERMINAL_IPC_CHANNELS.AGENT_OPEN, event)
}

function getOwnedAgentTerminal(sessionId: string, terminalId: string): AgentTerminalRecord {
  validateTerminalId(terminalId)
  const record = agentTerminals.get(terminalId)
  if (!record || record.sessionId !== sessionId) throw new Error('终端不存在或不属于当前 Agent 会话')
  return record
}

function appendOutputBuffer(event: { terminalId: string; sequence: number; data: string }): void {
  const current = terminalOutputBuffers.get(event.terminalId) ?? { output: '', sequence: 0, startOffset: 0, endOffset: 0 }
  terminalOutputBuffers.set(event.terminalId, appendTerminalOutput(current, event, MAX_REPLAY_CHARS))
}

/** 在 raw 输出流上扫描当前 pending marker；命中即写入命令状态并唤醒等待器。 */
function scanPendingCommandMarker(terminalId: string, chunk: string): void {
  const scanner = markerScanners.get(terminalId)
  if (!scanner) return
  const hit = scanner(chunk)
  if (!hit) return
  markerScanners.delete(terminalId)
  const record = agentTerminals.get(terminalId)
  if (record?.command) {
    record.command.finished = true
    record.command.exitCode = hit.exitCode
  }
  resolveCommandWaiters(terminalId, buildFinishedWaitResult(terminalId, hit.exitCode))
}

function resolveCommandWaiters(terminalId: string, result: AgentTerminalCommandWaitResult): void {
  const waiters = commandWaiters.get(terminalId)
  if (!waiters || waiters.size === 0) return
  commandWaiters.delete(terminalId)
  for (const waiter of waiters) waiter.finish(result)
}

function buildFinishedWaitResult(terminalId: string, exitCode: number | undefined): Extract<AgentTerminalCommandWaitResult, { status: 'finished' }> {
  const buffer = terminalOutputBuffers.get(terminalId)
  const outputTail = buffer ? readTerminalOutput(buffer, { limit: COMMAND_TAIL_CHARS }).output : ''
  return { status: 'finished', exitCode, outputTail }
}

function normalizeWaitMs(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, Math.round(value)))
}

function validateTerminalId(terminalId: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(terminalId)) throw new Error('终端 ID 无效')
}

function normalizeDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(500, Math.floor(value))) : 1
}
