/**
 * SettingsSearchBox - 设置快速搜索输入框
 *
 * 放在设置左侧导航顶部（「通用设置」上方）。
 * 键盘行为：↑/↓ 在结果间移动，Enter 跳转，Esc 清空搜索。
 * 过滤与高亮逻辑见 @/lib/settings-search，由 SettingsPanel 持有状态。
 */

import * as React from 'react'
import { Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface SettingsSearchBoxProps {
  /** 当前搜索词 */
  value: string
  /** 匹配的标签页数量；未搜索时传 null 不展示 */
  resultCount: number | null
  /** 搜索词变化 */
  onChange: (value: string) => void
  /** ↑/↓ 键移动结果高亮 */
  onNavigate: (direction: 1 | -1) => void
  /** Enter 键跳转当前高亮结果 */
  onEnter: () => void
}

export function SettingsSearchBox({
  value,
  resultCount,
  onChange,
  onNavigate,
  onEnter,
}: SettingsSearchBoxProps): React.ReactElement {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      onNavigate(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      onNavigate(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onEnter()
    } else if (e.key === 'Escape') {
      // 仅清空搜索，不冒泡给 SettingsPanel 的 Esc 关闭逻辑
      e.preventDefault()
      e.stopPropagation()
      onChange('')
    }
  }

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="搜索设置…"
        aria-label="搜索设置"
        spellCheck={false}
        className={cn(
          'h-8 w-full rounded-md border border-border/70 bg-background/60 pl-8 pr-16',
          'text-[13px] text-foreground outline-none transition-colors',
          'placeholder:text-muted-foreground/70',
          'focus:border-primary/60 focus:bg-background',
        )}
      />
      <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
        {resultCount !== null && (
          <span className="text-[11px] leading-none text-muted-foreground/80">
            {resultCount} 项
          </span>
        )}
        {value !== '' && (
          <button
            type="button"
            aria-label="清空搜索"
            onClick={() => onChange('')}
            className="flex size-4 items-center justify-center rounded-sm text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        )}
      </div>
    </div>
  )
}
