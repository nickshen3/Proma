import { describe, expect, test } from 'bun:test'
import {
  buildTerminalExecuteResultPayload,
  TERMINAL_WAIT_HINT,
} from './terminal-tool-result'
import type { AgentTerminalRecord } from './terminal-service'

/**
 * TerminalExecute 结果构造的行为约定：
 * - 未注册结束信号（无 waitMs）时附带 hint，引导模型下次直接传 waitMs 而不是 sleep 盲等；
 * - 有结束信号时返回 wait 且不再附带 hint；
 * - 长驻命令（dev server）语义由文案说明，不改变字段结构。
 */

const record: AgentTerminalRecord = {
  sessionId: 'session-1',
  terminalId: 'terminal-1',
  title: 'Agent 终端',
  cwd: 'D:\\workspace',
  profile: 'bash',
  status: 'running',
  command: { mode: 'interactive', startedAt: 1_000, finished: false },
}

describe('buildTerminalExecuteResultPayload', () => {
  test('未携带 wait 时不输出 wait 字段，并附带引导 hint', () => {
    const payload = buildTerminalExecuteResultPayload({ terminal: record, reused: false })
    expect(payload.commandStarted).toBe(true)
    expect(payload.outputSharedWithAgent).toBe(false)
    expect(payload.reused).toBe(false)
    expect(payload.terminal).toBe(record)
    expect('wait' in payload).toBe(false)
    expect(payload.hint).toBe(TERMINAL_WAIT_HINT)
    expect(payload.hint).toContain('pass waitMs')
    // 文案必须保留长驻命令例外，避免模型给 dev server 传 waitMs。
    expect(payload.hint).toContain('long-lived commands')
  })

  test('携带 wait（超时仍在运行）时输出 wait 字段，不附带 hint', () => {
    const payload = buildTerminalExecuteResultPayload({
      terminal: record,
      reused: true,
      wait: { status: 'running' },
    })
    expect(payload.wait).toEqual({ status: 'running' })
    expect(payload.hint).toBeUndefined()
    expect(payload.reused).toBe(true)
  })

  test('携带 wait（命令完成）时输出退出码与输出尾部，不附带 hint', () => {
    const payload = buildTerminalExecuteResultPayload({
      terminal: record,
      reused: false,
      wait: { status: 'finished', exitCode: 7, outputTail: 'error: boom' },
    })
    expect(payload.wait).toEqual({ status: 'finished', exitCode: 7, outputTail: 'error: boom' })
    expect(payload.hint).toBeUndefined()
  })
})
