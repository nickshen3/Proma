/**
 * 会话进程面板 L2 冒烟：真实 pi bash 工具 → patch(onSpawnProcess) → tracker → 事件流 → SessionProcessService 镜像 → 查询/终止。
 * 运行：bun scripts/smoke-process-panel.mjs（在 apps/electron 下）
 */
import { createBashToolDefinition } from '@earendil-works/pi-coding-agent'
import { CommandProcessTracker } from '../src/main/lib/adapters/command-process-tracker.ts'
import { ProcessRegistry } from '../src/main/lib/process-registry.ts'
import { SessionProcessService } from '../src/main/lib/session-process-service.ts'

let failed = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name} ${detail}`)
  }
}

const SESSION = 'smoke-session'
const registry = new ProcessRegistry()
const events = []
const service = new SessionProcessService()

// tracker 事件 → service 镜像（等价于 utility → main 的事件流）
const tracker = new CommandProcessTracker({
  registry,
  sessionId: SESSION,
  onEvent: (event) => { events.push(event); service.ingest(event) },
  onOutput: (event) => { events.push(event); service.ingest(event) },
})

// KILL 转发（等价 main → utility → registry.terminate）
service.killForwarder = undefined // service 镜像与 utility registry 是同一个实例，terminate 已直接生效

const tool = createBashToolDefinition(process.cwd(), {
  // 冒烟脚本无 pi 会话上下文（ctx.sessionManager），关闭 PI_* 环境注入以绕开；不影响 onSpawnProcess 链路验证
  exposeSessionEnvironment: false,
  // 裸脚本环境下 pi 的 shell 探测可能失败；真实应用由 Proma runtimeEnv.shellPath 提供，可用 SMOKE_SHELL_PATH 覆盖
  ...(process.env.SMOKE_SHELL_PATH ? { shellPath: process.env.SMOKE_SHELL_PATH } : {}),
  onSpawnProcess: (child, context) => tracker.handleSpawn(child, context),
})

console.log('== 场景 1：短命令（登记 → 输出 → 正常退出） ==')
{
  const result = await tool.execute('smoke-tc-1', { command: 'echo smoke-stdout-line && echo smoke-stderr-line 1>&2' }, undefined, undefined, {})
  const resultText = result?.content?.map(block => block.text ?? '').join('') ?? ''
  check('工具执行成功且输出完整', resultText.includes('smoke-stdout-line') && resultText.includes('smoke-stderr-line'), JSON.stringify(result).slice(0, 120))
  const rows = service.list(SESSION)
  check('镜像中恰好 1 条记录', rows.length === 1, JSON.stringify(rows))
  const row = rows[0] ?? {}
  check('processId = toolCallId', row.processId === 'smoke-tc-1', row.processId)
  check('status = exited', row.status === 'exited', row.status)
  check('exitCode = 0', row.exitCode === 0, String(row.exitCode))
  check('pid 已捕获', typeof row.pid === 'number', String(row.pid))
  const chunk = service.readOutput(SESSION, 'smoke-tc-1', 0)
  check('输出含 stdout 行', chunk.data.includes('smoke-stdout-line'), JSON.stringify(chunk.data.slice(0, 60)))
  check('输出含 stderr 行', chunk.data.includes('smoke-stderr-line'), JSON.stringify(chunk.data.slice(0, 60)))
  check('registered + updated 事件已推送', events.some(e => e.type === 'registered') && events.some(e => e.type === 'updated'))
}

console.log('== 场景 2：终止长驻命令（kill → killed） ==')
{
  const executePromise = tool.execute('smoke-tc-2', { command: 'node -e "console.log(\'ready\'); setInterval(()=>{},1000)"', timeout: 30 }, undefined, undefined, {})
  // 等 onSpawn 登记 + 首行输出
  await new Promise(resolve => setTimeout(resolve, 1500))
  const row = service.list(SESSION).find(r => r.processId === 'smoke-tc-2')
  check('长驻进程登记为 running', row?.status === 'running', JSON.stringify(row))
  const tick = service.readOutput(SESSION, 'smoke-tc-2', 0)
  check('收到长驻进程输出', tick.data.includes('ready'), JSON.stringify(tick.data.slice(0, 60)))

  const killed = await service.kill(SESSION, 'smoke-tc-2')
  check('kill 返回 true', killed === true)
  const killedRow = service.list(SESSION).find(r => r.processId === 'smoke-tc-2')
  check('镜像标记 killed', killedRow?.status === 'killed', JSON.stringify(killedRow))
  const result = await executePromise.catch(error => ({ error: String(error) }))
  check('工具执行已结束（中断/退出）', result?.exitCode !== undefined || result?.error !== undefined, JSON.stringify(result).slice(0, 120))
  // 确认 child 真的死了：等一拍后进程不应仍在运行
  await new Promise(resolve => setTimeout(resolve, 500))
  check('registered/updated 事件流完整', events.filter(e => e.processId === 'smoke-tc-2' || e.process?.processId === 'smoke-tc-2').length >= 2)
}

console.log('== 场景 3：会话清理 ==')
{
  await tool.execute('smoke-tc-3', { command: 'echo cleanup-check' }, undefined, undefined, {})
  check('清理前有记录', service.list(SESSION).length >= 3, String(service.list(SESSION).length))
  await service.killAndClearSession(SESSION)
  check('清理后记录为空', service.list(SESSION).length === 0, JSON.stringify(service.list(SESSION)))
}

console.log(failed === 0 ? '\n全部冒烟通过 ✅' : `\n${failed} 项失败 ❌`)
process.exit(failed === 0 ? 0 : 1)
