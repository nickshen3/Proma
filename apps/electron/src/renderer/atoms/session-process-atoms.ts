import { atom } from 'jotai'
import type { SessionProcessEvent, SessionProcessInfo } from '@proma/shared'

/**
 * 会话进程记录（命令进程部分，main 镜像）；键为 sessionId。
 * 终端记录不在此处：renderer 直接复用 agentTerminalTabsAtom 合成，保证单一数据源。
 */
export const agentProcessesAtom = atom<Map<string, SessionProcessInfo[]>>(new Map())

/** 排序：running 优先，组内 startedAt 倒序（最新在上）。 */
export function compareProcesses(a: SessionProcessInfo, b: SessionProcessInfo): number {
  const aRunning = a.status === 'running' ? 0 : 1
  const bRunning = b.status === 'running' ? 0 : 1
  if (aRunning !== bRunning) return aRunning - bRunning
  return b.startedAt - a.startedAt
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
