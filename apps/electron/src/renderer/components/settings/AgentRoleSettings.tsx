/**
 * AgentRoleSettings - Agent 角色管理设置页
 *
 * 上方：角色列表（内置/自定义分组，选择/新建/删除/启停）
 * 下方：编辑区（名称 + 职责 + 提示词 + 默认模型 + 图标 + 颜色；内置只读）
 * 顶部说明：角色决定一条消息由谁执行，不改变权限边界。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { toast } from 'sonner'
import { FolderPlus, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingsSection, SettingsCard } from './primitives'
import { AGENT_ROLE_ICON_MAP } from '@/components/agent/AgentRoleBadge'
import { agentRoleConfigAtom } from '@/atoms/agent-role-atoms'
import { cn } from '@/lib/utils'
import type { AgentRole, AgentRoleColor, AgentRoleGroup, AgentRoleIcon } from '@proma/shared'

const COLOR_OPTIONS: readonly AgentRoleColor[] = ['blue', 'green', 'violet', 'orange', 'pink', 'cyan', 'amber', 'slate']
const COLOR_SWATCH: Record<AgentRoleColor, string> = {
  blue: 'bg-blue-500',
  green: 'bg-green-500',
  violet: 'bg-violet-500',
  orange: 'bg-orange-500',
  pink: 'bg-pink-500',
  cyan: 'bg-cyan-500',
  amber: 'bg-amber-500',
  slate: 'bg-slate-500',
}

/** 表单草稿：id 为空表示新建 */
interface RoleDraft {
  id: string
  name: string
  description: string
  systemPrompt: string
  modelId: string
  icon: AgentRoleIcon
  color: AgentRoleColor
  disabled: boolean
  /** 所属分组：空串 = 未分组 */
  groupId: string
}

const NEW_DRAFT: RoleDraft = {
  id: '',
  name: '',
  description: '',
  systemPrompt: '',
  modelId: '',
  icon: 'bot',
  color: 'blue',
  disabled: false,
  groupId: '',
}

function toDraft(role: AgentRole): RoleDraft {
  return {
    id: role.id,
    name: role.name,
    description: role.description ?? '',
    systemPrompt: role.systemPrompt,
    modelId: role.modelId ?? '',
    icon: role.icon ?? 'bot',
    color: role.color ?? 'slate',
    disabled: role.disabled === true,
    groupId: role.groupId ?? '',
  }
}

export function AgentRoleSettings(): React.ReactElement {
  const [config, setConfig] = useAtom(agentRoleConfigAtom)
  const [draft, setDraft] = React.useState<RoleDraft | null>(null)
  const [saving, setSaving] = React.useState(false)

  const refresh = React.useCallback((): void => {
    window.electronAPI.getAgentRoleConfig().then((cfg) => setConfig(cfg)).catch(console.error)
  }, [setConfig])

  React.useEffect(() => {
    refresh()
  }, [refresh])

  const startCreate = (): void => setDraft({ ...NEW_DRAFT })

  const startEdit = (role: AgentRole): void => setDraft(toDraft(role))

  /** 分组名编辑态（重命名） */
  const [renamingGroup, setRenamingGroup] = React.useState<{ id: string; name: string } | null>(null)

  const createGroup = async (): Promise<void> => {
    try {
      const group = await window.electronAPI.createAgentRoleGroup({ name: '新分组' })
      refresh()
      setRenamingGroup({ id: group.id, name: group.name })
    } catch (error) {
      toast.error('创建分组失败', { description: error instanceof Error ? error.message : String(error) })
    }
  }

  const renameGroup = async (): Promise<void> => {
    if (!renamingGroup) return
    try {
      await window.electronAPI.updateAgentRoleGroup({ id: renamingGroup.id, name: renamingGroup.name })
      setRenamingGroup(null)
      refresh()
    } catch (error) {
      toast.error('重命名失败', { description: error instanceof Error ? error.message : String(error) })
    }
  }

  const removeGroup = async (group: AgentRoleGroup): Promise<void> => {
    try {
      await window.electronAPI.deleteAgentRoleGroup(group.id)
      toast.success(`已删除分组「${group.name}」（组内角色归入未分组）`)
      refresh()
    } catch (error) {
      toast.error('删除分组失败', { description: error instanceof Error ? error.message : String(error) })
    }
  }

  const saveDraft = async (): Promise<void> => {
    if (!draft) return
    if (!draft.name.trim() || !draft.systemPrompt.trim()) {
      toast.error('名称与提示词不能为空')
      return
    }
    setSaving(true)
    try {
      if (draft.id === '') {
        const created = await window.electronAPI.createAgentRole({
          name: draft.name,
          description: draft.description || undefined,
          systemPrompt: draft.systemPrompt,
          modelId: draft.modelId || undefined,
          icon: draft.icon,
          color: draft.color,
          ...(draft.groupId ? { groupId: draft.groupId } : {}),
        })
        toast.success(`已创建角色「${draft.name.trim()}」`)
        refresh()
        // 立即进入新角色的编辑态，便于继续完善
        setDraft({ ...toDraft(created) })
      } else {
        // 内置与自定义同等：均允许全字段编辑
        await window.electronAPI.updateAgentRole({
          id: draft.id,
          name: draft.name,
          description: draft.description,
          systemPrompt: draft.systemPrompt,
          modelId: draft.modelId || null,
          icon: draft.icon,
          color: draft.color,
          disabled: draft.disabled || undefined,
          groupId: draft.groupId || null,
        })
        toast.success(`已保存角色「${draft.name.trim()}」`)
        refresh()
      }
    } catch (error) {
      toast.error('保存失败', { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setSaving(false)
    }
  }

  const removeRole = async (role: AgentRole): Promise<void> => {
    try {
      await window.electronAPI.deleteAgentRole(role.id)
      toast.success(`已删除角色「${role.name}」${role.builtin ? '（可在「重置内置角色」找回）' : ''}`)
      if (draft?.id === role.id) setDraft(null)
      refresh()
    } catch (error) {
      toast.error('删除失败', { description: error instanceof Error ? error.message : String(error) })
    }
  }

  const resetOneBuiltin = async (): Promise<void> => {
    if (!draft?.id) return
    try {
      const next = await window.electronAPI.resetBuiltinAgentRoles(draft.id)
      setConfig(next)
      toast.success('已重置为源码默认')
      const restored = next.roles.find((role) => role.id === draft.id)
      if (restored) setDraft(toDraft(restored))
    } catch (error) {
      toast.error('重置失败', { description: error instanceof Error ? error.message : String(error) })
    }
  }

  const resetBuiltin = async (): Promise<void> => {
    try {
      const next = await window.electronAPI.resetBuiltinAgentRoles()
      setConfig(next)
      toast.success('已重置全部内置角色')
    } catch (error) {
      toast.error('重置失败', { description: error instanceof Error ? error.message : String(error) })
    }
  }

  const builtinRoles = config?.roles.filter((role) => role.builtin) ?? []
  const customRoles = config?.roles.filter((role) => !role.builtin) ?? []
  const editingBuiltin = draft ? (config?.roles.find((role) => role.id === draft.id)?.builtin ?? false) : false
  const groups = config?.groups ?? []
  const allRoles = config?.roles ?? []

  const renderRoleRow = (role: AgentRole): React.ReactElement => {
    const Icon = role.icon ? AGENT_ROLE_ICON_MAP[role.icon] : undefined
    return (
      <div
        key={role.id}
        className={cn(
          'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer transition-colors',
          draft?.id === role.id ? 'bg-accent' : 'hover:bg-accent/50',
          role.disabled && 'opacity-50',
        )}
        onClick={() => startEdit(role)}
      >
        {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" />}
        <span className="flex-1 truncate">{role.name}</span>
        {role.builtin && <span className="text-[10px] text-muted-foreground shrink-0">内置</span>}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          aria-label={`删除角色 ${role.name}`}
          onClick={(event) => {
            event.stopPropagation()
            void removeRole(role)
          }}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    )
  }

  const renderGroupSection = (group: AgentRoleGroup): React.ReactElement | null => {
    const groupRoles = allRoles.filter((role) => role.groupId === group.id)
    return (
      <div key={group.id} className="flex flex-col gap-0.5">
        <div className="group/head flex items-center gap-1 pt-1 px-2">
          {renamingGroup?.id === group.id ? (
            <>
              <Input
                autoFocus
                value={renamingGroup.name}
                onChange={(event) => setRenamingGroup({ ...renamingGroup, name: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void renameGroup()
                  if (event.key === 'Escape') setRenamingGroup(null)
                }}
                className="h-5 px-1 text-[11px]"
              />
              <Button
                type="button"
                variant="ghost" size="icon" className="size-5"
                aria-label="确认重命名"
                onClick={() => void renameGroup()}
              >
                <Pencil className="size-2.5" />
              </Button>
            </>
          ) : (
            <>
              <span className="text-[11px] font-medium text-muted-foreground/70 flex-1 truncate">{group.name}</span>
              <button
                type="button"
                aria-label={`重命名分组 ${group.name}`}
                className="opacity-0 group-hover/head:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                onClick={() => setRenamingGroup({ id: group.id, name: group.name })}
              >
                <Pencil className="size-3" />
              </button>
              <button
                type="button"
                aria-label={`删除分组 ${group.name}`}
                className="opacity-0 group-hover/head:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                onClick={() => void removeGroup(group)}
              >
                <Trash2 className="size-3" />
              </button>
            </>
          )}
        </div>
        {groupRoles.map(renderRoleRow)}
      </div>
    )
  }

  const ungroupedRoles = allRoles.filter((role) => !role.groupId)

  return (
    <SettingsSection title="Agent 角色" description="角色决定一条消息由谁执行（提示词 + 默认模型），在会话输入框的角色选择器中使用。内置与自定义角色同等可编辑可删除，内置角色可随时重置回默认；角色不改变权限边界。">
      <div className="flex gap-4">
        {/* 左侧列表 */}
        <div className="w-56 shrink-0 flex flex-col gap-2">
          <SettingsCard className="p-2">
            <ScrollArea className="h-[420px]">
              <div className="flex flex-col gap-1 pr-2">
                <button
                  type="button"
                  onClick={startCreate}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                >
                  <Plus className="size-4" />
                  新建角色
                </button>
                {ungroupedRoles.length > 0 && (
                  <div className="pt-1 text-[11px] font-medium text-muted-foreground/70 px-2">未分组</div>
                )}
                {ungroupedRoles.map(renderRoleRow)}
                {groups.map(renderGroupSection)}
              </div>
            </ScrollArea>
          </SettingsCard>
          <div className="flex flex-col gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="justify-start gap-2 text-muted-foreground"
              onClick={() => void createGroup()}
            >
              <FolderPlus className="size-3.5" />
              新建分组
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="justify-start gap-2 text-muted-foreground"
              onClick={() => void resetBuiltin()}
            >
              <RotateCcw className="size-3.5" />
              重置内置角色
            </Button>
          </div>
        </div>

        {/* 右侧编辑区 */}
        <SettingsCard className="flex-1 min-w-0 p-4 overflow-y-auto max-h-[480px]">
          {!draft ? (
            <div className="flex h-full min-h-[240px] items-center justify-center text-sm text-muted-foreground">
              选择左侧角色查看或编辑，或新建角色
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="agent-role-group">所属分组</Label>
                {/* Radix Select 不允许空 value，用哨兵值表示未分组 */}
                <Select
                  value={draft.groupId || '__none__'}
                  onValueChange={(value) => setDraft({ ...draft, groupId: value === '__none__' ? '' : value })}
                >
                  <SelectTrigger id="agent-role-group" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">未分组</SelectItem>
                    {groups.map((group) => (
                      <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="agent-role-name">名称</Label>
                  <Input
                    id="agent-role-name"
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    placeholder="如：SQL 优化专家"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="agent-role-model">默认模型（可选）</Label>
                  <Input
                    id="agent-role-model"
                    value={draft.modelId}
                    onChange={(event) => setDraft({ ...draft, modelId: event.target.value })}
                    placeholder="留空沿用会话当前模型"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="agent-role-desc">职责描述</Label>
                <Input
                  id="agent-role-desc"
                  value={draft.description}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                  placeholder="一句话说明该角色适合做什么"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="agent-role-prompt">角色提示词</Label>
                <Textarea
                  id="agent-role-prompt"
                  value={draft.systemPrompt}
                  onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })}
                  placeholder="注入本轮消息的角色提示词：职责、工作方式、边界"
                  className="min-h-32 text-xs"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label>图标</Label>
                    <div className="flex flex-wrap gap-1">
                      {(Object.keys(AGENT_ROLE_ICON_MAP) as AgentRoleIcon[]).map((key) => {
                        const Icon = AGENT_ROLE_ICON_MAP[key]
                        return (
                          <button
                            key={key}
                            type="button"
                            aria-label={`图标 ${key}`}
                            onClick={() => setDraft({ ...draft, icon: key })}
                            className={cn(
                              'flex size-7 items-center justify-center rounded-md border transition-colors',
                              draft.icon === key ? 'border-foreground/40 bg-accent' : 'border-transparent hover:bg-accent/50',
                            )}
                          >
                            <Icon className="size-4" />
                          </button>
                        )
                      })}
                    </div>
                  </div>
                <div className="flex flex-col gap-1.5">
                  <Label>标识色</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {COLOR_OPTIONS.map((key) => (
                      <button
                        key={key}
                        type="button"
                        aria-label={`颜色 ${key}`}
                        onClick={() => setDraft({ ...draft, color: key })}
                        className={cn(
                          'size-6 rounded-full border-2 transition-transform',
                          COLOR_SWATCH[key],
                          draft.color === key ? 'border-foreground/60 scale-110' : 'border-transparent',
                        )}
                      />
                    ))}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between rounded-md border px-3 py-2">
                <div className="flex flex-col">
                  <span className="text-sm">启用该角色</span>
                  <span className="text-xs text-muted-foreground">禁用后不出现在选择器，已有消息徽章不受影响</span>
                </div>
                <Switch
                  checked={!draft.disabled}
                  onCheckedChange={(checked) => setDraft({ ...draft, disabled: !checked })}
                />
              </div>

              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {editingBuiltin ? '内置角色：与自定义同等可编辑可删除，可随时重置回源码默认' : ''}
                </span>
                <div className="flex gap-2">
                  {editingBuiltin && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => void resetOneBuiltin()}
                      className="gap-1.5"
                    >
                      <RotateCcw className="size-3.5" />
                      重置为默认
                    </Button>
                  )}
                  <Button type="button" onClick={() => void saveDraft()} disabled={saving}>
                    {draft.id === '' ? '创建' : '保存'}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </SettingsCard>
      </div>
    </SettingsSection>
  )
}
