import { describe, expect, it, vi } from 'vitest'
import { toSessionId } from '../src/conversation.ts'
import { HarnessConversationService, type HarnessDependencies } from '../src/harness.ts'

interface FixtureEvent {
  seq: number
  type: string
  data: {
    message?: { content?: Array<{ type: string; text?: string }> }
    reason?: { kind: string }
  }
}

interface FixtureAgent {
  session: { id: string; seq: number; events: FixtureEvent[] }
  whenIdle: ReturnType<typeof vi.fn>
  followup: ReturnType<typeof vi.fn>
}

interface SetupCapableCall {
  sessionId?: string
  resumeSessionId?: string
  agentOptions?: { provider: string; model: string }
  meta?: { cwd: string; agentPreset: string }
  setup?: (agentCtx: unknown) => Promise<void>
}

function fixture() {
  let seq = 0
  const agents = new Map<string, FixtureAgent>()
  // Sessions persisted by a previous process run, keyed by session id: resume
  // succeeds only for ids present here, mirroring the real backend's
  // `session "<id>" not found` rejection for everything else.
  const persisted = new Map<string, FixtureEvent[]>()
  const makeAgent = (sessionId: string, events: FixtureEvent[]): FixtureAgent => ({
    session: { id: sessionId, get seq() { return seq }, events },
    whenIdle: vi.fn(async () => undefined),
    followup: vi.fn((message: { content: Array<{ type: string; text?: string }> }) => {
      events.push({ seq: seq++, type: 'turn/start', data: {} })
      events.push({ seq: seq++, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `answer:${message.content[0]?.text ?? ''}` }] } } })
      events.push({ seq: seq++, type: 'turn/end', data: { reason: { kind: 'completed' } } })
    }),
  })
  const create = vi.fn(async (call: SetupCapableCall) => {
    const agent = makeAgent(String(call.sessionId), [])
    agents.set(String(call.sessionId), agent)
    return { agent, dispose: vi.fn(async () => undefined) }
  })
  const resume = vi.fn(async (call: SetupCapableCall) => {
    const sessionId = String(call.resumeSessionId)
    const seed = persisted.get(sessionId)
    if (seed === undefined) throw new Error(`session "${sessionId}" not found`)
    const agent = makeAgent(sessionId, seed.map(event => ({ ...event })))
    agents.set(sessionId, agent)
    return { agent, dispose: vi.fn(async () => undefined) }
  })
  const flush = vi.fn(async () => true)
  const workspace = { path: '/first-workspace', attachSession: vi.fn(async () => undefined) }
  const mount = vi.fn(async () => undefined)
  const resolve = vi.fn(async (id?: string) => ({ id: id ?? 'default-preset' }))
  // A completed prior turn as a previous process run would have flushed it.
  const seedTurn = (): FixtureEvent[] => [
    { seq: seq++, type: 'turn/start', data: {} },
    { seq: seq++, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'prior answer' }] } } },
    { seq: seq++, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]
  return { create, resume, persisted, seedTurn, flush, agents, workspace, mount, resolve }
}

// Mocks model the factory seam loosely; the typed service consumes them.
function dependencies(f: ReturnType<typeof fixture>): HarnessDependencies {
  return {
    agents: { create: f.create, resume: f.resume },
    sessions: { flush: f.flush },
    selection: () => ({ provider: 'p', model: 'm' }),
    agentPresets: { resolve: f.resolve, mount: f.mount },
    workspaceRegistry: { list: () => [f.workspace], resolveByPath: vi.fn(async () => undefined) },
  } as unknown as HarnessDependencies
}

describe('HarnessConversationService', () => {
  it('lazily creates and reuses one agent for the same conversation', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu', workspace: '/work' })
    await expect(service.reply({ chatId: 'oc_1', chatType: 'p2p', content: 'one' })).resolves.toBe('answer:one')
    await expect(service.reply({ chatId: 'oc_1', chatType: 'p2p', content: 'two' })).resolves.toBe('answer:two')
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(f.flush).toHaveBeenCalledTimes(2)
  })

  it('isolates different chats and honors an explicit model route', async () => {
    const f = fixture()
    const deps = dependencies(f)
    deps.selection = () => ({ provider: 'default', model: 'default' })
    const service = new HarnessConversationService(deps, { domain: 'lark', workspace: '/work', provider: 'custom', model: 'model' })
    await service.reply({ chatId: 'a', chatType: 'p2p', content: 'one' })
    await service.reply({ chatId: 'b', chatType: 'p2p', content: 'two' })
    expect(f.create).toHaveBeenCalledTimes(2)
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({ agentOptions: { provider: 'custom', model: 'model' }, meta: { cwd: '/work', agentPreset: 'default-preset' } }))
  })

  it('uses the first registered workspace and mounts the default agent preset', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    await service.reply({ chatId: 'a', chatType: 'p2p', content: 'one' })
    const options = f.create.mock.calls[0]![0]
    expect(options.meta).toEqual({ cwd: '/first-workspace', agentPreset: 'default-preset' })
    const agentCtx = { on: vi.fn(() => () => undefined) }
    await options.setup?.(agentCtx)
    expect(f.resolve).toHaveBeenCalledWith(undefined)
    expect(f.mount).toHaveBeenCalledWith(agentCtx, 'default-preset')
    expect(f.workspace.attachSession).toHaveBeenCalledWith(options.sessionId)
  })

  it('uses and mounts an explicitly configured workspace and preset', async () => {
    const f = fixture()
    const explicit = { path: '/configured', attachSession: vi.fn(async () => undefined) }
    const deps = dependencies(f)
    deps.workspaceRegistry = { list: () => [], resolveByPath: vi.fn(async () => explicit) }
    const service = new HarnessConversationService(deps, { domain: 'feishu', workspace: '/configured', agentPreset: 'coding' })
    await service.reply({ chatId: 'a', chatType: 'p2p', content: 'one' })
    const options = f.create.mock.calls[0]![0]
    await options.setup?.({ on: vi.fn(() => () => undefined) })
    expect(f.resolve).toHaveBeenCalledWith('coding')
    expect(explicit.attachSession).toHaveBeenCalledWith(options.sessionId)
  })

  it('disposes a newly created agent when workspace attachment fails', async () => {
    const f = fixture()
    f.workspace.attachSession.mockRejectedValueOnce(new Error('attach failed'))
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    await expect(service.reply({ chatId: 'a', chatType: 'p2p', content: 'one' })).rejects.toThrow('attach failed')
    const handle = await f.create.mock.results[0]!.value
    expect(handle.dispose).toHaveBeenCalledOnce()
  })

  it('rejects a turn that commits no successful assistant answer', async () => {
    const create = vi.fn(async ({ sessionId }: { sessionId: string }) => ({ agent: { session: { id: sessionId, seq: 0, events: [{ seq: 0, type: 'turn/end', data: { reason: { kind: 'error' } } }] }, whenIdle: async () => undefined, followup() {} }, dispose: async () => undefined }))
    const resumeMiss = async (call: SetupCapableCall) => {
      throw new Error(`session "${String(call.resumeSessionId)}" not found`)
    }
    const deps: HarnessDependencies = {
      agents: { create, resume: resumeMiss },
      sessions: { flush: async () => true },
      selection: () => ({ provider: 'p', model: 'm' }),
      agentPresets: { resolve: async () => ({ id: 'default' }), mount: async () => undefined },
      workspaceRegistry: { list: () => [], resolveByPath: async () => undefined },
    } as unknown as HarnessDependencies
    const service = new HarnessConversationService(deps, { domain: 'feishu', workspace: '/work' })
    await expect(service.reply({ chatId: 'a', chatType: 'p2p', content: 'one' })).rejects.toThrow(/successful assistant response/)
  })
})

describe('resume-first session continuation', () => {
  it('resumes the persisted session and never calls create', async () => {
    const f = fixture()
    const deps = dependencies(f)
    deps.workspaceRegistry = { list: () => [], resolveByPath: vi.fn(async () => f.workspace) }
    const sessionId = toSessionId('feishu', 'chat:oc_persist')
    f.persisted.set(String(sessionId), f.seedTurn())
    const service = new HarnessConversationService(deps, { domain: 'feishu', workspace: '/work' })
    await expect(service.reply({ chatId: 'oc_persist', chatType: 'p2p', content: 'again' })).resolves.toBe('answer:again')
    expect(f.resume).toHaveBeenCalledTimes(1)
    expect(f.resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: sessionId }))
    expect(f.create).not.toHaveBeenCalled()
    expect(f.workspace.attachSession).toHaveBeenCalledWith(sessionId)
    const agent = f.agents.get(String(sessionId))!
    expect(agent.session.events.some(event =>
      event.type === 'assistant/message' && event.data.message?.content?.[0]?.text === 'prior answer')).toBe(true)
  })

  it('falls back to create when no persisted session exists', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu', workspace: '/work' })
    await expect(service.reply({ chatId: 'oc_fresh', chatType: 'p2p', content: 'one' })).resolves.toBe('answer:one')
    expect(f.resume).toHaveBeenCalledTimes(1)
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(f.resume.mock.invocationCallOrder[0]!).toBeLessThan(f.create.mock.invocationCallOrder[0]!)
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: toSessionId('feishu', 'chat:oc_fresh'),
      meta: { cwd: '/work', agentPreset: 'default-preset' },
    }))
  })

  it('mounts the preset and model route through the resume setup call', async () => {
    const f = fixture()
    const sessionId = toSessionId('feishu', 'chat:oc_setup')
    f.persisted.set(String(sessionId), f.seedTurn())
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu', workspace: '/work', provider: 'custom', model: 'model', agentPreset: 'coding' })
    await expect(service.reply({ chatId: 'oc_setup', chatType: 'p2p', content: 'one' })).resolves.toBe('answer:one')
    const call = f.resume.mock.calls[0]![0]
    expect(call.resumeSessionId).toBe(sessionId)
    expect(call.agentOptions).toEqual({ provider: 'custom', model: 'model' })
    expect(f.resolve).toHaveBeenCalledWith('coding')
    expect(f.create).not.toHaveBeenCalled()
    const agentCtx = { on: vi.fn(() => () => undefined) }
    await call.setup?.(agentCtx)
    expect(f.mount).toHaveBeenCalledWith(agentCtx, 'coding')
  })

  it('surfaces a resume failure instead of replacing the persisted session', async () => {
    const f = fixture()
    const sessionId = toSessionId('feishu', 'chat:oc_broken')
    f.persisted.set(String(sessionId), f.seedTurn())
    f.resume.mockImplementationOnce(async (call: SetupCapableCall) => {
      throw new Error(`session "${String(call.resumeSessionId)}" was written by a newer harness`)
    })
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu', workspace: '/work' })
    await expect(service.reply({ chatId: 'oc_broken', chatType: 'p2p', content: 'one' })).rejects.toThrow(/newer harness/)
    expect(f.create).not.toHaveBeenCalled()
    expect(f.persisted.has(String(sessionId))).toBe(true)
  })
})
