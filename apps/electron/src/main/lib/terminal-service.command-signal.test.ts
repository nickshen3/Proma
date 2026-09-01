import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TerminalOutputEvent } from '@proma/shared'

/**
 * 命令级结束信号的状态机测试：用 mock 的 TerminalRuntimeClient 驱动
 * output/exit 事件流，验证 one-shot、marker、terminated 三条路径。
 */

type OutputListener = (event: TerminalOutputEvent) => void
type ExitListener = (event: { terminalId: string; exitCode: number; signal?: number }) => void

const outputListeners = new Set<OutputListener>()
const exitListeners = new Set<ExitListener>()
const inputWrites: { terminalId: string; data: string }[] = []
const killedTerminalIds: string[] = []

mock.module('./terminal-runtime-client', () => ({
  terminalRuntimeClient: {
    onOutput: (listener: OutputListener) => {
      outputListeners.add(listener)
      return () => outputListeners.delete(listener)
    },
    onExit: (listener: ExitListener) => {
      exitListeners.add(listener)
      return () => exitListeners.delete(listener)
    },
    create: async (input: { terminalId: string; cwd: string; command?: string }) => ({
      terminalId: input.terminalId,
      title: 'shell',
      cwd: input.cwd,
      profile: 'default',
      pid: 42,
      shellKind: 'posix',
      ...(input.command === undefined ? {} : { command: input.command }),
    }),
    input: async (input: { terminalId: string; data: string }) => {
      inputWrites.push(input)
    },
    resize: async () => {},
    acknowledgeOutput: () => {},
    kill: (terminalId: string) => {
      killedTerminalIds.push(terminalId)
    },
    stop: async () => {},
  },
}))

mock.module('./main-window-store', () => ({
  getMainWindow: () => undefined,
}))

const { closeAgentTerminal, executeAgentTerminal, openAgentTerminal, waitForAgentTerminalCommand } = await import('./terminal-service')

let sequence = 0
function emitOutput(terminalId: string, data: string): void {
  sequence += 1
  const event: TerminalOutputEvent = { terminalId, sequence, data }
  for (const listener of outputListeners) listener(event)
}

function emitExit(terminalId: string, exitCode: number): void {
  for (const listener of exitListeners) listener({ terminalId, exitCode })
}

const scratchRoots: string[] = []
const ownedTerminals: { sessionId: string; terminalId: string }[] = []

function makeSession(): { sessionId: string; cwd: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'proma-terminal-signal-'))
  scratchRoots.push(cwd)
  return { sessionId: `session-${Math.random().toString(36).slice(2, 8)}`, cwd }
}

afterEach(() => {
  for (const owned of ownedTerminals.splice(0)) {
    try {
      closeAgentTerminal(owned.sessionId, owned.terminalId)
    } catch {
      // 终端可能已被测试关闭；清理失败可忽略。
    }
  }
  while (scratchRoots.length > 0) {
    const root = scratchRoots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

describe('executeAgentTerminal + waitForAgentTerminalCommand', () => {
  test('one-shot：新终端携带 waitMs 时命令经 create 一次性下发，exit 信号立即唤醒等待', async () => {
    const { sessionId, cwd } = makeSession()
    const record = await executeAgentTerminal({ sessionId, agentCwd: cwd, command: 'bun test', waitMs: 5_000 })
    ownedTerminals.push({ sessionId, terminalId: record.terminalId })
    expect(record.command?.mode).toBe('oneshot')
    // 一次性命令不经过 input 写入，而是直接作为 PTY spawn 参数。
    expect(inputWrites.some((write) => write.terminalId === record.terminalId)).toBe(false)

    emitOutput(record.terminalId, 'all specs passed\n')
    emitExit(record.terminalId, 0)

    const result = await waitForAgentTerminalCommand(sessionId, record.terminalId, 1_000)
    expect(result.status).toBe('finished')
    if (result.status === 'finished') {
      expect(result.exitCode).toBe(0)
      expect(result.outputTail).toContain('all specs passed')
    }
  })

  test('marker：复用交互终端携带 waitMs 时写入 marker 回显，输出流命中即结束', async () => {
    const { sessionId, cwd } = makeSession()
    const terminal = await openAgentTerminal({ sessionId, agentCwd: cwd })
    ownedTerminals.push({ sessionId, terminalId: terminal.terminalId })

    const record = await executeAgentTerminal({ sessionId, agentCwd: cwd, command: 'echo hi', terminalId: terminal.terminalId, waitMs: 5_000 })
    expect(record.command?.mode).toBe('marker')
    expect(record.command?.markerId).toMatch(/^[a-z0-9]+$/)
    const written = inputWrites.at(-1)?.data ?? ''
    expect(written.startsWith('echo hi; printf ')).toBe(true)

    const waited = waitForAgentTerminalCommand(sessionId, record.terminalId, 5_000)
    emitOutput(record.terminalId, `hi\r\n${'\x1b'}]633;proma-done;${record.command?.markerId}:0\x07`)
    const result = await waited
    expect(result.status).toBe('finished')
    if (result.status === 'finished') {
      expect(result.exitCode).toBe(0)
      expect(result.outputTail).toContain('hi')
    }
    // marker 已消费：终端本身仍 running，可继续接收下一条命令。
    expect(record.status).toBe('running')
  })

  test('marker：非零退出码被正确解析', async () => {
    const { sessionId, cwd } = makeSession()
    const terminal = await openAgentTerminal({ sessionId, agentCwd: cwd })
    ownedTerminals.push({ sessionId, terminalId: terminal.terminalId })
    const record = await executeAgentTerminal({ sessionId, agentCwd: cwd, command: 'exit 3', terminalId: terminal.terminalId, waitMs: 5_000 })
    ownedTerminals.push({ sessionId, terminalId: record.terminalId })
    const markerId = record.command?.markerId
    expect(markerId).toBeDefined()
    const waited = waitForAgentTerminalCommand(sessionId, record.terminalId, 5_000)
    emitOutput(record.terminalId, `\x1b]633;proma-done;${markerId}:3\x07`)
    const result = await waited
    expect(result).toMatchObject({ status: 'finished', exitCode: 3 })
  })

  test('等待期间终端被关闭时返回 terminated', async () => {
    const { sessionId, cwd } = makeSession()
    const record = await executeAgentTerminal({ sessionId, agentCwd: cwd, command: 'sleep 60', waitMs: 5_000 })
    ownedTerminals.push({ sessionId, terminalId: record.terminalId })
    const waited = waitForAgentTerminalCommand(sessionId, record.terminalId, 5_000)
    closeAgentTerminal(sessionId, record.terminalId)
    expect(await waited).toEqual({ status: 'terminated' })
  })

  test('未注册信号的交互命令不能等待，得到明确报错', async () => {
    const { sessionId, cwd } = makeSession()
    const record = await executeAgentTerminal({ sessionId, agentCwd: cwd, command: 'echo hi' })
    ownedTerminals.push({ sessionId, terminalId: record.terminalId })
    expect(record.command?.mode).toBe('interactive')
    await expect(waitForAgentTerminalCommand(sessionId, record.terminalId, 1_000)).rejects.toThrow('没有可等待的命令结束信号')
  })

  test('超时后返回 running，不阻塞后续等待', async () => {
    const { sessionId, cwd } = makeSession()
    const terminal = await openAgentTerminal({ sessionId, agentCwd: cwd })
    ownedTerminals.push({ sessionId, terminalId: terminal.terminalId })
    const record = await executeAgentTerminal({ sessionId, agentCwd: cwd, command: 'sleep 60', terminalId: terminal.terminalId, waitMs: 30_000 })
    ownedTerminals.push({ sessionId, terminalId: record.terminalId })
    const markerId = record.command?.markerId
    const startedAt = Date.now()
    const first = await waitForAgentTerminalCommand(sessionId, record.terminalId, 1_050)
    expect(first).toEqual({ status: 'running' })
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900)
    // 超时被 clamp 到下限附近；信号随后到来时仍可被下一次等待捕获。
    const second = waitForAgentTerminalCommand(sessionId, record.terminalId, 5_000)
    emitOutput(record.terminalId, `\x1b]633;proma-done;${markerId}:0\x07`)
    expect((await second).status).toBe('finished')
  })
})
