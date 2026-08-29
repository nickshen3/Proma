import { describe, expect, test } from 'bun:test'
import { createUpdateCheckScheduler } from './update-check-scheduler'

/** 注入型假时钟：记录定时器并支持定向触发 */
function createFakeClock() {
  interface FakeTimer {
    kind: 'timeout' | 'interval'
    fn: () => void
  }
  const timers = new Map<number, FakeTimer>()
  let nextId = 1

  const setTimeoutFn = (fn: () => void, _ms: number): ReturnType<typeof setTimeout> => {
    const id = nextId++
    timers.set(id, { kind: 'timeout', fn })
    return id as unknown as ReturnType<typeof setTimeout>
  }
  const setIntervalFn = (fn: () => void, _ms: number): ReturnType<typeof setInterval> => {
    const id = nextId++
    timers.set(id, { kind: 'interval', fn })
    return id as unknown as ReturnType<typeof setInterval>
  }
  const clearTimeoutFn = (timer: ReturnType<typeof setTimeout>): void => {
    timers.delete(timer as unknown as number)
  }
  const clearIntervalFn = (timer: ReturnType<typeof setInterval>): void => {
    timers.delete(timer as unknown as number)
  }

  return {
    setTimeoutFn,
    setIntervalFn,
    clearTimeoutFn,
    clearIntervalFn,
    /** 触发指定类型的定时器；timeout 触发后自删除 */
    fire(kind: 'timeout' | 'interval'): void {
      for (const [id, timer] of [...timers.entries()]) {
        if (timer.kind !== kind) continue
        if (kind === 'timeout') timers.delete(id)
        timer.fn()
      }
    },
    /** 当前存活的定时器类型（排序后） */
    activeKinds(): string[] {
      return [...timers.values()].map((t) => t.kind).sort()
    },
  }
}

function createHarness() {
  const clock = createFakeClock()
  let checkCalls = 0
  const scheduler = createUpdateCheckScheduler({
    check: () => { checkCalls++ },
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
  })
  return { clock, getCheckCalls: () => checkCalls, scheduler }
}

describe('更新检查调度器', () => {
  test('Given auto 模式启动 When start Then 安排启动延迟检查与周期检查且不立即检查', () => {
    const { clock, getCheckCalls, scheduler } = createHarness()
    scheduler.start()
    expect(getCheckCalls()).toBe(0)
    expect(clock.activeKinds()).toEqual(['interval', 'timeout'])
  })

  test('Given auto 模式启动延迟到期 When 触发 timeout Then 执行一次检查且不重复安排启动检查', () => {
    const { clock, getCheckCalls, scheduler } = createHarness()
    scheduler.start()
    clock.fire('timeout')
    expect(getCheckCalls()).toBe(1)
    expect(clock.activeKinds()).toEqual(['interval'])
  })

  test('Given manual 模式启动 When start Then 不安排任何自动检查', () => {
    const { clock, getCheckCalls, scheduler } = createHarness()
    scheduler.setMode('manual')
    scheduler.start()
    clock.fire('timeout')
    clock.fire('interval')
    expect(getCheckCalls()).toBe(0)
    expect(clock.activeKinds()).toEqual([])
  })

  test('Given auto 运行中切到 manual When setMode Then 取消尚未触发的自动检查', () => {
    const { clock, getCheckCalls, scheduler } = createHarness()
    scheduler.start()
    scheduler.setMode('manual')
    clock.fire('timeout')
    clock.fire('interval')
    expect(getCheckCalls()).toBe(0)
    expect(clock.activeKinds()).toEqual([])
  })

  test('Given manual 切回 auto When setMode Then 恢复周期检查但不补启动延迟检查', () => {
    const { clock, getCheckCalls, scheduler } = createHarness()
    scheduler.setMode('manual')
    scheduler.start()
    scheduler.setMode('auto')
    expect(clock.activeKinds()).toEqual(['interval'])
    clock.fire('timeout')
    expect(getCheckCalls()).toBe(0)
    clock.fire('interval')
    expect(getCheckCalls()).toBe(1)
  })

  test('Given 重复 start 或重复 setMode 同值 When 调度 Then 不产生重复定时器', () => {
    const { clock, scheduler } = createHarness()
    scheduler.start()
    scheduler.start()
    scheduler.setMode('auto')
    expect(clock.activeKinds()).toEqual(['interval', 'timeout'])
    scheduler.setMode('manual')
    scheduler.setMode('manual')
    expect(clock.activeKinds()).toEqual([])
  })

  test('Given 已 dispose When 再次 setMode(auto) Then 不重建定时器', () => {
    const { clock, scheduler } = createHarness()
    scheduler.start()
    scheduler.dispose()
    scheduler.setMode('auto')
    expect(clock.activeKinds()).toEqual([])
  })
})
