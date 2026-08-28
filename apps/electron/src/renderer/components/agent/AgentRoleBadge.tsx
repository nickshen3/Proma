/**
 * AgentRoleBadge — 消息流中的角色徽章
 *
 * 优先使用消息上持久化的角色名快照（角色被删除/改名后仍能显示），
 * 名称缺失时按 roleId 查配置兜底；两者都没有则不渲染（主助手不显示徽章）。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import {
  Search, Compass, Code2, ShieldCheck, Bot, BookOpen, Wrench, Sparkles, User,
} from 'lucide-react'
import type { AgentRoleIcon } from '@proma/shared'
import { agentRoleConfigAtom } from '@/atoms/agent-role-atoms'
import { cn } from '@/lib/utils'

/** 角色 icon key → lucide 图标（受控枚举，防任意组件注入） */
export const AGENT_ROLE_ICON_MAP: Record<AgentRoleIcon, React.ComponentType<{ className?: string }>> = {
  search: Search,
  compass: Compass,
  code: Code2,
  'shield-check': ShieldCheck,
  bot: Bot,
  book: BookOpen,
  wrench: Wrench,
  sparkles: Sparkles,
  user: User,
}

/** 角色标识色 → 徽章样式（含深浅主题适配） */
export const AGENT_ROLE_BADGE_CLASS: Record<string, string> = {
  blue: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/25',
  green: 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/25',
  violet: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/25',
  orange: 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/25',
  pink: 'bg-pink-500/10 text-pink-600 dark:text-pink-400 border-pink-500/25',
  cyan: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/25',
  amber: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25',
  slate: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/25',
}

interface AgentRoleBadgeProps {
  /** 角色 ID（优先用快照名渲染） */
  agentRoleId?: string
  /** 发送时刻的角色名快照（历史回放兜底） */
  agentRoleName?: string
  className?: string
}

/** 徽章展示信息：优先角色名快照，配置缺失/角色被删时仍能渲染 */
export interface AgentRoleBadgeDisplay {
  name: string
  icon?: AgentRoleIcon
  color?: string
  description?: string
}

/**
 * 解析徽章展示信息（纯函数）：
 * 1. 无 roleId 且无快照名 → null（主助手不显示徽章）；
 * 2. 快照名优先（历史回放时角色已删/改名仍能显示）；
 * 3. 名称缺失但配置命中 roleId 时用配置名兑底。
 */
export function resolveAgentRoleBadgeDisplay(
  roles: ReadonlyArray<{ id: string; name: string; icon?: AgentRoleIcon; color?: string; description?: string }> | undefined,
  agentRoleId: string | undefined,
  agentRoleName: string | undefined,
): AgentRoleBadgeDisplay | null {
  if (!agentRoleId && !agentRoleName) return null
  const role = agentRoleId ? roles?.find((item) => item.id === agentRoleId) : undefined
  const name = agentRoleName ?? role?.name
  if (!name) return null
  return {
    name,
    ...(role?.icon ? { icon: role.icon } : {}),
    ...(role?.color ? { color: role.color } : {}),
    ...(role?.description ? { description: role.description } : {}),
  }
}

export function AgentRoleBadge({ agentRoleId, agentRoleName, className }: AgentRoleBadgeProps): React.ReactElement | null {
  const config = useAtomValue(agentRoleConfigAtom)

  const display = resolveAgentRoleBadgeDisplay(config?.roles, agentRoleId, agentRoleName)
  if (!display) return null

  const Icon = display.icon ? AGENT_ROLE_ICON_MAP[display.icon] : undefined
  const badgeClass = (display.color && AGENT_ROLE_BADGE_CLASS[display.color]) || AGENT_ROLE_BADGE_CLASS.slate

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium leading-tight',
        badgeClass,
        className,
      )}
      title={`角色: ${display.name}${display.description ? ` — ${display.description}` : ''}`}
    >
      {Icon && <Icon className="size-3" />}
      {display.name}
    </span>
  )
}
