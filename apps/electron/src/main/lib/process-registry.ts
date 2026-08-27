import type { SessionProcessInfo, SessionProcessStatus } from '@proma/shared'

interface RegistryEntry {
  process: SessionProcessInfo
  /** 终止该进程的动作；由登记方注入（kill child / kill PTY）。 */
  killer?: () => void
}

const TERMINAL_STATUSES: readonly SessionProcessStatus[] = ['exited', 'killed']

/**
 * 会话进程内存登记表（进程面板唯一数据源，见 docs/plans/2026-08-27-session-process-panel-plan.md）。
 * 键序为 sessionId → processId；纯内存，不持久化，应用重启后不恢复。
 */
export class ProcessRegistry {
  private readonly entries = new Map<string, Map<string, RegistryEntry>>()

  register(process: SessionProcessInfo, options: { killer?: () => void } = {}): void {
    const byId = this.entries.get(process.sessionId) ?? new Map<string, RegistryEntry>()
    byId.set(process.processId, { process: { ...process }, killer: options.killer })
    this.entries.set(process.sessionId, byId)
  }

  /** 幂等更新：仅合并给定字段；记录不存在时忽略；已终态（exited/killed）记录不再被改回 running。 */
  update(
    sessionId: string,
    processId: string,
    patch: Partial<Omit<SessionProcessInfo, 'processId' | 'sessionId'>>,
  ): SessionProcessInfo | undefined {
    const entry = this.entries.get(sessionId)?.get(processId)
    if (!entry) return undefined
    if (TERMINAL_STATUSES.includes(entry.process.status) && patch.status === 'running') return entry.process
    entry.process = { ...entry.process, ...patch }
    return entry.process
  }

  list(sessionId: string): SessionProcessInfo[] {
    return [...(this.entries.get(sessionId)?.values() ?? [])].map((entry) => ({ ...entry.process }))
  }

  /** 终止单个活跃进程；不存在或已终态时返回 false。 */
  terminate(sessionId: string, processId: string): boolean {
    const entry = this.entries.get(sessionId)?.get(processId)
    if (!entry || entry.process.status !== 'running') return false
    entry.killer?.()
    this.update(sessionId, processId, { status: 'killed', endedAt: Date.now() })
    return true
  }

  /** 会话删除：终止全部活跃进程（终端、命令）并清空记录。 */
  clearSession(sessionId: string): void {
    const byId = this.entries.get(sessionId)
    if (!byId) return
    for (const [processId, entry] of byId) {
      if (entry.process.status === 'running') {
        entry.killer?.()
        entry.process = { ...entry.process, status: 'killed', endedAt: Date.now() }
      }
      byId.delete(processId)
    }
    this.entries.delete(sessionId)
  }
}
