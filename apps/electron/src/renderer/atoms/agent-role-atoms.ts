/**
 * Agent 角色 atoms
 *
 * - agentRoleConfigAtom：角色配置缓存（懒加载，CRUD 后刷新）
 * - sessionAgentRoleSelectionFamily：每会话当前选择的角色 ID（消息级，不跨消息记忆）
 * - sessionAgentRoleLockFamily：每会话"锁定角色"开关（锁定后选择随会话 meta 持久化恢复）
 *
 * 选择语义：
 * - 未锁定：发送一条消息后选择自动清空（回退主助手）
 * - 锁定：选择保持，并写入会话 meta.lockedAgentRoleId 以便重启恢复
 */

import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type { AgentRoleConfig } from '@proma/shared'
import { getDefaultAgentRoleConfig } from '@proma/shared'

/** 角色配置缓存；null 表示尚未加载（组件层懒加载 GET_CONFIG） */
export const agentRoleConfigAtom = atom<AgentRoleConfig | null>(null)

/** 每会话当前选择的角色 ID；undefined = 主助手（默认） */
export const sessionAgentRoleSelectionFamily = atomFamily((sessionId: string) =>
  atom<string | undefined>(undefined),
)

/** 每会话"锁定角色"开关 */
export const sessionAgentRoleLockFamily = atomFamily((sessionId: string) =>
  atom<boolean>(false),
)

/** 会话角色选择是否已从 meta 恢复过（避免覆盖用户当前操作） */
export const sessionAgentRoleHydratedFamily = atomFamily((sessionId: string) =>
  atom<boolean>(false),
)

/** 兜底配置（主进程不可用时给选择器一个安全空态） */
export const AGENT_ROLE_FALLBACK_CONFIG: AgentRoleConfig = getDefaultAgentRoleConfig()
