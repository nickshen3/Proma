import { atom } from 'jotai'
import type { SessionProcessEvent, SessionProcessInfo } from '@proma/shared'

/** 子会话引用（协作子 Agent / 探索分支）；label 用于面板来源标识。 */
export interface ChildSessionRef {
  sessionId: string
  label: string
}

/** 进程面板合成行：命令进程来自 main 镜像，终端从 agentTerminalTabsAtom 合成。 */
export interface ProcessRow {
  processId: string
  kind: 'command' | 'terminal'
  title: string
  status: 'running' | 'exited' | 'killed'
  startedAt: number
  endedAt?: number
  pid?: number
  exitCode?: number
  terminalId?: string
  /** 该行所属的会话（kill / 输出读取按此路由；子会话行≠当前面板会话）。 */
  ownerSessionId: string
  /** 来源子会话标识；主会话行无此字段。 */
  ownerLabel?: string
}

/**
 * 会话进程记录（命令进程部分，main 镜像）；键为 sessionId。
 * 终端记录不在此处：renderer 直接复用 agentTerminalTabsAtom 合成，保证单一数据源。
 */
export const agentProcessesAtom = atom<Map<string, SessionProcessInfo[]>>(new Map())

/** 排序：running 优先，组内 startedAt 倒序（最新在上）。 */
export function compareProcesses(a: Pick<SessionProcessInfo, 'status' | 'startedAt'>, b: Pick<SessionProcessInfo, 'status' | 'startedAt'>): number {
  const aRunning = a.status === 'running' ? 0 : 1
  const bRunning = b.status === 'running' ? 0 : 1
  if (aRunning !== bRunning) return aRunning - bRunning
  return b.startedAt - a.startedAt
}

/**
 * 合成进程面板行（FR6.3 v2）：主会话 + 其子会话（协作子 Agent / 探索分支）的
 * 命令进程与终端统一聚合；子会话行带 ownerLabel 标识。
 * filter='active' 仅保留 running（终端始终视为 running）。
 */
export function buildProcessRows(
  ownSessionId: string,
  commandProcesses: Map<string, SessionProcessInfo[]>,
  terminalTabs: Map<string, { terminalId: string; title: string }[]>,
  childSessions: ChildSessionRef[],
  filter: 'active' | 'all',
): ProcessRow[] {
  const sessionSources: { sessionId: string; ownerLabel?: string }[] = [
    { sessionId: ownSessionId },
    ...childSessions.map(child => ({ sessionId: child.sessionId, ownerLabel: child.label })),
  ]

  const rows: ProcessRow[] = []
  for (const { sessionId, ownerLabel } of sessionSources) {
    for (const row of commandProcesses.get(sessionId) ?? []) {
      rows.push({
        processId: row.processId,
        kind: 'command',
        title: row.title,
        status: row.status,
        startedAt: row.startedAt,
        ...(row.endedAt !== undefined ? { endedAt: row.endedAt } : {}),
        ...(row.pid !== undefined ? { pid: row.pid } : {}),
        ...(row.exitCode !== undefined ? { exitCode: row.exitCode } : {}),
        ownerSessionId: sessionId,
        ...(ownerLabel ? { ownerLabel } : {}),
      })
    }
    for (const tab of terminalTabs.get(sessionId) ?? []) {
      rows.push({
        processId: `terminal:${tab.terminalId}`,
        kind: 'terminal',
        title: tab.title,
        status: 'running',
        startedAt: 0,
        terminalId: tab.terminalId,
        ownerSessionId: sessionId,
        ...(ownerLabel ? { ownerLabel } : {}),
      })
    }
  }

  const filtered = filter === 'active' ? rows.filter(row => row.status === 'running') : rows
  return filtered.sort(compareProcesses)
}

/** 纯函数 reducer：把进程事件应用到会话进程 Map；返回新 Map（不可变更新）。 */
export function applySessionProcessEvent(
  previous: Map<string, SessionProcessInfo[]>,
  event: SessionProcessEvent,
): Map<string, SessionProcessInfo[]> {
  const next = new Map(previous)
  if (event.type === 'removed') {
    next.set(event.sessionId, (next.get(event.sessionId) ?? []).filter(row => row.processId !== event.processId))
    return next
  }
  // output 事件只更新输出缓冲（main 侧拉取模式），不影响记录列表
  if (event.type === 'output') return next

  const sessionId = event.process.sessionId
  const rows = [...(next.get(sessionId) ?? [])]
  if (event.type === 'registered') {
    // 同 processId 重复登记（如重试覆盖）：原位替换，否则插入
    const index = rows.findIndex(row => row.processId === event.process.processId)
    if (index >= 0) rows[index] = { ...event.process }
    else rows.push({ ...event.process })
  }
  else {
    const index = rows.findIndex(row => row.processId === event.process.processId)
    if (index >= 0) rows[index] = { ...rows[index], ...event.process }
    else rows.push({ ...event.process })
  }
  rows.sort(compareProcesses)
  next.set(sessionId, rows)
  return next
}
