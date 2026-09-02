import { describe, expect, it } from 'bun:test'
import { applySessionProcessEvent, buildProcessRows, compareProcesses } from './session-process-atoms'
import type { SessionProcessInfo } from '@proma/shared'

function makeProcess(partial: Partial<SessionProcessInfo> = {}): SessionProcessInfo {
  return {
    processId: 'p1',
    sessionId: 's1',
    kind: 'command',
    title: 'bun run dev',
    status: 'running',
    startedAt: 100,
    ...partial,
  }
}

describe('applySessionProcessEvent', () => {
  it('registered 插入记录并推送 registered 事件语义', () => {
    const next = applySessionProcessEvent(new Map(), { type: 'registered', process: makeProcess() })
    expect(next.get('s1')).toHaveLength(1)
    expect(next.get('s1')?.[0]?.title).toBe('bun run dev')
  })

  it('updated 原位合并且保留未知字段', () => {
    let map = applySessionProcessEvent(new Map(), { type: 'registered', process: makeProcess() })
    map = applySessionProcessEvent(map, { type: 'updated', process: makeProcess({ status: 'exited', exitCode: 0, endedAt: 200 }) })
    const [row] = map.get('s1') ?? []
    expect(row?.status).toBe('exited')
    expect(row?.exitCode).toBe(0)
    expect(row?.startedAt).toBe(100)
  })

  it('removed 删除对应记录', () => {
    let map = applySessionProcessEvent(new Map(), { type: 'registered', process: makeProcess() })
    map = applySessionProcessEvent(map, { type: 'registered', process: makeProcess({ processId: 'p2' }) })
    map = applySessionProcessEvent(map, { type: 'removed', sessionId: 's1', processId: 'p1' })
    expect(map.get('s1')?.map(row => row.processId)).toEqual(['p2'])
  })

  it('排序：running 优先，组内 startedAt 倒序', () => {
    let map = applySessionProcessEvent(new Map(), { type: 'registered', process: makeProcess({ processId: 'old', startedAt: 50 }) })
    map = applySessionProcessEvent(map, { type: 'registered', process: makeProcess({ processId: 'new', startedAt: 200 }) })
    map = applySessionProcessEvent(map, { type: 'updated', process: makeProcess({ processId: 'old', status: 'exited', exitCode: 1, endedAt: 90 }) })
    const ids = map.get('s1')?.map(row => row.processId)
    expect(ids).toEqual(['new', 'old'])
  })

  it('不同会话互不影响', () => {
    let map = applySessionProcessEvent(new Map(), { type: 'registered', process: makeProcess({ sessionId: 's1' }) })
    map = applySessionProcessEvent(map, { type: 'registered', process: makeProcess({ sessionId: 's2' }) })
    expect(map.get('s1')).toHaveLength(1)
    expect(map.get('s2')).toHaveLength(1)
  })
})

describe('compareProcesses', () => {
  it('running 排在 exited 前', () => {
    const running = makeProcess()
    const exited = makeProcess({ status: 'exited', endedAt: 1, startedAt: 999 })
    expect(compareProcesses(running, exited)).toBeLessThan(0)
  })
})

describe('buildProcessRows（父会话聚合子会话进程）', () => {
  const processes = new Map<string, SessionProcessInfo[]>([
    ['A', [makeProcess({ processId: 'p-a', sessionId: 'A', title: 'own-cmd' })]],
    ['A1', [makeProcess({ processId: 'p-a1', sessionId: 'A1', title: 'child-cmd' })]],
  ])
  const terminals = new Map<string, { terminalId: string; title: string }[]>([
    ['A', [{ terminalId: 't-a', title: 'own-shell' }]],
    ['A1', [{ terminalId: 't-a1', title: 'child-shell' }]],
  ])
  const children = [{ sessionId: 'A1', label: 'A1 · 子任务' }]

  it('父会话行带自身来源，无 ownerLabel', () => {
    const rows = buildProcessRows('A', processes, terminals, children, 'all')
    const own = rows.find(row => row.processId === 'p-a')
    expect(own?.ownerSessionId).toBe('A')
    expect(own?.ownerLabel).toBeUndefined()
  })

  it('子会话命令进程聚合进父面板并带来源标识', () => {
    const rows = buildProcessRows('A', processes, terminals, children, 'all')
    const child = rows.find(row => row.processId === 'p-a1')
    expect(child?.title).toBe('child-cmd')
    expect(child?.ownerSessionId).toBe('A1')
    expect(child?.ownerLabel).toBe('A1 · 子任务')
  })

  it('子会话终端同样聚合且可跳转', () => {
    const rows = buildProcessRows('A', processes, terminals, children, 'all')
    const childTerminal = rows.find(row => row.processId === 'terminal:t-a1')
    expect(childTerminal?.kind).toBe('terminal')
    expect(childTerminal?.ownerSessionId).toBe('A1')
    expect(childTerminal?.terminalId).toBe('t-a1')
  })

  it('active 筛选只保留 running（含子会话）', () => {
    const procs = new Map(processes)
    procs.set('A1', [makeProcess({ processId: 'p-a1', sessionId: 'A1', status: 'exited', exitCode: 1, endedAt: 9 })])
    const rows = buildProcessRows('A', procs, terminals, children, 'active')
    expect(rows.some(row => row.processId === 'p-a1')).toBe(false)
    expect(rows.some(row => row.processId === 'p-a')).toBe(true)
    expect(rows.some(row => row.processId === 'terminal:t-a')).toBe(true)
  })

  it('命令行合成时保留 endedAt（供耗时展示）', () => {
    const procs = new Map<string, SessionProcessInfo[]>([
      ['A', [makeProcess({ processId: 'p-done', status: 'exited', exitCode: 0, startedAt: 100, endedAt: 350 })]],
    ])
    const rows = buildProcessRows('A', procs, new Map(), [], 'all')
    expect(rows[0]?.endedAt).toBe(350)
  })

  it('无子会话时行为不变', () => {
    const rows = buildProcessRows('A', processes, terminals, [], 'all')
    expect(rows).toHaveLength(2)
    expect(rows.every(row => row.ownerSessionId === 'A')).toBe(true)
  })
})
