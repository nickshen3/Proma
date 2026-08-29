/**
 * 更新检查调度器
 *
 * 把「软件更新检查方式」设置（auto / manual）翻译成定时器行为：
 * - auto：启动延迟首次检查 + 周期复查
 * - manual：不安排任何自动检查，仅保留渲染进程手动触发
 *
 * 定时器全部通过构造参数注入，便于单测。
 */

import type { UpdateCheckMode } from '../../../types'

export interface UpdateCheckSchedulerOptions {
  /** 执行一次更新检查 */
  check: () => void
  /** 启动延迟首次检查的等待时间，默认 10 秒 */
  startupDelayMs?: number
  /** 周期检查间隔，默认 4 小时 */
  intervalMs?: number
  /** 注入时钟以便测试 */
  setTimeoutFn?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  /** 注入时钟以便测试 */
  clearTimeoutFn?: (timer: ReturnType<typeof setTimeout>) => void
  /** 注入时钟以便测试 */
  setIntervalFn?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>
  /** 注入时钟以便测试 */
  clearIntervalFn?: (timer: ReturnType<typeof setInterval>) => void
}

export interface UpdateCheckScheduler {
  /** 应用启动时调用一次：按当前模式安排自动检查。 */
  start(): void
  /** 设置变更入口：manual 取消未触发的自动检查；auto 恢复周期检查。 */
  setMode(mode: UpdateCheckMode): void
  /** 释放全部定时器；释放后 setMode 不再重建定时器。 */
  dispose(): void
}

export function createUpdateCheckScheduler({
  check,
  startupDelayMs = 10_000,
  intervalMs = 4 * 60 * 60 * 1000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}: UpdateCheckSchedulerOptions): UpdateCheckScheduler {
  let mode: UpdateCheckMode = 'auto'
  let disposed = false
  let started = false
  let startupTimer: ReturnType<typeof setTimeout> | null = null
  let intervalTimer: ReturnType<typeof setInterval> | null = null

  const clearStartupTimer = (): void => {
    if (!startupTimer) return
    clearTimeoutFn(startupTimer)
    startupTimer = null
  }

  const clearIntervalTimer = (): void => {
    if (!intervalTimer) return
    clearIntervalFn(intervalTimer)
    intervalTimer = null
  }

  /** 启动周期检查；已启动或已释放时是幂等操作 */
  const startInterval = (): void => {
    if (disposed || intervalTimer) return
    intervalTimer = setIntervalFn(check, intervalMs)
  }

  return {
    start() {
      if (disposed || started) return
      started = true
      if (mode === 'manual') {
        console.log('[更新] 检查方式为手动，跳过启动自动检查')
        return
      }
      startupTimer = setTimeoutFn(() => {
        startupTimer = null
        check()
      }, startupDelayMs)
      startInterval()
    },

    setMode(next) {
      mode = next
      if (next === 'manual') {
        console.log('[更新] 检查方式切换为手动，取消自动检查')
        clearStartupTimer()
        clearIntervalTimer()
        return
      }
      // 切回 auto：恢复周期检查；不补跑启动延迟检查，避免切换设置立即发起网络请求。
      startInterval()
    },

    dispose() {
      disposed = true
      clearStartupTimer()
      clearIntervalTimer()
    },
  }
}
