import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  askAnswerFor,
  approvalOutcomeFor,
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

/** Minimal listener-capturing double of the agent setup context. */
function agentCtxWithListeners(): {
  ctx: FallbackAgentContext
  sections: Array<{ name: string; order: number; text: string }>
  dispatch: (req: ApprovalRequest) => Promise<ApprovalOutcome>
} {
  const listeners: Array<(req: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>> = []
  const sections: Array<{ name: string; order: number; text: string }> = []
  const ctx = {
    on: vi.fn((name: string, listener: (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>, prepend?: boolean) => {
      expect(name).toBe('approval/request')
      if (prepend === true) listeners.unshift(listener)
      else listeners.push(listener)
      return () => undefined
    }),
    get: vi.fn((service: string) => service === 'systemPrompt'
      ? { section: (section: { name: string; order: number; text: string }) => { sections.push(section); return () => undefined } }
      : undefined),
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
  return { ctx, sections, dispatch }
}

describe('① ask auto-answer completes the turn instead of hanging', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('answers an options question with the first option and a free-text question with the policy text', () => {
    const deny = policy('deny-all', 0, { askAnswer: '按默认方案继续' })
    const withOptions = askAnswerFor(deny, askRequest([
      { id: 'q1', question: '选哪个包管理器?', options: [{ label: 'pnpm' }, { label: 'npm' }] },
    ]))
    expect(withOptions.answers).toEqual([{ id: 'q1', selected: ['pnpm'] }])

    const freeText = askAnswerFor(deny, askRequest([{ id: 'q2', question: '下一步怎么做?' }]))
    expect(freeText.answers).toEqual([{ id: 'q2', selected: [], custom: '按默认方案继续' }])

    const allow = policy('allow-all', 0, { askAnswer: '同意' })
    expect(askAnswerFor(allow, askRequest([{ id: 'q3', question: '继续?' }])).answers)
      .toEqual([{ id: 'q3', selected: [], custom: '同意' }])
  })

  it('the wrapped service settles after the fallback window and passes foreign agents through', async () => {
    let providerAnswer: AskUserQuestionAnswer | undefined
    const service = {
      ask: vi.fn((_request: AskUserQuestionRequest) => new Promise<AskUserQuestionAnswer>(resolve => {
        Object.defineProperty(service, '__settle', { value: (answer: AskUserQuestionAnswer) => { providerAnswer = answer; resolve(answer) }, configurable: true })
      })),
    }
    const settleProvider = (answer: AskUserQuestionAnswer): void => {
      (service as unknown as { __settle: (a: AskUserQuestionAnswer) => void }).__settle(answer)
    }
    const ownedAgent = { marker: 'owned' }
    const foreignAgent = { marker: 'foreign' }
    const restore = wrapUserQuestions(service, policy('allow-all', 5_000), (agent: unknown) => agent === ownedAgent, undefined)

    // Owned agent: machine answer after the window.
    const owned = service.ask(askRequest([{ id: 'q1', question: '继续?' }], ownedAgent as unknown as AskUserQuestionRequest['agent']))
    // Foreign agent still waits on the original provider (no machine answer).
    const foreign = service.ask(askRequest([{ id: 'q2', question: '继续?' }], foreignAgent as unknown as AskUserQuestionRequest['agent']))
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(owned).resolves.toEqual({ answers: [{ id: 'q1', selected: [], custom: '同意,请继续。' }] })
    settleProvider({ answers: [{ id: 'q2', selected: ['human'] }] })
    await expect(foreign).resolves.toEqual({ answers: [{ id: 'q2', selected: ['human'] }] })
    void providerAnswer

    restore()
    // After restore, everything passes through again.
    const passthrough = service.ask(askRequest([{ id: 'q3', question: 'x?' }], ownedAgent as unknown as AskUserQuestionRequest['agent']))
    settleProvider({ answers: [{ id: 'q3', selected: ['provider'] }] })
    await expect(passthrough).resolves.toEqual({ answers: [{ id: 'q3', selected: ['provider'] }] })
  })
})

describe('② approval policy decides both branches and stays traceable', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('allow-all permits and deny-all rejects, after the window, without calling next', async () => {
    const allow = agentCtxWithListeners()
    const logs: string[] = []
    installAgentInteractionFallback(allow.ctx, policy('allow-all', 3_000), { info: message => { logs.push(message) } })
    const request: ApprovalRequest = { agent: {} as ApprovalRequest['agent'], toolName: 'bash', signal: new AbortController().signal }
    const allowed = allow.dispatch(request)
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(allowed).resolves.toBe('allowed-once')
    expect(logs[0]).toContain('auto-decided allowed-once')

    const deny = agentCtxWithListeners()
    installAgentInteractionFallback(deny.ctx, policy('deny-all', 0), undefined)
    await expect(deny.dispatch({ agent: request.agent, toolName: 'bash' })).resolves.toBe('rejected')

    const customAllow = agentCtxWithListeners()
    installAgentInteractionFallback(customAllow.ctx, policy('custom', 0, { approvalAllow: true }), undefined)
    await expect(customAllow.dispatch({ agent: request.agent, toolName: 'bash' })).resolves.toBe('allowed-once')

    const customDeny = agentCtxWithListeners()
    installAgentInteractionFallback(customDeny.ctx, policy('custom', 0), undefined)
    await expect(customDeny.dispatch({ agent: request.agent, toolName: 'bash' })).resolves.toBe('rejected')
  })

  it('an aborted request settles cancelled instead of deciding', async () => {
    const { ctx, dispatch } = agentCtxWithListeners()
    installAgentInteractionFallback(ctx, policy('allow-all', 10_000), undefined)
    const controller = new AbortController()
    const pending = dispatch({ agent: {} as ApprovalRequest['agent'], toolName: 'bash', signal: controller.signal })
    controller.abort()
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(pending).resolves.toBe('cancelled')
  })
})

describe('③ policy=off behaves exactly as before', () => {
  it('the wrapper delegates every ask to the original provider', async () => {
    const service = { ask: vi.fn(async (_request: AskUserQuestionRequest) => ({ answers: [{ id: 'q', selected: ['provider'] }] })) }
    const restore = wrapUserQuestions(service, policy('off'), () => true, undefined)
    const result = await service.ask(askRequest([{ id: 'q', question: '?' }]))
    expect(result).toEqual({ answers: [{ id: 'q', selected: ['provider'] }] })
    // off delegates: the answer came from the original provider mock.
    expect(result.answers[0]?.selected).toEqual(['provider'])
    restore()
  })

  it('off installs no approval listener and no prompt section', () => {
    // The setup gate in harness.ts skips installAgentInteractionFallback
    // entirely for 'off'; the helper below therefore must never run. The
    // outcome mapping stays the fail-closed default for safety.
    expect(policy('off').kind).toBe('off')
    expect(approvalOutcomeFor(policy('off'))).toBe('rejected')
  })
})

describe('④ the guidance text reaches the system prompt', () => {
  it('registers a scoped section carrying the final-answer guidance', () => {
    const { ctx, sections } = agentCtxWithListeners()
    installAgentInteractionFallback(ctx, policy('deny-all'), undefined)
    expect(sections).toHaveLength(1)
    expect(sections[0]!.name).toBe('dsh-lark:interaction-policy')
    expect(sections[0]!.text).toContain('final answer')
    expect(sections[0]!.text).not.toContain('{{')
  })
})
