import { describe, expect, test } from 'bun:test'
import {
  WHEEL_TAB_NAV_DEFAULTS,
  advanceWheelTabNav,
  createWheelTabNavState,
  getNeighborTabId,
} from './tab-wheel-nav'

describe('标签栏滚轮切换', () => {
  test('given a full mouse wheel notch when advancing nav then switches to next tab immediately', () => {
    const state = createWheelTabNavState()

    const decision = advanceWheelTabNav(state, 120, 1_000)

    expect(decision.offset).toBe(1)
    expect(state.lastSwitchAt).toBe(1_000)
    expect(state.accumulatedDelta).toBe(0)
  })

  test('given an upward wheel notch when advancing nav then switches to previous tab', () => {
    const state = createWheelTabNavState()

    const decision = advanceWheelTabNav(state, -120, 1_000)

    expect(decision.offset).toBe(-1)
  })

  test('given tiny trackpad deltas below threshold when advancing nav then accumulates before switching', () => {
    const state = createWheelTabNavState()

    expect(advanceWheelTabNav(state, 10, 1_000).offset).toBe(0)
    expect(advanceWheelTabNav(state, 10, 1_010).offset).toBe(0)
    expect(advanceWheelTabNav(state, 10, 1_020).offset).toBe(0)
    expect(advanceWheelTabNav(state, 10, 1_030).offset).toBe(0)
    expect(advanceWheelTabNav(state, 10, 1_040).offset).toBe(1)
  })

  test('given a switch just happened when receiving more inertia events then drops them without accumulating', () => {
    const state = createWheelTabNavState()
    advanceWheelTabNav(state, 120, 1_000)

    // 冷却窗口内的惯性事件被丢弃，且不累积到冷却结束后的首次判断
    expect(advanceWheelTabNav(state, 60, 1_060).offset).toBe(0)
    expect(advanceWheelTabNav(state, 60, 1_100).offset).toBe(0)
    // 冷却结束（1_000 + 120 <= 1_121）后需要重新累积到阈值才切换
    expect(advanceWheelTabNav(state, 49, 1_121).offset).toBe(0)
    expect(advanceWheelTabNav(state, 1, 1_122).offset).toBe(1)
  })

  test('given custom options when advancing nav then respects provided threshold and cooldown', () => {
    const state = createWheelTabNavState()

    expect(advanceWheelTabNav(state, 200, 1_000, { threshold: 500 }).offset).toBe(0)
    expect(advanceWheelTabNav(state, 300, 1_010, { threshold: 500 }).offset).toBe(1)
    expect(advanceWheelTabNav(state, 1_000, 1_050, { threshold: 500, cooldownMs: 1_000 }).offset).toBe(0)
    // 冷却期从上次切换（1_010）起算，2_050 时已超过 1_000ms；冷却期内增量被丢弃，需重新累积到阈值
    expect(advanceWheelTabNav(state, 1_000, 2_050, { threshold: 500, cooldownMs: 1_000 }).offset).toBe(1)
  })

  test('given default cooldown when checking defaults then keeps documented values', () => {
    expect(WHEEL_TAB_NAV_DEFAULTS.threshold).toBe(50)
    expect(WHEEL_TAB_NAV_DEFAULTS.cooldownMs).toBe(120)
  })
})

describe('相邻标签定位', () => {
  const tabIds = ['files', 'changes', 'preview:1', 'browser:2'] as const

  test('given an active tab in the middle when locating neighbor then returns previous or next id', () => {
    expect(getNeighborTabId(tabIds, 'changes', -1)).toBe('files')
    expect(getNeighborTabId(tabIds, 'changes', 1)).toBe('preview:1')
  })

  test('given the first or last tab when locating neighbor then returns null instead of wrapping', () => {
    expect(getNeighborTabId(tabIds, 'files', -1)).toBeNull()
    expect(getNeighborTabId(tabIds, 'browser:2', 1)).toBeNull()
    expect(getNeighborTabId(tabIds, 'files', 1)).toBe('changes')
    expect(getNeighborTabId(tabIds, 'browser:2', -1)).toBe('preview:1')
  })

  test('given a missing or undefined active tab when locating neighbor then returns null', () => {
    expect(getNeighborTabId(tabIds, 'unknown' as (typeof tabIds)[number], 1)).toBeNull()
    expect(getNeighborTabId(tabIds, undefined, 1)).toBeNull()
    expect(getNeighborTabId([], undefined, 1)).toBeNull()
    expect(getNeighborTabId(['only'], 'only', 1)).toBeNull()
  })
})
