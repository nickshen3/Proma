/**
 * Agent 角色管理服务
 *
 * 管理 Agent 会话的角色 CRUD 与持久化。
 * 存储在 ~/.proma/agent-roles.json（safe-file 原子写）。
 *
 * 与系统提示词预设（system-prompt-manager）的差异：
 * - 写入统一走 writeJsonFileAtomic 原子写；
 * - 内置角色内容永远以 shared 源码为准（mergeAgentRoleConfig），
 *   磁盘仅持久化自定义角色、内置角色的 disabled 状态与默认角色 ID。
 */

import { randomUUID } from 'node:crypto'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'
import { getAgentRolesPath } from './config-paths'
import { mergeAgentRoleConfig } from '@proma/shared'
import type {
  AgentRole,
  AgentRoleConfig,
  AgentRoleCreateInput,
  AgentRoleUpdateInput,
} from '@proma/shared'

/** 读取合并后的角色配置（内置以源码为准；磁盘损坏时回退仅内置） */
export function getAgentRoleConfig(): AgentRoleConfig {
  return mergeAgentRoleConfig(readJsonFileSafe<unknown>(getAgentRolesPath()))
}

/** 持久化当前配置（仅写磁盘需要的最小信息，内置内容读时以源码覆盖） */
function persist(config: AgentRoleConfig): void {
  writeJsonFileAtomic(getAgentRolesPath(), config)
}

/** 校验角色必填字段；返回修剪后的值或抛错 */
function validateCreateInput(input: AgentRoleCreateInput): { name: string; systemPrompt: string } {
  const name = input.name?.trim()
  const systemPrompt = input.systemPrompt?.trim()
  if (!name) throw new Error('角色名称不能为空')
  if (!systemPrompt) throw new Error('角色提示词不能为空')
  return { name, systemPrompt }
}

/** 创建自定义角色 */
export function createAgentRole(input: AgentRoleCreateInput): AgentRole {
  const { name, systemPrompt } = validateCreateInput(input)
  const config = getAgentRoleConfig()
  const now = Date.now()
  const role: AgentRole = {
    id: randomUUID(),
    name,
    systemPrompt,
    builtin: false,
    createdAt: now,
    updatedAt: now,
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    ...(input.modelId?.trim() ? { modelId: input.modelId.trim() } : {}),
    ...(input.icon ? { icon: input.icon } : {}),
    ...(input.color ? { color: input.color } : {}),
  }
  config.roles.push(role)
  persist(config)
  return role
}

/** 更新角色（内置角色仅允许 disabled；modelId 传 null 表示清除） */
export function updateAgentRole(input: AgentRoleUpdateInput): AgentRole {
  const config = getAgentRoleConfig()
  const role = config.roles.find((item) => item.id === input.id)
  if (!role) throw new Error(`角色不存在: ${input.id}`)

  if (role.builtin) {
    if (input.disabled !== undefined) role.disabled = input.disabled || undefined
    persist(config)
    return role
  }

  if (input.name !== undefined) {
    const name = input.name.trim()
    if (!name) throw new Error('角色名称不能为空')
    role.name = name
  }
  if (input.systemPrompt !== undefined) {
    const systemPrompt = input.systemPrompt.trim()
    if (!systemPrompt) throw new Error('角色提示词不能为空')
    role.systemPrompt = systemPrompt
  }
  if (input.description !== undefined) {
    const description = input.description.trim()
    role.description = description || undefined
  }
  if (input.modelId !== undefined) {
    if (input.modelId === null || input.modelId.trim() === '') {
      delete role.modelId
    } else {
      role.modelId = input.modelId.trim()
    }
  }
  if (input.icon !== undefined) role.icon = input.icon
  if (input.color !== undefined) role.color = input.color
  if (input.disabled !== undefined) role.disabled = input.disabled || undefined
  role.updatedAt = Date.now()
  persist(config)
  return role
}

/** 删除自定义角色（内置角色不可删除；默认角色被删时清空 defaultRoleId） */
export function deleteAgentRole(roleId: string): void {
  const config = getAgentRoleConfig()
  const index = config.roles.findIndex((item) => item.id === roleId)
  const target = index !== -1 ? config.roles[index] : undefined
  if (!target) throw new Error(`角色不存在: ${roleId}`)
  if (target.builtin) throw new Error('内置角色不可删除')

  config.roles.splice(index, 1)
  if (config.defaultRoleId === roleId) delete config.defaultRoleId
  persist(config)
}

/** 重置全部内置角色为源码默认状态（清除 disabled；自定义角色不受影响） */
export function resetBuiltinAgentRoles(): AgentRoleConfig {
  const config = getAgentRoleConfig()
  const nextRoles: AgentRole[] = config.roles.map((role) =>
    role.builtin ? { ...role, disabled: undefined } : role,
  )
  const next: AgentRoleConfig = { roles: nextRoles, ...(config.defaultRoleId ? { defaultRoleId: config.defaultRoleId } : {}) }
  persist(next)
  return next
}

/**
 * 按 ID 查找可执行角色（存在且未禁用）。
 * 返回 undefined 表示“主助手”或角色不可用（调用方据此降级执行）。
 */
export function resolveExecutableAgentRole(roleId: string | undefined): AgentRole | undefined {
  if (!roleId) return undefined
  const role = getAgentRoleConfig().roles.find((item) => item.id === roleId)
  if (!role || role.disabled) return undefined
  return role
}

/**
 * 构建注入 systemPromptAppend 的角色提示词段（纯函数）。
 * 角色不改变权限边界：仅注入人格与职责约定。
 */
export function buildAgentRolePromptSection(role: AgentRole): string {
  const description = role.description?.trim()
  return [
    '',
    '## 执行角色',
    '',
    `本轮消息由「${role.name}」角色执行${description ? `（${description}）` : ''}。`,
    '',
    role.systemPrompt.trim(),
    '',
    '角色只约束工作方式与职责边界，不改变你的权限与安全规则；会话历史中的其他角色产出同样可信可用。',
    '',
  ].join('\n')
}
