import { describe, expect, it } from 'bun:test'
import { AGENT_IPC_CHANNELS } from './agent'
import type { SessionProcessEvent, SessionProcessInfo } from './agent'

describe('会话进程类型与 IPC 通道', () => {
  it('定义进程面板相关 IPC 通道', () => {
    expect(AGENT_IPC_CHANNELS.LIST_SESSION_PROCESSES).toBe('agent:processes:list')
    expect(AGENT_IPC_CHANNELS.GET_SESSION_PROCESS_OUTPUT).toBe('agent:processes:output')
    expect(AGENT_IPC_CHANNELS.KILL_SESSION_PROCESS).toBe('agent:processes:kill')
    expect(AGENT_IPC_CHANNELS.SESSION_PROCESS_EVENT).toBe('agent:processes:event')
  })

  it('SessionProcessInfo 覆盖命令与终端两类来源', () => {
    const command: SessionProcessInfo = {
      processId: 'p-cmd-1',
      sessionId: 's1',
      kind: 'command',
      title: 'bun run dev',
      status: 'running',
      startedAt: 1,
      pid: 4321,
    }
    const terminal: SessionProcessInfo = {
      processId: 't-1',
      sessionId: 's1',
      kind: 'terminal',
      title: 'dev-shell',
      status: 'running',
      startedAt: 2,
      pid: 4322,
      terminalId: 't-1',
    }
    expect(command.kind).toBe('command')
    expect(terminal.kind).toBe('terminal')
    expect(terminal.terminalId).toBe(terminal.processId)
  })

  it('SessionProcessInfo 状态收拢为 running/exited/killed', () => {
    const running: SessionProcessInfo = {
      processId: 'p1', sessionId: 's1', kind: 'command', title: 'x', status: 'running', startedAt: 1,
    }
    const exited: SessionProcessInfo = { ...running, status: 'exited', exitCode: 0, endedAt: 2 }
    const killed: SessionProcessInfo = { ...running, status: 'killed', endedAt: 2 }
    expect([exited.status, killed.status]).toEqual(['exited', 'killed'])
    // killed 不携带退出码
    expect(killed.exitCode).toBeUndefined()
  })

  it('SessionProcessEvent 覆盖 registered/updated/removed', () => {
    const process: SessionProcessInfo = {
      processId: 'p1', sessionId: 's1', kind: 'command', title: 'x', status: 'running', startedAt: 1,
    }
    const registered: SessionProcessEvent = { type: 'registered', process }
    const updated: SessionProcessEvent = { type: 'updated', process: { ...process, status: 'exited', exitCode: 0, endedAt: 9 } }
    const removed: SessionProcessEvent = { type: 'removed', sessionId: 's1', processId: 'p1' }
    expect(registered.type).toBe('registered')
    expect(updated.type).toBe('updated')
    expect(removed).toEqual({ type: 'removed', sessionId: 's1', processId: 'p1' })
  })
})
