import type { LarkChannel } from '@larksuiteoapi/node-sdk'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import type { Context } from '@deepseek-ai/cordis'
import type { Mock } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  HarnessConversationService,
  resolveInteractionPolicy,
  wrapUserQuestions,
  type HarnessDependencies,
  type InteractionPolicy,
} from '../src/harness.ts'
import { apply, claimAppId } from '../src/index.ts'
import { resolveConfig } from '../src/config.ts'

/** One fake SDK channel per `createLarkChannel` call, i.e. per apply cycle. */
interface ChannelRecord {
  handlers: Map<string, (payload: never) => unknown>
  connect: Mock
  disconnect: Mock
  send: Mock
  updateCard: Mock
}

const channels = vi.hoisted(() => ({ instances: [] as ChannelRecord[] }))

// Static import cannot work here: the factory must intercept the module the
// plugin under test imports, and vitest hoists vi.mock above every import.
vi.mock('@larksuiteoapi/node-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuiteoapi/node-sdk')>()
  const { vi: mockVi } = await import('vitest')
  return {
    ...actual,
    createLarkChannel: () => {
      const handlers = new Map<string, (payload: never) => unknown>()
      const record: ChannelRecord = {
        handlers,
        connect: mockVi.fn(async () => undefined),
        disconnect: mockVi.fn(async () => undefined),
        // Distinct ids keep card updates addressable across cycles.
        send: mockVi.fn(async () => ({ messageId: `om_send_${channels.instances.length + 1}` })),
        updateCard: mockVi.fn(async () => undefined),
      }
      const channel = {
        on: (name: string, handler: (payload: never) => unknown) => {
          handlers.set(name, handler)
          return () => { handlers.delete(name) }
        },
        connect: record.connect,
        disconnect: record.disconnect,
        send: record.send,
        updateCard: record.updateCard,
        downloadResource: async () => { throw new Error('downloadResource not expected in these tests') },
        rawClient: {},
      }
      channels.instances.push(record)
      return channel as unknown as LarkChannel
    },
  }
})

const tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-lark-hot-'))
const previousHome = process.env.DSH_HOME
beforeAll(() => { process.env.DSH_HOME = tmpRoot })
afterAll(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(tmpRoot, { recursive: true, force: true })
})

// ── host service doubles (shapes follow tests/harness.spec.ts) ───────────────

interface FixtureEvent {
  seq: number
  type: string
  data: { message?: { content?: Array<{ type: string; text?: string }> }; reason?: { kind: string } }
}

/** Agent-side events appended by one followup turn (answer mirrors the prompt). */
function pushAnswerTurn(events: FixtureEvent[], nextSeq: () => number, text: string): void {
  events.push({ seq: nextSeq(), type: 'turn/start', data: {} })
  events.push({ seq: nextSeq(), type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `answer:${text}` }] } } })
  events.push({ seq: nextSeq(), type: 'turn/end', data: { reason: { kind: 'completed' } } })
}

function hostServices(userQuestions: { ask: (request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer> }) {
  let eventSeq = 0
  const nextSeq = () => eventSeq++
  const agentSetupCtx = () => ({
    on: vi.fn((_name: string, _listener: unknown) => () => undefined),
    get: vi.fn(() => undefined),
    effect: vi.fn((callback: () => unknown) => async () => { void (callback() as () => unknown) }),
  })
  const create = vi.fn(async (call: { sessionId?: string; setup?: (ctx: unknown) => Promise<void> }) => {
    await call.setup?.(agentSetupCtx())
    const events: FixtureEvent[] = []
    const agent = {
      session: { id: String(call.sessionId), get seq() { return eventSeq }, events },
      whenIdle: vi.fn(async () => undefined),
      followup: vi.fn((message: { content: Array<{ type: string; text?: string }> }) => {
        pushAnswerTurn(events, nextSeq, message.content[0]?.text ?? '')
      }),
      status: 'idle' as const,
      cancel: vi.fn(),
    }
    return { agent, dispose: vi.fn(async () => undefined) }
  })
  const resume = vi.fn(async (call: { resumeSessionId?: string }) => {
    throw new Error(`session "${String(call.resumeSessionId)}" not found`)
  })
  return {
    agents: { create, resume },
    sessions: { flush: vi.fn(async () => true) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    agentPresets: { resolve: vi.fn(async () => ({ id: 'default-preset' })), mount: vi.fn(async () => undefined) },
    workspaceRegistry: {
      list: () => [{ path: '/first-workspace', attachSession: vi.fn(async () => undefined) }],
      resolveByPath: vi.fn(async () => undefined),
    },
    sessionQuery: { listSessions: vi.fn(async () => []) },
    llm: { listProviders: vi.fn(() => []), listModels: vi.fn(async () => []) },
    userQuestions,
  }
}

/** Minimal cordis-Context slice `apply` consumes; effects run LIFO on dispose. */
function makeFakeCtx(services: Record<string, unknown>, options: { failEffectAt?: number } = {}) {
  const entries: Array<{ label?: string; dispose: () => unknown }> = []
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  let effectCalls = 0
  const ctx = {
    logger,
    effect: vi.fn((execute: () => unknown, label?: string) => {
      effectCalls += 1
      if (options.failEffectAt === effectCalls) throw new Error('cannot create effect on inactive context')
      const dispose = execute() as () => unknown
      entries.unshift({ ...(label === undefined ? {} : { label }), dispose })
      return async () => {
        const index = entries.findIndex(entry => entry.dispose === dispose)
        if (index >= 0) await entries.splice(index, 1)[0]!.dispose()
      }
    }),
    get: (name: string) => services[name],
  }
  return {
    ctx: ctx as unknown as Context,
    logger,
    async disposeAll() { for (const entry of entries.splice(0)) await entry.dispose() },
    activeEffects: () => entries.map(entry => entry.label),
  }
}

const HOT_CONFIG = {
  appId: 'cli_hot',
  appSecret: 'hot_secret',
  interactionPolicy: 'deny-all' as const,
  interactionTimeoutMs: 0,
  interactionCards: true,
  cardInteractionTimeoutMs: 120000,
}

async function driveMessage(record: ChannelRecord, text: string, messageId: string) {
  await record.handlers.get('message')!({ messageId, chatId: 'oc_1', chatType: 'p2p', content: text } as never)
}

describe('① two apply → dispose cycles reload with equivalent behavior', () => {
  it('connects, answers, and tears down to zero residue in both cycles', async () => {
    const userQuestions = { ask: vi.fn(async (_request: AskUserQuestionRequest) => ({ answers: [] }) as AskUserQuestionAnswer) }
    const originalAsk = userQuestions.ask
     for (const cycle of [0, 1] as const) {
       const harness = makeFakeCtx(hostServices(userQuestions))
       await apply(harness.ctx, { ...HOT_CONFIG })
       const record = channels.instances[cycle]!
       expect(record.connect).toHaveBeenCalledTimes(1)
       expect(harness.logger.info).toHaveBeenCalledWith('dsh-lark: WebSocket connected')
      const wrappedAsk = userQuestions.ask
      expect(wrappedAsk).not.toBe(originalAsk)

      await driveMessage(record, cycle === 0 ? 'ping' : 'pong', `om_c${cycle}`)
      await vi.waitFor(() => {
        expect(record.send).toHaveBeenCalledWith('oc_1', { markdown: cycle === 0 ? 'answer:ping' : 'answer:pong' }, expect.anything())
      })

      // The app id stays claimed while the instance is live.
      expect(() => claimAppId('cli_hot')).toThrow(/already served/)

      await harness.disposeAll()
      // Zero residue: channel down and unsubscribed, wrap restored, claim free,
      // every registered effect settled.
      expect(record.disconnect).toHaveBeenCalledTimes(1)
      // The wrap is gone (restore installs the bound original, so compare
      // against the wrapper itself, not the raw mock reference).
      expect(userQuestions.ask).not.toBe(wrappedAsk)
      await expect(userQuestions.ask({ questions: [{ id: 'x', question: '?' }] } as AskUserQuestionRequest)).resolves.toEqual({ answers: [] })
    }
    // One fresh WebSocket connection per cycle, each its own SDK channel.
    expect(channels.instances).toHaveLength(2)
  })
})

describe('② a rejected reload candidate leaves the live instance untouched', () => {
  it('keeps the previous instance connected and answering when the new config is invalid', async () => {
    const userQuestions = { ask: vi.fn(async (_request: AskUserQuestionRequest) => ({ answers: [] }) as AskUserQuestionAnswer) }
    const harness = makeFakeCtx(hostServices(userQuestions))
    await apply(harness.ctx, { ...HOT_CONFIG })
    const record = channels.instances.at(-1)!

    // watchUserPatches rejects the candidate before touching the old tree.
    const { appId: _dropId, appSecret: _dropSecret, ...envOnly } = HOT_CONFIG
    await expect(apply(makeFakeCtx(hostServices(userQuestions)).ctx, {
      ...envOnly, appIdEnv: 'DSH_LARK_MISSING_VAR', appSecretEnv: 'DSH_LARK_MISSING_VAR',
    })).rejects.toThrow(/DSH_LARK_MISSING_VAR/)

    // No extra channel was created and the live instance still works.
    expect(channels.instances.at(-1)).toBe(record)
    expect(record.disconnect).not.toHaveBeenCalled()
    await driveMessage(record, 'still-alive', 'om_keep')
    await vi.waitFor(() => {
      expect(record.send).toHaveBeenCalledWith('oc_1', { markdown: 'answer:still-alive' }, expect.anything())
    })
    await harness.disposeAll()
  })
})

describe('③ userQuestions wrap restores without double-wrap or stale closures', () => {
  function policyOf(kind: InteractionPolicy['kind']): InteractionPolicy {
    return resolveInteractionPolicy({ interactionPolicy: kind, interactionTimeoutMs: 0 })
  }
  function askOf(agent: unknown, id: string): AskUserQuestionRequest {
    return { questions: [{ id, question: '继续?' }], agent } as unknown as AskUserQuestionRequest
  }

  it('passes through after restore and never double-wraps on re-apply', async () => {
    const provider = vi.fn(async (_request: AskUserQuestionRequest) => ({ answers: [] }) as AskUserQuestionAnswer)
    const service = { ask: provider }
    const agent = {}
    const restore = wrapUserQuestions(service, policyOf('allow-all'), candidate => candidate === agent, undefined)
    expect(service.ask).not.toBe(provider)
    await expect(service.ask(askOf(agent, 'q1'))).resolves.toEqual({ answers: [{ id: 'q1', selected: [], custom: '同意,请继续。' }] })
    expect(provider).not.toHaveBeenCalled()

    const wrapped = service.ask
     restore()
    expect(service.ask).not.toBe(wrapped)
    // After restore every ask — owned or not — reaches the original provider.
    await expect(service.ask(askOf(agent, 'q2'))).resolves.toEqual({ answers: [] })
    expect(provider).toHaveBeenCalledWith(askOf(agent, 'q2'))
  })

  it('a reloaded layer never clobbers a sibling instance stacked on top', async () => {
    const provider = vi.fn(async (_request: AskUserQuestionRequest) => ({ answers: [] }) as AskUserQuestionAnswer)
    const service = { ask: provider }
    const agentA = { instance: 'a' }
    const agentB = { instance: 'b' }
    const restoreA = wrapUserQuestions(service, policyOf('deny-all'), candidate => candidate === agentA, undefined)
    const restoreB = wrapUserQuestions(service, policyOf('allow-all'), candidate => candidate === agentB, undefined)

    // Instance B answers its own agent while A's layer sits beneath.
    await expect(service.ask(askOf(agentB, 'q1'))).resolves.toEqual({ answers: [{ id: 'q1', selected: [], custom: '同意,请继续。' }] })

    // A's entry reloads first: its restore must not uninstall B's wrapper.
    restoreA()
    expect(service.ask).not.toBe(provider)
    await expect(service.ask(askOf(agentB, 'q2'))).resolves.toEqual({ answers: [{ id: 'q2', selected: [], custom: '同意,请继续。' }] })

    // A's now-dead layer (still reachable through B's chain) reduces to a
    // passthrough: neither its policy nor its hub closures run.
    await expect(service.ask(askOf(agentA, 'q3'))).resolves.toEqual({ answers: [] })
    expect(provider).toHaveBeenCalledWith(askOf(agentA, 'q3'))
    const wrappedB = service.ask
     restoreB()
    expect(service.ask).not.toBe(wrappedB)
  })
})

describe('④ literal credentials win over env names; env path intact', () => {
  const ID_VAR = 'DSH_LARK_HOT_ID'
  const SECRET_VAR = 'DSH_LARK_HOT_SECRET'

  beforeAll(() => {
    process.env[ID_VAR] = 'cli_from_env'
    process.env[SECRET_VAR] = 'env_secret'
  })
  afterAll(() => {
    delete process.env[ID_VAR]
    delete process.env[SECRET_VAR]
  })

  it('prefers non-empty literals when both are configured', () => {
    const resolved = resolveConfig({
      appId: 'cli_literal', appSecret: 'literal_secret',
      appIdEnv: ID_VAR, appSecretEnv: SECRET_VAR,
    })
    expect(resolved).toMatchObject({ appId: 'cli_literal', appSecret: 'literal_secret' })
  })

  it('falls back to the named env vars when literals are absent', () => {
    const resolved = resolveConfig({ appIdEnv: ID_VAR, appSecretEnv: SECRET_VAR })
    expect(resolved).toMatchObject({ appId: 'cli_from_env', appSecret: 'env_secret' })
  })

  it('fails loud when the named env var is missing, and when neither path is set', () => {
    expect(() => resolveConfig({ appIdEnv: 'DSH_LARK_HOT_MISSING', appSecretEnv: SECRET_VAR }))
      .toThrow(/DSH_LARK_HOT_MISSING/)
    expect(() => resolveConfig({ appIdEnv: ID_VAR, appSecretEnv: 'DSH_LARK_HOT_MISSING' }))
      .toThrow(/DSH_LARK_HOT_MISSING/)
    expect(() => resolveConfig({})).toThrow(/appId is required/)
    expect(() => resolveConfig({ appId: 'id' })).toThrow(/appSecret is required/)
  })

  it('keeps the plain literal path (host `!!js` interpolation lands here) unchanged', () => {
    expect(resolveConfig({ appId: 'id', appSecret: 'secret' })).toMatchObject({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true,
    })
  })
})

describe('⑤ bridge state across a reload: chains cleared, bindings retained', () => {
  function conversationDeps(): { deps: HarnessDependencies; create: Mock } {
    let eventSeq = 0
    const create = vi.fn(async (call: { sessionId?: string }) => {
      const events: FixtureEvent[] = []
      const agent = {
        session: { id: String(call.sessionId), get seq() { return eventSeq }, events },
        whenIdle: vi.fn(async () => undefined),
        followup: vi.fn((message: { content: Array<{ type: string; text?: string }> }) => {
          pushAnswerTurn(events, () => eventSeq++, message.content[0]?.text ?? '')
        }),
        status: 'idle' as const,
        cancel: vi.fn(),
      }
      return { agent, dispose: vi.fn(async () => undefined) }
    })
    const deps: HarnessDependencies = {
      agents: { create, resume: async (call: { resumeSessionId?: string }) => { throw new Error(`session "${String(call.resumeSessionId)}" not found`) } },
      sessions: { flush: async () => true },
      selection: () => ({ provider: 'p', model: 'm' }),
      agentPresets: { resolve: async () => ({ id: 'default-preset' }), mount: async () => undefined },
      workspaceRegistry: { list: () => [], resolveByPath: async () => undefined },
    } as unknown as HarnessDependencies
    return { deps, create }
  }

  it('clears per-key chains and handles on dispose, and a fresh instance restores persisted bindings', async () => {
    const { deps } = conversationDeps()
    const persistPath = join(tmpRoot, 'bindings-reload.json')

    const first = new HarnessConversationService(deps, { domain: 'feishu' }, { persistPath })
    const delivered: string[] = []
    await first.drive({ chatId: 'oc_1', chatType: 'p2p', content: 'one' }, async text => { delivered.push(text) }, async () => undefined)
    expect(delivered).toEqual(['answer:one'])
    await first.rebind('chat:oc_1', SessionId('feishu://v2/oc_1/hot-reload'))
    const internals = first as unknown as {
      chains: Map<string, unknown>
      handles: Map<string, unknown>
      activeTurns: Set<string>
      stopFlags: Set<string>
    }
    expect(internals.chains.size).toBe(1)

    await first.dispose()
    expect(internals.chains.size).toBe(0)
    expect(internals.handles.size).toBe(0)
    expect(internals.activeTurns.size).toBe(0)
    expect(internals.stopFlags.size).toBe(0)

    // The next instance — what an entry reload constructs — starts from the
    // persisted bindings, never from the disposed instance's in-memory state.
    const second = new HarnessConversationService(deps, { domain: 'feishu' }, { persistPath })
    const restored = second as unknown as { bindings: Map<string, unknown> }
    expect(restored.bindings.get('chat:oc_1')).toBe('feishu://v2/oc_1/hot-reload')
  })
})

describe('⑥ context disposed mid-apply still tears the channel down', () => {
  it('stops the freshly connected channel when effect registration is rejected', async () => {
    const userQuestions = { ask: vi.fn(async (_request: AskUserQuestionRequest) => ({ answers: [] }) as AskUserQuestionAnswer) }
    // Effects register claim(1), wrap(2), channel teardown(3); rejecting the
    // third emulates a fiber unloaded while apply awaited the connection.
    const harness = makeFakeCtx(hostServices(userQuestions), { failEffectAt: 3 })
    await expect(apply(harness.ctx, { ...HOT_CONFIG })).rejects.toThrow(/inactive context/)
    const record = channels.instances.at(-1)!
    expect(record.connect).toHaveBeenCalledTimes(1)
    expect(record.disconnect).toHaveBeenCalledTimes(1)
    expect(record.handlers.size).toBe(0)
    // The fiber teardown cordis performs on unload runs the disposers that
    // DID register before the failure; mirror that, then the claim is free.
    await harness.disposeAll()
    expect(() => { claimAppId('cli_hot')() }).not.toThrow()
  })
})
