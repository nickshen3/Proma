import { Tray, Menu, app, dialog, nativeImage, BrowserWindow } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { listAgentSessions } from './lib/agent-session-manager'
import { listAgentWorkspaces } from './lib/agent-workspace-manager'
import { isAgentSessionActive, agentSessionProcessService } from './lib/agent-service'
import { getActiveTerminalCount } from './lib/terminal-service'
import { createTrayMenuModel, type TrayRecentSessionItem } from './lib/tray-menu-model'

let tray: Tray | null = null

export interface TrayActions {
  showMainWindow: () => void
  openAgentSession: (sessionId: string, title: string) => void
  createChatSession: () => void
  createAgentSession: () => void
  onTrayMouseEnter?: (bounds: Electron.Rectangle) => void
  onTrayMouseMove?: (bounds: Electron.Rectangle) => void
  onTrayMouseLeave?: () => void
}

let flashTimer: ReturnType<typeof setInterval> | null = null

function clearTrayFlashTimer(): void {
  if (flashTimer) {
    clearInterval(flashTimer)
    flashTimer = null
  }
}

/**
 * 获取托盘图标路径
 * 所有平台统一使用 Template 图标（PNG）
 */
function getTrayIconPath(): string {
  // dev: __dirname/resources（build:resources 拷贝产物）
  // prod: process.resourcesPath（electron-builder extraResources 产物）
  const resourcesDir = app.isPackaged
    ? join(process.resourcesPath, 'proma-logos')
    : join(__dirname, 'resources/proma-logos')
  return join(resourcesDir, 'iconTemplate.png')
}

/** 显示主窗口 */
function showMainWindow(): void {
  const windows = BrowserWindow.getAllWindows()
  if (windows.length === 0) return
  const mainWindow = windows[0]!
  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  mainWindow.show()
  mainWindow.focus()
}

function getDefaultTrayActions(): TrayActions {
  return {
    showMainWindow,
    openAgentSession: () => showMainWindow(),
    createChatSession: () => showMainWindow(),
    createAgentSession: () => showMainWindow(),
  }
}

function createRecentSessionMenuItem(
  item: TrayRecentSessionItem,
  actions: TrayActions,
): Electron.MenuItemConstructorOptions {
  return {
    label: item.title,
    sublabel: item.subtitle,
    click: () => actions.openAgentSession(item.id, item.title),
  }
}

function buildTrayMenu(actions: TrayActions): Menu {
  const sessions = listAgentSessions()
  const runningSessionIds = new Set(
    sessions
      .filter((session) => isAgentSessionActive(session.id))
      .map((session) => session.id)
  )
  const model = createTrayMenuModel(sessions, listAgentWorkspaces(), runningSessionIds)
  const runningItems = model.runningSessions.map((item) => createRecentSessionMenuItem(item, actions))
  const recentItems = model.recentSessions.map((item) => createRecentSessionMenuItem(item, actions))
  const moreItems = model.moreSessions.map((item) => createRecentSessionMenuItem(item, actions))

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(runningItems.length > 0
      ? [
          { label: '运行中', enabled: false },
          ...runningItems,
          { type: 'separator' as const },
        ]
      : []),
    { label: '最近', enabled: false },
    ...(recentItems.length > 0
      ? recentItems
      : [{ label: '暂无最近会话', enabled: false }]),
    ...(moreItems.length > 0
      ? [{
          label: '更多',
          submenu: moreItems,
        }]
      : []),
    { type: 'separator' },
    {
      label: '新建对话',
      click: () => actions.createChatSession(),
    },
    {
      label: '新建 Agent 会话',
      click: () => actions.createAgentSession(),
    },
    { type: 'separator' },
    {
      label: '打开 Proma',
      click: () => actions.showMainWindow(),
    },
    { type: 'separator' },
    {
      label: '退出 Proma',
      click: () => {
        void confirmQuitWithRunningProcesses().then((confirmed) => {
          if (confirmed) app.quit()
        })
      },
    },
  ]

  return Menu.buildFromTemplate(template)
}

/**
 * 退出前检查运行中的会话进程（命令进程 + 终端），
 * 存在时弹原生确认框；无进程或用户确认终止时返回 true。
 */
async function confirmQuitWithRunningProcesses(): Promise<boolean> {
  const commandCount = agentSessionProcessService.countRunningProcesses()
  const terminalCount = getActiveTerminalCount()
  const total = commandCount + terminalCount
  if (total === 0) return true

  const parts: string[] = []
  if (commandCount > 0) parts.push(`${commandCount} 个命令进程`)
  if (terminalCount > 0) parts.push(`${terminalCount} 个终端`)

  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const options = {
    type: 'warning' as const,
    title: '退出 Proma',
    message: `当前有 ${parts.join('、')}正在运行。`,
    detail: '退出 Proma 将终止这些进程。是否继续退出？',
    buttons: ['取消', '终止进程并退出'],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
  }
  const result = window && !window.isDestroyed()
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options)
  return result.response === 1
}

function updateTrayMenu(actions: TrayActions): Menu | null {
  if (!tray) return null
  const contextMenu = buildTrayMenu(actions)
  tray.setContextMenu(contextMenu)
  return contextMenu
}

/**
 * 创建系统托盘图标和菜单
 */
export function createTray(actionsInput?: Partial<TrayActions>): Tray | null {
  const iconPath = getTrayIconPath()
  const actions = { ...getDefaultTrayActions(), ...actionsInput }
  const hasIcon = existsSync(iconPath)

  if (!hasIcon && process.platform !== 'win32') {
    console.warn('Tray icon not found at:', iconPath)
    return null
  }

  try {
    const image = hasIcon ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()

    if (process.platform === 'darwin') {
      image.setTemplateImage(true)
    }

    tray = new Tray(image)

    tray.setToolTip(process.platform === 'win32' ? '' : 'Proma')

    updateTrayMenu(actions)

    tray.on('click', () => {
      if (process.platform === 'win32') {
        actions.showMainWindow()
        return
      }
      const contextMenu = updateTrayMenu(actions)
      if (contextMenu) {
        tray?.popUpContextMenu(contextMenu)
      }
    })

    tray.on('right-click', () => {
      updateTrayMenu(actions)
    })

    if (process.platform === 'win32') {
      tray.on('mouse-enter', () => {
        if (!tray) return
        actions.onTrayMouseEnter?.(tray.getBounds())
      })
      tray.on('mouse-move', () => {
        if (!tray) return
        actions.onTrayMouseMove?.(tray.getBounds())
      })
      tray.on('mouse-leave', () => {
        actions.onTrayMouseLeave?.()
      })
    }

    console.log('System tray created')
    return tray
  } catch (error) {
    console.error('Failed to create system tray:', error)
    return null
  }
}

/**
 * 销毁系统托盘
 */
export function destroyTray(): void {
  clearTrayFlashTimer()
  if (tray) {
    tray.destroy()
    tray = null
  }
}

/**
 * 获取当前托盘实例
 */
export function getTray(): Tray | null {
  return tray
}

/**
 * 切换托盘图标闪烁（仅 Windows）
 */
export function setTrayFlash(on: boolean): void {
  if (process.platform !== 'win32') return
  clearTrayFlashTimer()
  const baseIcon = nativeImage.createFromPath(getTrayIconPath())
  if (!on) {
    tray?.setImage(baseIcon)
    return
  }
  if (!tray) return
  let showIdle = true
  flashTimer = setInterval(() => {
    showIdle = !showIdle
    tray?.setImage(showIdle ? baseIcon : nativeImage.createEmpty())
  }, 500)
}
