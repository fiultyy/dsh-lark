import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TurnStreamCard } from '../src/stream.ts'
import type { CardSinks } from '../src/card-answerer.ts'

function sinks(): CardSinks & { sendCard: ReturnType<typeof vi.fn>; updateCard: ReturnType<typeof vi.fn> } {
  return {
    sendCard: vi.fn(async () => ({ messageId: 'om_stream_1' })),
    updateCard: vi.fn(async () => undefined),
  }
}

function target() {
  return { chatId: 'oc_1', replyTo: 'om_in_1', replyInThread: false }
}

function textDelta(piece: string) {
  return { type: 'assistant/chunk', data: { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: piece } } }
}

function blockEnd(full: string) {
  return {
    type: 'assistant/chunk',
    data: { turn: 0, step: 0, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: full } } },
  }
}

/** Extract the lark_md text content of the first div element in a card. */
function bodyText(card: unknown): string {
  const record = card as { elements?: Array<{ tag?: string; text?: { content?: string } }> }
  return record.elements?.find(element => element.tag === 'div')?.text?.content ?? ''
}

const THROTTLE = 800

describe('① N chunks inside the throttle window coalesce into ≤1 card update', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('five deltas in one window produce one send and one update', async () => {
    const s = sinks()
    const card = new TurnStreamCard(s, target(), { throttleMs: THROTTLE })
    for (const piece of ['你', '好', '，', '世', '界']) card.push(textDelta(piece))
    await vi.advanceTimersByTimeAsync(0)
    // The card opens with the first visible text...
    expect(s.sendCard).toHaveBeenCalledTimes(1)
    // ...and no update fires before the window elapses.
    expect(s.updateCard).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(THROTTLE)
    expect(s.updateCard).toHaveBeenCalledTimes(1)
    expect(bodyText(s.updateCard.mock.calls[0]![1])).toBe('你好，世界')
    // Back-to-back windows each coalesce their own burst.
    for (const piece of ['！', '！']) card.push(textDelta(piece))
    await vi.advanceTimersByTimeAsync(THROTTLE)
    expect(s.updateCard).toHaveBeenCalledTimes(2)
    expect(bodyText(s.updateCard.mock.calls[1]![1])).toBe('你好，世界！！')
    await card.finish('你好，世界！！')
  })

  it('block-end cumulative text calibrates the delta accumulation', async () => {
    const s = sinks()
    const card = new TurnStreamCard(s, target(), { throttleMs: THROTTLE })
    card.push(textDelta('dw'))
    card.push(textDelta('arf'))
    card.push(blockEnd('dwarf'))
    await vi.advanceTimersByTimeAsync(THROTTLE)
    expect(bodyText(s.updateCard.mock.calls[0]![1])).toBe('dwarf')
    await card.finish('dwarf')
  })
})

describe('② the terminal card equals the summarizeTurn projection', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('finish sets the full projection text on the same card', async () => {
    const s = sinks()
    const card = new TurnStreamCard(s, target(), { throttleMs: THROTTLE })
    card.push(textDelta('partial '))
    await vi.advanceTimersByTimeAsync(THROTTLE)
    // A pending flushed update is superseded by the terminal write.
    card.push(textDelta('more'))
    const settled = card.finish('partial more FINAL-PROJECTION')
    await vi.advanceTimersByTimeAsync(THROTTLE * 2)
    await expect(settled).resolves.toBe('card-final')
    const last = s.updateCard.mock.calls.at(-1)!
    expect(bodyText(last[1])).toBe('partial more FINAL-PROJECTION')
  })

  it('a turn whose stream produced no chunks still lands the terminal card', async () => {
    const s = sinks()
    const card = new TurnStreamCard(s, target(), { throttleMs: THROTTLE })
    await expect(card.finish('whole reply from projection')).resolves.toBe('card-final')
    expect(s.sendCard).toHaveBeenCalledTimes(1)
    expect(bodyText(s.updateCard.mock.calls.at(-1)![1])).toBe('whole reply from projection')
  })
})

describe('③ zero residual updates after turn/end', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a pending throttled flush is cancelled by finish; later pushes are ignored', async () => {
    const s = sinks()
    const card = new TurnStreamCard(s, target(), { throttleMs: THROTTLE })
    card.push(textDelta('a'))
    await vi.advanceTimersByTimeAsync(0)
    card.push(textDelta('b'))
    const updatesAtFinish = s.updateCard.mock.calls.length
    await card.finish('ab')
    const updatesAfterFinish = s.updateCard.mock.calls.length
    // finish replaced any pending intermediate update with the terminal one.
    expect(updatesAfterFinish).toBe(updatesAtFinish + 1)
    card.push(textDelta('late'))
    await vi.advanceTimersByTimeAsync(THROTTLE * 3)
    expect(s.updateCard.mock.calls.length).toBe(updatesAfterFinish)
    expect(bodyText(s.updateCard.mock.calls.at(-1)![1])).toBe('ab')
  })
})

describe('④ card API failure degrades silently and the full reply survives', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('send failure: no card at all, finish reports text-needed', async () => {
    const s = sinks()
    s.sendCard.mockRejectedValueOnce(new Error('card api rate limited'))
    const warnings: string[] = []
    const card = new TurnStreamCard(s, target(), { throttleMs: THROTTLE, logger: { warn: (m: string) => warnings.push(m) } })
    card.push(textDelta('hello'))
    await vi.advanceTimersByTimeAsync(THROTTLE * 2)
    await expect(card.finish('hello full reply')).resolves.toBe('text-needed')
    expect(s.updateCard).not.toHaveBeenCalled()
    expect(warnings.join('\n')).toContain('stream card send failed')
  })

  it('update failure mid-stream: card degrades, finish reports text-needed', async () => {
    const s = sinks()
    const card = new TurnStreamCard(s, target(), { throttleMs: THROTTLE })
    card.push(textDelta('x'))
    await vi.advanceTimersByTimeAsync(0)
    s.updateCard.mockRejectedValueOnce(new Error('update failed'))
    card.push(textDelta('y'))
    await vi.advanceTimersByTimeAsync(THROTTLE)
    await expect(card.finish('xy full reply')).resolves.toBe('text-needed')
    // The bridge's deliver() path runs — the reply is not lost.
  })

  it('terminal update failure: finish reports text-needed even after a healthy stream', async () => {
    const s = sinks()
    const card = new TurnStreamCard(s, target(), { throttleMs: THROTTLE })
    card.push(textDelta('x'))
    await vi.advanceTimersByTimeAsync(THROTTLE)
    expect(s.updateCard).toHaveBeenCalledTimes(1)
    s.updateCard.mockRejectedValueOnce(new Error('final failed'))
    await expect(card.finish('x full reply')).resolves.toBe('text-needed')
  })
})
