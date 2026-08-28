/**
 * Agent 角色管理服务测试
 *
 * 覆盖：CRUD 正常路径、内置角色保护、默认角色联动、损坏配置回退。
 * 使用临时 HOME 目录隔离 ~/.proma 配置。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { getAgentRolesPath } from './config-paths'

type AgentRoleManager = typeof import('./agent-role-manager')

let manager: AgentRoleManager
let tempHome: string
const originalHome = process.env.HOME
const originalUserProfile = process.env.USERPROFILE
const originalPromaDev = process.env.PROMA_DEV

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'proma-agent-role-'))
  process.env.HOME = tempHome
  process.env.USERPROFILE = tempHome
  // 对齐 agent-session-manager.test 的隔离模式：正式目录名，避免与其他测试文件的目录假设冲突
  process.env.PROMA_DEV = '0'
  manager = await import('./agent-role-manager')
})

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE
  } else {
    process.env.USERPROFILE = originalUserProfile
  }
  if (originalPromaDev === undefined) {
    delete process.env.PROMA_DEV
  } else {
    process.env.PROMA_DEV = originalPromaDev
  }
  if (tempHome) rmSync(tempHome, { recursive: true, force: true })
})

describe('createAgentRole', () => {
  test('创建自定义角色并持久化', () => {
    const role = manager.createAgentRole({
      name: '  SQL 优化专家  ',
      description: '专注 SQL 调优',
      systemPrompt: ' 你是 SQL 优化专家。 ',
      icon: 'wrench',
      color: 'amber',
    })
    expect(role.id).toBeTruthy()
    expect(role.builtin).toBe(false)
    expect(role.name).toBe('SQL 优化专家')
    expect(role.systemPrompt).toBe('你是 SQL 优化专家。')

    const onDisk = JSON.parse(readFileSync(getAgentRolesPath(), 'utf-8'))
    expect(onDisk.roles.some((item: { id: string }) => item.id === role.id)).toBe(true)
  })

  test('名称或提示词为空时抛错且不落盘', () => {
    const before = JSON.parse(readFileSync(getAgentRolesPath(), 'utf-8'))
    expect(() => manager.createAgentRole({ name: '  ', systemPrompt: 'x' })).toThrow()
    expect(() => manager.createAgentRole({ name: 'x', systemPrompt: '' })).toThrow()
    const after = JSON.parse(readFileSync(getAgentRolesPath(), 'utf-8'))
    expect(after.roles).toHaveLength(before.roles.length)
  })
})

describe('updateAgentRole', () => {
  test('自定义角色可更新全部可变字段，modelId=null 清除', () => {
    const role = manager.createAgentRole({ name: '初版', systemPrompt: 'v1', modelId: 'glm-5.3' })
    const updated = manager.updateAgentRole({
      id: role.id,
      name: '改名',
      systemPrompt: 'v2',
      description: '新描述',
      modelId: null,
      icon: 'book',
      color: 'pink',
      disabled: true,
    })
    expect(updated.name).toBe('改名')
    expect(updated.systemPrompt).toBe('v2')
    expect(updated.description).toBe('新描述')
    expect(updated.modelId).toBeUndefined()
    expect(updated.disabled).toBe(true)
  })

  test('内置角色同样允许全字段编辑（需求变更：与自定义同等）', () => {
    const updated = manager.updateAgentRole({
      id: 'builtin-research',
      name: '高级研究员',
      systemPrompt: '新提示词',
      description: '新职责',
      icon: 'book',
      color: 'pink',
      disabled: true,
    })
    expect(updated.name).toBe('高级研究员')
    expect(updated.systemPrompt).toBe('新提示词')
    expect(updated.builtin).toBe(true)

    // 重置回默认
    manager.resetBuiltinAgentRoles('builtin-research')
  })

  test('角色不存在时抛错', () => {
    expect(() => manager.updateAgentRole({ id: 'no-such-role', name: 'x' })).toThrow()
  })
})

describe('deleteAgentRole / resetBuiltinAgentRoles', () => {
  test('自定义角色可删除，删除后不再出现', () => {
    const role = manager.createAgentRole({ name: '待删', systemPrompt: 'x' })
    expect(() => manager.deleteAgentRole(role.id)).not.toThrow()
    expect(manager.getAgentRoleConfig().roles.find((item) => item.id === role.id)).toBeUndefined()
  })

  test('内置角色可删除且不复活；单角色重置可找回', () => {
    manager.deleteAgentRole('builtin-research')
    const afterDelete = manager.getAgentRoleConfig()
    expect(afterDelete.roles.find((item) => item.id === 'builtin-research')).toBeUndefined()
    expect(afterDelete.deletedBuiltinRoleIds).toContain('builtin-research')

    // 重启模拟：重新读盘后仍不复活
    expect(manager.getAgentRoleConfig().roles.find((item) => item.id === 'builtin-research')).toBeUndefined()

    // 单角色重置找回，恢复源码默认
    const afterReset = manager.resetBuiltinAgentRoles('builtin-research')
    const restored = afterReset.roles.find((item) => item.id === 'builtin-research')
    expect(restored?.name).toBe('研究员')
    expect(afterReset.deletedBuiltinRoleIds ?? []).not.toContain('builtin-research')
  })

  test('全量重置恢复全部内置且保留自定义与用户删除记录清空', () => {
    const custom = manager.createAgentRole({ name: '保持不变', systemPrompt: 'x' })
    manager.deleteAgentRole('builtin-explore')
    const beforeCustomCount = manager.getAgentRoleConfig().roles.filter((item) => !item.builtin).length
    const config = manager.resetBuiltinAgentRoles()
    expect(config.roles.find((item) => item.id === 'builtin-explore')?.name).toBe('探索者')
    expect(config.roles.find((item) => item.id === custom.id)?.name).toBe('保持不变')
    // 全部内置恢复 + 自定义数量不变（含本用例新建）
    expect(config.roles.filter((item) => item.builtin)).toHaveLength(8)
    expect(config.roles.filter((item) => !item.builtin)).toHaveLength(beforeCustomCount)
    expect(config.deletedBuiltinRoleIds ?? []).toEqual([])
  })

  test('重置不存在的内置角色 id 抛错', () => {
    expect(() => manager.resetBuiltinAgentRoles('no-such-builtin')).toThrow()
    expect(() => manager.resetBuiltinAgentRoles('custom-not-builtin')).toThrow()
  })
})

describe('buildAgentRolePromptSection', () => {
  test('包含角色名、职责与提示词，并声明不改变权限边界', () => {
    const section = manager.buildAgentRolePromptSection({
      id: 'x', name: '审阅者', description: '把关质量', systemPrompt: '聚焦正确性。',
      builtin: false, createdAt: 0, updatedAt: 0,
    })
    expect(section).toContain('## 执行角色')
    expect(section).toContain('「审阅者」')
    expect(section).toContain('把关质量')
    expect(section).toContain('聚焦正确性。')
    expect(section).toContain('不改变你的权限')
  })

  test('无描述时不输出空括号', () => {
    const section = manager.buildAgentRolePromptSection({
      id: 'x', name: '无描述角色', systemPrompt: '提示词',
      builtin: false, createdAt: 0, updatedAt: 0,
    })
    expect(section).not.toContain('（）')
    expect(section).toContain('「无描述角色」')
  })
})

describe('getAgentRoleConfig / resolveExecutableAgentRole', () => {
  test('配置不存在时返回全部内置角色的安全默认', () => {
    const config = manager.getAgentRoleConfig()
    expect(config.roles.filter((role) => role.builtin).map((role) => role.id)).toEqual([
      'builtin-product-manager',
      'builtin-frontend-engineer',
      'builtin-backend-engineer',
      'builtin-test-engineer',
      'builtin-research',
      'builtin-explore',
      'builtin-implement',
      'builtin-review',
    ])
  })

  test('resolveExecutableAgentRole：空 ID 与禁用角色返回 undefined', () => {
    expect(manager.resolveExecutableAgentRole(undefined)).toBeUndefined()
    expect(manager.resolveExecutableAgentRole('no-such-role')).toBeUndefined()
    expect(manager.resolveExecutableAgentRole('builtin-research')?.name).toBe('研究员')

    manager.updateAgentRole({ id: 'builtin-research', disabled: true })
    expect(manager.resolveExecutableAgentRole('builtin-research')).toBeUndefined()
    manager.updateAgentRole({ id: 'builtin-research', disabled: false })
  })

  test('磁盘主文件损坏时通过 .bak 恢复或回退安全默认，且后续写入合法', () => {
    const { writeFileSync, rmSync: rm } = require('node:fs') as typeof import('node:fs')
    const filePath = getAgentRolesPath()

    // 路径 1：主文件损坏，但 .bak 存在（前一次原子写留下的备份）→ 从备份恢复合法配置
    writeFileSync(filePath, '{broken json', 'utf-8')
    const recovered = manager.getAgentRoleConfig()
    expect(Array.isArray(recovered.roles)).toBe(true)
    expect(recovered.roles.length).toBeGreaterThan(0)

    // 路径 2：主文件、.tmp、.bak 全部缺失/损坏 → merge 回退仅内置角色的安全默认
    for (const suffix of ['', '.tmp', '.bak']) {
      try { rm(filePath + suffix, { force: true }) } catch { /* 忽略 */ }
    }
    writeFileSync(filePath, '{broken json', 'utf-8')
    const fallback = manager.getAgentRoleConfig()
    expect(fallback.roles.every((role) => role.builtin)).toBe(true)

    // 一次合法 CRUD 后文件恢复为合法 JSON
    manager.createAgentRole({ name: '恢复后', systemPrompt: 'ok' })
    expect(existsSync(filePath)).toBe(true)
    expect(() => JSON.parse(readFileSync(filePath, 'utf-8'))).not.toThrow()
  })
})
