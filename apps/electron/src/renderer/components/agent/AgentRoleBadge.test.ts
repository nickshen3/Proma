/**
 * AgentRoleBadge 徽章展示解析测试
 *
 * 覆盖 FR-4：快照名兜底（角色被删/改名后历史回放仍能显示标识）、
 * 配置未加载兜底、主助手不渲染徽章。
 */

import { describe, expect, test } from 'bun:test'
import { resolveAgentRoleBadgeDisplay } from './AgentRoleBadge'

const ROLES = [
  { id: 'builtin-research', name: '研究员', icon: 'search' as const, color: 'blue', description: '调研' },
  { id: 'custom-1', name: 'SQL 优化专家' },
]

describe('resolveAgentRoleBadgeDisplay', () => {
  test('无 roleId 且无快照名时返回 null（主助手不显示徽章）', () => {
    expect(resolveAgentRoleBadgeDisplay(ROLES, undefined, undefined)).toBeNull()
  })

  test('正常路径：roleId 命中配置，返回名称/图标/颜色', () => {
    const display = resolveAgentRoleBadgeDisplay(ROLES, 'builtin-research', undefined)
    expect(display?.name).toBe('研究员')
    expect(display?.icon).toBe('search')
    expect(display?.color).toBe('blue')
    expect(display?.description).toBe('调研')
  })

  test('快照名优先：角色已改名后历史消息仍显示发送时刻的名字', () => {
    const display = resolveAgentRoleBadgeDisplay(ROLES, 'builtin-research', '旧名字')
    expect(display?.name).toBe('旧名字')
    // 图标颜色仍取自当前配置
    expect(display?.icon).toBe('search')
  })

  test('角色已删除且无快照名：roleId 无法命中时不渲染', () => {
    expect(resolveAgentRoleBadgeDisplay(ROLES, 'deleted-role', undefined)).toBeNull()
  })

  test('角色已删除但有快照名：仅靠快照渲染（无图标颜色）', () => {
    const display = resolveAgentRoleBadgeDisplay(ROLES, 'deleted-role', '已删角色')
    expect(display?.name).toBe('已删角色')
    expect(display?.icon).toBeUndefined()
    expect(display?.color).toBeUndefined()
  })

  test('配置未加载（roles undefined）时快照名仍可渲染', () => {
    const display = resolveAgentRoleBadgeDisplay(undefined, 'any-id', '快照名')
    expect(display?.name).toBe('快照名')
  })
})
