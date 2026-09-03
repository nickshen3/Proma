import { describe, expect, test } from 'bun:test'
import {
  validateBashLongSleepStatement,
  validateToolInput,
} from './agent-tool-input-validator'

/**
 * Bash 独立分钟级 sleep 语句拦截（按语句段切分，不限位置）：
 * 真实案例是子 Agent 用 `sleep 570; <检查>` 与 `cd … && sleep 580; <检查>` 凑十分钟轮询间隔，
 * 一次工具调用被空转占用数分钟。拦截语义是“任何位置的独立分钟级 sleep 语句”，
 * 循环体内的短 sleep、非独立段、短延迟一律放行，保持低误伤。
 */

describe('validateBashLongSleepStatement', () => {
  test('拦截真实案例形态：sleep 570 后接检查命令', () => {
    const failure = validateBashLongSleepStatement('sleep 570; cd "D:\\ai-workspace\\人力资源" && git branch --show-current')
    expect(failure?.behavior).toBe('deny')
    expect(failure?.message).toContain('~570s')
    expect(failure?.message).toContain('Do not use Bash as a timer')
    // 引导必须是条件驱动模板，而不是教模型拼固定时长的采样循环。
    expect(failure?.message).toContain('gh pr watch')
    expect(failure?.message).toContain('break')
    expect(failure?.message).toContain('WaitFor')
  })

  test('拦截非开头位置的独立 sleep：cd 前缀与命令中段都能命中', () => {
    const probe = 'cd /d/ai-workspace/金融 && sleep 580; python -c "csv mtime"; powershell -NoProfile -Command "(Get-CimInstance Win32_Process | Measure-Object).Count"'
    const failure = validateBashLongSleepStatement(probe)
    expect(failure?.behavior).toBe('deny')
    expect(failure?.message).toContain('~580s')
    expect(validateBashLongSleepStatement('cd /d/ai-workspace/金融 && sleep 590; python -c "x"')?.behavior).toBe('deny')
    expect(validateBashLongSleepStatement('echo start; sleep 90; echo done')?.behavior).toBe('deny')
  })

  test('拦截 &&、换行与纯 sleep 三种前缀形态', () => {
    expect(validateBashLongSleepStatement('sleep 90 && git status')?.behavior).toBe('deny')
    expect(validateBashLongSleepStatement('sleep 120\ngit log -1')?.behavior).toBe('deny')
    expect(validateBashLongSleepStatement('   sleep 300')?.behavior).toBe('deny')
  })

  test('支持 s/m/h/d 单位换算与多参数相加', () => {
    expect(validateBashLongSleepStatement('sleep 2m; gh pr list')?.behavior).toBe('deny')
    expect(validateBashLongSleepStatement('sleep 1.5h; echo later')?.behavior).toBe('deny')
    expect(validateBashLongSleepStatement('sleep 1d; echo tomorrow')?.behavior).toBe('deny')
    expect(validateBashLongSleepStatement('sleep 30 40; echo 70s')?.behavior).toBe('deny')
  })

  test('放行低于 60s 的短延迟', () => {
    expect(validateBashLongSleepStatement('sleep 5; curl localhost:5173')).toBeNull()
    expect(validateBashLongSleepStatement('sleep 45')).toBeNull()
    expect(validateBashLongSleepStatement('sleep 0.5m; echo 30s')).toBeNull()
  })

  test('放行非独立 sleep 语句：循环体、子 shell 与命令内联', () => {
    expect(validateBashLongSleepStatement('for i in 1 2 3; do sleep 5; curl -sf localhost:5173 && break; done')).toBeNull()
    expect(validateBashLongSleepStatement('(sleep 300; bg-task) &')).toBeNull()
    expect(validateBashLongSleepStatement('echo "sleep 600"; date')).toBeNull()
    expect(validateBashLongSleepStatement('watch -n 60 "git status"')).toBeNull()
  })
})

describe('validateToolInput 接入', () => {
  test('bash 与 Bash 两种工具名都会触发 sleep 拦截', () => {
    expect(validateToolInput('bash', { command: 'sleep 570; gh pr list' })?.behavior).toBe('deny')
    expect(validateToolInput('Bash', { command: 'sleep 570; gh pr list' })?.behavior).toBe('deny')
  })

  test('普通 bash 命令不受影响', () => {
    expect(validateToolInput('bash', { command: 'git status --porcelain' })).toBeNull()
  })

  test('原有必填参数校验行为保持不变', () => {
    const failure = validateToolInput('TerminalExecute', {})
    expect(failure?.behavior).toBe('deny')
    expect(failure?.message).toContain('missing required parameter')
    expect(validateToolInput('TerminalExecute', { command: 'echo hi' })).toBeNull()
  })

  test('WaitFor：必填 command，且检查命令含独立分钟级 sleep 会被引导纠正', () => {
    expect(validateToolInput('WaitFor', {})?.behavior).toBe('deny')
    const failure = validateToolInput('WaitFor', { command: 'sleep 120; gh pr view 42' })
    expect(failure?.behavior).toBe('deny')
    expect(failure?.message).toContain('A check must exit 0 exactly when the condition is satisfied')
    // 正常条件检查命令放行（含短 sleep 与循环内的合理轮询）。
    expect(validateToolInput('WaitFor', { command: 'gh pr view 42 --json state -q .state | grep -q MERGED' })).toBeNull()
  })
})
