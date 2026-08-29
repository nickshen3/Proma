import { describe, expect, test } from 'bun:test'
import { resolveTerminalCopyPasteAction } from './terminal-copy-keys'

interface KeyEventInit {
  type?: string
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
}

function keydown(init: KeyEventInit) {
  return {
    type: 'keydown',
    key: init.key,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
    ...('type' in init ? { type: init.type as string } : {}),
  }
}

describe('终端智能 Ctrl+C 复制判定', () => {
  test('Given 无选区按 Ctrl+C When 判定 Then 放行发送 ^C 中断', () => {
    expect(resolveTerminalCopyPasteAction(keydown({ key: 'c', ctrlKey: true }), false)).toBeNull()
  })

  test('Given 有选区按 Ctrl+C When 判定 Then 拦截为复制', () => {
    expect(resolveTerminalCopyPasteAction(keydown({ key: 'c', ctrlKey: true }), true)).toBe('copy')
  })

  test('Given mac 有选区按 Cmd+C When 判定 Then 拦截为复制；无选区放行', () => {
    expect(resolveTerminalCopyPasteAction(keydown({ key: 'c', metaKey: true }), true)).toBe('copy')
    expect(resolveTerminalCopyPasteAction(keydown({ key: 'c', metaKey: true }), false)).toBeNull()
  })

  test('Given 有选区按 Ctrl+Shift+C When 判定 Then 显式复制兜底；无选区放行', () => {
    expect(resolveTerminalCopyPasteAction(keydown({ key: 'C', ctrlKey: true, shiftKey: true }), true)).toBe('copy')
    expect(resolveTerminalCopyPasteAction(keydown({ key: 'C', ctrlKey: true, shiftKey: true }), false)).toBeNull()
  })
})

describe('终端显式粘贴兜底判定', () => {
  test('Given Ctrl+Shift+C/V 之外的 Ctrl+V When 判定 Then 放行走 xterm 原生 paste', () => {
    expect(resolveTerminalCopyPasteAction(keydown({ key: 'v', ctrlKey: true }), true)).toBeNull()
    expect(resolveTerminalCopyPasteAction(keydown({ key: 'v', ctrlKey: true }), false)).toBeNull()
  })

  test('Given Ctrl+Shift+V When 判定 Then 拦截为粘贴', () => {
    expect(resolveTerminalCopyPasteAction(keydown({ key: 'V', ctrlKey: true, shiftKey: true }), false)).toBe('paste')
  })

  test('Given mac Cmd+Shift+V When 判定 Then 拦截为粘贴', () => {
    expect(resolveTerminalCopyPasteAction(keydown({ key: 'V', metaKey: true, shiftKey: true }), false)).toBe('paste')
  })
})

describe('终端复制粘贴判定排除项', () => {
  test('Given keypress 事件 When 判定 Then 一律放行', () => {
    expect(resolveTerminalCopyPasteAction(
      keydown({ type: 'keypress', key: 'c', ctrlKey: true }),
      true,
    )).toBeNull()
  })

  test('Given 普通按键或其它修饰组合 When 判定 Then 一律放行', () => {
    expect(resolveTerminalCopyPasteAction(keydown({ key: 'c' }), true)).toBeNull()
    expect(resolveTerminalCopyPasteAction(keydown({ key: 'x', ctrlKey: true }), true)).toBeNull()
    expect(resolveTerminalCopyPasteAction(keydown({ key: 'c', ctrlKey: true, altKey: true }), true)).toBeNull()
    expect(resolveTerminalCopyPasteAction(keydown({ key: 'v', altKey: true, metaKey: true }), true)).toBeNull()
  })
})
