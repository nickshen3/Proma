/**
 * Agent 角色类型定义
 *
 * "角色"是用户可感知、可选择、可自定义的 agent 人格预设：
 * 名称 + 图标 + 颜色 + 职责描述 + 系统提示词追加段 + 默认模型（可选）。
 * 内置角色由应用源码分发（升级时内容以源码为准，仅保留用户禁用状态）；
 * 自定义角色由用户 CRUD，存储在 ~/.proma/agent-roles.json。
 *
 * 角色不改变权限边界：执行权限始终沿用会话 permissionMode。
 */

/** 角色图标（受控枚举，renderer 映射到 lucide 图标，避免任意路径） */
export type AgentRoleIcon =
  | 'search'
  | 'compass'
  | 'code'
  | 'shield-check'
  | 'bot'
  | 'book'
  | 'wrench'
  | 'sparkles'
  | 'user'

/** 角色标识色（受控枚举，renderer 映射到主题安全色板） */
export type AgentRoleColor =
  | 'blue'
  | 'green'
  | 'violet'
  | 'orange'
  | 'pink'
  | 'cyan'
  | 'amber'
  | 'slate'

/** Agent 角色 */
export interface AgentRole {
  /** 唯一标识 */
  id: string
  /** 展示名 */
  name: string
  /** 一句话职责描述（选择器 tooltip 与管理列表使用） */
  description?: string
  /** 角色提示词追加段（拼入本轮 systemPromptAppend） */
  systemPrompt: string
  /** 默认模型 ID；缺省沿用会话当前模型 */
  modelId?: string
  /** 图标 key */
  icon?: AgentRoleIcon
  /** 标识色 key */
  color?: AgentRoleColor
  /** 内置角色：内容随源码升级覆盖；不可删除、不可改内容，可禁用 */
  builtin: boolean
  /** 是否禁用（禁用后不出现在选择器，不参与执行） */
  disabled?: boolean
  /** 创建时间 */
  createdAt: number
  /** 更新时间 */
  updatedAt: number
}

/** 角色配置（存储在 ~/.proma/agent-roles.json） */
export interface AgentRoleConfig {
  /** 角色列表（内置在前，按源码顺序；自定义按创建时间） */
  roles: AgentRole[]
  /** 全局默认角色 ID；缺省 = 主助手（无角色，现状行为） */
  defaultRoleId?: string
}

/** 创建角色输入 */
export interface AgentRoleCreateInput {
  name: string
  description?: string
  systemPrompt: string
  modelId?: string
  icon?: AgentRoleIcon
  color?: AgentRoleColor
}

/** 更新角色输入（内置角色仅允许 disabled） */
export interface AgentRoleUpdateInput {
  id: string
  name?: string
  description?: string
  systemPrompt?: string
  modelId?: string | null
  icon?: AgentRoleIcon
  color?: AgentRoleColor
  disabled?: boolean
}

/** 内置角色：研究员（对齐 AgentDelegationRole 'research'） */
export const BUILTIN_ROLE_RESEARCH: AgentRole = {
  id: 'builtin-research',
  name: '研究员',
  description: '检索调研、多源对比、给出带证据的结论',
  systemPrompt: `你是专注研究与信息综合的角色。

- 优先使用检索工具获取最新事实，区分一手来源与转述；结论标注证据与出处。
- 不确定的内容明确标注不确定，不编造。
- 对比类问题给出结构化对比与适用场景建议。
- 不修改任何项目文件；需要动手实现时提醒用户切换到工程师角色。`,
  icon: 'search',
  color: 'blue',
  builtin: true,
  createdAt: 0,
  updatedAt: 0,
}

/** 内置角色：探索者（对齐 AgentDelegationRole 'explore'） */
export const BUILTIN_ROLE_EXPLORE: AgentRole = {
  id: 'builtin-explore',
  name: '探索者',
  description: '只读侦察代码库与方案结构，输出关键路径与风险',
  systemPrompt: `你是只读探索/侦察角色，负责快速摸清代码库或方案结构。

- 只读：不创建、不修改、不删除任何文件。
- 优先输出：目标位置、调用关系与数据流、关键约束、风险点。
- 结尾给出下一步建议（实现路径、需要确认的问题）。
- 按结论先行、细节可展开的方式组织回答，控制篇幅。`,
  icon: 'compass',
  color: 'cyan',
  builtin: true,
  createdAt: 0,
  updatedAt: 0,
}

/** 内置角色：工程师（对齐 AgentDelegationRole 'implement'） */
export const BUILTIN_ROLE_IMPLEMENT: AgentRole = {
  id: 'builtin-implement',
  name: '工程师',
  description: '写代码、跑测试、最小改动交付',
  systemPrompt: `你是实现导向的工程角色。

- 先明确目标行为与最小改动方案再动手。
- 遵循所在项目的工程约定（AGENTS.md 等）。
- 改完运行最小相关测试与类型检查，报告验证结果。
- 保持改动聚焦，不顺手重构无关代码；需要先调研时建议切换到研究员或探索者。`,
  icon: 'code',
  color: 'green',
  builtin: true,
  createdAt: 0,
  updatedAt: 0,
}

/** 内置角色：审阅者（对齐 AgentDelegationRole 'review'） */
export const BUILTIN_ROLE_REVIEW: AgentRole = {
  id: 'builtin-review',
  name: '审阅者',
  description: '审代码与方案：正确性、边界、回归风险把关',
  systemPrompt: `你是质量把关的审阅角色。

- 聚焦：正确性、边界条件、回归风险、安全与性能。
- 只指出有依据的问题，按严重程度排序，避免风格化吹毛求疵。
- 每个问题给出具体位置与修复建议。
- 不直接修改文件，输出审阅意见（除非用户明确要求代改）。`,
  icon: 'shield-check',
  color: 'violet',
  builtin: true,
  createdAt: 0,
  updatedAt: 0,
}

/** 全部内置角色（顺序即选择器展示顺序） */
export const BUILTIN_AGENT_ROLES: readonly AgentRole[] = [
  BUILTIN_ROLE_RESEARCH,
  BUILTIN_ROLE_EXPLORE,
  BUILTIN_ROLE_IMPLEMENT,
  BUILTIN_ROLE_REVIEW,
]

/** Agent 角色 IPC 通道常量 */
export const AGENT_ROLE_IPC_CHANNELS = {
  /** 获取完整角色配置 */
  GET_CONFIG: 'agent-role:get-config',
  /** 创建角色 */
  CREATE: 'agent-role:create',
  /** 更新角色 */
  UPDATE: 'agent-role:update',
  /** 删除角色 */
  DELETE: 'agent-role:delete',
  /** 重置内置角色（用源码内容覆盖，仅保留 disabled） */
  RESET_BUILTIN: 'agent-role:reset-builtin',
  /** 主进程通知 Renderer：角色配置已变更 */
  CONFIG_UPDATED: 'agent-role:config-updated',
} as const

/** 未知/损坏输入回退用的默认配置（仅内置角色） */
export function getDefaultAgentRoleConfig(): AgentRoleConfig {
  return { roles: BUILTIN_AGENT_ROLES.map((role) => ({ ...role })) }
}

function isValidAgentRoleIcon(value: unknown): value is AgentRoleIcon {
  return (
    value === 'search' || value === 'compass' || value === 'code' || value === 'shield-check' ||
    value === 'bot' || value === 'book' || value === 'wrench' || value === 'sparkles' || value === 'user'
  )
}

function isValidAgentRoleColor(value: unknown): value is AgentRoleColor {
  return (
    value === 'blue' || value === 'green' || value === 'violet' || value === 'orange' ||
    value === 'pink' || value === 'cyan' || value === 'amber' || value === 'slate'
  )
}

/** 结构校验：宽松解析未知 JSON 为合法 AgentRole；不合法返回 undefined */
function coerceAgentRole(value: unknown): AgentRole | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id.length === 0) return undefined
  if (typeof record.name !== 'string' || record.name.trim().length === 0) return undefined
  if (typeof record.systemPrompt !== 'string' || record.systemPrompt.trim().length === 0) return undefined
  const role: AgentRole = {
    id: record.id,
    name: record.name.trim(),
    systemPrompt: record.systemPrompt.trim(),
    builtin: record.builtin === true,
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
  }
  if (typeof record.description === 'string' && record.description.trim().length > 0) {
    role.description = record.description.trim()
  }
  if (typeof record.modelId === 'string' && record.modelId.length > 0) {
    role.modelId = record.modelId
  }
  if (isValidAgentRoleIcon(record.icon)) role.icon = record.icon
  if (isValidAgentRoleColor(record.color)) role.color = record.color
  if (record.disabled === true) role.disabled = true
  return role
}

/**
 * 合并磁盘配置与内置角色（纯函数，main 与测试共用）。
 *
 * - 磁盘中的内置角色：全部字段以源码为准覆盖，仅保留用户的 disabled 状态；
 *   id 对不上源码的疑似内置项（id 以 builtin- 开头但源码已移除）直接丢弃；
 * - 磁盘中的自定义角色：结构校验通过即保留；
 * - defaultRoleId 不存在（或指向被禁用角色）时清空；
 * - 任何结构问题都回退为"仅内置角色"的安全默认，不抛出。
 */
export function mergeAgentRoleConfig(raw: unknown): AgentRoleConfig {
  const fallback = getDefaultAgentRoleConfig()
  if (typeof raw !== 'object' || raw === null) return fallback
  const record = raw as Record<string, unknown>
  if (!Array.isArray(record.roles)) return fallback

  const parsed = record.roles
    .map((item) => coerceAgentRole(item))
    .filter((item): item is AgentRole => item !== undefined)

  // 自定义角色：去掉与内置 id 冲突的项与 id 重复项，按创建时间稳定排序
  const builtinIds = new Set(BUILTIN_AGENT_ROLES.map((role) => role.id))
  const seenIds = new Set<string>()
  const customRoles: AgentRole[] = []
  for (const role of parsed) {
    if (role.builtin || builtinIds.has(role.id) || seenIds.has(role.id)) continue
    seenIds.add(role.id)
    customRoles.push(role)
  }
  customRoles.sort((a, b) => a.createdAt - b.createdAt)

  // 内置角色：源码为准，保留磁盘上的 disabled
  const disabledById = new Map(
    parsed.filter((role) => builtinIds.has(role.id) && role.disabled).map((role) => [role.id, true]),
  )
  const mergedBuiltin = BUILTIN_AGENT_ROLES.map((role) => ({
    ...role,
    ...(disabledById.get(role.id) ? { disabled: true } : {}),
  }))

  const roles = [...mergedBuiltin, ...customRoles]

  // defaultRoleId 校验：必须指向存在且未禁用的角色
  let defaultRoleId: string | undefined
  if (typeof record.defaultRoleId === 'string') {
    const target = roles.find((role) => role.id === record.defaultRoleId)
    if (target && !target.disabled) defaultRoleId = target.id
  }

  return { roles, ...(defaultRoleId ? { defaultRoleId } : {}) }
}
