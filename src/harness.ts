import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { conversationKey, summarizeTurn, toSessionId } from './conversation.ts'
import type { ConversationMessage } from './conversation.ts'
import type { DomainName, InteractionPolicyKind } from './config.ts'
import type { InteractionCardHub } from './card-answerer.ts'
import { TurnStreamCard, installAgentStreamForwarder } from './stream.ts'
import type { StreamAgentContext } from './stream.ts'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { composeUserText } from './media.ts'
import type { InboundFileNote, SenderLabel } from './media.ts'

/** Resolved machine-answer policy for ask/approval fallback. */
export interface InteractionPolicy {
  readonly kind: InteractionPolicyKind
  readonly askAnswer?: string
  readonly approvalAllow: boolean
  readonly timeoutMs: number
}

export function resolveInteractionPolicy(policy: {
  interactionPolicy: InteractionPolicyKind
  interactionTimeoutMs: number
  askAutoAnswer?: string
  approvalAllow?: boolean
}): InteractionPolicy {
  return {
    kind: policy.interactionPolicy,
    ...(policy.askAutoAnswer === undefined ? {} : { askAnswer: policy.askAutoAnswer }),
    approvalAllow: policy.approvalAllow ?? false,
    timeoutMs: policy.interactionTimeoutMs,
  }
}

const DENY_ASK_TEXT = '请不向用户提问,直接完成本轮并给出最终答复。'
const ALLOW_ASK_TEXT = '同意,请继续。'

/** One question's machine answer under the policy. */
function answerItemFor(
  policy: InteractionPolicy,
  question: AskUserQuestionRequest['questions'][number],
): AskUserQuestionAnswer['answers'][number] {
  // Options questions take the first option under every non-off policy —
  // selecting beats free text when the form offers concrete choices.
  const first = question.options?.[0]?.label
  if (first !== undefined) return { id: question.id, selected: [first] }
  return { id: question.id, selected: [], custom: policy.askAnswer ?? (policy.kind === 'deny-all' ? DENY_ASK_TEXT : ALLOW_ASK_TEXT) }
}

export function askAnswerFor(policy: InteractionPolicy, request: AskUserQuestionRequest): AskUserQuestionAnswer {
  return { answers: request.questions.map(question => answerItemFor(policy, question)) }
}

export function approvalOutcomeFor(policy: InteractionPolicy): ApprovalOutcome {
  if (policy.kind === 'allow-all') return 'allowed-once'
  if (policy.kind === 'deny-all') return 'rejected'
  return policy.approvalAllow ? 'allowed-once' : 'rejected'
}

/** Wait the fallback window unless the owning signal aborts first. */
function waitForFallbackWindow(ms: number, signal: AbortSignal | undefined): Promise<'ok' | 'aborted'> {
  if (ms <= 0) return Promise.resolve(signal?.aborted === true ? 'aborted' : 'ok')
  const { promise, resolve } = Promise.withResolvers<'ok' | 'aborted'>()
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort)
    resolve('ok')
  }, ms)
  const onAbort = (): void => {
    clearTimeout(timer)
    resolve('aborted')
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  return promise
}

const INTERACTION_GUIDANCE = [
  'You are serving a Feishu/Lark chat channel where mid-turn human interaction is unreliable.',
  'Prefer finishing the current turn with a complete, self-contained final answer instead of pausing to ask questions or request confirmations.',
  'If you must ask, assume the answer may come from an automatic policy fallback rather than a human.',
].join(' ')

/** Minimal agent-context face the fallback registrations need. */
export type FallbackAgentContext = Parameters<typeof installModelSelection>[0] & {
  on(name: 'approval/request', listener: (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>, prepend?: boolean): () => void
  get(service: 'systemPrompt'): { section(section: { name: string; order: number; text: string }): () => void } | undefined
  effect(callback: () => () => void, label?: string): void
}

/**
 * Register the machine-answer fallback on one agent's setup context:
 * - a prepended, agent-scoped `approval/request` listener that decides after
 *   the fallback window (a human/card answerer registered ahead of us in the
 *   waterfall can still answer inside it) — the approval service keeps
 *   writing its `approval/asked`/`approval/decided` audit pair around us;
 * - a scoped system-prompt section telling the model to prefer final answers.
 */
export function installAgentInteractionFallback(
  agentCtx: FallbackAgentContext,
  policy: InteractionPolicy,
  logger: { info(message: string): unknown } | undefined,
): void {
  const stopApproval = agentCtx.on('approval/request', async (req, next) => {
    const window = await waitForFallbackWindow(policy.timeoutMs, req.signal)
    if (window === 'aborted') return 'cancelled'
    const outcome = approvalOutcomeFor(policy)
    logger?.info(`dsh-lark: approval for ${req.toolName} auto-decided ${outcome} (policy ${policy.kind})`)
    return outcome
  }, true)
  agentCtx.effect(() => stopApproval, 'dsh-lark: approval fallback')
  const systemPrompt = agentCtx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    const stopSection = systemPrompt.section({
      name: 'dsh-lark:interaction-policy',
      order: 160,
      text: INTERACTION_GUIDANCE,
    })
    agentCtx.effect(() => stopSection, 'dsh-lark: interaction guidance')
  }
}

/**
 * Register the Feishu-card answerer on one agent's setup context: a
 * prepended, agent-scoped `approval/request` listener that shows an
 * allow/deny card in the agent's conversation and waits for a button,
 * the card timeout, or abort. A click decides; a timeout/absent target
 * delegates to the next listener (the machine policy fallback LK-002
 * installs behind us, then the service's fail-closed default). Registered
 * BEFORE that fallback so the card owns the first decision slot.
 */
export function installAgentCardAnswerer(
  agentCtx: FallbackAgentContext,
  hub: InteractionCardHub,
  options: { timeoutMs: number; policy: InteractionPolicy },
  logger: { info(message: string): unknown } | undefined,
): void {
  const stopApproval = agentCtx.on('approval/request', async (req, next) => {
    const target = hub.targetFor(req.agent)
    if (target === undefined) return next()
    const timeoutNote = options.policy.kind === 'off'
      ? '等待超时，未收到点击。'
      : `等待超时，已按策略（${options.policy.kind}）自动决定。`
    const result = await hub.approvalCard(target, { toolName: req.toolName, reason: req.reason }, {
      ...(req.signal === undefined ? {} : { signal: req.signal }),
      timeoutMs: options.timeoutMs,
      timeoutNote,
    })
    if (result.kind === 'decided') {
      logger?.info(`dsh-lark: approval for ${req.toolName} decided ${result.outcome} via card`)
      return result.outcome
    }
    if (result.kind === 'cancelled') return 'cancelled'
    logger?.info(`dsh-lark: approval card for ${req.toolName} fell through (${result.kind}); delegating`)
    return next()
  }, true)
  agentCtx.effect(() => stopApproval, 'dsh-lark: approval card answerer')
}

/** Service face `wrapUserQuestions` needs; the host service satisfies it. */
export interface UserQuestionsLike {
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
}

/**
 * Wrap the shared userQuestions service so ask-style tool calls from agents
 * owned by this plugin settle from an interaction card and, failing that,
 * the machine policy instead of hanging on an answerer for a channel the
 * user cannot reach. Other agents' asks pass through untouched. Returns a
 * restore function.
 */
export function wrapUserQuestions(
  service: UserQuestionsLike,
  policy: InteractionPolicy,
  ownsAgent: (agent: unknown) => boolean,
  logger: { info(message: string): unknown } | undefined,
  cards?: { hub: InteractionCardHub; timeoutMs: number },
): () => void {
  const original = service.ask.bind(service)
  const cardAsk = async (request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer | undefined> => {
    if (cards === undefined) return undefined
    const target = cards.hub.targetFor(request.agent)
    if (target === undefined) return undefined
    const timeoutNote = policy.kind === 'off'
      ? '等待超时，未收到点击。'
      : `等待超时，已按策略（${policy.kind}）自动作答。`
    const result = await cards.hub.askCard(target, request, {
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      timeoutMs: cards.timeoutMs,
      timeoutNote,
    })
    if (result.kind === 'cancelled') {
      throw new Error('ask_user_question was aborted before the card was answered')
    }
    if (result.kind === 'unavailable') return undefined
    // 'answered' (every option question clicked) or 'timeout': merge what
    // the human picked with the machine policy's answer for the rest.
    const answered = result.kind === 'answered'
      || (policy.kind !== 'off' && result.kind === 'timeout')
    if (!answered) {
      throw new Error('ask_user_question card timed out with no machine policy configured')
    }
    const answers = request.questions.map((question, index) => {
      const picked = result.picked.get(index)
      return picked !== undefined && picked.selected.length > 0
        ? picked
        : answerItemFor(policy, question)
    })
    logger?.info(`dsh-lark: ask settled for ${answers.length} question(s) via card (${result.kind})`)
    return { answers }
  }
  service.ask = (request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> => {
    if (!ownsAgent(request.agent)) return original(request)
    if (policy.kind === 'off' && cards === undefined) return original(request)
    return cardAsk(request).then(answer => {
      if (answer !== undefined) return answer
      // Card path taken but produced nothing (no sinks / send failed):
      // with no machine policy behind it the ask must fail closed instead
      // of falling through to an unreachable provider.
      if (policy.kind === 'off') {
        throw new Error('ask_user_question card was unavailable with no machine policy configured')
      }
      return waitForFallbackWindow(policy.timeoutMs, request.signal).then(window => {
        if (window === 'aborted') {
          throw new Error('ask_user_question was aborted before the policy fallback answered')
        }
        logger?.info(`dsh-lark: ask auto-answered for ${request.questions.length} question(s) (policy ${policy.kind})`)
        return askAnswerFor(policy, request)
      })
    })
  }
  return () => { service.ask = original }
}

interface AgentLike {
  session: { id: unknown; seq: number; events: readonly unknown[] }
  status: 'idle' | 'running'
  whenIdle(): Promise<void>
  followup(message: ReturnType<typeof createUserMessage>): void
  cancel(cause: { kind: 'user' }): void
}

interface AgentHandleLike { agent: AgentLike; dispose(): Promise<void> }

interface WorkspaceLike {
  path: string
  attachSession(sessionId: unknown): Promise<void>
}

type ModelSelection = { provider: string; model: string }
type AgentSetupFn = (agentCtx: Parameters<typeof installModelSelection>[0]) => Promise<void>

interface CreateAgentCall {
  sessionId: SessionId
  meta: { cwd: string; agentPreset: string }
  agentOptions: ModelSelection
  setup: AgentSetupFn
}

interface ResumeAgentCall {
  resumeSessionId: SessionId
  agentOptions: ModelSelection
  setup: AgentSetupFn
}

/** Per-conversation choices applied on top of the plugin config by `/` commands. */
export interface ConversationOverrides {
  provider?: string
  model?: string
  workspace?: string
  agentPreset?: string
}

/** Conversation controls the command surface drives. */
export interface ConversationControls {
  rebind(key: string, sessionId: SessionId): Promise<void>
  restart(key: string, patch: ConversationOverrides, options: { fresh: boolean; clear: boolean }): Promise<void>
  cancel(key: string): Promise<boolean>
}

export interface HarnessDependencies {
  agents: {
    create(options: CreateAgentCall): Promise<AgentHandleLike>
    resume(options: ResumeAgentCall): Promise<AgentHandleLike>
  }
  sessions: { flush(session: AgentLike['session']): Promise<unknown> }
  selection(): ModelSelection
  agentPresets: {
    resolve(id?: string): Promise<{ id: string }>
    mount(agentCtx: Parameters<typeof installModelSelection>[0], id?: string): Promise<unknown>
  }
  workspaceRegistry: {
    list(): WorkspaceLike[]
    resolveByPath(path: string): Promise<WorkspaceLike | undefined>
  }
}

export interface HarnessBridgeConfig {
  domain: DomainName
  workspace?: string
  agentPreset?: string
  provider?: string
  model?: string
}

export interface InboundMessage extends ConversationMessage {
  content: string
  /** Downloaded and durably saved images (LK-007). */
  images?: ImageAttachmentRef[]
  /** Locally saved non-image files (LK-007). */
  files?: InboundFileNote[]
}

interface PersistedConversation {
  sessionId?: string
  overrides?: ConversationOverrides
}
interface PersistedState { conversations: Record<string, PersistedConversation> }

export interface ConversationServiceOptions {
  /** File the per-conversation bindings/overrides survive restarts in. */
  persistPath?: string
  logger?: { info?(message: string): unknown; warn?(message: string): unknown }
}

/**
 * Resume rejections meaning "nothing durable exists under this id" (or no
 * persistence backend composed at all) — the only outcomes allowed to fall
 * back to a fresh create. Any other resume failure keeps the durable
 * conversation authoritative and surfaces as a safe error to the user.
 */
function isResumeMiss(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  // dsh-session-persistence: `session "<id>" not found`; dsh-agent-loop:
  // 'cannot resume: session persistence is not configured'.
  return message.includes('not found') || message.includes('session persistence is not configured')
}

export class HarnessConversationService implements ConversationControls {
  private readonly handles = new Map<string, Promise<AgentHandleLike>>()
  /** Explicit session binding per conversation key (defaults to the deterministic id). */
  private readonly bindings = new Map<string, SessionId>()
  /** Per-conversation overrides layered over the plugin config. */
  private readonly overrides = new Map<string, ConversationOverrides>()
  /** Serialized turn chain per key; the SDK chat queue must stay free for /stop. */
  private readonly chains = new Map<string, Promise<void>>()
  private readonly activeTurns = new Set<string>()
  private readonly stopFlags = new Set<string>()
  /** Live agents created by this service; drives the ask fallback ownership check. */
  private readonly liveAgents = new WeakSet<object>()
  private readonly interactionPolicy: InteractionPolicy
  private readonly cardHub: InteractionCardHub | undefined
  private readonly cardTimeoutMs: number
  private readonly streamThrottleMs: number
  /** How sender identity prefixes user text (LK-007). */
  private readonly senderLabel: SenderLabel
  /** The in-flight turn's streaming card, keyed by its session object. */
  private activeStream: { session: object; card: TurnStreamCard } | undefined

  constructor(
    deps: HarnessDependencies,
    config: HarnessBridgeConfig,
    options: ConversationServiceOptions & {
      interactionPolicy?: InteractionPolicy
      cardHub?: InteractionCardHub
      cardTimeoutMs?: number
      streamThrottleMs?: number
      senderLabel?: SenderLabel
    } = {},
  ) {
    this.deps = deps
    this.config = config
    this.interactionPolicy = options.interactionPolicy ?? resolveInteractionPolicy({
      interactionPolicy: 'off',
      interactionTimeoutMs: 0,
    })
    this.cardHub = options.cardHub
    this.cardTimeoutMs = options.cardTimeoutMs ?? 120000
    this.streamThrottleMs = options.streamThrottleMs ?? 0
    this.senderLabel = options.senderLabel ?? 'group'
    this.persistPath = options.persistPath
    this.logger = options.logger
    this.restoreSync()
  }

  /** The in-flight turn's streaming card for one agent session, if any. */
  streamFor(session: object): TurnStreamCard | undefined {
    const active = this.activeStream
    return active !== undefined && active.session === session ? active.card : undefined
  }

  /** Whether an agent object is one this service created and still holds. */
  ownsAgent(agent: unknown): boolean {
    return typeof agent === 'object' && agent !== null && this.liveAgents.has(agent)
  }

  /** The service logger narrowed to the fallback's info-only face. */
  private infoLogger(): { info(message: string): unknown } | undefined {
    const logger = this.logger
    return logger === undefined || typeof (logger as { info?: unknown }).info !== 'function'
      ? undefined
      : { info: message => (logger as { info(message: string): unknown }).info(message) }
  }
  private readonly deps: HarnessDependencies
  private readonly config: HarnessBridgeConfig
  private readonly persistPath: string | undefined
  private readonly logger: { info?(message: string): unknown; warn?(message: string): unknown } | undefined


  /** Full turn outcome: reply text plus how the stream card settled. */
  private async runTurn(message: InboundMessage): Promise<{ text: string; finalViaCard: boolean }> {
    const key = conversationKey(message)
    const handle = await this.getOrCreate(key)
    const agent = handle.agent
    const target = {
      chatId: message.chatId,
      ...(message.replyToMessageId === undefined ? {} : { replyTo: message.replyToMessageId }),
      ...(message.threadId === undefined ? {} : { replyInThread: true }),
    }
    this.cardHub?.bind(key, agent, target)
    const sinks = this.cardHub?.currentSinks()
    const stream = this.streamThrottleMs > 0 && sinks !== undefined
      ? new TurnStreamCard(sinks, target, { throttleMs: this.streamThrottleMs, ...(this.logger === undefined ? {} : { logger: this.logger }) })
      : undefined
    await agent.whenIdle()
    const firstSeq = agent.session.seq
    this.activeStream = stream === undefined ? undefined : { session: agent.session as object, card: stream }
    try {
      agent.followup(createUserMessage({
        content: [
          ...(message.images ?? []).map(attachment => ({ type: 'image' as const, attachment })),
          { type: 'text', text: composeUserText(message.content, {
            images: message.images ?? [],
            files: message.files ?? [],
          }, message, this.senderLabel) },
        ],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
      await this.deps.sessions.flush(agent.session)
    } finally {
      this.activeStream = undefined
    }
    const result = summarizeTurn(agent.session.events as Parameters<typeof summarizeTurn>[0], firstSeq)
    if (!result.ok) {
      await stream?.fail('本轮没有产生有效回复。')
      throw new Error('Harness turn did not produce a successful assistant response')
    }
    const finalViaCard = stream !== undefined && await stream.finish(result.text) === 'card-final'
    return { text: result.text, finalViaCard }
  }

  async reply(message: InboundMessage): Promise<string> {
    return (await this.runTurn(message)).text
  }

  /**
   * Drive one inbound message as a serialized background turn for its
   * conversation. Returns the chain promise; the channel fires this without
   * awaiting so `/stop` (and card clicks) are not queued behind the turn.
   */
  drive(
    message: InboundMessage,
    deliver: (text: string) => Promise<void>,
    fail: (error: unknown) => Promise<void>,
  ): Promise<void> {
    const key = conversationKey(message)
    const prior = this.chains.get(key) ?? Promise.resolve()
    const work = prior.then(async () => {
      this.activeTurns.add(key)
      try {
        const outcome = await this.runTurn(message)
        // The terminal stream card may already carry the reply; only the
        // text channel fallbacks deliver it as messages.
        if (!outcome.finalViaCard) await deliver(outcome.text)
      } catch (error: unknown) {
        if (this.stopFlags.delete(key)) return
        await fail(error)
      } finally {
        this.activeTurns.delete(key)
      }
    })
    this.chains.set(key, work)
    return work
  }

  async rebind(key: string, sessionId: SessionId): Promise<void> {
    await this.dropHandle(key)
    this.bindings.set(key, sessionId)
    await this.persist()
  }

  async restart(key: string, patch: ConversationOverrides, options: { fresh: boolean; clear: boolean }): Promise<void> {
    const previous = this.overrides.get(key) ?? {}
    const merged: ConversationOverrides = { ...previous, ...patch }
    for (const field of Object.keys(merged) as Array<keyof ConversationOverrides>) {
      if (merged[field] === undefined) delete merged[field]
    }
    this.overrides.set(key, merged)
    await this.dropHandle(key)
    if (options.fresh || options.clear) {
      this.bindings.set(key, toSessionId(this.config.domain, key, `g${Date.now().toString(36)}`))
    }
    await this.persist()
  }

  async cancel(key: string): Promise<boolean> {
    const pending = this.handles.get(key)
    if (pending === undefined) return false
    const handle = await pending.catch(() => undefined)
    if (handle === undefined || handle.agent.status !== 'running') return false
    this.stopFlags.add(key)
    handle.agent.cancel({ kind: 'user' })
    return true
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.chains.values()])
    const handles = await Promise.allSettled(this.handles.values())
    await Promise.all(handles.flatMap(result => result.status === 'fulfilled' ? [result.value.dispose()] : []))
    this.handles.clear()
  }

  private async dropHandle(key: string): Promise<void> {
    const pending = this.handles.get(key)
    this.handles.delete(key)
    if (pending === undefined) return
    const handle = await pending.catch(() => undefined)
    if (handle !== undefined) this.cardHub?.forget(handle.agent)
    await handle?.dispose()
  }

  private getOrCreate(key: string): Promise<AgentHandleLike> {
    let pending = this.handles.get(key)
    if (pending !== undefined) return pending
    pending = this.acquireAgent(key).catch((error: unknown) => {
      this.handles.delete(key)
      throw error
    })
    this.handles.set(key, pending)
    return pending
  }

  private effectiveConfig(key: string): HarnessBridgeConfig & ConversationOverrides {
    return { ...this.config, ...(this.overrides.get(key) ?? {}) }
  }

  private async acquireAgent(key: string): Promise<AgentHandleLike> {
    const config = this.effectiveConfig(key)
    const fallback = this.deps.selection()
    const selection: ModelSelection = {
      provider: config.provider ?? fallback.provider,
      model: config.model ?? fallback.model,
    }
    const workspace = config.workspace === undefined
      ? this.deps.workspaceRegistry.list()[0]
      : await this.deps.workspaceRegistry.resolveByPath(config.workspace)
    const cwd = config.workspace ?? workspace?.path ?? process.cwd()
    const agentPreset = (await this.deps.agentPresets.resolve(config.agentPreset)).id
    const sessionId = this.bindings.get(key) ?? toSessionId(config.domain, key)
    const setup: AgentSetupFn = async (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
      await this.deps.agentPresets.mount(agentCtx, agentPreset)
      if (this.interactionPolicy.kind !== 'off') {
        // Registered BEFORE the card answerer: both prepend, so the card
        // answerer (registered last) ends up first in the waterfall and the
        // machine policy sits behind it as the timeout fallback.
        installAgentInteractionFallback(agentCtx as FallbackAgentContext, this.interactionPolicy, this.infoLogger())
      }
      if (this.cardHub !== undefined) {
        installAgentCardAnswerer(agentCtx as FallbackAgentContext, this.cardHub, {
          timeoutMs: this.cardTimeoutMs,
          policy: this.interactionPolicy,
        }, this.infoLogger())
      }
      if (this.streamThrottleMs > 0) {
        installAgentStreamForwarder(agentCtx as unknown as StreamAgentContext, session => this.streamFor(session))
      }
    }
    // Resume-first: a persisted session under this id (from a previous
    // process run) must continue instead of colliding with create. Only a
    // resume miss falls back to create; a real failure with an existing log
    // is surfaced so an empty replacement never shadows the durable id.
    let handle: AgentHandleLike
    try {
      handle = await this.deps.agents.resume({ resumeSessionId: sessionId, agentOptions: selection, setup })
    } catch (error: unknown) {
      if (!isResumeMiss(error)) throw error
      handle = await this.deps.agents.create({ sessionId, meta: { cwd, agentPreset }, agentOptions: selection, setup })
    }
    try {
      await workspace?.attachSession(sessionId)
    } catch (error: unknown) {
      await handle.dispose()
      throw error
    }
    this.liveAgents.add(handle.agent)
    return handle
  }

  private restoreSync(): void {
    if (this.persistPath === undefined) return
    let raw: string
    try {
      raw = readFileSyncUtf8(this.persistPath)
    } catch {
      return
    }
    const state = parsePersistedState(raw)
    if (state === undefined) {
      this.logger?.warn?.(`dsh-lark: ignoring unreadable binding store ${this.persistPath}`)
      return
    }
    for (const [key, conversation] of Object.entries(state.conversations)) {
      if (typeof conversation.sessionId === 'string' && conversation.sessionId !== '') {
        this.bindings.set(key, SessionId(conversation.sessionId))
      }
      if (conversation.overrides !== undefined) this.overrides.set(key, conversation.overrides)
    }
  }

  private async persist(): Promise<void> {
    if (this.persistPath === undefined) return
    const state: PersistedState = { conversations: {} }
    const keys = new Set<string>([...this.bindings.keys(), ...this.overrides.keys()])
    for (const key of keys) {
      const entry: PersistedConversation = {}
      const boundSession = this.bindings.get(key)
      if (boundSession !== undefined) entry.sessionId = String(boundSession)
      const overrides = this.overrides.get(key)
      if (overrides !== undefined) entry.overrides = overrides
      state.conversations[key] = entry
    }
    const path = this.persistPath
    const temporary = `${path}.tmp-${process.pid}-${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 6)}`
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await rename(temporary, path)
    } catch (error: unknown) {
      this.logger?.warn?.(`dsh-lark: could not persist conversation bindings: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function readFileSyncUtf8(path: string): string {
  // Synchronous one-shot at construction; the store is tiny and rare.
  return readFileSync(path, 'utf8')
}

function parsePersistedState(raw: string): PersistedState | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || !('conversations' in parsed)) return undefined
  const conversations = (parsed as { conversations: unknown }).conversations
  if (conversations === null || typeof conversations !== 'object' || Array.isArray(conversations)) return undefined
  const result: PersistedState = { conversations: {} }
  for (const [key, value] of Object.entries(conversations as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue
    const record = value as Record<string, unknown>
    const entry: PersistedConversation = {}
    if (typeof record.sessionId === 'string') entry.sessionId = record.sessionId
    if (record.overrides !== null && typeof record.overrides === 'object' && !Array.isArray(record.overrides)) {
      const overrides: ConversationOverrides = {}
      const source = record.overrides as Record<string, unknown>
      for (const field of ['provider', 'model', 'workspace', 'agentPreset'] as const) {
        if (typeof source[field] === 'string') overrides[field] = source[field]
      }
      entry.overrides = overrides
    }
    result.conversations[key] = entry
  }
  return result
}
