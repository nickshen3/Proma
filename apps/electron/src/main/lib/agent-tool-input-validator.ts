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
  ['WaitFor', ['command']],
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
  // 与工具名大小写无关地拦截，并引导改用条件驱动等待。
  if (toolName === 'bash' || toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : ''
    return validateBashPrefixSleep(command)
  }
  // WaitFor 的检查命令以前缀 sleep 开头同样没有意义：检查应在条件满足时退出 0。
  if (toolName === 'WaitFor') {
    const command = typeof input.command === 'string' ? input.command : ''
    const failure = validateBashPrefixSleep(command)
    if (failure) {
      return {
        behavior: 'deny' as const,
        message: 'WaitFor check command starts with a sleep. A check must exit 0 exactly when the condition is satisfied; a leading sleep only delays every poll. Provide a real condition check instead.',
      }
    }
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
    message: `Bash command starts with a sleep of ~${seconds}s. Do not use Bash as a timer: it blocks one tool call for the whole delay. Wait on the condition, not the clock: prefer a command that exits when the state changes (e.g. gh pr watch <n> --interval 15), a conditional loop that breaks on success (for i in $(seq 1 60); do <check> && break; sleep 10; done), the WaitFor tool (server-side polling that wakes you when the check passes), or a Proma automation for recurring checks.`,
  }
}
