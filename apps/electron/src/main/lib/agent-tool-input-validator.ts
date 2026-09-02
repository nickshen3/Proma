/**
 * 工具参数校验模块
 *
 * 在 canUseTool 回调中拦截参数缺失的工具调用，
 * 返回描述性 deny message 引导模型重试。
 */

/** 已知工具的必需参数映射 */
export const TOOL_REQUIRED_PARAMS: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ['Write', ['file_path', 'content']],
  ['Edit', ['file_path', 'old_string', 'new_string']],
  ['Bash', ['command']],
  ['Read', ['file_path']],
  ['Glob', ['pattern']],
  ['Grep', ['pattern']],
  ['TerminalExecute', ['command']],
  ['TerminalWait', ['terminalId']],
  ['TerminalInterrupt', ['terminalId']],
  ['TerminalClose', ['terminalId']],
])

/** Bash 前缀长 sleep 的拦截阈值（秒）：达到即视为把 Bash 当定时器使用。 */
const BASH_PREFIX_SLEEP_DENY_SECONDS = 60

/** 校验失败结果，与 PermissionResult deny 形状一致 */
export interface ToolValidationFailure {
  behavior: 'deny'
  message: string
}

/**
 * 校验工具调用的必需参数是否存在且非空。
 *
 * 未知工具或参数完整时返回 null；
 * 参数缺失时返回 deny 结果，message 中列出缺失的参数名。
 */
export function validateToolInput(
  toolName: string,
  input: Record<string, unknown>,
): ToolValidationFailure | null {
  const requiredParams = TOOL_REQUIRED_PARAMS.get(toolName)
  if (requiredParams) {
    const missing: string[] = []
    for (const param of requiredParams) {
      const value = input[param]
      if (value === undefined || value === null || value === '') {
        missing.push(param)
      }
    }
    if (missing.length > 0) {
      const paramList = missing.map((p) => `"${p}"`).join(', ')
      const message = missing.length === 1
        ? `Tool "${toolName}" is missing required parameter ${paramList}. Please retry with all required parameters filled in.`
        : `Tool "${toolName}" is missing required parameters: ${paramList}. Please retry with all required parameters filled in.`
      return { behavior: 'deny' as const, message }
    }
  }

  // Bash 前缀分钟级 sleep 是“把同步工具当定时器”的反模式：一次调用被空转占用数分钟
  // （真实案例：子 Agent 用 sleep 570 + timeout 600 凑十分钟轮询间隔，八小时空转上百次）。
  // 与工具名大小写无关地拦截，并引导改用短间隔自查、阻塞式子命令或 Proma 定时任务。
  if (toolName === 'bash' || toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : ''
    return validateBashPrefixSleep(command)
  }
  return null
}

/** GNU sleep 支持多参数相加与 s/m/h/d 后缀；仅匹配命令开头的 sleep 段。 */
const BASH_PREFIX_SLEEP_PATTERN = /^sleep((?:\s+[0-9]+(?:\.[0-9]+)?[smhdSMHD]?)+)/

/**
 * 拦截以分钟级 sleep 开头的 Bash 命令。低于阈值、非前缀（如循环体内的短 sleep）
 * 或仅提及 sleep 字样但不以它开头的命令一律放行，保持低误伤。
 */
export function validateBashPrefixSleep(command: string): ToolValidationFailure | null {
  const trimmed = command.trim()
  const match = BASH_PREFIX_SLEEP_PATTERN.exec(trimmed)
  if (!match) return null

  let totalSeconds = 0
  const args = /\s+([0-9]+(?:\.[0-9]+)?)([smhdSMHD]?)/g
  let arg: RegExpExecArray | null
  while ((arg = args.exec(match[1] ?? '')) !== null) {
    const value = Number.parseFloat(arg[1] ?? '0')
    const unit = (arg[2] || 's').toLowerCase()
    const factor = unit === 'm' ? 60 : unit === 'h' ? 3_600 : unit === 'd' ? 86_400 : 1
    totalSeconds += value * factor
  }
  if (totalSeconds < BASH_PREFIX_SLEEP_DENY_SECONDS) return null

  const seconds = Math.round(totalSeconds)
  return {
    behavior: 'deny' as const,
    message: `Bash command starts with a sleep of ~${seconds}s. Do not use Bash as a timer: it blocks one tool call for the whole delay. Instead, re-issue short checks yourself as needed, poll with short sleeps inside loops, use a blocking subcommand for state changes (e.g. gh pr watch), or schedule recurring checks as a Proma automation.`,
  }
}
