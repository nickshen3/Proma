/**
 * RoleSelector — 输入区角色选择器
 *
 * 徽章式 ghost 按钮 + DropdownMenu：
 * - 默认（主助手）/ 内置角色 / 自定义角色 三组；
 * - 「锁定到会话」：锁定后选择持久化到会话 meta，重启恢复；
 *   未锁定时选择仅对下一条消息生效，发送后自动回退默认；
 * - 「管理角色」打开管理对话框（创建/编辑/删除/禁用/重置内置）。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Bot, Check, Lock, LockOpen, Pencil, UserRound } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AGENT_ROLE_ICON_MAP,
  AGENT_ROLE_BADGE_CLASS,
} from './AgentRoleBadge'
import {
  agentRoleConfigAtom,
  sessionAgentRoleSelectionFamily,
  sessionAgentRoleLockFamily,
  sessionAgentRoleHydratedFamily,
} from '@/atoms/agent-role-atoms'
import { agentSessionsAtom } from '@/atoms/agent-atoms'
import { settingsOpenAtom, settingsTabAtom } from '@/atoms/settings-tab'
import { inputToolbarButtonClass } from '@/components/ai-elements/input-toolbar-styles'
import { cn } from '@/lib/utils'
import type { AgentRole } from '@proma/shared'

interface RoleSelectorProps {
  sessionId: string
}

export function RoleSelector({ sessionId }: RoleSelectorProps): React.ReactElement {
  const [config, setConfig] = useAtom(agentRoleConfigAtom)
  const [selection, setSelection] = useAtom(sessionAgentRoleSelectionFamily(sessionId))
  const [locked, setLocked] = useAtom(sessionAgentRoleLockFamily(sessionId))
  const [hydrated, setHydrated] = useAtom(sessionAgentRoleHydratedFamily(sessionId))
  const sessions = useAtomValue(agentSessionsAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const setSettingsTab = useSetAtom(settingsTabAtom)
  const [open, setOpen] = React.useState(false)

  // 打开下拉时刷新配置（管理对话框可能在其他会话/窗口改动过）
  const refreshConfig = React.useCallback((): void => {
    window.electronAPI.getAgentRoleConfig().then((cfg) => setConfig(cfg)).catch(console.error)
  }, [setConfig])

  // 首次挂载：从会话 meta 恢复锁定角色（重启恢复；不覆盖已 hydrate 的会话）
  React.useEffect(() => {
    if (hydrated) return
    setHydrated(true)
    const meta = sessions.find((item) => item.id === sessionId)
    if (meta?.lockedAgentRoleId) {
      setSelection(meta.lockedAgentRoleId)
      setLocked(true)
    }
  }, [hydrated, sessions, sessionId, setSelection, setLocked, setHydrated])

  const enabledRoles = config?.roles.filter((role) => !role.disabled) ?? []
  const groups = config?.groups ?? []
  const ungroupedRoles = enabledRoles.filter((role) => !role.groupId)
  const selectedRole = enabledRoles.find((role) => role.id === selection)

  /** 持久化/清除锁定的角色 */
  const persistLock = React.useCallback((roleId: string | undefined): void => {
    window.electronAPI.updateSessionAgentRoleLock(sessionId, roleId ?? null).catch((error) => {
      console.error('[RoleSelector] 持久化锁定角色失败:', error)
    })
  }, [sessionId])

  const selectRole = (roleId: string | undefined): void => {
    setSelection(roleId)
    if (locked) persistLock(roleId)
    setOpen(false)
  }

  const toggleLock = (): void => {
    const next = !locked
    setLocked(next)
    persistLock(next ? selection : undefined)
  }

  const renderRoleItem = (role: AgentRole): React.ReactElement => {
    const Icon = role.icon ? AGENT_ROLE_ICON_MAP[role.icon] : Bot
    return (
      <DropdownMenuItem
        key={role.id}
        onClick={() => selectRole(role.id)}
        className="gap-2"
      >
        <Icon className="size-4 shrink-0" />
        <span className="flex-1 truncate">{role.name}</span>
        {role.modelId && <span className="text-[10px] text-muted-foreground truncate max-w-28">{role.modelId}</span>}
        {selection === role.id && <Check className="size-3.5 shrink-0" />}
      </DropdownMenuItem>
    )
  }

  const TriggerIcon = selectedRole?.icon ? AGENT_ROLE_ICON_MAP[selectedRole.icon] : UserRound
  const badgeClass = (selectedRole?.color && AGENT_ROLE_BADGE_CLASS[selectedRole.color]) || AGENT_ROLE_BADGE_CLASS.slate

  return (
    <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (next) refreshConfig()
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={selectedRole ? `角色: ${selectedRole.name}` : '选择执行角色'}
            title={selectedRole
              ? `角色: ${selectedRole.name}${selectedRole.description ? ` — ${selectedRole.description}` : ''}${locked ? '（已锁定）' : ''}`
              : '选择执行角色'}
            className={cn(
              inputToolbarButtonClass,
              'gap-1 px-2',
              selectedRole && 'border',
              selectedRole && badgeClass,
            )}
          >
            <TriggerIcon className="size-[17px]" />
            {selectedRole && <span className="text-xs max-w-20 truncate">{selectedRole.name}</span>}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60 z-[60]">
          <DropdownMenuItem onClick={() => selectRole(undefined)} className="gap-2">
            <UserRound className="size-4 shrink-0" />
            <span className="flex-1">默认（主助手）</span>
            {!selection && <Check className="size-3.5 shrink-0" />}
          </DropdownMenuItem>

          {ungroupedRoles.length > 0 && (
            <>
              <DropdownMenuSeparator />
              {ungroupedRoles.map(renderRoleItem)}
            </>
          )}

          {groups.map((group) => {
            const groupRoles = enabledRoles.filter((role) => role.groupId === group.id)
            if (groupRoles.length === 0) return null
            return (
              <React.Fragment key={group.id}>
                <DropdownMenuSeparator />
                <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground/70">{group.name}</div>
                {groupRoles.map(renderRoleItem)}
              </React.Fragment>
            )
          })}

          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={toggleLock} className="gap-2">
            {locked ? <Lock className="size-4 shrink-0" /> : <LockOpen className="size-4 shrink-0" />}
            <span className="flex-1">{locked ? '已锁定：选择对本会话保持' : '锁定：选择对本会话保持'}</span>
            {locked && <Check className="size-3.5 shrink-0" />}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              setOpen(false)
              setSettingsTab('agent-roles')
              setSettingsOpen(true)
            }}
            className="gap-2"
          >
            <Pencil className="size-4 shrink-0" />
            <span className="flex-1">管理角色</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
  )
}
