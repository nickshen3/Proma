import { describe, expect, test } from 'bun:test'
import type { SDKContentBlock, SDKMessage, SDKUserMessage } from '@proma/shared'
import { buildProcessGroupTranscript, collectToolResults } from './process-group-transcript'

function userToolResultMessage(
  toolUseId: string,
  content: string | Array<{ type: string; text?: string }>,
  isError?: boolean,
): SDKUserMessage {
  return {
    type: 'user',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
  }
}

function toolUseBlock(id: string, name: string, input: Record<string, unknown>): SDKContentBlock {
  return { type: 'tool_use', id, name, input }
}

describe('执行过程转录', () => {
  test('given mixed thinking text and tool blocks when building transcript then emits ordered numbered sections with paired results', () => {
    const blocks: SDKContentBlock[] = [
      { type: 'thinking', thinking: '先读取文件确认结构。' },
      toolUseBlock('toolu_1', 'Read', { file_path: 'src/main.tsx', limit: 100 }),
      { type: 'text', text: '已确认入口结构，接下来搜索使用点。' },
      toolUseBlock('toolu_2', 'Grep', { pattern: 'useToolResult' }),
    ]
    const toolResults = new Map([
      ['toolu_1', { text: 'const x = 1', isError: false }],
      ['toolu_2', { text: 'src/a.tsx:55', isError: false }],
    ])

    const transcript = buildProcessGroupTranscript(blocks, toolResults)

    expect(transcript.startsWith('## 执行过程\n')).toBe(true)
    expect(transcript).toContain('### 1. 思考\n\n先读取文件确认结构。')
    expect(transcript).toContain('### 2. 工具调用：Read')
    expect(transcript).toContain('**参数**\n\n```json\n{\n  "file_path": "src/main.tsx",\n  "limit": 100\n}\n```')
    expect(transcript).toContain('**结果**\n\n```text\nconst x = 1\n```')
    expect(transcript).toContain('### 3. 消息\n\n已确认入口结构，接下来搜索使用点。')
    expect(transcript).toContain('### 4. 工具调用：Grep')
    expect(transcript.endsWith('\n')).toBe(true)
  })

  test('given a missing tool result when building transcript then marks it as not yet returned', () => {
    const blocks = [toolUseBlock('toolu_pending', 'Bash', { command: 'bun test' })]
    const transcript = buildProcessGroupTranscript(blocks, new Map())

    expect(transcript).toContain('### 1. 工具调用：Bash')
    expect(transcript).toContain('**结果**\n\n> （尚未返回结果）')
  })

  test('given an error tool result when building transcript then annotates the error marker', () => {
    const blocks = [toolUseBlock('toolu_err', 'Bash', { command: 'exit 1' })]
    const toolResults = new Map([['toolu_err', { text: 'command failed', isError: true }]])

    const transcript = buildProcessGroupTranscript(blocks, toolResults)

    expect(transcript).toContain('**结果**（工具返回错误）\n\n```text\ncommand failed\n```')
  })

  test('given a result containing triple backticks when building transcript then upgrades the fence to four backticks', () => {
    const blocks = [toolUseBlock('toolu_md', 'Write', { content: '# doc' })]
    const toolResults = new Map([['toolu_md', { text: '已写入：\n```md\n# doc\n```', isError: false }]])

    const transcript = buildProcessGroupTranscript(blocks, toolResults)

    expect(transcript).toContain('````text\n已写入：\n```md\n# doc\n```\n````')
  })

  test('given blank blocks or an empty group when building transcript then skips or returns empty string', () => {
    expect(buildProcessGroupTranscript([], new Map())).toBe('')
    expect(buildProcessGroupTranscript([
      { type: 'thinking', thinking: '   ' },
      { type: 'text', text: '' },
    ], new Map())).toBe('')
  })

  test('given tool results across multiple user messages when collecting then keeps the first result per tool_use_id and ignores non-user messages', () => {
    const messages: SDKMessage[] = [
      { type: 'assistant', message: { content: [] }, parent_tool_use_id: null },
      userToolResultMessage('toolu_a', 'first result'),
      userToolResultMessage('toolu_a', 'duplicate result'),
      userToolResultMessage('toolu_b', [{ type: 'text', text: 'array result' }], true),
      { type: 'user', parent_tool_use_id: null },
    ]

    const results = collectToolResults(messages)

    expect(results.size).toBe(2)
    expect(results.get('toolu_a')).toEqual({ text: 'first result', isError: undefined })
    expect(results.get('toolu_b')).toEqual({ text: 'array result', isError: true })
  })
})
