import type { SessionProcessEvent, SessionProcessInfo, SessionProcessOutputChunk } from '@proma/shared'
import { ProcessRegistry } from './process-registry'
import { OutputRingBuffer } from './adapters/command-process-tracker'

export interface SessionProcessKillForwarder {
  /** 转发终止请求到会话的 utility runtime；不可达（无活跃 query）时返回 false。 */
  (sessionId: string, processId: string): Promise<boolean>
}

/**
 * main 侧进程面板服务：utility 进程事件的权威镜像（命令进程）+ 输出缓冲。
 * renderer 查询（list/output）只读本服务；kill 先标记镜像再转发 utility 执行真实终止。
 * 纯内存，不持久化；会话删除时 clearSession。
 */
export class SessionProcessService {
  private readonly registry = new ProcessRegistry()
  private readonly buffers = new Map<string, OutputRingBuffer>()
  private readonly listeners = new Set<(event: SessionProcessEvent) => void>()

  constructor(private readonly killForwarder?: SessionProcessKillForwarder) {}

  /** 注册 renderer 推送监听；返回取消订阅函数。 */
  onEvent(listener: (event: SessionProcessEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** utility 事件流入（registered/updated/output）；原样转发给 renderer 监听者。 */
  ingest(event: SessionProcessEvent): void {
    if (event.type === 'registered') {
      this.registry.register(event.process)
      this.bufferFor(event.process.sessionId, event.process.processId)
    }
    else if (event.type === 'updated') {
      this.registry.update(event.process.sessionId, event.process.processId, event.process)
    }
    else if (event.type === 'output') {
      this.bufferFor(event.sessionId, event.processId).append(event.data)
    }
    else if (event.type === 'removed') {
      this.registry.remove(event.sessionId, event.processId)
      this.buffers.delete(bufferKey(event.sessionId, event.processId))
    }
    for (const listener of this.listeners) {
      try { listener(event) } catch (error) { console.warn('[SessionProcess] listener failed:', error) }
    }
  }

  list(sessionId: string): SessionProcessInfo[] {
    return this.registry.list(sessionId)
  }

  readOutput(sessionId: string, processId: string, offset: number): SessionProcessOutputChunk {
    return this.buffers.get(bufferKey(sessionId, processId))?.read(offset) ?? { offset, nextOffset: offset, truncated: false, data: '' }
  }

  /** 终止命令进程：镜像立即标记 killed（killed 事件转发给 renderer），并尽力转发 utility 执行真实 kill。 */
  async kill(sessionId: string, processId: string): Promise<boolean> {
    const marked = this.registry.terminate(sessionId, processId)
    if (!marked) return false
    const [updated] = this.registry.list(sessionId).filter(row => row.processId === processId)
    if (updated) this.emit({ type: 'updated', process: updated })
    if (this.killForwarder) {
      try { await this.killForwarder(sessionId, processId) } catch (error) {
        console.warn('[SessionProcess] kill forward failed:', error)
      }
    }
    return true
  }

  /** 会话删除：终止活跃进程并清空记录与缓冲。 */
  clearSession(sessionId: string): void {
    for (const row of this.registry.list(sessionId)) {
      this.emit({ type: 'removed', sessionId, processId: row.processId })
    }
    this.registry.clearSession(sessionId)
  }

  private bufferFor(sessionId: string, processId: string): OutputRingBuffer {
    const key = bufferKey(sessionId, processId)
    let buffer = this.buffers.get(key)
    if (!buffer) {
      buffer = new OutputRingBuffer()
      this.buffers.set(key, buffer)
    }
    return buffer
  }

  private emit(event: SessionProcessEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch (error) { console.warn('[SessionProcess] listener failed:', error) }
    }
  }
}

function bufferKey(sessionId: string, processId: string): string {
  return `${sessionId}:${processId}`
}
