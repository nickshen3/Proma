# 会话进程面板（Session Process Panel）实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 Agent 会话右侧工作区新增「进程」聚合 tab，展示当前会话打开的全部命令进程与终端，支持只读监控与终止。

**Architecture:** 主进程新增 per-call 进程登记表（registry），通过自研 `BashOperations` 统一接管两条 shell 路径的 spawn；IPC 四层暴露 list/kill 与状态变更事件；renderer 以 Jotai Map\<sessionId, ProcessInfo[]\> 为单一数据源，聚合 tab 作为既有右侧 tab 体系的新基础 tab。

**Tech Stack:** Electron IPC（invoke + WebContents.send）、Pi runtime（`BashToolOptions.operations/spawnHook`）、Jotai、React + Tailwind + Radix、`bun test`。

**需求文档:** `docs/plans/2026-08-27-session-process-panel.md`（术语、FR 编号、验收场景以它为准）

---

## 全局约定

- 分支：`my-proma`。所有提交在该分支进行。
- **版本号策略**（遵循项目规范"每次改动递增交付物 patch"）：涉及 `packages/shared` 的提交递增 `packages/shared/package.json` patch；涉及 `apps/electron` 的提交递增 `apps/electron/package.json` patch。同一次提交两者都改则各自 +1。
- 测试：`bun test <file>`（BDD 风格 describe/it，中文用例名可读优先）；每任务收尾跑 `bun run typecheck`。
- IPC 四层契约同步：`packages/shared` 常量/类型 → `apps/electron/src/main/ipc.ts` handler → `apps/electron/src/preload/index.ts` bridge → renderer 调用。
- 关键既有锚点：
  - 通道常量：`packages/shared/src/types/agent.ts` 中 `AGENT_IPC_CHANNELS`（如 `STOP_AGENT: 'agent:stop'` 约 L1731）
  - tab 类型：`apps/electron/src/renderer/atoms/agent-atoms.ts:630` `AgentSidePanelBaseTab`
  - 终端 atoms 范式：`apps/electron/src/renderer/atoms/agent-atoms.ts:712` `agentTerminalTabsAtom`
  - tabs 数组：`apps/electron/src/renderer/components/agent/SidePanel.tsx` ~L1005-1046
  - bash 定制点：`apps/electron/src/main/lib/adapters/pi-agent-adapter.ts` `createWslBashOperations`（L1137）/ `createPromaBashToolOptions`（L1222 附近）
  - stream 事件：`apps/electron/src/renderer/hooks/useGlobalAgentListeners.ts` `onAgentStreamEvent`（L1433），`toolcall_start/end` 分支（L202-204）
  - main IPC 注册：`apps/electron/src/main/ipc.ts`；preload：`apps/electron/src/preload/index.ts`

---

### Task 0: 环境基线

**Files:** 无代码改动。

**Step 1: 安装依赖**

```bash
bun install
```

Expected: 成功生成 node_modules。若 Electron postinstall 在代理下失败，设置 `HTTPS_PROXY=http://127.0.0.1:7890` 重试。

**Step 2: 验证基线绿**

```bash
bun run typecheck && bun test
```

Expected: 全绿。若有上游既有失败，记录清单，排除在本功能之外。

**Step 3: 对照 pi 默认 bash operations**

阅读 `node_modules/@earendil-works/pi-coding-agent/dist` 中 bash 工具实现，确认：默认 operations 的 spawn 参数、timeout 语义、`options.signal` 的 child 终止行为、exec 返回值形状（`{ exitCode }`）。产出笔记记入本文件末尾「实现期笔记」。

**Step 4: 提交**

```bash
git add docs/plans/2026-08-27-session-process-panel-plan.md
git commit -m "docs(plans): session process panel implementation plan"
```

（文档改动随首个代码提交一并递增 electron patch 亦可，见 Task 9。）

---

### Task 1: shared 类型与通道常量

**Files:**
- Modify: `packages/shared/src/types/agent.ts`（`AGENT_IPC_CHANNELS` 增加通道；文件末尾新增进程类型）
- Create: `packages/shared/src/types/session-process.test.ts`

**Step 1: 写失败测试**

```ts
// packages/shared/src/types/session-process.test.ts
import { describe, expect, it } from 'bun:test'
import { AGENT_IPC_CHANNELS } from './agent'
import type { SessionProcessInfo } from './agent'

describe('会话进程类型与通道', () => {
  it('定义进程相关 IPC 通道', () => {
    expect(AGENT_IPC_CHANNELS.LIST_SESSION_PROCESSES).toBe('agent:processes:list')
    expect(AGENT_IPC_CHANNELS.KILL_SESSION_PROCESS).toBe('agent:processes:kill')
    expect(AGENT_IPC_CHANNELS.SESSION_PROCESS_EVENT).toBe('agent:processes:event')
  })

  it('SessionProcessInfo 状态收拢为三种', () => {
    const running: SessionProcessInfo = {
      processId: 'p1',
      sessionId: 's1',
      kind: 'command',
      title: 'bun run dev',
      status: 'running',
      startedAt: 1,
    }
    const exited: SessionProcessInfo = { ...running, status: 'exited', exitCode: 0, endedAt: 2 }
    const killed: SessionProcessInfo = { ...running, status: 'killed', endedAt: 2 }
    expect([exited.status, killed.status]).toEqual(['exited', 'killed'])
  })
})
```

**Step 2: 跑测试确认失败**

Run: `bun test packages/shared/src/types/session-process.test.ts`
Expected: FAIL（通道不存在 / 类型不存在）。

**Step 3: 最小实现**

在 `AGENT_IPC_CHANNELS` 中加入：

```ts
  LIST_SESSION_PROCESSES: 'agent:processes:list',
  KILL_SESSION_PROCESS: 'agent:processes:kill',
  SESSION_PROCESS_EVENT: 'agent:processes:event',
```

在 `packages/shared/src/types/agent.ts` 末尾新增：

```ts
// ===== 会话进程面板 =====

/** 会话进程来源：命令进程 / 终端。 */
export type SessionProcessKind = 'command' | 'terminal'

/** 会话进程状态：运行中 / 正常退出 / 被终止。 */
export type SessionProcessStatus = 'running' | 'exited' | 'killed'

/** 进程面板的单条记录（内存态，不持久化）。 */
export interface SessionProcessInfo {
  /** 进程记录唯一 id；命令进程使用工具调用 id，终端使用 terminalId。 */
  processId: string
  sessionId: string
  kind: SessionProcessKind
  /** 列表显示名：命令摘要或终端标题。 */
  title: string
  status: SessionProcessStatus
  startedAt: number
  endedAt?: number
  /** OS 进程 id；仅当底层可得时提供（自研 operations 与 PTY 均可得）。 */
  pid?: number
  /** 正常退出码；killed 不填。 */
  exitCode?: number
  /** 终端类记录对应右侧独立 tab 的 terminalId。 */
  terminalId?: string
}

/** 进程状态变更事件（main → renderer 推送）。 */
export type SessionProcessEvent =
  | { type: 'registered'; process: SessionProcessInfo }
  | { type: 'updated'; process: SessionProcessInfo }
  | { type: 'removed'; sessionId: string; processId: string }
```

同时确认 `packages/shared/src/types/index.ts` 已 re-export `agent.ts` 的导出（现有机制应已覆盖）。

**Step 4: 跑测试确认通过 + typecheck**

Run: `bun test packages/shared/src/types/session-process.test.ts && bun run typecheck`

**Step 5: 提交**

```bash
git add packages/shared/src/types/agent.ts packages/shared/src/types/session-process.test.ts packages/shared/package.json
git commit -m "feat(shared): session process panel types and ipc channels"
```

（提交前将 `packages/shared/package.json` patch +1。）

---

### Task 2: 主进程进程登记表 process-registry

**Files:**
- Create: `apps/electron/src/main/lib/process-registry.ts`
- Create: `apps/electron/src/main/lib/process-registry.test.ts`

**Step 1: 写失败测试**（覆盖：登记→更新→终止→会话清理；并发同名进程隔离；幽灵记录收敛）

```ts
// apps/electron/src/main/lib/process-registry.test.ts
import { describe, expect, it } from 'bun:test'
import { ProcessRegistry } from './process-registry'
import type { SessionProcessInfo } from '@proma/shared'

function makeProcess(partial: Partial<SessionProcessInfo> = {}): SessionProcessInfo {
  return {
    processId: 'tc-1', sessionId: 's1', kind: 'command',
    title: 'bun run dev', status: 'running', startedAt: 1, ...partial,
  }
}

describe('ProcessRegistry', () => {
  it('登记与查询按会话隔离', () => {
    const registry = new ProcessRegistry()
    registry.register(makeProcess())
    registry.register(makeProcess({ processId: 'tc-2', sessionId: 's2' }))
    expect(registry.list('s1')).toHaveLength(1)
    expect(registry.list('s2')).toHaveLength(1)
  })

  it('更新状态保留原字段', () => {
    const registry = new ProcessRegistry()
    registry.register(makeProcess())
    registry.update('s1', 'tc-1', { status: 'exited', exitCode: 0, endedAt: 9 })
    const [row] = registry.list('s1')
    expect(row.status).toBe('exited')
    expect(row.title).toBe('bun run dev')
    expect(row.exitCode).toBe(0)
  })

  it('terminate 调用注入的 killer 并标记 killed', () => {
    const registry = new ProcessRegistry()
    let killed = false
    registry.register(makeProcess(), { killer: () => { killed = true } })
    const result = registry.terminate('s1', 'tc-1')
    expect(result).toBe(true)
    expect(killed).toBe(true)
    expect(registry.list('s1')[0].status).toBe('killed')
  })

  it('已退出进程不可再终止', () => {
    const registry = new ProcessRegistry()
    registry.register(makeProcess({ status: 'exited', endedAt: 2 }))
    expect(registry.terminate('s1', 'tc-1')).toBe(false)
  })

  it('清空会话时终止活跃进程并移除全部记录', () => {
    const registry = new ProcessRegistry()
    const killed: string[] = []
    registry.register(makeProcess({ processId: 'a' }), { killer: () => killed.push('a') })
    registry.register(makeProcess({ processId: 'b', status: 'exited', endedAt: 2 }))
    registry.clearSession('s1')
    expect(killed).toEqual(['a'])
    expect(registry.list('s1')).toHaveLength(0)
  })

  it('并发同名命令进程各自独立', () => {
    const registry = new ProcessRegistry()
    registry.register(makeProcess({ processId: 'tc-a' }))
    registry.register(makeProcess({ processId: 'tc-b' }))
    expect(registry.list('s1')).toHaveLength(2)
  })
})
```

**Step 2: 跑测试确认失败**

Run: `bun test apps/electron/src/main/lib/process-registry.test.ts`

**Step 3: 最小实现**

```ts
// apps/electron/src/main/lib/process-registry.ts
import type { SessionProcessInfo } from '@proma/shared'

interface RegistryEntry {
  process: SessionProcessInfo
  /** 终止该进程的动作；由登记方注入（kill child / kill PTY）。 */
  killer?: () => void
}

/** 会话进程内存登记表。按键序为 sessionId → processId；不持久化。 */
export class ProcessRegistry {
  private readonly entries = new Map<string, Map<string, RegistryEntry>>()

  register(process: SessionProcessInfo, options: { killer?: () => void } = {}): void {
    const byId = this.entries.get(process.sessionId) ?? new Map<string, RegistryEntry>()
    byId.set(process.processId, { process, killer: options.killer })
    this.entries.set(process.sessionId, byId)
  }

  /** 幂等更新：仅合并给定字段；记录不存在时忽略。 */
  update(sessionId: string, processId: string, patch: Partial<Omit<SessionProcessInfo, 'processId' | 'sessionId'>>): SessionProcessInfo | undefined {
    const entry = this.entries.get(sessionId)?.get(processId)
    if (!entry) return undefined
    entry.process = { ...entry.process, ...patch }
    return entry.process
  }

  list(sessionId: string): SessionProcessInfo[] {
    return [...(this.entries.get(sessionId)?.values() ?? [])].map((entry) => ({ ...entry.process }))
  }

  /** 终止单个活跃进程；返回是否存在且确有终止动作。 */
  terminate(sessionId: string, processId: string): boolean {
    const entry = this.entries.get(sessionId)?.get(processId)
    if (!entry || entry.process.status !== 'running') return false
    entry.killer?.()
    this.update(sessionId, processId, { status: 'killed', endedAt: Date.now() })
    return true
  }

  /** 会话删除：终止全部活跃进程（终端、命令）并清空记录。 */
  clearSession(sessionId: string): void {
    const byId = this.entries.get(sessionId)
    if (!byId) return
    for (const [processId, entry] of byId) {
      if (entry.process.status === 'running') {
        entry.killer?.()
        entry.process = { ...entry.process, status: 'killed', endedAt: Date.now() }
      }
      byId.delete(processId)
    }
    this.entries.delete(sessionId)
  }
}
```

**Step 4: 跑测试确认通过 + typecheck**

**Step 5: 提交**

```bash
git commit -am "feat(electron): session process registry"   # 先改 apps/electron/package.json patch +1
```

---

### Task 3: 命令进程登记与精准 kill（patch pi-coding-agent + tracker）

> **2026-08-27 Task 0 修订**：原方案「非 WSL 路径自研 operations 复刻」取消。原因：pi 默认 `createLocalBashOperations` 依赖 `getShellConfig` 的 shell 探测链（Git Bash 探测、stdin transport 平台差异、PATH 回退），且包 `exports` 仅开放 `.`/`./rpc-entry`/`./client`，深路径不可 import，复刻维护成本高。改为 **patch 方案**（原 V2 升级为主路径）：仓库已有 `patchedDependencies` 先例（pi-ai、node-pty）。

**Files:**
- Create: `patches/@earendil-works%2Fpi-coding-agent@0.84.2.patch`
- Modify: `package.json`（`patchedDependencies` 登记 `"@earendil-works/pi-coding-agent@0.84.2"`）
- Modify: `apps/electron/src/main/lib/adapters/pi-agent-adapter.ts`（`createPromaBashToolOptions` 注入 `onSpawnProcess` → tracker；`createWslBashOperations` 的 exec 内直接登记）
- Create: `apps/electron/src/main/lib/adapters/command-process-tracker.ts` + 同名 `.test.ts`

**patch 内容（最小侵入，不传回调时零行为变化）：**
1. `dist/core/tools/bash.js`：exec 内 `spawn(...)` 后调用 `options.onSpawn?.(child, { command, cwd })`；`createBashToolDefinition` 构造 exec options 处把 `BashToolOptions.onSpawnProcess` 透传为 `onSpawn`。
2. `dist/core/tools/bash.d.ts`：`BashOperations` exec options 与 `BashToolOptions` 各增加可选 `onSpawn? / onSpawnProcess?: (child: import("child_process").ChildProcess, context: { command: string; cwd: string }) => void`。

**Proma 侧 tracker 职责（统一服务两条路径）：**
- `onSpawn`：`registry.register({ processId: randomUUID(), kind: 'command', title: summarize(command), status: 'running', startedAt, pid: child.pid }, { killer: () => child.kill('SIGTERM') })`——kill 行为与 WSL 路径现状一致；进程树增强后续评估。
- 输出缓冲：exec 的 `onData` 旁路写入 registry entry 环形缓冲（默认上限 200KB，对齐终端日志策略），支持按 `processId + offset` 增量拉取（需求文档 FR3.1 的输出数据源细化：不复用 ProcessBlockGroup stream 链路，语义不变）。
- 收敛：exec resolve → `exited`(exitCode)；reject `aborted` → `killed`；reject `timeout:` → `exited` 标注超时；其余 reject → `exited`。每次收敛推送 `SessionProcessEvent.updated`。
- 标题摘要：超 80 字符截断 ellipsis。
- `toolcallId` 不可得（exec 上下文无 id），`processId = randomUUID()`，列表数据完全来自 main registry，不与 stream 事件做键关联。

**降级路径（若 patch 应用失败或上游重构冲突）**：回退 V1——标准路径仅 `spawnHook` 登记无 PID + run 级中断，WSL 路径保留全能力；在实现期笔记记录。

**Step 1: 写失败测试**（command-process-tracker）：『生成截断的命令标题（超 80 字符 ellipsis）』『登记命令进程产生 running 记录并挂接 killer』『exec 正常结束回填 exitCode 并更新为 exited』『abort 结束更新为 killed』『输出缓冲环形上限生效』。

**Step 2: 跑测试确认失败。**

**Step 3: 实现 patch 与 tracker**；`bun install` 触发 patch 应用，用运行时小脚本（exec 一个 `echo` 经 adapter）验证 `onSpawnProcess` 生效。

**Step 4: 接入 `createPromaBashToolOptions`（标准路径）与 `createWslBashOperations`（WSL 路径）**；registry/事件转发经构造参数注入（adapter options 增加 `processRegistry` 与 `onProcessEvent`），避免模块级单例。

**Step 5: 跑新测试 + 相关目录测试 + typecheck。**

**Step 6: 提交** `feat(electron): track command processes via pi bash hook`（electron patch +1）

---

### Task 4: IPC 四层（list / kill / 事件推送）

**Files:**
- Modify: `apps/electron/src/main/ipc.ts`（两个 invoke handler）
- Modify: `apps/electron/src/preload/index.ts`（bridge 方法与事件监听）
- Modify: `apps/electron/src/main/lib/adapters/pi-agent-adapter.ts`（事件经现有 WebContents 转发链路广播 `SESSION_PROCESS_EVENT`）
- Test: `packages/shared` 已有类型测试；IPC 层以 typecheck + Task 6 集成验证为主

**Step 1: main handler**

```ts
// ipc.ts 中注册（模式对齐现有 terminal handler）
ipcMain.handle(AGENT_IPC_CHANNELS.LIST_SESSION_PROCESSES, (_event, sessionId: string) => {
  return processRegistry.list(sessionId)
})
ipcMain.handle(AGENT_IPC_CHANNELS.KILL_SESSION_PROCESS, (_event, input: { sessionId: string; processId: string }) => {
  return processRegistry.terminate(input.sessionId, input.processId)
})
```

registry 实例在 main 编排层创建并传入 adapter（Task 3）与 ipc.ts（Task 4），单一实例。事件推送复用 terminal 事件的转发通道模式（`AgentTerminalOpenEvent` 的现有发送路径），把 `SessionProcessEvent` 发给主窗口。

**Step 2: preload bridge**

```ts
  // electronAPI 增补
  listSessionProcesses: (sessionId: string) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.LIST_SESSION_PROCESSES, sessionId),
  killSessionProcess: (input: { sessionId: string; processId: string }) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.KILL_SESSION_PROCESS, input),
  onSessionProcessEvent: (listener: (event: SessionProcessEvent) => void) => {
    // 模式对齐现有 onAgentTerminalOpen 等事件订阅
  },
```

**Step 3: 终端登记接线**：在创建终端的既有 service 流程中调用 `processRegistry.register({ kind: 'terminal', processId: terminalId, terminalId, ... , killer: () => killTerminal(terminalId) })`，终端关闭事件收敛状态——保证 FR1.4（终端单一数据源语义：registry 是投影，真值仍为 terminal-service）。

**Step 4: typecheck + 手动验证**：`bun run dev` 下用任一会话跑命令，主进程日志确认 register/update 事件发出。

**Step 5: 提交** `feat(electron): session process ipc endpoints`（electron patch +1）

---

### Task 5: renderer atoms 与 stream 关联

**Files:**
- Modify: `apps/electron/src/renderer/atoms/agent-atoms.ts`
- Modify: `apps/electron/src/renderer/hooks/useGlobalAgentListeners.ts`
- Create: `apps/electron/src/renderer/atoms/session-process-atoms.test.ts`

**Step 1: 写失败测试**（atoms reducer 语义：registered 插入排序、updated 原位替换、removed 删除、按会话 Map）

**Step 2: 实现**

```ts
// agent-atoms.ts 增补（紧邻 agentTerminalTabsAtom）
export const agentProcessesAtom = atom<Map<string, SessionProcessInfo[]>>(new Map())
```

reducer 函数 `applySessionProcessEvent(map, event): Map<...>` 纯函数导出便于测试。排序规则（FR2.5）：running 优先，组内 startedAt 倒序。

`useGlobalAgentListeners.ts`：新增 `onSessionProcessEvent` 订阅写入 atom；同时在 `toolcall_start/end` 分支（L202-204）不做改动——命令进程的真值来自 main registry 推送，stream 分支仅在「registry 事件与 stream 事件标题不一致」时以 stream 侧标题补全（防御性，Task 0 Step 3 结论决定是否需要）。

初始加载：会话激活时 `listSessionProcesses(sessionId)` 拉取全量，事件流做增量。

**Step 3: 测试通过 + typecheck → 提交** `feat(electron): session process renderer state`（electron patch +1）

---

### Task 6: 聚合 tab 骨架与列表 UI

**Files:**
- Modify: `apps/electron/src/renderer/atoms/agent-atoms.ts:630`（`AgentSidePanelBaseTab` 增加 `'processes'`）
- Modify: `apps/electron/src/renderer/components/agent/SidePanel.tsx`（tabs 数组基础段 + 内容渲染分支 + 关闭守卫）
- Create: `apps/electron/src/renderer/components/agent/ProcessesPanel.tsx`

**Step 1: tab 注册**

- `AgentSidePanelBaseTab` 改为 `'files' | 'changes' | 'processes' | 'chat' | 'temporary-agent' | WorkspaceComponentTab`。
- tabs 数组基础段（`files` 等所在处）加入 `{ id: 'processes', label: '进程', icon: <Cpu className="size-3.5" />, badge: 活跃数 }`（badge 写法对齐现有 tab activity/badge 模式；无活跃进程不显示）。排序在 `changes` 之后（开放问题 3 的建议位，实现时如有更好的现有排序约定则从之）。
- 内容渲染分支：`activeTab === 'processes'` → `<ProcessesPanel sessionId={sessionId} />`。`'processes'` 不设 `closable`（基础 tab 不可关闭）。

**Step 2: ProcessesPanel 骨架**

结构（完整实现本步只做列表 + 空状态 + 筛选；展开/终止在 Task 7）：

```tsx
interface ProcessesPanelProps { sessionId: string }
// 读 agentProcessesAtom；空状态引导文案（FR 引导语见需求文档 §6）
// 顶部：筛选 Segmented（活跃 / 全部，默认活跃）
// 列表项：状态点（running 绿 / exited 中性 / killed 警示）、标题（ellipsis + title 全文）、
//         来源图标（命令 SquareTerminal 复用 / 终端 SquareTerminal 区分色 或 Terminal/CommandPause 语义图标）、
//         时长（running 实时递增，1s tick；exited/killed 显示 endedAt 相对时长或退出码）
```

复用既有 primitives 与主题变量；不新建颜色 token。

**Step 3: 手动验证**：`bun run dev`，跑命令 + 开终端，确认列表、筛选、徽标、会话切换跟随（FR6.2）。

**Step 4: 提交** `feat(electron): session processes aggregate tab`（electron patch +1）

---

### Task 7: 详情展开、终止操作、终端跳转

**Files:**
- Modify: `apps/electron/src/renderer/components/agent/ProcessesPanel.tsx`
- Create: `apps/electron/src/renderer/components/agent/ProcessOutputView.tsx`
- Modify: `apps/electron/src/renderer/atoms/agent-atoms.ts`（展开状态 atom：Map<sessionId, selectedProcessId>）

**Step 1: 展开输出区**（FR3.1）：点击列表项展开内嵌输出视图。输出数据源按 kind 分流：终端 → 直接复用现有终端输出缓冲读取（`readTerminalOutput` 链路，只读快照 + 尾随）；命令进程 → 复用 ProcessBlockGroup 的输出数据源（以 processId/title+startedAt 关联，Task 3 结论决定键）。滚动默认跟随尾部，提供暂停跟随 toggle。

**Step 2: 终止操作**（FR4.1-4.3）：running 项显示「终止」按钮 → 二段式确认（按钮原地变为「确认终止?」3 秒超时回退）→ `killSessionProcess` → registry 推送 updated(killed) 驱动 UI。已退出项无终止按钮（FR4.4）。

**Step 3: 终端跳转**（FR3.2）：终端项详情区「在终端 tab 中打开」→ `onTabChange(getTerminalSidePanelTab(terminalId))`；目标 tab 不存在（用户已关）→ 轻提示。

**Step 4: 手动验证 + typecheck → 提交** `feat(electron): process panel output, kill and terminal jump`（electron patch +1）

---

### Task 8: 边界打磨与验收

**Files:**
- Modify: `apps/electron/src/renderer/components/agent/ProcessesPanel.tsx`（键盘、窄宽度）
- Modify: 会话删除清理接线点（现有会话删除 service/handler 中调用 `processRegistry.clearSession`）
- Test: 各相关 `.test.ts` 补边界用例

**Step 1: 键盘与可达性**（§6）：列表 `role="list"/listitem"`、上下键移动、Enter 展开、终止按钮可 Tab 聚焦。

**Step 2: 会话删除清理**（FR5.3-5.4）：在现有删除会话的 handler 中调用 `clearSession(sessionId)`（终端已被现有逻辑终止时 killer 幂等不重复杀）。

**Step 3: 需求文档验收场景逐条手动过**（§9 六个 BDD 场景），记录结果到「实现期笔记」。

**Step 4: 深浅主题检查 + 窄宽度 ellipsis 检查。**

**Step 5: 提交** `fix(electron): process panel edge cases and cleanup`（electron patch +1）

---

### Task 9: 全量验证与收尾

**Step 1:** `bun run typecheck && bun test` 全绿。
**Step 2:** 改动了运行时与 IPC，按项目规范跑 `bun run electron:build` 确认打包构建通过。
**Step 3:** 汇总版本号：确认本分支所有提交已按全局约定递增（shared 与 electron 各自 patch）；发布产物相关交付物为 `apps/electron`。
**Step 4:** `git diff` 自查无无关文件；推送 `git push -u origin my-proma`。
**Step 5:** 更新需求文档状态为「已实现（分支 my-proma）」，附「实现期笔记」结论。

---

## 实现期笔记

### 2026-08-27 Task 0（环境基线）

- `bun install` 通过（813 包）；`bun run typecheck` 全绿。
- `bun test` 基线：515 pass / **1 fail** —— `@proma/session-core` 的 planning 数据库测试（isolation/transactions/reminders/optimistic versions）为上游既有失败，本地无任何代码改动，与本功能无关，排除在本功能验证范围外，不修复（避免无关变更）。
- **pi-coding-agent 0.84.2 对照结论：**
  - 默认实现 `dist/core/tools/bash.js` 的 `createLocalBashOperations`：spawn → timeout/abort 走 `killProcessTree(pid)` → `waitForChildProcess(child)`；exec 返回 `{ exitCode }`，aborted/timeout 抛错。
  - `BashOperations.exec(command, cwd, { onData, signal?, timeout?, env? })`；**exec 上下文不携带 toolcall id** → 进程记录与 stream 事件不做键关联，输出流改为 registry 自带环形缓冲 + 增量拉取 IPC（Task 4/5 细化，需求语义不变）。
  - `getShellConfig`（Git Bash 探测 / stdin transport / PATH 回退）不可从包外 import（`exports` 仅 `.`/`./rpc-entry`/`./client`）→ **Task 3 改为 patch 方案**（见 Task 3 修订说明）。
  - 基线既知失败项：`session-core` planning 测试 1 例（见上），后续任务跑全量测试时以“不新增失败”为准。
