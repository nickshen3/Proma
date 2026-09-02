/**
 * TerminalExecute 工具结果的构造与共享文案。
 *
 * 独立成模块是因为 pi-builtin-tools.ts 依赖链会拉起大量主进程服务
 * （含 electron 运行时），无法在 bun test 中直接导入；结果构造本身是
 * 纯函数，值得单独覆盖。
 */

import type { AgentTerminalCommandWaitResult, AgentTerminalRecord } from './terminal-service'

/**
 * 不携带 waitMs 的调用不会注册结束信号；在结果里提示模型下次可直接阻塞等待
 * 拿退出码，避免退回 sleep 盲等。长驻命令（dev server 等）仍应省略 waitMs。
 */
export const TERMINAL_WAIT_HINT = 'No completion signal was registered. When you need this command\'s result, pass waitMs (1000-120000) to return its exit code and output tail as soon as it finishes; keep omitting waitMs only for long-lived commands like dev servers, then inspect output with TerminalRead.'

export interface TerminalExecuteResultPayload {
  terminal: AgentTerminalRecord
  commandStarted: true
  reused: boolean
  outputSharedWithAgent: false
  /** waitMs 提供时的命令结束信号结果。 */
  wait?: AgentTerminalCommandWaitResult
  /** 未注册结束信号时的引导提示。 */
  hint?: string
}

export function buildTerminalExecuteResultPayload(input: {
  terminal: AgentTerminalRecord
  reused: boolean
  wait?: AgentTerminalCommandWaitResult
}): TerminalExecuteResultPayload {
  return {
    terminal: input.terminal,
    commandStarted: true,
    reused: input.reused,
    outputSharedWithAgent: false,
    ...(input.wait === undefined ? {} : { wait: input.wait }),
    ...(input.wait === undefined ? { hint: TERMINAL_WAIT_HINT } : {}),
  }
}
