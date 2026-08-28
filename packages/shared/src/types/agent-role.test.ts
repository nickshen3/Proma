/**
 * Agent 角色配置合并逻辑测试
 *
 * 内置角色可增删改（2026-08-28 需求变更），合并语义：
 * 磁盘版本优先、deletedBuiltinRoleIds 防复活、新装/新增内置以源码版本出现。
 */

import { describe, expect, test } from 'bun:test'
import {
  BUILTIN_AGENT_ROLES,
  BUILTIN_ROLE_RESEARCH,
  getDefaultAgentRoleConfig,
  mergeAgentRoleConfig,
} from './agent-role'

describe('getDefaultAgentRoleConfig', () => {
  test('默认配置包含全部 8 个内置角色', () => {
    const config = getDefaultAgentRoleConfig()
    expect(config.roles).toHaveLength(BUILTIN_AGENT_ROLES.length)
    expect(config.roles.every((role) => role.builtin)).toBe(true)
    expect(config.defaultRoleId).toBeUndefined()
    expect(config.deletedBuiltinRoleIds).toBeUndefined()
  })

  test('内置角色集包含新增的研发流程角色', () => {
    const ids = BUILTIN_AGENT_ROLES.map((role) => role.id)
    expect(ids).toContain('builtin-product-manager')
    expect(ids).toContain('builtin-frontend-engineer')
    expect(ids).toContain('builtin-backend-engineer')
    expect(ids).toContain('builtin-test-engineer')
    expect(ids).toContain('builtin-research')
    // 8 个内置角色颜色互不重复，便于选择器辨识
    const colors = new Set(BUILTIN_AGENT_ROLES.map((role) => role.color))
    expect(colors.size).toBe(BUILTIN_AGENT_ROLES.length)
  })
})

describe('mergeAgentRoleConfig', () => {
  test('非对象输入回退到仅内置角色的安全默认', () => {
    for (const raw of [undefined, null, 'x', 42, [], {}]) {
      const config = mergeAgentRoleConfig(raw)
      expect(config.roles.map((role) => role.id)).toEqual(BUILTIN_AGENT_ROLES.map((role) => role.id))
      expect(config.deletedBuiltinRoleIds ?? []).toEqual([])
    }
  })

  test('roles 非数组时回退安全默认', () => {
    const config = mergeAgentRoleConfig({ roles: 'not-an-array' })
    expect(config.roles).toHaveLength(BUILTIN_AGENT_ROLES.length)
  })

  test('磁盘上的内置角色修改被保留（不再源码覆盖）', () => {
    const config = mergeAgentRoleConfig({
      roles: [
        { ...BUILTIN_ROLE_RESEARCH, name: '我的研究员', systemPrompt: '自定义提示词', icon: 'bot', color: 'pink' },
      ],
    })
    const research = config.roles.find((role) => role.id === 'builtin-research')
    expect(research?.name).toBe('我的研究员')
    expect(research?.systemPrompt).toBe('自定义提示词')
    expect(research?.icon).toBe('bot')
    expect(research?.color).toBe('pink')
    expect(research?.builtin).toBe(true)
  })

  test('磁盘无记录且未删除的内置角色以源码版本出现（新装/新增内置）', () => {
    const config = mergeAgentRoleConfig({ roles: [] })
    const research = config.roles.find((role) => role.id === 'builtin-research')
    expect(research?.name).toBe('研究员')
    expect(research?.systemPrompt).toBe(BUILTIN_ROLE_RESEARCH.systemPrompt)
  })

  test('deletedBuiltinRoleIds 中的内置角色不出现（删除不复活）', () => {
    const config = mergeAgentRoleConfig({
      roles: [],
      deletedBuiltinRoleIds: ['builtin-research', 'builtin-test-engineer'],
    })
    expect(config.roles.find((role) => role.id === 'builtin-research')).toBeUndefined()
    expect(config.roles.find((role) => role.id === 'builtin-test-engineer')).toBeUndefined()
    expect(config.roles.find((role) => role.id === 'builtin-explore')).toBeDefined()
    // 删除记录原样保留（含在源码中的过滤）
    expect(config.deletedBuiltinRoleIds).toEqual(['builtin-research', 'builtin-test-engineer'])
  })

  test('deletedBuiltinRoleIds 中的未知 id 被清理（防垃圾积累）', () => {
    const config = mergeAgentRoleConfig({
      roles: [],
      deletedBuiltinRoleIds: ['no-such-builtin', 'builtin-research'],
    })
    expect(config.deletedBuiltinRoleIds).toEqual(['builtin-research'])
  })

  test('磁盘记录强制 builtin=true（防止手改 JSON 伪装成自定义角色）', () => {
    const config = mergeAgentRoleConfig({
      roles: [
        { ...BUILTIN_ROLE_RESEARCH, name: '伪装', systemPrompt: 'x', builtin: false },
      ],
    })
    const research = config.roles.find((role) => role.id === 'builtin-research')
    expect(research?.builtin).toBe(true)
    // 也不会重复出现在自定义分组
    expect(config.roles.filter((role) => !role.builtin)).toHaveLength(0)
  })

  test('合法自定义角色保留并按创建时间排序，内置在前', () => {
    const config = mergeAgentRoleConfig({
      roles: [
        { id: 'custom-b', name: 'B', systemPrompt: 'b', builtin: false, createdAt: 200 },
        { id: 'custom-a', name: 'A', systemPrompt: 'a', builtin: false, createdAt: 100 },
      ],
    })
    expect(config.roles.slice(0, BUILTIN_AGENT_ROLES.length).every((role) => role.builtin)).toBe(true)
    const custom = config.roles.filter((role) => !role.builtin)
    expect(custom.map((role) => role.id)).toEqual(['custom-a', 'custom-b'])
  })

  test('结构不合法的自定义角色被丢弃', () => {
    const config = mergeAgentRoleConfig({
      roles: [
        { id: '', name: '空 id', systemPrompt: 'x' },
        { id: 'no-name', systemPrompt: 'x' },
        { id: 'no-prompt', name: '没有提示词' },
        { name: 123, systemPrompt: 'x' },
        { id: 'valid', name: '合法', systemPrompt: 'ok', icon: 'not-an-icon', color: 'not-a-color' },
      ],
    })
    const custom = config.roles.filter((role) => !role.builtin)
    expect(custom.map((role) => role.id)).toEqual(['valid'])
    expect(custom[0]?.icon).toBeUndefined()
    expect(custom[0]?.color).toBeUndefined()
  })

  test('与内置 id 冲突或重复 id 的自定义角色被丢弃', () => {
    const config = mergeAgentRoleConfig({
      roles: [
        { id: 'builtin-research', name: '伪装内置', systemPrompt: 'x', builtin: false, createdAt: 1 },
        { id: 'dup', name: '第一个', systemPrompt: 'x', builtin: false, createdAt: 1 },
        { id: 'dup', name: '第二个', systemPrompt: 'x', builtin: false, createdAt: 2 },
      ],
    })
    const custom = config.roles.filter((role) => !role.builtin)
    expect(custom).toHaveLength(1)
    expect(custom[0]?.name).toBe('第一个')
  })

  test('defaultRoleId 指向有效角色时保留，指向禁用或不存在角色时清空', () => {
    const kept = mergeAgentRoleConfig({
      roles: [
        { ...BUILTIN_ROLE_RESEARCH },
        { id: 'custom-a', name: 'A', systemPrompt: 'a', builtin: false, createdAt: 1 },
      ],
      defaultRoleId: 'custom-a',
    })
    expect(kept.defaultRoleId).toBe('custom-a')

    const missing = mergeAgentRoleConfig({ roles: [], defaultRoleId: 'no-such-role' })
    expect(missing.defaultRoleId).toBeUndefined()

    const disabled = mergeAgentRoleConfig({
      roles: [{ ...BUILTIN_ROLE_RESEARCH, disabled: true }],
      defaultRoleId: 'builtin-research',
    })
    expect(disabled.defaultRoleId).toBeUndefined()
  })
})
