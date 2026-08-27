import { describe, expect, it } from 'bun:test'
import { applySessionProcessEvent, compareProcesses } from './session-process-atoms'
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
