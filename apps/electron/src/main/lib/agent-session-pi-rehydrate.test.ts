import { describe, expect, test } from 'bun:test'
import { convertSDKMessagesToAgentMessages } from './agent-session-pi-rehydrate'

type AnyRecord = Record<string, unknown>

function wireUser(uuid: string, blocks: AnyRecord[], createdAt = 1000): AnyRecord {
  return { type: 'user', uuid, message: { content: blocks }, _createdAt: createdAt }
}

function wireAssistant(uuid: string, blocks: AnyRecord[], extra: AnyRecord = {}, createdAt = 2000): AnyRecord {
  return {
    type: 'assistant',
    uuid,
    message: {
      content: blocks,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 },
      model: 'glm-5.3',
      stop_reason: 'stop',
      ...extra,
    },
    _channelProvider: 'zhipu-coding',
    _createdAt: createdAt,
  }
}

describe('SDKMessage → AgentMessage 逆转换', () => {
  test('Given 纯文本 user 与 assistant When 转换 Then 得到 UserMessage 与 AssistantMessage', () => {
    const { messages, assistantEntryBindings } = convertSDKMessagesToAgentMessages([
      wireUser('u1', [{ type: 'text', text: '你好' }]),
      wireAssistant('a1', [{ type: 'text', text: '回复' }]),
    ])

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: 'user', content: '你好', timestamp: 1000 })
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      provider: 'zhipu-coding',
      model: 'glm-5.3',
      stopReason: 'stop',
      usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 1 },
      timestamp: 2000,
    })
    expect(assistantEntryBindings).toEqual([{ uuid: 'a1', index: 1 }])
  })

  test('Given assistant 带 thinking 与 tool_use When 转换 Then 块逐个映射且工具名逆映射为 Pi 名', () => {
    const { messages } = convertSDKMessagesToAgentMessages([
      wireAssistant('a1', [
        { type: 'thinking', thinking: '想一想' },
        { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use', id: 'call_2', name: 'MultiEdit', input: { path: 'a.ts', edits: [{}, {}] } },
      ], { stop_reason: 'toolUse' }),
    ])

    const assistant = messages[0] as unknown as AnyRecord
    expect(assistant.stopReason).toBe('toolUse')
    expect(assistant.content).toEqual([
      { type: 'thinking', thinking: '想一想' },
      { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } },
      { type: 'toolCall', id: 'call_2', name: 'edit', arguments: { path: 'a.ts', edits: [{}, {}] } },
    ])
  })

  test('Given user 内嵌 tool_result When 转换 Then 拆为独立 ToolResultMessage 且 toolName 从配对 assistant 反查', () => {
    const { messages } = convertSDKMessagesToAgentMessages([
      wireAssistant('a1', [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'x.ts' } }], { stop_reason: 'toolUse' }),
      wireUser('t1', [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: '内容' }], is_error: false }]),
    ])

    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'read',
      isError: false,
      timestamp: 1000,
    })
  })

  test('Given tool_result 无配对 assistant When 转换 Then toolName 兜底 unknown 不报错', () => {
    const { messages } = convertSDKMessagesToAgentMessages([
      wireUser('t1', [{ type: 'tool_result', tool_use_id: 'call_orphan', content: [{ type: 'text', text: 'x' }], is_error: true }]),
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: 'toolResult', toolCallId: 'call_orphan', toolName: 'unknown', isError: true })
  })

  test('Given user 同时含 text 与 tool_result When 转换 Then toolResult 在前、userText 在后', () => {
    const { messages } = convertSDKMessagesToAgentMessages([
      wireUser('u1', [
        { type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: '结果' }], is_error: false },
        { type: 'text', text: '补充说明' },
      ]),
    ])

    expect(messages.map((m) => (m as unknown as AnyRecord).role)).toEqual(['toolResult', 'user'])
    expect(messages[1]).toMatchObject({ content: '补充说明' })
  })

  test('Given system/result 事件消息 When 转换 Then 跳过不进入对话树', () => {
    const { messages } = convertSDKMessagesToAgentMessages([
      { type: 'system', subtype: 'compact_boundary', summary: '...' },
      { type: 'result', subtype: 'success' },
      wireUser('u1', [{ type: 'text', text: '你好' }]),
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: 'user' })
  })

  test('Given 终态错误 assistant When 转换 Then 保留 errorMessage', () => {
    const { messages } = convertSDKMessagesToAgentMessages([
      { ...wireAssistant('a1', [{ type: 'text', text: '部分输出' }], { stop_reason: 'error' }), error: { message: 'boom' } },
    ])

    expect(messages[0]).toMatchObject({ stopReason: 'error', errorMessage: 'boom' })
  })

  test('Given 缺失 _channelProvider 与 model When 转换 Then 使用兜底占位值', () => {
    const row: AnyRecord = {
      type: 'assistant',
      uuid: 'a1',
      message: { content: [{ type: 'text', text: 'x' }], usage: {}, stop_reason: 'stop' },
      _createdAt: 1,
    }
    const { messages } = convertSDKMessagesToAgentMessages([row])
    expect(messages[0]).toMatchObject({ provider: 'anthropic', model: 'unknown', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })
  })
})
