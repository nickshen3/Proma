/**
 * tab-wheel-nav — 标签栏滚轮切换的纯决策逻辑。
 *
 * 鼠标悬停在标签栏标题行上滚动滚轮时，按显示顺序切换相邻标签；
 * 累积阈值过滤细微抖动，冷却窗口抑制触控板惯性导致的连续多跳。
 */

export interface WheelTabNavState {
  /** 冷却窗口外累计的垂直滚动增量。 */
  accumulatedDelta: number
  /** 上次接受切换的时间戳（performance.now()）。 */
  lastSwitchAt: number
}

export const WHEEL_TAB_NAV_DEFAULTS = {
  /** 触发一次切换所需的最小累计 |deltaY|；鼠标一格（100/120）必定立即触发。 */
  threshold: 50,
  /** 两次切换之间的最小间隔（ms），抑制触控板惯性连跳。 */
  cooldownMs: 120,
} as const

export function createWheelTabNavState(): WheelTabNavState {
  return { accumulatedDelta: 0, lastSwitchAt: 0 }
}

export interface WheelTabNavDecision {
  /** 切换方向：1 = 下一个标签，-1 = 上一个标签，0 = 本轮不切换。 */
  offset: -1 | 0 | 1
}

/**
 * 用本次滚轮增量推进状态机；跨过切换阈值时返回方向并重置状态。
 * 冷却窗口内的事件被丢弃且不累积，避免惯性滚动攒出连续切换。
 */
export function advanceWheelTabNav(
  state: WheelTabNavState,
  deltaY: number,
  now: number,
  options?: Partial<{ threshold: number; cooldownMs: number }>,
): WheelTabNavDecision {
  const threshold = options?.threshold ?? WHEEL_TAB_NAV_DEFAULTS.threshold
  const cooldownMs = options?.cooldownMs ?? WHEEL_TAB_NAV_DEFAULTS.cooldownMs

  if (now - state.lastSwitchAt < cooldownMs) return { offset: 0 }

  state.accumulatedDelta += deltaY
  if (Math.abs(state.accumulatedDelta) < threshold) return { offset: 0 }

  const offset: -1 | 1 = state.accumulatedDelta > 0 ? 1 : -1
  state.accumulatedDelta = 0
  state.lastSwitchAt = now
  return { offset }
}

/**
 * 按标签栏显示顺序取相邻标签 id；不循环，越界或未找到当前标签时返回 null。
 */
export function getNeighborTabId<T extends string>(
  tabIds: readonly T[],
  activeTabId: T | undefined,
  offset: -1 | 1,
): T | null {
  if (offset !== -1 && offset !== 1) return null
  const index = activeTabId === undefined ? -1 : tabIds.indexOf(activeTabId)
  if (index < 0) return null
  const nextIndex = index + offset
  if (nextIndex < 0 || nextIndex >= tabIds.length) return null
  return tabIds[nextIndex] ?? null
}
