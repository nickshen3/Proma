/**
 * 执行过程转录（process-group transcript）
 *
 * 把一个执行过程组内的内容块（thinking / text / tool_use）连同对应的
 * tool_result 组装成一份自包含的 Markdown 文本，供用户一键复制后
 * 粘贴给 Agent 分析问题。纯逻辑模块，不依赖 React，便于单测。
 */

import { extractToolResultText } from './task-progress'
import type {
  SDKContentBlock,
  SDKMessage,
  SDKTextBlock,
  SDKThinkingBlock,
  SDKToolResultBlock,
  SDKToolUseBlock,
  SDKUserMessage,
} from '@proma/shared'

/** 单个工具结果的文本摘要（从 user 消息的 tool_result 提取）。 */
export interface ProcessToolResultSummary {
  text?: string
  isError?: boolean
}

/**
 * 从消息流中收集 tool_use_id → 工具结果文本。
 * 只提取文本类内容，图片等二进制块不会混入转录。
 */
export function collectToolResults(allMessages: readonly SDKMessage[]): Map<string, ProcessToolResultSummary> {
  const results = new Map<string, ProcessToolResultSummary>()

  for (const message of allMessages) {
    if (message.type !== 'user') continue
    const userMsg = message as SDKUserMessage
    const blocks = userMsg.message?.content
    if (!Array.isArray(blocks)) continue

    for (const block of blocks) {
      if (block.type !== 'tool_result') continue
      const resultBlock = block as SDKToolResultBlock
      // 同一 tool_use_id 只保留首个结果（正常流程不会重复返回）。
      if (results.has(resultBlock.tool_use_id)) continue
      const text = extractToolResultText(resultBlock.content)
      results.set(resultBlock.tool_use_id, { text, isError: resultBlock.is_error })
    }
  }

  return results
}

/** 内容含 ``` 时升级为四反引号围栏，避免破坏嵌套代码块。 */
function wrapCodeBlock(content: string, language: string): string {
  const fence = content.includes('```') ? '````' : '```'
  return `${fence}${language}\n${content}\n${fence}`
}

function formatJsonInput(input: Record<string, unknown> | undefined): string {
  if (!input || Object.keys(input).length === 0) return ''
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    // 循环引用等极端情况下退化为原始字符串
    return String(input)
  }
}

/**
 * 把执行过程组的内容块渲染为 Markdown 转录。
 *
 * 结构：每个块一节（思考 / 消息 / 工具调用），工具调用与其结果配对；
 * 结果尚未返回（流式进行中）时显式标注，方便据此判断截断点。
 */
export function buildProcessGroupTranscript(
  blocks: readonly SDKContentBlock[],
  toolResults: ReadonlyMap<string, ProcessToolResultSummary>,
): string {
  const sections: string[] = []
  let step = 0

  for (const block of blocks) {
    if (block.type === 'thinking') {
      const thinking = (block as SDKThinkingBlock).thinking?.trim()
      if (!thinking) continue
      step += 1
      sections.push(`### ${step}. 思考\n\n${thinking}`)
      continue
    }

    if (block.type === 'text') {
      const text = (block as SDKTextBlock).text?.trim()
      if (!text) continue
      step += 1
      sections.push(`### ${step}. 消息\n\n${text}`)
      continue
    }

    if (block.type === 'tool_use') {
      const tool = block as SDKToolUseBlock
      step += 1
      const parts: string[] = [`### ${step}. 工具调用：${tool.name}`]

      const inputJson = formatJsonInput(tool.input)
      if (inputJson) {
        parts.push(`**参数**\n\n${wrapCodeBlock(inputJson, 'json')}`)
      }

      const result = toolResults.get(tool.id)
      if (!result) {
        parts.push('**结果**\n\n> （尚未返回结果）')
      } else if (!result.text) {
        parts.push('**结果**\n\n> （无文本输出）')
      } else {
        const errorMark = result.isError ? '（工具返回错误）' : ''
        parts.push(`**结果**${errorMark}\n\n${wrapCodeBlock(result.text, 'text')}`)
      }

      sections.push(parts.join('\n\n'))
      continue
    }

    // 其余块类型（如 redacted_thinking）当前不出现在过程组中，安全忽略。
  }

  return sections.length > 0
    ? `## 执行过程\n\n${sections.join('\n\n')}\n`
    : ''
}
