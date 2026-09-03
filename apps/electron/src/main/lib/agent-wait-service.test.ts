import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cancelWaitsForSession, waitForCondition } from './agent-wait-service'

/**
 * 条件等待服务：等待由条件而非时钟驱动。
 * 测试注入 node 执行器（process.execPath -e）避免依赖平台 shell 探测。
 */

const shell = { file: process.execPath, args: ['-e'] }

const scratchRoots: string[] = []

describe('waitForCondition', () => {
  test('条件立即满足：首次检查即返回 satisfied 与输出', async () => {
    const startedAt = Date.now()
    const result = await waitForCondition({
      sessionId: 'wait-1',
      command: 'console.log("ready"); process.exit(0)',
      shell,
      intervalSeconds: 1,
      timeoutMs: 5_000,
    })
    expect(result.status).toBe('satisfied')
    if (result.status === 'satisfied') {
      expect(result.checks).toBe(1)
      expect(result.lastOutput).toContain('ready')
      expect(result.elapsedMs).toBeLessThan(2_000)
    }
    expect(Date.now() - startedAt).toBeLessThan(3_000)
  })

  test('按间隔轮询直至条件满足：文件出现后立即返回', async () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-wait-'))
    scratchRoots.push(root)
    const marker = join(root, 'merged.txt').replaceAll('\\', '/')
    const command = `process.exit(require('fs').existsSync('${marker}') ? 0 : 1)`
    setTimeout(() => writeFileSync(marker, 'ok', 'utf-8'), 1_500)

    const result = await waitForCondition({
      sessionId: 'wait-2',
      command,
      shell,
      intervalSeconds: 1,
      timeoutMs: 10_000,
    })
    expect(result.status).toBe('satisfied')
    if (result.status === 'satisfied') expect(result.checks).toBeGreaterThanOrEqual(2)
  })

  test('条件始终不满足时按超时收尾并带回最后输出', async () => {
    const result = await waitForCondition({
      sessionId: 'wait-3',
      command: 'console.error("still-open"); process.exit(1)',
      shell,
      intervalSeconds: 1,
      timeoutMs: 1_000,
    })
    expect(result.status).toBe('timeout')
    if (result.status === 'timeout') {
      expect(result.checks).toBeGreaterThanOrEqual(1)
      expect(result.lastOutput).toContain('still-open')
    }
  })

  test('会话取消：cancelWaitsForSession 立即释放挂起的等待', async () => {
    const waiting = waitForCondition({
      sessionId: 'wait-cancel',
      command: 'process.exit(1)',
      shell,
      intervalSeconds: 1,
      timeoutMs: 60_000,
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    cancelWaitsForSession('wait-cancel')
    const result = await waiting
    expect(result.status).toBe('cancelled')
  })

  test('中止信号：abortSignal 触发时立即收尾并停止后续轮询', async () => {
    const controller = new AbortController()
    const waiting = waitForCondition({
      sessionId: 'wait-abort',
      command: 'process.exit(1)',
      shell,
      intervalSeconds: 1,
      timeoutMs: 60_000,
      abortSignal: controller.signal,
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    controller.abort()
    const result = await waiting
    expect(result.status).toBe('cancelled')
  })

  test('中止信号已触发时直接取消，不执行任何检查', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await waitForCondition({
      sessionId: 'wait-aborted',
      command: 'process.exit(0)',
      shell,
      abortSignal: controller.signal,
    })
    expect(result.status).toBe('cancelled')
  })
})

describe('waitForCondition 参数归一', () => {
  test('空命令与非法间隔被拒绝或归一', async () => {
    expect(waitForCondition({ sessionId: 'wait-4', command: '   ', shell })).rejects.toThrow('为空')
    const fast = await waitForCondition({
      sessionId: 'wait-5',
      command: 'process.exit(0)',
      shell,
      intervalSeconds: 0,
      timeoutMs: 1,
    })
    // timeoutMs 低于下限被抬到 1000，但条件首次检查即满足，不受影响。
    expect(fast.status).toBe('satisfied')
  })
})

// 退出前清理临时目录（bun:test 无内置 afterAll 文件级钩子的场景下用它兑底）。
process.on('exit', () => {
  for (const root of scratchRoots) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // 清理失败可忽略。
    }
  }
})
