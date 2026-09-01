import { describe, expect, test } from 'bun:test'
import {
  buildCommandMarkerEcho,
  buildOneShotSpawnPlan,
  createCommandMarkerScanner,
  generateCommandMarkerId,
} from './terminal-command-signal'

describe('buildCommandMarkerEcho', () => {
  test('posix 生成以分号开头的 printf 回显，marker ID 内嵌', () => {
    const echo = buildCommandMarkerEcho('posix', 'ab12cd34')
    expect(echo).toBe(`; printf '\\033]633;proma-done;ab12cd34:%s\\007' "$?"`)
  })

  test('powershell 生成 Write-Host 回显并读取 $LASTEXITCODE', () => {
    const echo = buildCommandMarkerEcho('powershell', 'ab12cd34')
    expect(echo).toContain('Write-Host -NoNewline')
    expect(echo).toContain('proma-done;ab12cd34:')
    expect(echo).toContain('$LASTEXITCODE')
  })

  test('cmd 不支持，返回 undefined', () => {
    expect(buildCommandMarkerEcho('cmd', 'ab12cd34')).toBeUndefined()
  })

  test('拒绝非法 marker ID', () => {
    expect(() => buildCommandMarkerEcho('posix', 'bad id!')).toThrow()
    expect(() => createCommandMarkerScanner('bad id!')).toThrow()
  })
})

describe('createCommandMarkerScanner', () => {
  test('完整输出中命中 marker 并解析退出码', () => {
    const scanner = createCommandMarkerScanner('ab12cd34')
    expect(scanner(`build ok\n${'\x1b'}]633;proma-done;ab12cd34:0\x07`)).toEqual({ exitCode: 0 })
  })

  test('跨 chunk 分片也能命中', () => {
    const scanner = createCommandMarkerScanner('ab12cd34')
    expect(scanner('running...\n')).toBeUndefined()
    expect(scanner('\x1b]633;proma')).toBeUndefined()
    expect(scanner('-done;ab12cd34:1')).toBeUndefined()
    expect(scanner('7\x07')).toEqual({ exitCode: 17 })
  })

  test('只匹配指定的 marker ID，忽略其他命令的 marker', () => {
    const scanner = createCommandMarkerScanner('first001')
    expect(scanner('\x1b]633;proma-done;otherid0:0\x07')).toBeUndefined()
    expect(scanner('\x1b]633;proma-done;first001:3\x07')).toEqual({ exitCode: 3 })
  })

  test('负数退出码（信号相关场景）可解析', () => {
    const scanner = createCommandMarkerScanner('ab12cd34')
    expect(scanner('\x1b]633;proma-done;ab12cd34:-1\x07')).toEqual({ exitCode: -1 })
  })

  test('缓冲超限后不会误报，也不会无限增长', () => {
    const scanner = createCommandMarkerScanner('ab12cd34')
    expect(scanner('x'.repeat(2_000))).toBeUndefined()
    // 被截断在缓冲外的半个 marker 不应拼成命中。
    expect(scanner('\x1b]633;proma-done;ab1')).toBeUndefined()
    expect(scanner('2cd34:0\x07')).toEqual({ exitCode: 0 })
  })
})

describe('generateCommandMarkerId', () => {
  test('生成符合 marker 规则的短 ID', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(generateCommandMarkerId()).toMatch(/^[a-z0-9]{1,32}$/)
    }
  })
})

describe('buildOneShotSpawnPlan', () => {
  test('posix 平台追加 -c 并保留登录参数', () => {
    expect(buildOneShotSpawnPlan({
      shellKind: 'posix',
      platform: 'other',
      command: 'bun test',
      interactive: { file: '/bin/zsh', args: ['-l'] },
    })).toEqual({ file: '/bin/zsh', args: ['-l', '-c', 'bun test'] })
  })

  test('非 Windows PowerShell 追加 -Command，无需引号处理', () => {
    expect(buildOneShotSpawnPlan({
      shellKind: 'powershell',
      platform: 'other',
      command: 'bun test',
      interactive: { file: 'pwsh', args: ['-NoLogo'] },
    })).toEqual({ file: 'pwsh', args: ['-NoLogo', '-Command', 'bun test'] })
  })

  test('Windows PowerShell 传裸命令，argv 转义交给 node-pty 的 MSVCRT 规则', () => {
    expect(buildOneShotSpawnPlan({
      shellKind: 'powershell',
      platform: 'win32',
      command: 'echo "hello world"',
      interactive: { file: 'powershell.exe', args: ['-NoLogo'] },
    })).toEqual({ file: 'powershell.exe', args: ['-NoLogo', '-Command', 'echo "hello world"'] })
  })

  test('Git Bash 去掉交互 -i，裸命令交给 argv 转义', () => {
    expect(buildOneShotSpawnPlan({
      shellKind: 'posix',
      platform: 'win32',
      command: 'bun run build',
      interactive: { file: 'bash.exe', args: ['--login', '-i'] },
    })).toEqual({ file: 'bash.exe', args: ['--login', '-c', 'bun run build'] })
  })

  test('WSL 走默认发行版 bash -lc，裸命令交给 argv 转义', () => {
    expect(buildOneShotSpawnPlan({
      shellKind: 'wsl',
      platform: 'win32',
      command: 'make all',
      interactive: { file: 'wsl.exe', args: [] },
    })).toEqual({ file: 'wsl.exe', args: ['bash', '-lc', 'make all'] })
  })

  test('cmd 走 /c 原样透传', () => {
    expect(buildOneShotSpawnPlan({
      shellKind: 'cmd',
      platform: 'win32',
      command: 'echo hi',
      interactive: { file: 'cmd.exe', args: [] },
    })).toEqual({ file: 'cmd.exe', args: ['/c', 'echo hi'] })
  })
})
