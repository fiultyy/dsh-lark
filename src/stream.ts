import type { CardSinks, ChatTarget } from './card-answerer.ts'

/**
 * Live progress card for one agent turn (LK-004): assistant text chunks
 * coalesce inside a throttle window into at most one card update, the
 * terminal card is set from the turn's `summarizeTurn` projection, and any
 * card API failure degrades silently so the plain-text reply channel
 * (LK-005) still delivers the full answer.
 */

/** Narrowed `session/event` payload the card consumes; unknown shapes pass. */
export interface StreamEventLike {
  type: string
  data: {
    turn?: unknown
    step?: unknown
    chunk?: { type?: unknown; text?: unknown; block?: { type?: unknown; text?: unknown } }
    reason?: { kind?: unknown }
  }
}

export interface TurnStreamCardOptions {
  /** coalescing window for card updates (ms). */
  throttleMs: number
  logger?: { warn?(message: string): unknown }
}

function div(text: string): object {
  return { tag: 'div', text: { tag: 'lark_md', content: text } }
}

function shell(template: string, title: string, elements: object[]): object {
  return {
    config: { wide_screen_mode: true },
    header: { template, title: { tag: 'plain_text', content: title } },
    elements,
  }
}

function progressCard(text: string): object {
  return shell('blue', '正在生成…', [div(text === '' ? '…' : text)])
}

function finalCard(text: string): object {
  return shell('green', '回复', [div(text)])
}

function failedCard(note: string): object {
  return shell('red', '本轮未完成', [div(note)])
}

/**
 * One turn's streaming card. `push` folds `step/start` resets and
 * `assistant/chunk` text deltas (calibrated by `block-end` cumulative
 * text) into a buffer; the first visible text opens the card and later
 * updates coalesce per {@link TurnStreamCardOptions.throttleMs}. All card
 * I/O failures mark the card degraded — silent from the caller's side —
 * so `finish`/`fail` report whether the text channel must deliver.
 */
export class TurnStreamCard {
  private buffer = ''
  private messageId: string | undefined
  private opening: Promise<boolean> | undefined
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private flushQueued = false
  private closed = false
  private degraded = false

  constructor(
    private readonly sinks: CardSinks,
    private readonly target: ChatTarget,
    private readonly options: TurnStreamCardOptions,
  ) {}

  /** Fold one session event; ignored once the turn is closed or degraded. */
  push(event: StreamEventLike): void {
    if (this.closed || this.degraded) return
    if (event.type === 'step/start') {
      // The card follows the newest step's progress; the terminal card is
      // the whole-turn projection, so intermediate resets lose nothing.
      this.buffer = ''
      return
    }
    if (event.type !== 'assistant/chunk') return
    const chunk = event.data.chunk
    if (chunk === undefined) return
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      this.buffer += chunk.text
    } else if (chunk.type === 'block-end' && chunk.block !== undefined
      && chunk.block.type === 'text' && typeof chunk.block.text === 'string') {
      this.buffer = chunk.block.text
    } else {
      return
    }
    void this.ensureCard().then(opened => {
      if (opened) this.scheduleFlush()
    })
  }

  /** Open the progress card on first visible text; resolves false on failure. */
  private ensureCard(): Promise<boolean> {
    if (this.messageId !== undefined) return Promise.resolve(true)
    if (this.opening === undefined) {
      this.opening = this.sinks.sendCard(this.target.chatId, progressCard(this.buffer), {
        ...(this.target.replyTo === undefined ? {} : { replyTo: this.target.replyTo }),
        replyInThread: this.target.replyInThread === true,
      }).then(sent => {
        this.messageId = sent.messageId
        return true
      }, (error: unknown) => {
        this.degrade('send', error)
        return false
      })
    }
    return this.opening
  }

  /** At most one update per throttle window while chunks keep arriving. */
  private scheduleFlush(): void {
    if (this.flushQueued || this.closed) return
    this.flushQueued = true
    this.flushTimer = setTimeout(() => {
      this.flushQueued = false
      this.flushTimer = undefined
      void this.flush()
    }, this.options.throttleMs)
  }

  private async flush(): Promise<void> {
    if (this.closed || this.degraded) return
    const opened = await this.ensureCard()
    if (!opened) return
    if (this.buffer === '') return
    try {
      await this.sinks.updateCard(this.messageId!, progressCard(this.buffer))
    } catch (error: unknown) {
      this.degrade('update', error)
    }
  }

  private degrade(phase: 'send' | 'update' | 'final', error: unknown): void {
    this.degraded = true
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
      this.flushQueued = false
    }
    this.options.logger?.warn?.(`dsh-lark: stream card ${phase} failed: ${error instanceof Error ? error.message : String(error)} (degrading to text replies)`)
  }


  /**
   * Close the turn with the projection text as the terminal card.
   * Cancels any pending flush; later pushes are ignored. Returns
   * `'card-final'` when the terminal card carries the reply (the text
   * channel may stay quiet) and `'text-needed'` when the card path is
   * unusable (never opened or degraded) so the caller must deliver the
   * full text reply.
   */
  async finish(finalText: string): Promise<'card-final' | 'text-needed'> {
    this.closed = true
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
      this.flushQueued = false
    }
    if (this.degraded) return 'text-needed'
    // A turn that never streamed still deserves its terminal card: open
    // one now with the full projection text.
    if (this.messageId === undefined) {
      const opened = await this.ensureCard()
      if (!opened || this.messageId === undefined) return 'text-needed'
    }
    try {
      await this.sinks.updateCard(this.messageId, finalCard(finalText))
      return 'card-final'
    } catch (error: unknown) {
      this.degrade('final', error)
      return 'text-needed'
    }
  }

  /** Close a failed turn: annotate the card best-effort, text path flows on. */
  async fail(note: string): Promise<void> {
    this.closed = true
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
      this.flushQueued = false
    }
    if (this.degraded || this.messageId === undefined) return
    try {
      await this.sinks.updateCard(this.messageId, failedCard(note))
    } catch {
      // Best-effort annotation only.
    }
  }
}

/** Agent-context face the stream forwarder registers with. */
export type StreamAgentContext = {
  on(name: 'session/event', listener: (session: object, event: StreamEventLike) => void): () => void
  effect(callback: () => () => void, label?: string): void
}

/**
 * Forward one agent's `session/event` feed (agent-scoped: the runtime
 * already filters to that agent's sessions) into the streaming card the
 * bridge opened for the current turn, when one exists.
 */
export function installAgentStreamForwarder(
  agentCtx: StreamAgentContext,
  streamFor: (session: object) => TurnStreamCard | undefined,
): void {
  const stop = agentCtx.on('session/event', (session, event) => {
    streamFor(session)?.push(event)
  })
  agentCtx.effect(() => stop, 'dsh-lark: stream forwarder')
}
