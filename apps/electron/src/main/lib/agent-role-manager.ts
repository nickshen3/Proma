/**
 * Agent 角色管理服务
 *
 * 管理 Agent 会话的角色 CRUD 与持久化。
 * 存储在 ~/.proma/agent-roles.json（safe-file 原子写）。
 *
 * 内置角色与自定义角色同等可编辑可删除（2026-08-28 需求变更）；
 * 唯一差异：内置角色可「重置」回源码默认（单个或全部）。
 * 用户删除的内置角色 id 记录在 deletedBuiltinRoleIds，重启不复活。
 */

import { randomUUID } from 'node:crypto'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'
import { getAgentRolesPath } from './config-paths'
import { BUILTIN_AGENT_ROLES, mergeAgentRoleConfig } from '@proma/shared'
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

/** 更新角色（内置与自定义同等，均允许全字段；modelId 传 null 表示清除） */
export function updateAgentRole(input: AgentRoleUpdateInput): AgentRole {
  const config = getAgentRoleConfig()
  const role = config.roles.find((item) => item.id === input.id)
  if (!role) throw new Error(`角色不存在: ${input.id}`)

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

/**
 * 删除角色（内置与自定义均可删）。
 * 删除内置角色时记录到 deletedBuiltinRoleIds，重启后不被源码复活；
 * 重置内置角色可找回。默认角色被删时清空 defaultRoleId。
 */
export function deleteAgentRole(roleId: string): void {
  const config = getAgentRoleConfig()
  const index = config.roles.findIndex((item) => item.id === roleId)
  const target = index !== -1 ? config.roles[index] : undefined
  if (!target) throw new Error(`角色不存在: ${roleId}`)

  config.roles.splice(index, 1)
  if (target.builtin) {
    config.deletedBuiltinRoleIds = [
      ...(config.deletedBuiltinRoleIds ?? []).filter((id) => id !== roleId),
      roleId,
    ]
  }
  if (config.defaultRoleId === roleId) delete config.defaultRoleId
  persist(config)
}

/**
 * 重置内置角色为源码默认。
 * - 指定 roleId：恢复单个内置角色（清除用户修改，并从删除记录中找回）；
 * - 未指定：恢复全部内置角色（自定义角色不受影响）。
 */
export function resetBuiltinAgentRoles(roleId?: string): AgentRoleConfig {
  const config = getAgentRoleConfig()
  const builtinById = new Map(BUILTIN_AGENT_ROLES.map((role) => [role.id, role]))

  if (roleId) {
    const source = builtinById.get(roleId)
    if (!source) throw new Error(`内置角色不存在: ${roleId}`)
    // 恢复源码版本（保留 id 语义），从删除记录中移除
    const rest = config.roles.filter((item) => item.id !== roleId)
    const sourceIndex = BUILTIN_AGENT_ROLES.findIndex((role) => role.id === roleId)
    const insertBefore = rest.findIndex(
      (item) => item.builtin && BUILTIN_AGENT_ROLES.findIndex((role) => role.id === item.id) > sourceIndex,
    )
    const resetRole: AgentRole = { ...source, updatedAt: Date.now() }
    if (insertBefore === -1) {
      rest.push(resetRole)
    } else {
      rest.splice(insertBefore, 0, resetRole)
    }
    return persistAndReturn({
      roles: rest,
      ...(config.defaultRoleId ? { defaultRoleId: config.defaultRoleId } : {}),
      deletedBuiltinRoleIds: (config.deletedBuiltinRoleIds ?? []).filter((id) => id !== roleId),
    })
  }

  // 全量重置：自定义角色保留，内置全部恢复源码版本，清空删除记录
  const customRoles = config.roles.filter((item) => !item.builtin)
  return persistAndReturn({
    roles: [...BUILTIN_AGENT_ROLES.map((role) => ({ ...role })), ...customRoles],
    ...(config.defaultRoleId ? { defaultRoleId: config.defaultRoleId } : {}),
  })
}

/** 持久化并返回合并后的配置（读回以确保与 merge 语义一致） */
function persistAndReturn(config: AgentRoleConfig): AgentRoleConfig {
  persist(config)
  return getAgentRoleConfig()
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
