import { describe, expect, test } from 'bun:test'
import {
  validateBashPrefixSleep,
  validateToolInput,
} from './agent-tool-input-validator'

/**
 * Bash 前缀分钟级 sleep 拦截：
 * 真实案例是子 Agent 用 `sleep 570; <检查命令>` + timeout 600 凑十分钟轮询间隔，
 * 一次工具调用被空转占用数分钟。拦截仅针对“以 sleep 开头且总时长 ≥ 60s”，
 * 循环体内的短 sleep、非开头的 sleep 字样、短延迟一律放行，保持低误伤。
 */

describe('validateBashPrefixSleep', () => {
  test('拦截真实案例形态：sleep 570 后接检查命令', () => {
    const failure = validateBashPrefixSleep('sleep 570; cd "D:\\ai-workspace\\人力资源" && git branch --show-current')
    expect(failure?.behavior).toBe('deny')
    expect(failure?.message).toContain('~570s')
    expect(failure?.message).toContain('Do not use Bash as a timer')
  })

  test('拦截 &&、换行与纯 sleep 三种前缀形态', () => {
    expect(validateBashPrefixSleep('sleep 90 && git status')?.behavior).toBe('deny')
    expect(validateBashPrefixSleep('sleep 120\ngit log -1')?.behavior).toBe('deny')
    expect(validateBashPrefixSleep('   sleep 300')?.behavior).toBe('deny')
  })

  test('支持 s/m/h/d 单位换算与多参数相加', () => {
    expect(validateBashPrefixSleep('sleep 2m; gh pr list')?.behavior).toBe('deny')
    expect(validateBashPrefixSleep('sleep 1.5h; echo later')?.behavior).toBe('deny')
    expect(validateBashPrefixSleep('sleep 1d; echo tomorrow')?.behavior).toBe('deny')
    expect(validateBashPrefixSleep('sleep 30 40; echo 70s')?.behavior).toBe('deny')
  })

  test('放行低于 60s 的短延迟', () => {
    expect(validateBashPrefixSleep('sleep 5; curl localhost:5173')).toBeNull()
    expect(validateBashPrefixSleep('sleep 45')).toBeNull()
    expect(validateBashPrefixSleep('sleep 0.5m; echo 30s')).toBeNull()
  })

  test('放行非前缀 sleep：循环体内、命令中部与仅提及字样', () => {
    expect(validateBashPrefixSleep('for i in 1 2 3; do sleep 5; curl -sf localhost:5173 && break; done')).toBeNull()
    expect(validateBashPrefixSleep('echo "sleep 600"; date')).toBeNull()
    expect(validateBashPrefixSleep('sleepy 5; echo typo')).toBeNull()
    expect(validateBashPrefixSleep('watch -n 60 "git status"')).toBeNull()
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
})
