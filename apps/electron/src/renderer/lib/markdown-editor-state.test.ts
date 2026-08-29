import { afterEach, describe, expect, test } from 'bun:test'
import {
  clearMarkdownEditorStateCache,
  createMarkdownEditorCacheKey,
  createMarkdownEditorViewState,
  getMarkdownEditorViewState,
  setMarkdownEditorViewState,
  shouldPersistScrollPosition,
} from '@/lib/markdown-editor-state'

/**
 * Markdown 查看位置记忆（切 Tab / 关闭重开后恢复原位置）的数据层行为。
 * 组件层依赖这些语义：编辑态重挂载从 editorState.richScroll 恢复，
 * 只读预览从 scrollPositionCache 恢复，二者都以本模块的存取往返为基础。
 */

afterEach(() => {
  clearMarkdownEditorStateCache()
})

describe('Markdown 编辑状态存取往返', () => {
  test('given 编辑态滚动已保存 when 重挂载读取 then richScroll 与 previewScroll 完整保留', () => {
    const sessionId = 'scroll-restore-roundtrip'
    const cacheKey = createMarkdownEditorCacheKey({ filePath: 'docs/long.md', dirPath: 'D:/proj' })
    const state = createMarkdownEditorViewState('# 草稿', true)
    state.richScroll = { top: 3200, left: 0 }
    state.previewScroll = { top: 1200, left: 40 }
    setMarkdownEditorViewState(sessionId, cacheKey, state)

    const restored = getMarkdownEditorViewState(sessionId, cacheKey)
    expect(restored?.editing).toBeTrue()
    expect(restored?.richScroll).toEqual({ top: 3200, left: 0 })
    expect(restored?.previewScroll).toEqual({ top: 1200, left: 40 })
  })

  test('given 同一文件的不同路径表示 when 生成缓存 key then 归并为同一 identity', () => {
    const a = createMarkdownEditorCacheKey({ filePath: 'docs\\long.md', dirPath: 'D:\\proj' })
    const b = createMarkdownEditorCacheKey({ filePath: 'D:/proj/docs/long.md' })
    expect(a).toBe(b)
  })

  test('given 会话状态被清理 when 再次读取 then 返回 undefined 不残留旧位置', () => {
    const sessionId = 'scroll-restore-cleared'
    const cacheKey = createMarkdownEditorCacheKey({ filePath: 'notes.md' })
    setMarkdownEditorViewState(sessionId, cacheKey, createMarkdownEditorViewState('', true))

    clearMarkdownEditorStateCache()

    expect(getMarkdownEditorViewState(sessionId, cacheKey)).toBeUndefined()
  })
})

describe('滚动位置写入防污染', () => {
  test('given loading 占位使内容收缩到视口内 when 滚动事件触发 then 不应写入缓存', () => {
    expect(shouldPersistScrollPosition(600, 600)).toBeFalse()
    expect(shouldPersistScrollPosition(540, 600)).toBeFalse()
  })

  test('given 1px 舍入误差 when 内容几乎占满视口 then 仍不写入', () => {
    expect(shouldPersistScrollPosition(601, 600)).toBeFalse()
  })

  test('given 内容可正常滚动 when 滚动事件触发 then 允许写入', () => {
    expect(shouldPersistScrollPosition(4800, 600)).toBeTrue()
    expect(shouldPersistScrollPosition(1200, 800)).toBeTrue()
  })
})
