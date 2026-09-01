import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import {
  buildCommandMarkerEcho,
  buildOneShotSpawnPlan,
  createCommandMarkerScanner,
  generateCommandMarkerId,
  type NodePlatform,
  type ShellSpawnPlan,
} from './terminal-command-signal'

/**
 * 命令结束信号的真实 shell 端到端验证。
 *
 * 单元测试只覆盖纯函数与 mock 状态机，无法证明两件事：
 * 1. marker 回显指令（printf 八进制转义、PowerShell 5.1 的 [char]27 与 $LASTEXITCODE）
 *    在真实 shell 语法下成立，且扫描器能从真实 stdout 解析出退出码；
 * 2. one-shot spawn 参数经标准 MSVCRT argv 转义（node-pty 的 argsToCommandLine 与
 *    child_process 默认行为一致）后，含空格/双引号的命令在真实 shell 下完整执行。
 *
 * 驱动方式：
 * - marker：经 stdin 逐行喂给 shell（powershell -Command - / bash -s），
 *   贴近 PTY 往交互 shell 写入的语义，不引入额外引号层；
 * - one-shot：直接把 buildOneShotSpawnPlan 的 argv 交给 child_process.spawn
 *   （win32 默认 MSVCRT 转义，等价 node-pty 数组路径）。
 *
 * 环境缺少对应 shell 时用例自动跳过，不影响跨平台 CI。
 */

const IS_WIN = process.platform === 'win32'
const PLATFORM: NodePlatform = IS_WIN ? 'win32' : 'other'
const RUN_TIMEOUT_MS = 20_000

function firstExisting(paths: string[]): string | undefined {
  for (const path of paths) {
    try {
      if (existsSync(path)) return path
    } catch {
      // 探测失败视为不存在。
    }
  }
  return undefined
}

const windowsPowerShell = IS_WIN
  ? firstExisting([join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')])
  : firstExisting(['/usr/local/bin/pwsh', '/opt/homebrew/bin/pwsh', '/usr/bin/pwsh'])
const cmdExe = IS_WIN ? (process.env.ComSpec || 'cmd.exe') : undefined
const gitBash = IS_WIN
  ? firstExisting([
      join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
      'D:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
      'D:\\Program Files\\Git\\usr\\bin\\bash.exe',
    ])
  : undefined
const posixBash = IS_WIN ? undefined : firstExisting(['/bin/bash', '/usr/bin/bash'])

interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
}

function runShell(file: string, args: string[], options: { feed?: string } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env: { ...process.env, TERM: 'dumb' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`shell 执行超时：${file} ${args.join(' ')}`))
    }, RUN_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode: code ?? -1 })
    })
    if (options.feed !== undefined) {
      child.stdin.write(options.feed)
      child.stdin.end()
    }
  })
}

/** 执行一次性 spawn 计划，验证其在真实 shell 下运行。 */
function runOneShot(plan: ShellSpawnPlan): Promise<RunResult> {
  return runShell(plan.file, plan.args)
}

const powershellTest = windowsPowerShell ? test : test.skip
const cmdTest = cmdExe ? test : test.skip
const gitBashTest = gitBash ? test : test.skip
const posixBashTest = posixBash ? test : test.skip
const bashLikeTest = gitBash ?? posixBash ? test : test.skip

describe('marker 回显指令（复用终端等待路径）', () => {
  powershellTest('PowerShell：命令成功后回显 OSC 633 marker，扫描器从真实 stdout 解析退出码 0', async () => {
    const markerId = generateCommandMarkerId()
    const echo = buildCommandMarkerEcho('powershell', markerId)!
    const { stdout } = await runShell(windowsPowerShell!, ['-NoProfile', '-Command', '-'], {
      feed: `Write-Output proma-ok${echo}\r\n`,
    })
    expect(stdout).toContain('proma-ok')
    expect(createCommandMarkerScanner(markerId)(stdout)).toEqual({ exitCode: 0 })
  }, RUN_TIMEOUT_MS)

  powershellTest('PowerShell：原生命令非零退出时 $LASTEXITCODE 正确进入 marker', async () => {
    const markerId = generateCommandMarkerId()
    const echo = buildCommandMarkerEcho('powershell', markerId)!
    const { stdout } = await runShell(windowsPowerShell!, ['-NoProfile', '-Command', '-'], {
      feed: `cmd /c exit 3${echo}\r\n`,
    })
    expect(createCommandMarkerScanner(markerId)(stdout)).toEqual({ exitCode: 3 })
  }, RUN_TIMEOUT_MS)

  bashLikeTest('bash：printf 八进制转义输出完整 marker，扫描器解析退出码 0', async () => {
    const bash = gitBash ?? posixBash!
    const markerId = generateCommandMarkerId()
    const echo = buildCommandMarkerEcho('posix', markerId)!
    const { stdout } = await runShell(bash, ['-s'], { feed: `echo proma-ok${echo}\n` })
    expect(stdout).toContain('proma-ok')
    expect(createCommandMarkerScanner(markerId)(stdout)).toEqual({ exitCode: 0 })
  }, RUN_TIMEOUT_MS)

  bashLikeTest('bash："$?" 捕获原生命令非零退出码', async () => {
    const bash = gitBash ?? posixBash!
    const markerId = generateCommandMarkerId()
    const echo = buildCommandMarkerEcho('posix', markerId)!
    const { stdout } = await runShell(bash, ['-s'], { feed: `sh -c 'exit 7'${echo}\n` })
    expect(createCommandMarkerScanner(markerId)(stdout)).toEqual({ exitCode: 7 })
  }, RUN_TIMEOUT_MS)
})

describe('one-shot spawn 参数（新终端等待路径）', () => {
  powershellTest('PowerShell：简单命令经 MSVCRT argv 转义后执行并返回退出码 0', async () => {
    const plan = buildOneShotSpawnPlan({
      shellKind: 'powershell',
      platform: PLATFORM,
      command: 'Write-Output oneshot-ok',
      interactive: { file: windowsPowerShell!, args: ['-NoLogo'] },
    })
    const { stdout, exitCode } = await runOneShot(plan)
    expect(exitCode).toBe(0)
    expect(stdout).toContain('oneshot-ok')
  }, RUN_TIMEOUT_MS)

  powershellTest('PowerShell：含空格与双引号的命令经 argv 转义后完整执行', async () => {
    const plan = buildOneShotSpawnPlan({
      shellKind: 'powershell',
      platform: PLATFORM,
      command: 'Write-Output "hello world"',
      interactive: { file: windowsPowerShell!, args: ['-NoLogo'] },
    })
    const { stdout, exitCode } = await runOneShot(plan)
    expect(exitCode).toBe(0)
    expect(stdout).toContain('hello world')
  }, RUN_TIMEOUT_MS)

  powershellTest('PowerShell：非零退出码精确回传', async () => {
    const plan = buildOneShotSpawnPlan({
      shellKind: 'powershell',
      platform: PLATFORM,
      command: 'exit 5',
      interactive: { file: windowsPowerShell!, args: ['-NoLogo'] },
    })
    const { exitCode } = await runOneShot(plan)
    expect(exitCode).toBe(5)
  }, RUN_TIMEOUT_MS)

  cmdTest('cmd：/c 透传执行命令并回传退出码', async () => {
    const echoPlan = buildOneShotSpawnPlan({
      shellKind: 'cmd',
      platform: PLATFORM,
      command: 'echo cmd-ok',
      interactive: { file: cmdExe!, args: [] },
    })
    const echoed = await runOneShot(echoPlan)
    expect(echoed.exitCode).toBe(0)
    expect(echoed.stdout).toContain('cmd-ok')

    const exitPlan = buildOneShotSpawnPlan({
      shellKind: 'cmd',
      platform: PLATFORM,
      command: 'exit 4',
      interactive: { file: cmdExe!, args: [] },
    })
    expect((await runOneShot(exitPlan)).exitCode).toBe(4)
  }, RUN_TIMEOUT_MS)

  gitBashTest('Git Bash：--login -c 执行含双引号命令', async () => {
    const plan = buildOneShotSpawnPlan({
      shellKind: 'posix',
      platform: PLATFORM,
      command: 'echo "a b"',
      interactive: { file: gitBash!, args: ['--login', '-i'] },
    })
    const { stdout, exitCode } = await runOneShot(plan)
    expect(exitCode).toBe(0)
    expect(stdout).toContain('a b')
  }, RUN_TIMEOUT_MS)

  posixBashTest('POSIX bash：-l -c 执行含双引号命令', async () => {
    const plan = buildOneShotSpawnPlan({
      shellKind: 'posix',
      platform: PLATFORM,
      command: 'echo "a b"',
      interactive: { file: posixBash!, args: ['-l'] },
    })
    const { stdout, exitCode } = await runOneShot(plan)
    expect(exitCode).toBe(0)
    expect(stdout).toContain('a b')
  }, RUN_TIMEOUT_MS)
})
