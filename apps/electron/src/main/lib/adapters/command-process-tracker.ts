import { randomUUID } from 'node:crypto'
import type { SessionProcessEvent, SessionProcessInfo, SessionProcessOutputChunk } from '@proma/shared'
import type { ProcessRegistry } from '../process-registry'

const DEFAULT_OUTPUT_LIMIT_BYTES = 200 * 1024

/** 命令标题摘要：超长截断并追加 ellipsis（U+2026 占 1 位）。 */
export function summarizeCommand(command: string, max = 80): string {
  if (command.length <= max) return command
  return `${command.slice(0, max - 1)}…`
}

/**
 * 输出环形缓冲：字节级追加，超上限丢弃最早内容。
 * offset 为绝对字节位置（含已丢弃部分），read(offset) 若早于缓冲起点则从起点返回并标记 truncated。
 */
export class OutputRingBuffer {
  private chunks: Buffer[] = []
  /** 缓冲内第一字节的绝对偏移。 */
  private baseOffset = 0
  private bufferLength = 0
  private dropped = false

  constructor(private readonly limitBytes: number = DEFAULT_OUTPUT_LIMIT_BYTES) {}

  append(data: Buffer | string): void {
    const chunk = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    this.chunks.push(chunk)
    this.bufferLength += chunk.length
    if (this.bufferLength <= this.limitBytes) return
    // 丢弃最早内容，直到回到上限内
    while (this.bufferLength > this.limitBytes && this.chunks.length > 0) {
      const first = this.chunks[0]
      if (!first) break
      if (this.bufferLength - first.length >= this.limitBytes) {
        // 整块可丢
        this.chunks.shift()
        this.baseOffset += first.length
        this.bufferLength -= first.length
      }
      else {
        // 块内部分丢弃
        const dropBytes = this.bufferLength - this.limitBytes
        this.chunks[0] = Buffer.from(first.subarray(dropBytes))
        this.baseOffset += dropBytes
        this.bufferLength -= dropBytes
      }
      this.dropped = true
    }
  }

  /** 绝对末尾偏移；下一次拉取应传入该值。 */
  get nextOffset(): number {
    return this.baseOffset + this.bufferLength
  }

  read(offset: number): SessionProcessOutputChunk {
    const from = Math.max(offset, this.baseOffset)
    const parts: Buffer[] = []
    let cursor = this.baseOffset
    for (const chunk of this.chunks) {
      const end = cursor + chunk.length
      if (end <= from) {
        cursor = end
        continue
      }
      const startInChunk = Math.max(0, from - cursor)
      parts.push(chunk.subarray(startInChunk))
      cursor = end
    }
    return {
      offset: from,
      nextOffset: this.nextOffset,
      truncated: this.dropped && from <= this.baseOffset,
      data: Buffer.concat(parts).toString('utf8'),
    }
  }
}

export interface CommandProcessTrackerOptions {
  registry: ProcessRegistry
  sessionId: string
  /** 进程登记/状态变化时回调（用于主进程向渲染进程推送）。 */
  onEvent?: (event: SessionProcessEvent) => void
  /** 输出块回调（环形缓冲旁路，utility → main 流式转发）。 */
  onOutput?: (event: Extract<SessionProcessEvent, { type: 'output' }>) => void
  /** 单进程输出缓冲上限（字节）。 */
  outputLimitBytes?: number
}

interface SpawnContext {
  command: string
  cwd: string
  toolCallId?: string
}

/** tracker 实际依赖的 child 最小结构；node ChildProcess 与测试 fake 均天然兼容。 */
export interface SpawnableChild {
  pid?: number
  stdout?: { on(event: 'data', listener: (d: Buffer) => void): unknown } | null
  stderr?: { on(event: 'data', listener: (d: Buffer) => void): unknown } | null
  once(event: 'close', listener: (code: number | null, signal?: string) => void): unknown
  kill(signal?: number | string): unknown
}

/**
 * 命令进程追踪器：以 pi bash 的 onSpawnProcess 回调为入口，登记进程记录、
 * 旁路缓冲输出、监听 close 收敛状态。processId 优先使用 toolCallId（与 stream 事件天然关联）。
 */
export class CommandProcessTracker {
  private readonly buffers = new Map<string, OutputRingBuffer>()

  constructor(private readonly options: CommandProcessTrackerOptions) {}

  /** BashToolOptions.onSpawnProcess 的实现。 */
  handleSpawn(child: SpawnableChild, context: SpawnContext): void {
    const processId = context.toolCallId || randomUUID()
    const now = Date.now()
    const buffer = new OutputRingBuffer(this.options.outputLimitBytes)
    this.buffers.set(processId, buffer)

    const process: SessionProcessInfo = {
      processId,
      sessionId: this.options.sessionId,
      kind: 'command',
      title: summarizeCommand(context.command),
      status: 'running',
      startedAt: now,
      ...(child.pid !== undefined ? { pid: child.pid } : {}),
    }
    this.options.registry.register(process, { killer: () => child.kill('SIGTERM') })
    this.options.onEvent?.({ type: 'registered', process: { ...process } })

    // 输出旁路：pi 内部已挂 onData 处理工具输出；此处额外挂监听服务于进程面板缓冲与流式转发。
    const emitOutput = (d: Buffer): void => {
      buffer.append(d)
      this.options.onOutput?.({ type: 'output', sessionId: this.options.sessionId, processId, data: d.toString('utf8') })
    }
    child.stdout?.on('data', emitOutput)
    child.stderr?.on('data', emitOutput)

    child.once('close', (code: number | null, signal?: string) => {
      // code 为 null（被信号终止）统一记 killed，涵盖：用户终止、abort 中断、超时；正常结束记 exited。
      const status = code === null || signal ? 'killed' : 'exited'
      const updated = this.options.registry.update(this.options.sessionId, processId, {
        status,
        endedAt: Date.now(),
        ...(status === 'exited' && code !== null ? { exitCode: code } : {}),
      })
      if (updated) this.options.onEvent?.({ type: 'updated', process: { ...updated } })
    })
  }

  /** 进程输出增量读取；进程未知时返回空片段。 */
  readOutput(processId: string, offset: number): SessionProcessOutputChunk {
    const buffer = this.buffers.get(processId)
    if (!buffer) {
      return { offset, nextOffset: offset, truncated: false, data: '' }
    }
    return buffer.read(offset)
  }
}
