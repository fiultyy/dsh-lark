import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toSessionId } from '../src/conversation.ts'
import { applyCardAction, handleCommand, parseCommand } from '../src/commands.ts'
import type { CommandDeps, CommandMessage, OutboundPayload, OutboundSender } from '../src/commands.ts'
import { HarnessConversationService, type ConversationControls, type HarnessDependencies } from '../src/harness.ts'

type SendRecord = { payload: OutboundPayload; options?: { replyTo?: string; replyInThread?: boolean } | undefined }
interface FixtureEvent { seq: number; type: string; data: Record<string, unknown> }


function sender(): { sent: SendRecord[]; send: OutboundSender } {
  const sent: SendRecord[] = []
  return { sent, send: async (payload, options) => { sent.push({ payload, options }) } }
}

function message(overrides: Partial<CommandMessage> = {}): CommandMessage {
  return { messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', ...overrides }
}

function firstCardAction(sent: SendRecord[]): Record<string, string> {
  const card = (sent[0]!.payload as { card: { elements: Array<{ tag: string; actions?: Array<{ value: unknown }> }> } }).card
  return card.elements.flatMap(element => element.actions ?? [])[0]!.value as Record<string, string>
}

// ─── host-state mocks (sessionQuery / llm / workspaces / presets) ───────────

function hostDeps(controls: ConversationControls): CommandDeps {
  return {
    sessionQuery: {
      listSessions: vi.fn(async () => [
        { header: { version: 0, id: SessionId('s_recent'), createdAt: 1710000000000, cwd: '/proj-a' }, live: false, persisted: true },
        { header: { version: 0, id: SessionId('s_older'), createdAt: 1700000000000, cwd: '/proj-b' }, live: true, persisted: true },
      ]),
    },
    llm: {
      listProviders: vi.fn(() => [{ id: 'zhipu', name: 'Zhipu' }]),
      listModels: vi.fn(async () => [{ provider: 'zhipu', id: 'glm-5.3', name: 'GLM-5.3' }]),
    },
    workspaces: { list: vi.fn(() => [{ path: '/ws/one' }, { path: '/ws/two' }]) },
    presets: { list: vi.fn(async () => [{ id: 'standard' }, { id: 'maestro' }, { id: 'broken', broken: 'unparsable' }]) },
    controls,
    domain: 'feishu',
  }
}

// ─── agent factory mock over a persisted-session map ────────────────────────

interface FactoryFixture extends HarnessDependencies {
  create: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  cancelCalls: Array<{ kind: string }>
}

/**
 * Agent factory double. `slow` builds agents whose turn only settles when
 * `cancel()` fires (abort end committed), modelling an in-flight turn.
 */
function makeDeps(persisted: Map<string, FixtureEvent[]>, slow = false): FactoryFixture {
  let seq = 0
  const cancelCalls: Array<{ kind: string }> = []
  let releaseTurn: (() => void) | undefined
  let running = false
  const makeAgent = (sessionId: string, events: FixtureEvent[]) => ({
    session: { id: sessionId, get seq() { return seq }, events },
    get status() { return (running ? 'running' : 'idle') as 'running' | 'idle' },
    whenIdle: async () => {
      if (slow && releaseTurn !== undefined) {
        const original = releaseTurn
        await new Promise<void>(resolve => {
          releaseTurn = () => { original(); resolve(); releaseTurn = undefined }
        })
      }
    },
    followup: (msg: { content: Array<{ type: string; text?: string }> }) => {
      if (slow) {
        running = true
        releaseTurn = () => {
          running = false
          events.push({ seq: seq++, type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
        }
        return
      }
      events.push({ seq: seq++, type: 'turn/start', data: {} })
      events.push({ seq: seq++, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `answer:${msg.content[0]?.text ?? ''}` }] } } })
      events.push({ seq: seq++, type: 'turn/end', data: { reason: { kind: 'completed' } } })
    },
    cancel: (cause: { kind: string }) => {
      cancelCalls.push(cause)
      releaseTurn?.()
    },
  })
  const create = vi.fn(async (call: { sessionId: string }) => {
    const agent = makeAgent(String(call.sessionId), [])
    return { agent, dispose: vi.fn(async () => undefined) }
  })
  const resume = vi.fn(async (call: { resumeSessionId: string }) => {
    const seed = persisted.get(call.resumeSessionId)
    if (seed === undefined) throw new Error(`session "${call.resumeSessionId}" not found`)
    const agent = makeAgent(call.resumeSessionId, seed.map(event => ({ ...event })))
    return { agent, dispose: vi.fn(async () => undefined) }
  })
  const fixture = {
    create,
    resume,
    cancelCalls,
    agents: { create, resume },
    sessions: { flush: vi.fn(async () => true) },
    selection: () => ({ provider: 'default', model: 'default' }),
    agentPresets: { resolve: vi.fn(async (id?: string) => ({ id: id ?? 'default-preset' })), mount: vi.fn(async () => undefined) },
    workspaceRegistry: { list: () => [], resolveByPath: async (path: string) => ({ path, attachSession: async () => undefined }) },
  }
  return fixture as unknown as FactoryFixture
}

const tempDirs: string[] = []
afterEach(async () => { await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

async function tempPersistPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lark-commands-'))
  tempDirs.push(dir)
  return join(dir, 'bindings.json')
}

const seedTurn = (): FixtureEvent[] => [
  { seq: 0, type: 'turn/start', data: {} },
  { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'prior answer' }] } } },
  { seq: 2, type: 'turn/end', data: { reason: { kind: 'completed' } } },
]

describe('①/⑤ slash dispatch', () => {
  it('recognizes the six commands and never misfires on ordinary /x-prefixed prose', async () => {
    expect(parseCommand('/resume')?.name).toBe('resume')
    expect(parseCommand('/model glm')?.name).toBe('model')
    expect(parseCommand('/cd /ws/one')?.name).toBe('cd')
    expect(parseCommand('/new')?.name).toBe('new')
    expect(parseCommand('/stop')?.name).toBe('stop')
    expect(parseCommand('/help')?.name).toBe('help')
    // Paths, prose and non-ASCII prefixes stay with the agent.
    expect(parseCommand('/src/main.ts 请修复这个文件')).toBeUndefined()
    expect(parseCommand('看看 /resume 这个词在文档里的用法')).toBeUndefined()
    expect(parseCommand('/规范说明开头')).toBeUndefined()
    expect(parseCommand('/stop/')).toBeUndefined()
    expect(parseCommand('普通消息')).toBeUndefined()

    const controls: ConversationControls = { rebind: vi.fn(), restart: vi.fn(), cancel: vi.fn(async () => false) }
    const deps = hostDeps(controls)
    for (const name of ['resume', 'model', 'cd', 'new', 'stop', 'help'] as const) {
      const { sent, send } = sender()
      await handleCommand(deps, message(), { name, arg: '' }, send)
      expect(sent.length, name).toBe(1)
    }
  })

  it('an unknown command resolves to the help text', async () => {
    const controls: ConversationControls = { rebind: vi.fn(), restart: vi.fn(), cancel: vi.fn(async () => false) }
    const { sent, send } = sender()
    await handleCommand(hostDeps(controls), message(), parseCommand('/giveup')!, send)
    expect(sent[0]!.payload).toHaveProperty('markdown')
    expect((sent[0]!.payload as { markdown: string }).markdown).toContain('/resume')
  })
})

describe('② /resume card data, rebind, and cross-restart continuation', () => {
  it('builds the card from real sessionQuery records and rebinds to the chosen session', async () => {
    const rebind = vi.fn(async () => undefined)
    const deps = hostDeps({ rebind, restart: vi.fn(), cancel: vi.fn(async () => false) })
    const { sent, send } = sender()
    await handleCommand(deps, message(), { name: 'resume', arg: '' }, send)
    expect(deps.sessionQuery.listSessions).toHaveBeenCalledOnce()
    const card = (sent[0]!.payload as { card: { elements: Array<{ tag: string; actions?: Array<{ value: unknown }> }> } }).card
    const values = card.elements.flatMap(element => element.actions ?? []).map(option => option.value as Record<string, string>)
    expect(values).toContainEqual({ cmd: 'resume', arg: 's_recent', ck: 'chat:oc_1' })
    expect(values).toContainEqual({ cmd: 'resume', arg: 's_older', ck: 'chat:oc_1' })
    await applyCardAction(deps, { chatId: 'oc_1', action: { value: values[0] } }, send)
    expect(rebind).toHaveBeenCalledWith('chat:oc_1', SessionId('s_recent'))
  })

  it('a restarted process resumes the bound session and keeps its context', async () => {
    const persistPath = await tempPersistPath()
    const first = new HarnessConversationService(makeDeps(new Map()), { domain: 'feishu' }, { persistPath })
    await first.rebind('chat:oc_1', SessionId('lark-legacy'))

    const secondDeps = makeDeps(new Map([['lark-legacy', seedTurn()]]))
    const second = new HarnessConversationService(secondDeps, { domain: 'feishu' }, { persistPath })
    await expect(second.reply({ chatId: 'oc_1', chatType: 'p2p', content: 'continue' })).resolves.toBe('answer:continue')
    expect(secondDeps.resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: SessionId('lark-legacy') }))
    expect(secondDeps.create).not.toHaveBeenCalled()
  })
})

describe('③ /model and /cd take effect on the next turn', () => {
  it('model selection flows into the next agent options', async () => {
    const factory = makeDeps(new Map())
    const service = new HarnessConversationService(factory, { domain: 'feishu' }, { persistPath: await tempPersistPath() })
    const deps = hostDeps(service)
    const { sent, send } = sender()
    await handleCommand(deps, message(), { name: 'model', arg: '' }, send)
    const modelValue = firstCardAction(sent)
    expect(modelValue.arg).toBe('zhipu/glm-5.3')
    await applyCardAction(deps, { chatId: 'oc_1', action: { value: modelValue } }, send)
    await service.reply({ chatId: 'oc_1', chatType: 'p2p', content: 'next' })
    expect(factory.create).toHaveBeenCalledWith(expect.objectContaining({ agentOptions: { provider: 'zhipu', model: 'glm-5.3' } }))
  })

  it('cd switches the workspace and starts a fresh session id', async () => {
    const factory = makeDeps(new Map())
    const service = new HarnessConversationService(factory, { domain: 'feishu' }, { persistPath: await tempPersistPath() })
    const deps = hostDeps(service)
    const { sent, send } = sender()
    await handleCommand(deps, message(), { name: 'cd', arg: '' }, send)
    const cdValue = firstCardAction(sent)
    expect(cdValue.arg).toBe('/ws/one')
    await applyCardAction(deps, { chatId: 'oc_1', action: { value: cdValue } }, send)
    await service.reply({ chatId: 'oc_1', chatType: 'p2p', content: 'after cd' })
    const call = factory.create.mock.calls[0]![0] as { sessionId: string; meta: { cwd: string } }
    expect(call.sessionId).not.toBe(toSessionId('feishu', 'chat:oc_1'))
    expect(call.meta.cwd).toBe('/ws/one')
  })
})

describe('④ /stop cancels the in-flight turn and confirms', () => {
  it('cancels a running agent, suppresses the error reply, and reports idle on repeat', async () => {
    const factory = makeDeps(new Map(), true)
    const service = new HarnessConversationService(factory, { domain: 'feishu' }, { persistPath: await tempPersistPath() })
    const msg = { chatId: 'oc_1', chatType: 'p2p' as const, content: 'long task' }
    const delivered: string[] = []
    const failures: unknown[] = []
    const drive = service.drive(msg, async text => { delivered.push(text) }, async error => { failures.push(error) })
    await vi.waitFor(() => {
      expect(factory.create).toHaveBeenCalled()
    })
    const deps = hostDeps(service)
    const { sent, send } = sender()
    await handleCommand(deps, { ...message(), ...msg }, { name: 'stop', arg: '' }, send)
    expect((sent[0]!.payload as { markdown: string }).markdown).toBe('已停止当前任务。')
    expect(factory.cancelCalls).toEqual([{ kind: 'user' }])
    await drive
    expect(delivered).toEqual([])
    expect(failures).toEqual([])

    const { sent: secondSent, send: secondSend } = sender()
    await handleCommand(deps, { ...message(), ...msg }, { name: 'stop', arg: '' }, secondSend)
    expect((secondSent[0]!.payload as { markdown: string }).markdown).toBe('当前没有正在运行的任务。')
  })
})

describe('⑥ thread conversation keys', () => {
  it('thread cards carry the thread key and rebind only that thread', async () => {
    const rebind = vi.fn(async () => undefined)
    const deps = hostDeps({ rebind, restart: vi.fn(), cancel: vi.fn(async () => false) })
    const { sent, send } = sender()
    await handleCommand(deps, message({ chatId: 'oc_g', chatType: 'group', threadId: 'omt_9' }), { name: 'resume', arg: '' }, send)
    const value = firstCardAction(sent)
    expect(value.ck).toBe('thread:oc_g:omt_9')
    await applyCardAction(deps, { chatId: 'oc_g', action: { value } }, send)
    expect(rebind).toHaveBeenCalledWith('thread:oc_g:omt_9', SessionId('s_recent'))
  })
})
