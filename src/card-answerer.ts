import { randomUUID } from 'node:crypto'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswerItem, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'

/** Outbound card delivery the hub drives; attached by the channel once live. */
export interface CardSinks {
  sendCard(to: string, card: object, options: { replyTo?: string; replyInThread?: boolean }): Promise<{ messageId: string }>
  updateCard(messageId: string, card: object): Promise<void>
}

/** Where one agent's interaction cards go: its latest inbound chat anchor. */
export interface ChatTarget {
  readonly chatId: string
  readonly replyTo?: string
  readonly replyInThread?: boolean
}

export type ApprovalCardResult =
  | { readonly kind: 'decided'; readonly outcome: ApprovalOutcome }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unavailable' }

export type AskCardResult =
  | { readonly kind: 'answered'; readonly picked: ReadonlyMap<number, AskUserQuestionAnswerItem> }
  | { readonly kind: 'timeout'; readonly picked: ReadonlyMap<number, AskUserQuestionAnswerItem> }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unavailable' }

export interface CardWaitOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs: number
  /** Card annotation shown when the wait times out (wording depends on policy). */
  readonly timeoutNote: string
}

/** Wire shape of a card-action button value (`{ ia, o?, q?, s? }`). */
interface CardActionPayload {
  ia: unknown
  o?: unknown
  q?: unknown
  s?: unknown
}

/** Parse one untrusted card-action value at the boundary; no others pass. */
function parseCardAction(value: unknown): CardActionPayload | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  return value as CardActionPayload
}

/** Buttons per action row (Feishu renders a handful per row comfortably). */
const BUTTONS_PER_ROW = 3
/** Option buttons per question; beyond this the tail is policy-answerable only. */
const MAX_OPTION_BUTTONS = 8

function div(text: string): { tag: string; text: { tag: string; content: string } } {
  return { tag: 'div', text: { tag: 'lark_md', content: text } }
}

function button(label: string, value: Record<string, unknown>, type: 'default' | 'primary' | 'danger'): object {
  return { tag: 'button', text: { tag: 'plain_text', content: label }, type, value }
}

function actionRows(actions: Array<{ label: string; value: Record<string, unknown>; type?: 'default' | 'primary' | 'danger' }>): object[] {
  const rows: object[] = []
  for (let index = 0; index < actions.length; index += BUTTONS_PER_ROW) {
    rows.push({
      tag: 'action',
      actions: actions.slice(index, index + BUTTONS_PER_ROW).map(action => button(action.label, action.value, action.type ?? 'default')),
    })
  }
  return rows
}

function noteElement(text: string): object {
  return { tag: 'note', elements: [{ tag: 'plain_text', content: text }] }
}

function cardShell(template: string, title: string, elements: object[]): object {
  return {
    config: { wide_screen_mode: true },
    header: { template, title: { tag: 'plain_text', content: title } },
    elements,
  }
}

function approvalAskCard(toolName: string, reason: string | undefined, interactionId: string): object {
  const lines = [`**工具**：\`${toolName}\``]
  if (reason !== undefined) lines.push(`**原因**：${reason}`)
  return cardShell('orange', '需要审批', [
    div(lines.join('\n')),
    noteElement('Agent 请求放行一次操作，点击按钮决定：'),
    ...actionRows([
      { label: '允许一次', value: { ia: interactionId, o: 'allow' }, type: 'primary' },
      { label: '拒绝', value: { ia: interactionId, o: 'deny' }, type: 'danger' },
    ]),
  ])
}

const APPROVAL_TEMPLATES: Record<string, string> = {
  'allowed-once': 'green',
  rejected: 'red',
  cancelled: 'grey',
  unavailable: 'grey',
}

function approvalResolvedCard(toolName: string, reason: string | undefined, note: string, outcome: ApprovalOutcome): object {
  const lines = [`**工具**：\`${toolName}\``]
  if (reason !== undefined) lines.push(`**原因**：${reason}`)
  lines.push(`**决议**：${note}`)
  return cardShell(APPROVAL_TEMPLATES[outcome] ?? 'grey', '审批已决定', [div(lines.join('\n'))])
}

function askQuestions(request: AskUserQuestionRequest, interactionId: string, picked: ReadonlyMap<number, AskUserQuestionAnswerItem>): object[] {
  const elements: object[] = []
  request.questions.forEach((question, index) => {
    const pick = picked.get(index)
    if (pick !== undefined) {
      elements.push(div(`✅ **${question.question}** → ${pick.selected.join('、')}`))
      return
    }
    const options = question.options ?? []
    if (options.length === 0) {
      elements.push(div(`**${question.question}**\n（本题没有选项按钮，超时将按策略自动作答）`))
      return
    }
    const shown = options.slice(0, MAX_OPTION_BUTTONS)
    const detail = question.detail === undefined ? '' : `\n${question.detail}`
    elements.push(div(`**${question.question}**${detail}`))
    elements.push(...actionRows(shown.map(option => ({ label: option.label, value: { ia: interactionId, q: index, s: option.label } }))))
    if (options.length > shown.length) {
      elements.push(noteElement(`选项过多，仅显示前 ${shown.length} 项，其余按策略处理。`))
    }
  })
  return elements
}

function askCard(request: AskUserQuestionRequest, interactionId: string, picked: ReadonlyMap<number, AskUserQuestionAnswerItem>, note?: string): object {
  const elements = askQuestions(request, interactionId, picked)
  if (note !== undefined) elements.push(noteElement(note))
  return cardShell('turquoise', '需要你的回答', elements)
}

interface PendingInteraction {
  /** Wire action handling; returns false when the value targets another id. */
  handle(value: CardActionPayload, operator: string): Promise<boolean>
  /** Settle without a click (dispose); the card, if any, is annotated. */
  settle(note: string): Promise<void>
}

/**
 * Feishu-card answerer for ask/approval interactions: sends one card per
 * request, resolves on button clicks, annotates the card on every terminal
 * state (click, timeout, cancellation), and stays silent when no sinks are
 * attached so callers can delegate to the machine policy.
 */
export class InteractionCardHub {
  private sinks: CardSinks | undefined
  private readonly pending = new Map<string, PendingInteraction>()
  private readonly agentKeys = new Map<object, string>()
  private readonly targets = new Map<string, ChatTarget>()

  constructor(private readonly logger?: { warn?(message: string): unknown; info?(message: string): unknown }) {}

  /** Wire the live channel's card delivery; safe to call once per channel. */
  attach(sinks: CardSinks): void {
    this.sinks = sinks
  }

  /** The sinks once a channel is live; lets the bridge open stream cards. */
  currentSinks(): CardSinks | undefined {
    return this.sinks
  }
  /**
   * Bind one agent to its conversation key and remember where that
   * conversation's cards go (its latest inbound anchor). The bridge calls
   * this on every reply, so a re-created agent rebinds and a stale target
   * ages out with the conversation.
   */
  bind(key: string, agent: object, target: ChatTarget): void {
    this.agentKeys.set(agent, key)
    this.targets.set(key, target)
  }

  /** Drop an agent's routing entries when its handle is disposed. */
  forget(agent: object): void {
    this.agentKeys.delete(agent)
  }

  /** Where this agent's interaction cards go, when its conversation has one. */
  targetFor(agent: unknown): ChatTarget | undefined {
    if (typeof agent !== 'object' || agent === null) return undefined
    const key = this.agentKeys.get(agent)
    return key === undefined ? undefined : this.targets.get(key)
  }

  private async updateQuietly(messageId: string, card: object): Promise<void> {
    if (this.sinks === undefined) return
    try {
      await this.sinks.updateCard(messageId, card)
    } catch (error: unknown) {
      this.logger?.warn?.(`dsh-lark: interaction card update failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Show an allow/deny card and wait for a click, the timeout, or abort. */
  async approvalCard(
    target: ChatTarget,
    ask: { toolName: string; reason: string | undefined },
    wait: CardWaitOptions,
  ): Promise<ApprovalCardResult> {
    if (this.sinks === undefined) return { kind: 'unavailable' }
    if (wait.signal?.aborted === true) return { kind: 'cancelled' }
    const interactionId = randomUUID()
    let messageId: string
    try {
      const sent = await this.sinks.sendCard(target.chatId, approvalAskCard(ask.toolName, ask.reason, interactionId), {
        ...(target.replyTo === undefined ? {} : { replyTo: target.replyTo }),
        replyInThread: target.replyInThread === true,
      })
      messageId = sent.messageId
    } catch (error: unknown) {
      this.logger?.warn?.(`dsh-lark: approval card send failed: ${error instanceof Error ? error.message : String(error)}`)
      return { kind: 'unavailable' }
    }
    const { promise, resolve } = Promise.withResolvers<ApprovalCardResult>()
    let settled = false
    const finish = (result: ApprovalCardResult, card?: object): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      wait.signal?.removeEventListener('abort', onAbort)
      this.pending.delete(interactionId)
      const updated = card === undefined ? Promise.resolve() : this.updateQuietly(messageId, card)
      void updated.then(() => resolve(result), () => resolve(result))
    }
    const timer = setTimeout(() => {
      finish({ kind: 'timeout' }, approvalResolvedCard(ask.toolName, ask.reason, wait.timeoutNote, 'unavailable'))
    }, wait.timeoutMs)
    const onAbort = (): void => {
      finish({ kind: 'cancelled' }, approvalResolvedCard(ask.toolName, ask.reason, '请求已取消。', 'cancelled'))
    }
    wait.signal?.addEventListener('abort', onAbort, { once: true })
    this.pending.set(interactionId, {
      handle: async (value, operator) => {
        if (value.ia !== interactionId) return false
        if (value.o === 'allow') {
          finish({ kind: 'decided', outcome: 'allowed-once' }, approvalResolvedCard(ask.toolName, ask.reason, `已由 ${operator} 允许。`, 'allowed-once'))
          return true
        }
        if (value.o === 'deny') {
          finish({ kind: 'decided', outcome: 'rejected' }, approvalResolvedCard(ask.toolName, ask.reason, `已由 ${operator} 拒绝。`, 'rejected'))
          return true
        }
        return true
      },
      settle: async note => { finish({ kind: 'cancelled' }, approvalResolvedCard(ask.toolName, ask.reason, note, 'cancelled')) },
    })
    return promise
  }

  /** Show one button group per option question; clicks fill answers one by one. */
  async askCard(
    target: ChatTarget,
    request: AskUserQuestionRequest,
    wait: CardWaitOptions,
  ): Promise<AskCardResult> {
    if (this.sinks === undefined) return { kind: 'unavailable' }
    if (wait.signal?.aborted === true) return { kind: 'cancelled' }
    const interactionId = randomUUID()
    const picked = new Map<number, AskUserQuestionAnswerItem>()
    const unanswered = new Set<number>()
    request.questions.forEach((question, index) => {
      if ((question.options ?? []).length > 0) unanswered.add(index)
    })
    let messageId: string
    try {
      const sent = await this.sinks.sendCard(target.chatId, askCard(request, interactionId, picked), {
        ...(target.replyTo === undefined ? {} : { replyTo: target.replyTo }),
        replyInThread: target.replyInThread === true,
      })
      messageId = sent.messageId
    } catch (error: unknown) {
      this.logger?.warn?.(`dsh-lark: ask card send failed: ${error instanceof Error ? error.message : String(error)}`)
      return { kind: 'unavailable' }
    }
    const { promise, resolve } = Promise.withResolvers<AskCardResult>()
    let settled = false
    const finish = (result: AskCardResult, note?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      wait.signal?.removeEventListener('abort', onAbort)
      this.pending.delete(interactionId)
      const updated = this.updateQuietly(messageId, askCard(request, interactionId, picked, note))
      void updated.then(() => resolve(result), () => resolve(result))
    }
    const timer = setTimeout(() => {
      finish({ kind: 'timeout', picked }, wait.timeoutNote)
    }, wait.timeoutMs)
    const onAbort = (): void => {
      finish({ kind: 'cancelled' }, '请求已取消。')
    }
    wait.signal?.addEventListener('abort', onAbort, { once: true })
    this.pending.set(interactionId, {
      handle: async (value, _operator) => {
        if (value.ia !== interactionId) return false
        const index = value.q
        if (typeof index !== 'number' || !Number.isInteger(index) || !unanswered.has(index)) return true
        const label = value.s
        const options = request.questions[index]?.options ?? []
        if (typeof label !== 'string' || !options.some(option => option.label === label)) return true
        const question = request.questions[index]
        if (question === undefined) return true
        picked.set(index, { id: question.id, selected: [label] })
        unanswered.delete(index)
        if (unanswered.size === 0) {
          finish({ kind: 'answered', picked })
        } else {
          await this.updateQuietly(messageId, askCard(request, interactionId, picked))
        }
        return true
      },
      settle: async note => { finish({ kind: 'cancelled' }, note) },
    })
    return promise
  }

  /** Route one card-action value; true when it targeted a live interaction. */
  async applyAction(value: unknown, operator = '用户'): Promise<boolean> {
    const payload = parseCardAction(value)
    if (payload === undefined || typeof payload.ia !== 'string') return false
    const pending = this.pending.get(payload.ia)
    if (pending === undefined) return false
    return pending.handle(payload, operator)
  }

  /** Settle every pending interaction (channel teardown); idempotent. */
  async dispose(): Promise<void> {
    const pending = [...this.pending.values()]
    this.pending.clear()
    await Promise.allSettled(pending.map(entry => entry.settle('通道已关闭，本次请求已取消。')))
  }
}
