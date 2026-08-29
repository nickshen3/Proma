/**
 * 从 Proma JSONL (SDKMessage) 重建 Pi artifact（rehydrate）
 *
 * 适用场景：会话移动工作区、撤回重置后 Pi metadata 被合法清空，但 JSONL 历史
 * 仍在。此时撤回非首条消息无法 branch、下次发送只能降级为「最近 20 条摘要注入」。
 * 本模块把 JSONL 的 SDKMessage（Anthropic wire 风格）逆转换回 Pi AgentMessage，
 * 用 SessionManager.create + appendMessage 重建一棵完整对话树，恢复 resume 与
 * 撤回锚点能力。
 *
 * 逆转换对照正向转换 pi-message-adapter.ts 的 convertPiMessage：
 * - displayToolName 的固定映射表在此反向还原（Read→read 等；MultiEdit/Edit→edit
 *   由参数结构即可兼容，两套风格字段在 wire input 中同时保留）。
 * - thinking/thoughtSignature 均为可选字段：JSONL 未持久化 signature，重建后缺失
 *   只影响个别 provider 的多轮连续性，不破坏树结构。
 * - Api/ProviderId 为开放 string：provider 回填 _channelProvider，api 用
 *   'anthropic-messages' 占位。
 * - system/result 等 SDK 事件消息不属于对话上下文，跳过；重建树没有 compaction
 *   entry，上下文为全量，Pi 会在达到阈值后自动重新压缩。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionManager } from '@earendil-works/pi-coding-agent'

/** appendMessage 接受的消息联合（Message | CustomMessage | BashExecutionMessage） */
type AppendableMessage = Parameters<SessionManager['appendMessage']>[0]

/** SDKMessage 的宽松 wire 结构（仅取逆转换需要的字段） */
type WireRow = Record<string, unknown>

/** 重建产物 */
export interface PiRehydrateOutcome {
  /** 新建 artifact 的绝对路径 */
  sessionFile: string
  /** Pi session ID */
  sdkSessionId: string
  /** assistant 消息 uuid → artifact entry id */
  piEntryBindings: Record<string, string>
  /** 实际重建的消息条数 */
  rebuiltCount: number
}

/** displayToolName（pi-message-adapter）正向映射的逆表 */
const WIRE_TO_PI_TOOL_NAME: Record<string, string> = {
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  MultiEdit: 'edit',
  Bash: 'bash',
  Grep: 'grep',
  Glob: 'find',
  LS: 'ls',
}

function toPiToolName(wireName: unknown): string {
  if (typeof wireName !== 'string') return 'unknown'
  return WIRE_TO_PI_TOOL_NAME[wireName] ?? wireName
}

function asTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now()
}

function usageFromWire(usage: unknown): {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
} {
  const raw = (usage ?? {}) as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    input: num(raw.input_tokens),
    output: num(raw.output_tokens),
    cacheRead: num(raw.cache_read_input_tokens),
    cacheWrite: num(raw.cache_creation_input_tokens),
  }
}

/** 先扫一遍 assistant 的 tool_use，建立 tool_use_id → Pi 工具名映射，供 toolResult 反查 */
function buildToolNameIndex(rows: WireRow[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const row of rows) {
    if (row.type !== 'assistant') continue
    const blocks = ((row.message as WireRow | undefined)?.content) as unknown
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      const candidate = block as WireRow
      if (candidate?.type === 'tool_use' && typeof candidate.id === 'string') {
        index.set(candidate.id, toPiToolName(candidate.name))
      }
    }
  }
  return index
}

/**
 * SDKMessage 列表 → Pi AgentMessage 列表（纯函数）。
 *
 * - user 的 text 块合并为一条 UserMessage；tool_result 块每块拆为独立 ToolResultMessage
 *   （Pi 的 toolResult 是顶层消息，与 Anthropic wire 的 user 内嵌相反）
 * - assistant 的 thinking/text/tool_use 块逐块映射，tool_use 名称经逆表还原
 * - system / result 等事件消息跳过
 *
 * @returns AgentMessage 数组与 assistant uuid 的对应关系（用于重建 entry bindings）
 */
export function convertSDKMessagesToAgentMessages(
  rows: WireRow[],
): { messages: AppendableMessage[]; assistantEntryBindings: Array<{ uuid: string; index: number }> } {
  const toolNameIndex = buildToolNameIndex(rows)
  const messages: AppendableMessage[] = []
  const assistantEntryBindings: Array<{ uuid: string; index: number }> = []

  for (const row of rows) {
    const wire = (row.message ?? {}) as WireRow
    const timestamp = asTimestamp(row._createdAt)
    const uuid = typeof row.uuid === 'string' ? row.uuid : ''

    if (row.type === 'user') {
      const blocks = Array.isArray(wire.content) ? (wire.content as WireRow[]) : []
      for (const block of blocks) {
        if (block?.type === 'tool_result') {
          messages.push({
            role: 'toolResult',
            toolCallId: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
            toolName: toolNameIndex.get(String(block.tool_use_id)) ?? 'unknown',
            content: Array.isArray(block.content) ? block.content : [{ type: 'text', text: String(block.content ?? '') }],
            isError: block.is_error === true,
            timestamp,
          } as AppendableMessage)
        }
      }
      const text = blocks
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => String(block.text))
        .join('')
      if (text !== '' || blocks.length === 0) {
        // 纯文本 user 消息；空 content 的 user 行也保留（防御损坏数据，内容置空串）。
        messages.push({
          role: 'user',
          content: text,
          timestamp,
        } as AppendableMessage)
      }
    } else if (row.type === 'assistant') {
      const blocks = Array.isArray(wire.content) ? (wire.content as WireRow[]) : []
      const content = blocks.map((block) => {
        if (block?.type === 'thinking') {
          return { type: 'thinking', thinking: String(block.thinking ?? '') }
        }
        if (block?.type === 'tool_use') {
          return {
            type: 'toolCall',
            id: String(block.id ?? ''),
            name: toPiToolName(block.name),
            arguments: (block.input ?? {}) as Record<string, unknown>,
          }
        }
        return { type: 'text', text: String(block?.text ?? '') }
      })
      const assistantMessage = {
        role: 'assistant',
        content,
        api: 'anthropic-messages',
        provider: typeof row._channelProvider === 'string' ? row._channelProvider : 'anthropic',
        model: typeof wire.model === 'string' ? wire.model : 'unknown',
        usage: usageFromWire(wire.usage),
        stopReason: typeof wire.stop_reason === 'string' ? wire.stop_reason : 'stop',
        timestamp,
        ...(row.error && typeof (row.error as WireRow).message === 'string'
          ? { errorMessage: String((row.error as WireRow).message) }
          : {}),
      } as AppendableMessage
      assistantEntryBindings.push({ uuid, index: messages.length })
      messages.push(assistantMessage)
    }
    // system / result / progress 等事件消息不属于对话上下文，跳过。
  }

  return { messages, assistantEntryBindings }
}

/** rehydrate 核心的依赖注入参数（避免与 agent-session-manager 循环依赖） */
export interface RehydrateCoreInput {
  /** 已读取（normalize 过）的 SDKMessage 列表 */
  messages: WireRow[]
  /** 重建树的 cwd（当前会话解析后的工作目录） */
  cwd: string
  /** Pi session 存储目录 */
  sessionsDir: string
  /** 动态 import 的 Pi SDK（测试可注入 fake） */
  loadSdk?: () => Promise<typeof import('@earendil-works/pi-coding-agent')>
}

/**
 * 从消息列表重建 Pi artifact 树。
 *
 * 每条消息 appendMessage 为 entry（parent 链线性），assistant 记录 uuid → entry id。
 * 重建的树没有 branch/compaction 元数据，上下文为全量直线历史。
 */
export async function rehydratePiArtifactFromMessages(
  input: RehydrateCoreInput,
): Promise<PiRehydrateOutcome> {
  const { messages: rows, cwd, sessionsDir } = input
  const loadSdk = input.loadSdk ?? (async () => import('@earendil-works/pi-coding-agent'))
  const { messages, assistantEntryBindings } = convertSDKMessagesToAgentMessages(rows)
  if (messages.length === 0) {
    throw new Error('没有可重建的对话消息')
  }

  const sdk = await loadSdk()
  const manager = sdk.SessionManager.create(cwd, sessionsDir)
  const piEntryBindings: Record<string, string> = {}
  for (let i = 0; i < messages.length; i++) {
    const entryId = manager.appendMessage(messages[i]!)
    const binding = assistantEntryBindings.find((candidate) => candidate.index === i)
    if (binding && binding.uuid) piEntryBindings[binding.uuid] = entryId
  }
  const sessionFile = manager.getSessionFile()
  if (!sessionFile || !existsSync(sessionFile)) {
    throw new Error('Pi 未能生成重建的 session artifact')
  }

  return {
    sessionFile,
    sdkSessionId: manager.getSessionId(),
    piEntryBindings,
    rebuiltCount: messages.length,
  }
}

/** 仅供测试与日志：join sessionsDir 的便捷导出 */
export function piSessionsDir(sdkConfigDir: string): string {
  return join(sdkConfigDir, 'sessions')
}
