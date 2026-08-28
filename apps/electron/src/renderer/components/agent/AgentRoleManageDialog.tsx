/**
 * AgentRoleManageDialog — 角色管理对话框
 *
 * 列表 + 表单：
 * - 自定义角色：创建 / 编辑 / 删除；
 * - 内置角色：只读（内容随源码升级），仅允许启用/禁用与重置；
 * - 图标与颜色从受控枚举中选择，防止任意内容注入。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { toast } from 'sonner'
import { Plus, RotateCcw, Trash2 } from 'lucide-react'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { ScrollArea } from '@/components/ui/scroll-area'
import { AGENT_ROLE_ICON_MAP } from './AgentRoleBadge'
import { agentRoleConfigAtom } from '@/atoms/agent-role-atoms'
import { cn } from '@/lib/utils'
import type { AgentRole, AgentRoleColor, AgentRoleIcon } from '@proma/shared'

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

/** 表单草稿：与 AgentRole 字段一一对应（id 为空表示新建） */
interface RoleDraft {
  id: string
  name: string
  description: string
  systemPrompt: string
  modelId: string
  icon: AgentRoleIcon
  color: AgentRoleColor
  disabled: boolean
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
  }
}

interface AgentRoleManageDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}

export function AgentRoleManageDialog({ open, onOpenChange, onChanged }: AgentRoleManageDialogProps): React.ReactElement {
  const [config, setConfig] = useAtom(agentRoleConfigAtom)
  const [draft, setDraft] = React.useState<RoleDraft | null>(null)
  const [saving, setSaving] = React.useState(false)

  const refresh = React.useCallback((): void => {
    window.electronAPI.getAgentRoleConfig().then((cfg) => setConfig(cfg)).catch(console.error)
  }, [setConfig])

  React.useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  const closeForm = (): void => setDraft(null)

  const startCreate = (): void => setDraft({ ...NEW_DRAFT })

  const startEdit = (role: AgentRole): void => setDraft(toDraft(role))

  const saveDraft = async (): Promise<void> => {
    if (!draft) return
    if (!draft.name.trim() || !draft.systemPrompt.trim()) {
      toast.error('名称与提示词不能为空')
      return
    }
    setSaving(true)
    try {
      if (draft.id === '') {
        await window.electronAPI.createAgentRole({
          name: draft.name,
          description: draft.description || undefined,
          systemPrompt: draft.systemPrompt,
          modelId: draft.modelId || undefined,
          icon: draft.icon,
          color: draft.color,
        })
        toast.success(`已创建角色「${draft.name.trim()}」`)
        // 新建后停留在表单但切换到该角色编辑态，便于继续完善
        refresh()
        onChanged()
      } else {
        const existing = config?.roles.find((role) => role.id === draft.id)
        if (existing?.builtin) {
          // 内置角色仅允许 disabled
          await window.electronAPI.updateAgentRole({ id: draft.id, disabled: draft.disabled || undefined })
        } else {
          await window.electronAPI.updateAgentRole({
            id: draft.id,
            name: draft.name,
            description: draft.description,
            systemPrompt: draft.systemPrompt,
            modelId: draft.modelId || null,
            icon: draft.icon,
            color: draft.color,
            disabled: draft.disabled || undefined,
          })
        }
        toast.success(`已保存角色「${draft.name.trim()}」`)
        refresh()
        onChanged()
      }
      closeForm()
    } catch (error) {
      toast.error('保存失败', { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setSaving(false)
    }
  }

  const removeRole = async (role: AgentRole): Promise<void> => {
    if (role.builtin) return
    try {
      await window.electronAPI.deleteAgentRole(role.id)
      toast.success(`已删除角色「${role.name}」`)
      if (draft?.id === role.id) closeForm()
      refresh()
      onChanged()
    } catch (error) {
      toast.error('删除失败', { description: error instanceof Error ? error.message : String(error) })
    }
  }

  const resetBuiltin = async (): Promise<void> => {
    try {
      const next = await window.electronAPI.resetBuiltinAgentRoles()
      setConfig(next)
      onChanged()
      toast.success('已重置全部内置角色')
    } catch (error) {
      toast.error('重置失败', { description: error instanceof Error ? error.message : String(error) })
    }
  }

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
        {!role.builtin && (
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
        )}
      </div>
    )
  }

  const builtinRoles = config?.roles.filter((role) => role.builtin) ?? []
  const customRoles = config?.roles.filter((role) => !role.builtin) ?? []
  const editingBuiltin = draft ? (config?.roles.find((role) => role.id === draft.id)?.builtin ?? false) : false

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle>管理 Agent 角色</DialogTitle>
          <DialogDescription>
            角色决定一条消息由谁执行（提示词 + 默认模型）；不改变权限边界。内置角色内容随应用升级更新，可禁用。
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 border-t">
          {/* 左侧列表 */}
          <div className="w-56 shrink-0 border-r p-2 flex flex-col gap-1 overflow-hidden">
            <ScrollArea className="flex-1">
              <div className="flex flex-col gap-1 pr-2">
                <button
                  type="button"
                  onClick={startCreate}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                >
                  <Plus className="size-4" />
                  新建角色
                </button>
                {builtinRoles.length > 0 && (
                  <div className="pt-1 text-[11px] font-medium text-muted-foreground/70 px-2">内置</div>
                )}
                {builtinRoles.map(renderRoleRow)}
                {customRoles.length > 0 && (
                  <div className="pt-1 text-[11px] font-medium text-muted-foreground/70 px-2">自定义</div>
                )}
                {customRoles.map(renderRoleRow)}
              </div>
            </ScrollArea>
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

          {/* 右侧表单 */}
          <div className="flex-1 min-w-0 p-4 overflow-y-auto">
            {!draft ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                选择左侧角色查看或编辑，或新建角色
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="agent-role-name">名称</Label>
                    <Input
                      id="agent-role-name"
                      value={draft.name}
                      disabled={editingBuiltin}
                      onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                      placeholder="如：SQL 优化专家"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="agent-role-model">默认模型（可选）</Label>
                    <Input
                      id="agent-role-model"
                      value={draft.modelId}
                      disabled={editingBuiltin}
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
                    disabled={editingBuiltin}
                    onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                    placeholder="一句话说明该角色适合做什么"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="agent-role-prompt">角色提示词</Label>
                  {editingBuiltin ? (
                    <ScrollArea className="h-32 rounded-md border bg-muted/30 p-3">
                      <pre className="whitespace-pre-wrap font-sans text-xs text-muted-foreground">{draft.systemPrompt}</pre>
                    </ScrollArea>
                  ) : (
                    <Textarea
                      id="agent-role-prompt"
                      value={draft.systemPrompt}
                      onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })}
                      placeholder="注入本轮消息的角色提示词：职责、工作方式、边界"
                      className="min-h-32 text-xs"
                    />
                  )}
                </div>

                {!editingBuiltin && (
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
                )}

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
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="border-t px-5 py-3">
          <div className="flex w-full items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {editingBuiltin ? '内置角色内容随应用升级更新，仅可调整启用状态' : ''}
            </span>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={closeForm}>取消</Button>
              {draft && draft.id === '' && (
                <Button type="button" onClick={() => void saveDraft()} disabled={saving}>创建</Button>
              )}
              {draft && draft.id !== '' && (
                <Button
                  type="button"
                  onClick={editingBuiltin ? () => void toggleBuiltinDisabledAndSave() : () => void saveDraft()}
                  disabled={saving}
                >
                  {editingBuiltin ? '保存启用状态' : '保存'}
                </Button>
              )}
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  /** 内置角色的保存仅提交 disabled（与 saveDraft 内部分支一致，单独函数以便按钮文案区分） */
  async function toggleBuiltinDisabledAndSave(): Promise<void> {
    await saveDraft()
  }
}
