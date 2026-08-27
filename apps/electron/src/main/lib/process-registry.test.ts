import { describe, expect, it } from 'bun:test'
import { ProcessRegistry } from './process-registry'
import type { SessionProcessInfo } from '@proma/shared'

function makeProcess(partial: Partial<SessionProcessInfo> = {}): SessionProcessInfo {
  return {
    processId: 'tc-1',
    sessionId: 's1',
    kind: 'command',
    title: 'bun run dev',
    status: 'running',
    startedAt: 1,
    ...partial,
  }
}

describe('ProcessRegistry', () => {
  it('登记与查询按会话隔离', () => {
    const registry = new ProcessRegistry()
    registry.register(makeProcess())
    registry.register(makeProcess({ processId: 'tc-2', sessionId: 's2' }))
    expect(registry.list('s1')).toHaveLength(1)
    expect(registry.list('s2')).toHaveLength(1)
  })

  it('更新状态保留原字段且幂等收敛', () => {
    const registry = new ProcessRegistry()
    registry.register(makeProcess())
    registry.update('s1', 'tc-1', { status: 'exited', exitCode: 0, endedAt: 9 })
    const [row] = registry.list('s1')
    expect(row?.status).toBe('exited')
    expect(row?.title).toBe('bun run dev')
    expect(row?.exitCode).toBe(0)
    // 已终态的记录不被后续 update 复活
    registry.update('s1', 'tc-1', { status: 'running' })
    expect(registry.list('s1')[0]?.status).toBe('exited')
  })

  it('terminate 调用注入的 killer 并标记 killed', () => {
    const registry = new ProcessRegistry()
    let killed = false
    registry.register(makeProcess(), { killer: () => { killed = true } })
    expect(registry.terminate('s1', 'tc-1')).toBe(true)
    expect(killed).toBe(true)
    expect(registry.list('s1')[0]?.status).toBe('killed')
    expect(registry.list('s1')[0]?.endedAt).toBeGreaterThan(0)
  })

  it('已退出进程不可再终止', () => {
    const registry = new ProcessRegistry()
    let killed = false
    registry.register(makeProcess({ status: 'exited', endedAt: 2 }), { killer: () => { killed = true } })
    expect(registry.terminate('s1', 'tc-1')).toBe(false)
    expect(killed).toBe(false)
  })

  it('清空会话时终止活跃进程并移除全部记录', () => {
    const registry = new ProcessRegistry()
    const killed: string[] = []
    registry.register(makeProcess({ processId: 'a' }), { killer: () => killed.push('a') })
    registry.register(makeProcess({ processId: 'b', status: 'exited', endedAt: 2 }))
    registry.clearSession('s1')
    expect(killed).toEqual(['a'])
    expect(registry.list('s1')).toHaveLength(0)
    expect(registry.list('s1')).toEqual([])
  })

  it('并发同名命令进程各自独立', () => {
    const registry = new ProcessRegistry()
    registry.register(makeProcess({ processId: 'tc-a' }))
    registry.register(makeProcess({ processId: 'tc-b' }))
    expect(registry.list('s1')).toHaveLength(2)
  })

  it('终端记录携带 terminalId 且 kill 同样生效', () => {
    const registry = new ProcessRegistry()
    let killed = false
    registry.register(makeProcess({ processId: 't-1', kind: 'terminal', terminalId: 't-1' }), { killer: () => { killed = true } })
    expect(registry.terminate('s1', 't-1')).toBe(true)
    expect(killed).toBe(true)
  })
})
