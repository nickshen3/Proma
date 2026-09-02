import React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Circle, ExternalLink, Square } from 'lucide-react'
import { agentTerminalTabsAtom } from '@/atoms/agent-atoms'
import { agentProcessesAtom, buildProcessRows, type ChildSessionRef, type ProcessRow } from '@/atoms/session-process-atoms'
import { cn } from '@/lib/utils'

type StatusFilter = 'active' | 'all'

const STATUS_META: Record<ProcessRow['status'], { label: string; className: string }> = {
  running: { label: '运行中', className: 'text-emerald-500' },
  exited: { label: '已退出', className: 'text-muted-foreground' },
  killed: { label: '已终止', className: 'text-amber-500' },
}

function formatDuration(startedAt: number, endedAt?: number): string {
  const seconds = Math.max(0, Math.floor(((endedAt ?? Date.now()) - startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`
}

interface ProcessesPanelProps {
  sessionId: string
  /** 协作子 Agent / 探索分支：其进程聚合进当前面板（FR6.3 v2）。 */
  childSessions?: ChildSessionRef[]
  /** 跳转到终端独立 tab。 */
  onOpenTerminalTab?: (terminalId: string) => void
}

export function ProcessesPanel({ sessionId, childSessions = [], onOpenTerminalTab }: ProcessesPanelProps): React.ReactElement {
  const commandProcesses = useAtomValue(agentProcessesAtom)
  const setCommandProcesses = useSetAtom(agentProcessesAtom)
  const terminalTabs = useAtomValue(agentTerminalTabsAtom)
  const [filter, setFilter] = React.useState<StatusFilter>('active')
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [confirmingId, setConfirmingId] = React.useState<string | null>(null)
  const [, forceTick] = React.useReducer(count => count + 1, 0)

  // 挂载时全量拉取该会话的命令进程记录（事件流做增量）
  React.useEffect(() => {
    let cancelled = false
    void window.electronAPI.listSessionProcesses(sessionId).then((rows) => {
      if (cancelled) return
      setCommandProcesses((previous) => {
        const next = new Map(previous)
        next.set(sessionId, rows)
        return next
      })
    }).catch(console.error)
    return () => { cancelled = true }
  }, [sessionId, setCommandProcesses])

  // 运行时长实时递增（仅存在 running 记录时跳动）
  const hasRunning = React.useMemo(() => {
    const rows = commandProcesses.get(sessionId) ?? []
    return rows.some(row => row.status === 'running')
  }, [commandProcesses, sessionId])
  React.useEffect(() => {
    if (!hasRunning) return
    const timer = setInterval(forceTick, 1000)
    return () => clearInterval(timer)
  }, [hasRunning])

  const rows = React.useMemo<ProcessRow[]>(
    () => buildProcessRows(sessionId, commandProcesses, terminalTabs, childSessions, filter),
    [commandProcesses, terminalTabs, sessionId, childSessions, filter],
  )

  const selected = rows.find(row => row.processId === selectedId) ?? null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-3 py-1.5">
        <div className="flex items-center gap-1 rounded-md bg-muted p-0.5 text-xs">
          {(['active', 'all'] as const).map(value => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              className={cn(
                'rounded px-2 py-0.5 transition-colors',
                filter === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {value === 'active' ? '活跃' : '全部'}
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center text-xs text-muted-foreground">
          <p>此会话暂无进程</p>
          <p className="text-[11px]">Agent 执行命令或打开终端后将显示在这里</p>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" role="list">
          {rows.map(row => (
            <ProcessRowItem
              key={`${row.ownerSessionId}:${row.processId}`}
              row={row}
              selected={row.processId === selectedId}
              confirming={confirmingId === row.processId}
              onSelect={() => setSelectedId(current => (current === row.processId ? null : row.processId))}
              onKillRequest={() => setConfirmingId(row.processId)}
              onKillCancel={() => setConfirmingId(null)}
              onKillConfirm={() => {
                setConfirmingId(null)
                if (row.kind === 'terminal' && row.terminalId) {
                  void window.electronAPI.killTerminal(row.terminalId).catch(console.error)
                }
                else {
                  void window.electronAPI.killSessionProcess({ sessionId: row.ownerSessionId, processId: row.processId }).catch(console.error)
                }
              }}
              onOpenTerminalTab={onOpenTerminalTab}
            />
          ))}
        </ul>
      )}

      {selected && selected.kind === 'command' && (
        <ProcessOutputView
          sessionId={selected.ownerSessionId}
          processId={selected.processId}
          title={selected.title}
          pid={selected.pid}
        />
      )}
    </div>
  )
}

interface ProcessRowItemProps {
  row: ProcessRow
  selected: boolean
  confirming: boolean
  onSelect: () => void
  onKillRequest: () => void
  onKillCancel: () => void
  onKillConfirm: () => void
  onOpenTerminalTab?: (terminalId: string) => void
}

function ProcessRowItem({ row, selected, confirming, onSelect, onKillRequest, onKillCancel, onKillConfirm, onOpenTerminalTab }: ProcessRowItemProps): React.ReactElement {
  const meta = STATUS_META[row.status]
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onSelect()
          }
        }}
        className={cn(
          'group flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-muted/60',
          selected && 'bg-muted',
        )}
      >
        <Circle className={cn('size-2 shrink-0 fill-current', meta.className)} />
        <span className="min-w-0 flex-1 truncate" title={row.title}>
          {row.title}
          {row.ownerLabel && (
            <span className="ml-1.5 rounded bg-muted px-1 py-px align-middle text-[10px] text-muted-foreground">{row.ownerLabel}</span>
          )}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {row.kind === 'terminal'
            ? '终端'
            : row.status === 'running'
              ? formatDuration(row.startedAt)
              : row.status === 'exited' && row.exitCode !== undefined
                ? `退出码 ${row.exitCode}`
                : meta.label}
        </span>
        {row.status === 'running' && (
          confirming ? (
            <span className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                className="rounded bg-destructive px-1.5 py-0.5 text-[11px] text-destructive-foreground"
                onClick={(event) => { event.stopPropagation(); onKillConfirm() }}
              >
                确认终止?
              </button>
              <button
                type="button"
                className="rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                onClick={(event) => { event.stopPropagation(); onKillCancel() }}
              >
                取消
              </button>
            </span>
          ) : (
            <button
              type="button"
              title="终止进程"
              className="hidden shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive group-hover:block"
              onClick={(event) => { event.stopPropagation(); onKillRequest() }}
            >
              <Square className="size-3" />
            </button>
          )
        )}
      </div>
      {selected && row.kind === 'terminal' && row.terminalId && onOpenTerminalTab && (
        <div className="px-4 pb-2 pt-1">
          <button
            type="button"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => onOpenTerminalTab(row.terminalId!)}
          >
            <ExternalLink className="size-3" />
            在终端 tab 中打开
          </button>
        </div>
      )}
    </li>
  )
}

interface ProcessOutputViewProps {
  sessionId: string
  processId: string
  title: string
  pid?: number
}

/** 命令进程输出视图：展开时全量拉取，随后经事件流增量追加，默认跟随尾部。 */
function ProcessOutputView({ sessionId, processId, title, pid }: ProcessOutputViewProps): React.ReactElement {
  const [text, setText] = React.useState('')
  const [follow, setFollow] = React.useState(true)
  const offsetRef = React.useRef(0)
  const scrollRef = React.useRef<HTMLPreElement>(null)

  React.useEffect(() => {
    offsetRef.current = 0
    setText('')
    let cancelled = false
    void window.electronAPI.getSessionProcessOutput({ sessionId, processId, offset: 0 }).then((chunk) => {
      if (cancelled) return
      offsetRef.current = chunk.nextOffset
      setText(chunk.data)
    }).catch(console.error)
    return () => { cancelled = true }
  }, [sessionId, processId])

  React.useEffect(() => {
    const unsubscribe = window.electronAPI.onSessionProcessEvent((event) => {
      if (event.type !== 'output' || event.processId !== processId || event.sessionId !== sessionId) return
      setText(previous => (previous + event.data).slice(-200_000))
    })
    return unsubscribe
  }, [sessionId, processId])

  React.useEffect(() => {
    if (follow && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [text, follow])

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t">
      <div className="flex items-start justify-between gap-2 px-3 py-1">
        <span className="min-w-0 flex-1 break-all text-[11px] leading-4 text-muted-foreground">
          {title}
          {pid !== undefined ? ` · PID ${pid}` : ''}
        </span>
        <button
          type="button"
          className={cn('shrink-0 rounded px-1.5 py-0.5 text-[11px] hover:bg-muted', follow ? 'text-foreground' : 'text-muted-foreground')}
          onClick={() => setFollow(value => !value)}
        >
          {follow ? '跟随中' : '已暂停'}
        </button>
      </div>
      <pre
        ref={scrollRef}
        className="min-h-24 flex-1 overflow-auto bg-muted/40 px-3 py-2 font-mono text-[11px] leading-4 whitespace-pre-wrap text-foreground/90"
      >
        {text || '(暂无输出)'}
      </pre>
    </div>
  )
}
