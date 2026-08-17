import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InteractionCardHub, type CardSinks } from '../src/card-answerer.ts'
import {
  installAgentCardAnswerer,
  installAgentInteractionFallback,
  resolveInteractionPolicy,
  wrapUserQuestions,
  type FallbackAgentContext,
  type InteractionPolicy,
} from '../src/harness.ts'

function policy(kind: InteractionPolicy['kind'], timeoutMs = 0, extra: { askAnswer?: string; approvalAllow?: boolean } = {}): InteractionPolicy {
  return resolveInteractionPolicy({
    interactionPolicy: kind,
    interactionTimeoutMs: timeoutMs,
    ...(extra.askAnswer === undefined ? {} : { askAutoAnswer: extra.askAnswer }),
    ...(extra.approvalAllow === undefined ? {} : { approvalAllow: extra.approvalAllow }),
  })
}

function askRequest(questions: AskUserQuestionRequest['questions'], agent?: AskUserQuestionRequest['agent']): AskUserQuestionRequest {
  const request: AskUserQuestionRequest = { questions }
  if (agent !== undefined) request.agent = agent
  return request
}

/** Listener-capturing double of the agent setup context (waterfall order). */
function agentCtxWithListeners(): {
  ctx: FallbackAgentContext
  dispatch: (req: ApprovalRequest) => Promise<ApprovalOutcome>
} {
  const listeners: Array<(req: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>> = []
  const ctx = {
    on: vi.fn((_name: string, listener: (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>, prepend?: boolean) => {
      if (prepend === true) listeners.unshift(listener)
      else listeners.push(listener)
      return () => undefined
    }),
    get: vi.fn(() => undefined),
    effect: vi.fn(),
  } as unknown as FallbackAgentContext
  const dispatch = (req: ApprovalRequest): Promise<ApprovalOutcome> => {
    const chain: Array<() => Promise<ApprovalOutcome>> = [() => Promise.resolve('unavailable')]
    for (const listener of [...listeners].reverse()) {
      const next = chain[chain.length - 1]!
      chain.push(() => listener(req, next))
    }
    return chain[chain.length - 1]!()
  }
  return { ctx, dispatch }
}

function cardSinks(): CardSinks & { sendCard: ReturnType<typeof vi.fn>; updateCard: ReturnType<typeof vi.fn> } {
  return {
    sendCard: vi.fn(async () => ({ messageId: 'om_card_1' })),
    updateCard: vi.fn(async () => undefined),
  }
}

/** Collect every button value object embedded in a card JSON payload. */
function buttonValues(card: unknown): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node !== 'object' || node === null) return
    const record = node as Record<string, unknown>
    if (record.tag === 'button' && typeof record.value === 'object' && record.value !== null) {
      found.push(record.value as Record<string, unknown>)
    }
    for (const child of Object.values(record)) walk(child)
  }
  walk(card)
  return found
}

/** Flatten a card payload into the text contents it renders. */
function cardTexts(card: unknown): string[] {
  const texts: string[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node !== 'object' || node === null) return
    const record = node as Record<string, unknown>
    for (const [key, value] of Object.entries(record)) {
      if ((key === 'content' || key === 'title') && typeof value === 'string') texts.push(value)
      else walk(value)
    }
  }
  walk(card)
  return texts
}

const AGENT = { marker: 'lark-agent' } as unknown as ApprovalRequest['agent']
const TARGET = { chatId: 'oc_1', replyTo: 'om_in_1', replyInThread: false }

/** Hub bound to a live conversation, with sinks attached. */
function liveHub(sinks: CardSinks): InteractionCardHub {
  const hub = new InteractionCardHub(undefined)
  hub.attach(sinks)
  hub.bind('chat:oc_1', AGENT, TARGET)
  return hub
}

const CARD_TIMEOUT = 60_000

describe('① approval request shows an allow/deny button card', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('sends a card whose buttons decide allow-once/rejected', async () => {
    const sinks = cardSinks()
    const hub = liveHub(sinks)
    const { ctx, dispatch } = agentCtxWithListeners()
    installAgentCardAnswerer(ctx, hub, { timeoutMs: CARD_TIMEOUT, policy: policy('off') }, undefined)

    const decided = dispatch({ agent: AGENT, toolName: 'bash', reason: 'rm -rf dist' })
    await vi.advanceTimersByTimeAsync(0)
    expect(sinks.sendCard).toHaveBeenCalledTimes(1)
    const [to, card, options] = sinks.sendCard.mock.calls[0]! as [string, object, { replyTo?: string }]
    expect(to).toBe('oc_1')
    expect(options.replyTo).toBe('om_in_1')
    const values = buttonValues(card)
    expect(values.map(value => value.o)).toEqual(['allow', 'deny'])
    expect(String(values[0]!.ia)).not.toBe('')
    // Tool name and reason surface on the card.
    expect(cardTexts(card).join('\n')).toContain('bash')
    expect(cardTexts(card).join('\n')).toContain('rm -rf dist')

    await vi.advanceTimersByTimeAsync(CARD_TIMEOUT)
    await expect(decided).resolves.toBe('unavailable')
  })
})

describe('② a button click resolves the decision and the turn continues', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('allow and deny clicks both decide; the card is annotated afterwards', async () => {
    const sinks = cardSinks()
    const hub = liveHub(sinks)
    const { ctx, dispatch } = agentCtxWithListeners()
    installAgentCardAnswerer(ctx, hub, { timeoutMs: CARD_TIMEOUT, policy: policy('off') }, undefined)

    const decided = dispatch({ agent: AGENT, toolName: 'bash' })
    await vi.advanceTimersByTimeAsync(0)
    const value = buttonValues(sinks.sendCard.mock.calls[0]![1]).find(entry => entry.o === 'allow')!
    // A stray command-card value routes elsewhere, never touching this hub.
    await expect(hub.applyAction({ cmd: 'resume', arg: 'x', ck: 'y' })).resolves.toBe(false)
    expect(await hub.applyAction(value, '张三')).toBe(true)
    await expect(decided).resolves.toBe('allowed-once')
    // The card now shows the human's decision instead of buttons.
    const annotated = sinks.updateCard.mock.calls.at(-1)![1]
    expect(cardTexts(annotated).join('\n')).toContain('张三')
    expect(buttonValues(annotated)).toHaveLength(0)

    // Deny path on a fresh request.
    const denied = dispatch({ agent: AGENT, toolName: 'bash' })
    await vi.advanceTimersByTimeAsync(0)
    const denyValue = buttonValues(sinks.sendCard.mock.calls.at(-1)![1]).find(entry => entry.o === 'deny')!
    await hub.applyAction(denyValue, '李四')
    await expect(denied).resolves.toBe('rejected')
  })
})

describe('③ ask options render as button groups and clicks fill answers', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('clicking an option returns it as the answer; partial picks persist', async () => {
    const sinks = cardSinks()
    const hub = liveHub(sinks)
    const service = { ask: vi.fn(async (_request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> => ({ answers: [] })) }
    const restore = wrapUserQuestions(
      service, policy('custom', 0, { askAnswer: '默认继续' }), agent => agent === AGENT, undefined,
      { hub, timeoutMs: CARD_TIMEOUT },
    )

    const question = service.ask(askRequest([
      { id: 'q1', question: '用哪个包管理器?', options: [{ label: 'pnpm' }, { label: 'npm' }] },
      { id: 'q2', question: '继续吗?', options: [{ label: '是' }, { label: '否' }] },
    ], AGENT))
    await vi.advanceTimersByTimeAsync(0)
    expect(sinks.sendCard).toHaveBeenCalledTimes(1)
    const card = sinks.sendCard.mock.calls[0]![1]
    const labels = buttonValues(card).map(value => value.s).filter(label => typeof label === 'string')
    expect(labels).toEqual(['pnpm', 'npm', '是', '否'])

    // First pick annotates the card but does not resolve the ask yet.
    const pnpm = buttonValues(card).find(value => value.s === 'pnpm')!
    await hub.applyAction(pnpm, '张三')
    expect(sinks.updateCard).toHaveBeenCalled()
    const intermediate = sinks.updateCard.mock.calls.at(-1)![1]
    expect(cardTexts(intermediate).join('\n')).toContain('pnpm')

    const yes = buttonValues(card).find(value => value.s === '是')!
    await hub.applyAction(yes, '张三')
    await expect(question).resolves.toEqual({ answers: [
      { id: 'q1', selected: ['pnpm'] },
      { id: 'q2', selected: ['是'] },
    ] })
    restore()
  })
})

describe('④ timeout falls back to the LK-002 policy and annotates the card', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('approval: card times out, machine policy behind it decides, card says so', async () => {
    const sinks = cardSinks()
    const hub = liveHub(sinks)
    const { ctx, dispatch } = agentCtxWithListeners()
    installAgentInteractionFallback(ctx, policy('deny-all'), undefined)
    // Production order: the fallback registers first so the card answerer
    // (both prepended) owns the first decision slot.
    installAgentCardAnswerer(ctx, hub, { timeoutMs: 1_000, policy: policy('deny-all') }, undefined)
    const decided = dispatch({ agent: AGENT, toolName: 'bash' })
    await vi.advanceTimersByTimeAsync(0)
    expect(sinks.sendCard).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(decided).resolves.toBe('rejected')
    const annotated = sinks.updateCard.mock.calls.at(-1)![1]
    expect(cardTexts(annotated).join('\n')).toContain('超时')
    expect(cardTexts(annotated).join('\n')).toContain('deny-all')
  })

  it('ask: clicks win, the unclicked remainder is policy-answered; card annotated', async () => {
    const sinks = cardSinks()
    const hub = liveHub(sinks)
    const service = { ask: vi.fn(async (_request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> => ({ answers: [] })) }
    const restore = wrapUserQuestions(
      service, policy('custom', 0, { askAnswer: '默认继续' }), agent => agent === AGENT, undefined,
      { hub, timeoutMs: 1_000 },
    )

    const question = service.ask(askRequest([
      { id: 'q1', question: '用哪个包管理器?', options: [{ label: 'pnpm' }, { label: 'npm' }] },
      { id: 'q2', question: '下一步?', options: [{ label: '重构' }, { label: '保持' }] },
    ], AGENT))
    await vi.advanceTimersByTimeAsync(0)
    const card = sinks.sendCard.mock.calls[0]![1]
    const npm = buttonValues(card).find(value => value.s === 'npm')!
    await hub.applyAction(npm, '张三')
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(question).resolves.toEqual({ answers: [
      { id: 'q1', selected: ['npm'] },
      { id: 'q2', selected: ['重构'] },
    ] })
    const annotated = sinks.updateCard.mock.calls.at(-1)![1]
    expect(cardTexts(annotated).join('\n')).toContain('超时')
    restore()
  })
})

describe('⑤ non-lark sessions are untouched (per-agent scoping)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('approval: a foreign agent delegates without any card traffic', async () => {
    const sinks = cardSinks()
    const hub = liveHub(sinks)
    const { ctx, dispatch } = agentCtxWithListeners()
    installAgentCardAnswerer(ctx, hub, { timeoutMs: CARD_TIMEOUT, policy: policy('off') }, undefined)

    const foreignAgent = { marker: 'web-agent' } as unknown as ApprovalRequest['agent']
    await expect(dispatch({ agent: foreignAgent, toolName: 'bash' })).resolves.toBe('unavailable')
    expect(sinks.sendCard).not.toHaveBeenCalled()
  })

  it('ask: foreign agents still reach the original provider', async () => {
    const sinks = cardSinks()
    const hub = liveHub(sinks)
    const service = { ask: vi.fn(async (_request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> => ({ answers: [{ id: 'q1', selected: ['provider'] }] })) }
    const restore = wrapUserQuestions(
      service, policy('allow-all'), agent => agent === AGENT, undefined,
      { hub, timeoutMs: CARD_TIMEOUT },
    )

    const foreignAgent = { marker: 'web-agent' } as unknown as AskUserQuestionRequest['agent']
    await expect(service.ask(askRequest([{ id: 'q1', question: '继续?' }], foreignAgent)))
      .resolves.toEqual({ answers: [{ id: 'q1', selected: ['provider'] }] })
    expect(sinks.sendCard).not.toHaveBeenCalled()
    restore()
  })
})
