/**
 * ProcessRegistry 全局运行中进程查询测试（退出/删除提醒用）
 */

import { describe, expect, test } from 'bun:test'
import { ProcessRegistry } from './process-registry'
import type { SessionProcessInfo } from '@proma/shared'

function makeProcess(sessionId: string, processId: string, status: SessionProcessInfo['status'] = 'running'): SessionProcessInfo {
  return {
    processId,
    sessionId,
    kind: 'command',
    status,
    title: 'test',
    startedAt: 0,
  } satisfies SessionProcessInfo
}

describe('ProcessRegistry.listRunning / countRunning', () => {
  test('跨会话统计运行中进程；终态不计入', () => {
    const registry = new ProcessRegistry()
    registry.register(makeProcess('s1', 'p1'))
    registry.register(makeProcess('s1', 'p2', 'exited'))
    registry.register(makeProcess('s2', 'p3'))
    registry.register(makeProcess('s2', 'p4', 'killed'))

    expect(registry.countRunning()).toBe(2)
    expect(registry.listRunning().map((process) => process.processId).sort()).toEqual(['p1', 'p3'])
  })

  test('terminate 后不再计入；clearSession 后该会话清零', () => {
    const registry = new ProcessRegistry()
    registry.register(makeProcess('s1', 'p1'))
    registry.register(makeProcess('s2', 'p2'))

    expect(registry.terminate('s1', 'p1')).toBe(true)
    expect(registry.countRunning()).toBe(1)

    registry.clearSession('s2')
    expect(registry.countRunning()).toBe(0)
    expect(registry.listRunning()).toEqual([])
  })

  test('空注册表返回 0', () => {
    const registry = new ProcessRegistry()
    expect(registry.countRunning()).toBe(0)
    expect(registry.listRunning()).toEqual([])
  })
})
