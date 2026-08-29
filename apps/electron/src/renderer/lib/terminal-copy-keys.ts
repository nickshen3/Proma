/**
 * 终端复制/粘贴按键判定
 *
 * TerminalTabContent 的 CustomKeyEventHandler 用它决定是否拦截按键：
 * 拦截返回 'copy' / 'paste'，放行返回 null。纯逻辑无副作用，便于单测。
 */

/** CustomKeyEventHandler 收到的键盘事件最小结构 */
export interface TerminalKeyEventShape {
  type: string
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/** 拦截动作：复制选区 / 显式粘贴 */
export type TerminalCopyPasteAction = 'copy' | 'paste'

/**
 * 判定终端按键是否应被拦截为复制/粘贴。
 *
 * 规则与 VS Code / Windows Terminal 的智能 Ctrl+C 对齐：
 * - Ctrl+C / Cmd+C：仅当终端有选区时视为复制；无选区放行，
 *   让 ^C 正常发送给 PTY 触发中断（SIGINT）。
 * - Ctrl+Shift+C：有选区时的无歧义显式复制兜底。
 * - Ctrl+Shift+V / Cmd+Shift+V：显式粘贴兜底；
 *   Ctrl+V / Cmd+V 不拦截，继续走 xterm 原生 paste 通道。
 */
export function resolveTerminalCopyPasteAction(
  event: TerminalKeyEventShape,
  hasSelection: boolean,
): TerminalCopyPasteAction | null {
  // 只在 keydown 拦截；keypress 等合成事件放行交给 xterm
  if (event.type !== 'keydown') return null

  const primary = event.ctrlKey || event.metaKey
  if (!primary || event.altKey) return null

  if (event.key === 'c' || event.key === 'C') {
    // 无选区时一律放行：智能 Ctrl+C 保持中断语义，Ctrl+Shift+C 不劫持普通输入
    return hasSelection ? 'copy' : null
  }
  if (event.key === 'v' || event.key === 'V') {
    return event.shiftKey ? 'paste' : null
  }
  return null
}
