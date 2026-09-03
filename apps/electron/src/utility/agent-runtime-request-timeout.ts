import { AGENT_RUNTIME_METHODS } from '@proma/shared'

const DEFAULT_PARENT_REQUEST_TIMEOUT_MS = 120_000
// AskUserQuestion 属于用户主导的自由文本交互；两分钟不足以完成输入。
export const ASK_USER_QUESTION_TIMEOUT_MS = 15 * 60_000
// WaitFor 服务端条件轮询最长 2 小时；通道超时必须覆盖工具自身上限，
// 否则长等待会在条件满足前被掐断（真实案例：interval 90s 的等待在 120s 处报
// "Main runtime request timed out: agent.capability.customTool"）。额外 5 分钟消化末轮检查开销。
export const WAITFOR_PARENT_REQUEST_TIMEOUT_MS = 7_200_000 + 5 * 60_000

/**
 * Utility Process 请求主进程的等待时间。
 * 仅用户交互与长时条件等待工具延长，避免放宽其他跨进程能力调用的故障检测。
 */
export function getParentRequestTimeoutMs(method: string, payload: unknown): number {
  if (
    method === AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL
    && (payload as { toolName?: unknown } | null)?.toolName === 'AskUserQuestion'
  ) {
    return ASK_USER_QUESTION_TIMEOUT_MS
  }
  if (
    method === AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL
    && (payload as { toolName?: unknown } | null)?.toolName === 'WaitFor'
  ) {
    return WAITFOR_PARENT_REQUEST_TIMEOUT_MS
  }
  return DEFAULT_PARENT_REQUEST_TIMEOUT_MS
}
