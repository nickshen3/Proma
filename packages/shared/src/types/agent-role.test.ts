/**
 * Agent 角色配置合并逻辑测试
 *
 * 覆盖：内置覆盖策略、自定义角色校验、损坏回退、defaultRoleId 校验。
 */

import { describe, expect, test } from 'bun:test'
import {
  BUILTIN_AGENT_ROLES,
  BUILTIN_ROLE_RESEARCH,
  getDefaultAgentRoleConfig,
  mergeAgentRoleConfig,
} from './agent-role'

describe('getDefaultAgentRoleConfig', () => {
  test('默认配置仅包含全部内置角色', () => {
    const config = getDefaultAgentRoleConfig()
    expect(config.roles).toHaveLength(BUILTIN_AGENT_ROLES.length)
    expect(config.roles.every((role) => role.builtin)).toBe(true)
    expect(config.defaultRoleId).toBeUndefined()
  })
})

describe('mergeAgentRoleConfig', () => {
  test('非对象输入回退到仅内置角色的安全默认', () => {
    for (const raw of [undefined, null, 'x', 42, [], {}]) {
      const config = mergeAgentRoleConfig(raw)
      expect(config.roles.map((role) => role.id)).toEqual(BUILTIN_AGENT_ROLES.map((role) => role.id))
    }
  })

  test('roles 非数组时回退安全默认', () => {
    const config = mergeAgentRoleConfig({ roles: 'not-an-array' })
    expect(config.roles).toHaveLength(BUILTIN_AGENT_ROLES.length)
  })

  test('内置角色内容以源码为准覆盖，仅保留用户的 disabled 状态', () => {
    const config = mergeAgentRoleConfig({
      roles: [
        // 用户磁盘上被篡改/旧版本的内置角色 + 禁用状态
        { ...BUILTIN_ROLE_RESEARCH, name: '被改坏的名字', systemPrompt: '旧版提示词', icon: 'bot', color: 'pink' },
        { ...BUILTIN_ROLE_RESEARCH, id: 'builtin-explore', name: '探索者', systemPrompt: 'x', disabled: true },
      ],
    })
    const research = config.roles.find((role) => role.id === 'builtin-research')
    expect(research?.name).toBe('研究员')
    expect(research?.systemPrompt).toBe(BUILTIN_ROLE_RESEARCH.systemPrompt)
    expect(research?.icon).toBe('search')
    expect(research?.disabled).toBeUndefined()

    const explore = config.roles.find((role) => role.id === 'builtin-explore')
    expect(explore?.disabled).toBe(true)
    // 覆盖后内容仍以源码为准
    expect(explore?.name).toBe('探索者')
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
    // 非法 icon/color 被剔除而不是透传
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
