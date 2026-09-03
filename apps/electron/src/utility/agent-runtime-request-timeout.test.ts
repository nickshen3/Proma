import { describe, expect, test } from 'bun:test'
import {
  ASK_USER_QUESTION_TIMEOUT_MS,
  WAITFOR_PARENT_REQUEST_TIMEOUT_MS,
  getParentRequestTimeoutMs,
} from './agent-runtime-request-timeout'
import { AGENT_RUNTIME_METHODS } from '@proma/shared'

/**
 * Utility→主进程 capability 请求的超时策略：
 * 默认 120s 故障检测不变；仅用户交互（AskUserQuestion）与长时条件等待（WaitFor）
 * 豁免。WaitFor 豁免必须覆盖其服务端轮询上限（2h），否则长等待会在条件满足前
 * 被通道掐断（真实案例：interval 90s 的等待在 120s 处超时报错）。
 */

describe('getParentRequestTimeoutMs', () => {
  test('默认请求保持 120s 故障检测', () => {
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL, { toolName: 'TerminalRead' }))
      .toBe(120_000)
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL, { toolName: 'Bash' }))
      .toBe(120_000)
    expect(getParentRequestTimeoutMs('agent.unknown.method', null)).toBe(120_000)
  })

  test('AskUserQuestion 维持 15 分钟豁免', () => {
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL, { toolName: 'AskUserQuestion' }))
      .toBe(ASK_USER_QUESTION_TIMEOUT_MS)
  })

  test('WaitFor 的 customTool 请求豁免到覆盖其 2 小时轮询上限', () => {
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL, { toolName: 'WaitFor' }))
      .toBe(WAITFOR_PARENT_REQUEST_TIMEOUT_MS)
    // 豁免必须严格大于 WaitFor 的最长等待 2 小时。
    expect(WAITFOR_PARENT_REQUEST_TIMEOUT_MS).toBeGreaterThan(7_200_000)
  })
})
