import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import { CommandProcessTracker, summarizeCommand } from './command-process-tracker'
import { ProcessRegistry } from '../process-registry'
import type { SessionProcessEvent } from '@proma/shared'

/** 构造可触发 stdout/stderr/close 的假 child（结构兼容 SpawnableChild）。 */
function makeFakeChild(pid = 4321) {
  const child = new EventEmitter() as unknown as {
    pid: number
    stdout: EventEmitter
    stderr: EventEmitter
    kill: () => boolean
    once: (event: 'close', listener: (code: number | null, signal?: string) => void) => unknown
    emitClose: (code: number | null, signal?: string) => void
  }
  child.pid = pid
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => true
  child.once = (event, listener) => {
    ;(child as unknown as EventEmitter).on(event, listener)
    return child
  }
  child.emitClose = (code, signal) => (child as unknown as EventEmitter).emit('close', code, signal)
  return child
}

function makeTracker(overrides: Partial<{ outputLimitBytes: number }> = {}) {
  const registry = new ProcessRegistry()
  const events: SessionProcessEvent[] = []
  const tracker = new CommandProcessTracker({
    registry,
    sessionId: 's1',
    onEvent: (event) => events.push(event),
    outputLimitBytes: overrides.outputLimitBytes,
  })
  return { registry, events, tracker }
}

describe('summarizeCommand', () => {
  it('短命令原样返回', () => {
    expect(summarizeCommand('bun run dev')).toBe('bun run dev')
  })

  it('超 80 字符截断并追加 ellipsis', () => {
    const long = 'x'.repeat(120)
    const summary = summarizeCommand(long)
    expect(summary.length).toBe(80)
    expect(summary.endsWith('…')).toBe(true)
  })
})

describe('CommandProcessTracker', () => {
  it('handleSpawn 登记 running 记录并推送 registered 事件', () => {
    const { registry, events, tracker } = makeTracker()
    const child = makeFakeChild(111)
    tracker.handleSpawn(child, { command: 'bun run dev', cwd: 'D:/x', toolCallId: 'tc-1' })
    const [row] = registry.list('s1')
    expect(row?.processId).toBe('tc-1')
    expect(row?.status).toBe('running')
    expect(row?.pid).toBe(111)
    expect(row?.title).toBe('bun run dev')
    expect(events[0]?.type).toBe('registered')
  })

  it('无 toolCallId 时生成独立 processId', () => {
    const { registry, tracker } = makeTracker()
    tracker.handleSpawn(makeFakeChild(), { command: 'ls', cwd: 'D:/x' })
    const [row] = registry.list('s1')
    expect(row?.processId).toBeTruthy()
    expect(row?.processId).not.toBe('')
  })

  it('stdout/stderr 写入输出缓冲并可增量读取', () => {
    const { tracker } = makeTracker()
    const child = makeFakeChild()
    tracker.handleSpawn(child, { command: 'bun test', cwd: 'D:/x', toolCallId: 'tc-2' })
    ;(child.stdout as EventEmitter).emit('data', Buffer.from('hello '))
    ;(child.stderr as EventEmitter).emit('data', Buffer.from('world'))
    const first = tracker.readOutput('tc-2', 0)
    expect(first.data).toBe('hello world')
    expect(first.nextOffset).toBe(Buffer.byteLength('hello world'))
    expect(first.truncated).toBe(false)
  })

  it('readOutput 支持 offset 增量拉取', () => {
    const { tracker } = makeTracker()
    const child = makeFakeChild()
    tracker.handleSpawn(child, { command: 'bun test', cwd: 'D:/x', toolCallId: 'tc-3' })
    ;(child.stdout as EventEmitter).emit('data', Buffer.from('abcdefgh'))
    const chunk = tracker.readOutput('tc-3', 3)
    expect(chunk.data).toBe('defgh')
    expect(chunk.offset).toBe(3)
  })

  it('环形缓冲超上限时丢弃早期内容并标记 truncated', () => {
    const { tracker } = makeTracker({ outputLimitBytes: 16 })
    const child = makeFakeChild()
    tracker.handleSpawn(child, { command: 'big', cwd: 'D:/x', toolCallId: 'tc-4' })
    ;(child.stdout as EventEmitter).emit('data', Buffer.from('abcdefghijklmnop')) // 16 bytes
    ;(child.stdout as EventEmitter).emit('data', Buffer.from('QRST')) // 超限 4 字节，丢棄最早 'abcd'
    const chunk = tracker.readOutput('tc-4', 0)
    expect(chunk.truncated).toBe(true)
    expect(chunk.data).toBe('efghijklmnopQRST')
  })

  it('close(code) 收敛为 exited 并推送 updated 事件', () => {
    const { registry, events, tracker } = makeTracker()
    const child = makeFakeChild()
    tracker.handleSpawn(child, { command: 'bun test', cwd: 'D:/x', toolCallId: 'tc-5' })
    child.emitClose(0)
    const [row] = registry.list('s1')
    expect(row?.status).toBe('exited')
    expect(row?.exitCode).toBe(0)
    expect(row?.endedAt).toBeGreaterThan(0)
    expect(events.at(-1)?.type).toBe('updated')
  })

  it('close(null, signal) 收敛为 killed 且不携带退出码', () => {
    const { registry, tracker } = makeTracker()
    const child = makeFakeChild()
    tracker.handleSpawn(child, { command: 'bun run dev', cwd: 'D:/x', toolCallId: 'tc-6' })
    child.emitClose(null, 'SIGTERM')
    const [row] = registry.list('s1')
    expect(row?.status).toBe('killed')
    expect(row?.exitCode).toBeUndefined()
  })

  it('registry.terminate 注入的 killer 能杀掉 child', () => {
    const { registry, tracker } = makeTracker()
    let killed = false
    const child = makeFakeChild()
    child.kill = () => {
      killed = true
      return true
    }
    tracker.handleSpawn(child, { command: 'bun run dev', cwd: 'D:/x', toolCallId: 'tc-7' })
    expect(registry.terminate('s1', 'tc-7')).toBe(true)
    expect(killed).toBe(true)
  })

  it('多个并发进程互不串扰', () => {
    const { registry, tracker } = makeTracker()
    tracker.handleSpawn(makeFakeChild(1), { command: 'a', cwd: 'D:/x', toolCallId: 'tc-a' })
    tracker.handleSpawn(makeFakeChild(2), { command: 'b', cwd: 'D:/x', toolCallId: 'tc-b' })
    expect(registry.list('s1')).toHaveLength(2)
  })
})
