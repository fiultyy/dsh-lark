import type { ResolvedConfig } from './config.ts'

/** Minimal channel face `sendReply` needs; the official Lark channel satisfies it. */
export interface SliceCapableChannel {
  send(
    chatId: string,
    payload: { markdown: string } | { text: string },
    options?: { replyTo?: string; replyInThread?: boolean },
  ): Promise<unknown>
}

export interface OutboundPolicy {
  /** Per-slice budget counted in Unicode code points. */
  maxChars: number
  /** Degradation switch: send plain-text slices instead of markdown. */
  plainText: boolean
}

export interface OutboundLogger {
  warn(message: string): unknown
  error(message: string): unknown
}

const FENCE_OPEN_PATTERN = /^(\s*)(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE_PATTERN = /^\s*(`{3,}|~{3,})\s*$/

interface SourceBlock {
  /** Paragraph lines, or fenced-block body lines (opener kept aside). */
  lines: string[]
  /** Exact separator that followed this block in the source; '' for the final block. */
  separatorAfter: string
  /** Present for fenced blocks: opener line info and derived closer. */
  fence: { opener: string; closer: string } | undefined
}

/** A block already guaranteed to fit `maxChars`; atomic unit of slice packing. */
interface AtomicBlock {
  render: string
  separatorAfter: string
}

function codePoints(text: string): string[] {
  return [...text]
}

function parseBlocks(text: string): SourceBlock[] {
  const lines = text.split('\n')
  const blocks: SourceBlock[] = []
  let current: SourceBlock | undefined
  let blanks = 0
  let openFence: { indent: string; marker: string } | undefined
  const openBlock = () => {
    current = { lines: [], separatorAfter: '', fence: undefined }
    blocks.push(current)
  }
  for (const line of lines) {
    if (openFence !== undefined) {
      const close = FENCE_CLOSE_PATTERN.exec(line)
      if (close !== null && close[1]![0] === openFence.marker[0]) {
        openFence = undefined
        continue
      }
      current!.lines.push(line)
      continue
    }
    if (line.trim() === '') {
      blanks += 1
      continue
    }
    const fenceOpen = FENCE_OPEN_PATTERN.exec(line)
    if (current !== undefined) {
      // A blank line (or a fence close above) starts a new block; consecutive
      // non-blank lines stay one paragraph. Record the exact separator that
      // separated the previous block from this one so packing can replay it.
      current.separatorAfter = '\n'.repeat(blanks + 1)
    }
    blanks = 0
    openBlock()
    if (fenceOpen !== null) {
      const indent = fenceOpen[1]!
      const marker = fenceOpen[2]!
      current!.fence = { opener: line, closer: indent + marker }
      openFence = { indent, marker }
    } else {
      current!.lines.push(line)
    }
  }
  if (current !== undefined && blanks > 0) current.separatorAfter = '\n'.repeat(blanks)
  return blocks
}

function renderBlock(block: SourceBlock): string {
  if (block.fence === undefined) return block.lines.join('\n')
  // An unclosed fence at end-of-text still renders closed: every slice must
  // carry balanced fences for Feishu-side markdown to parse.
  return [block.fence.opener, ...block.lines, block.fence.closer].join('\n')
}

/** Hard-cut one oversized line by code points, preferring a space boundary so
 * words (and the space itself) survive concatenation of the pieces. */
function hardCutLine(line: string, maxChars: number): string[] {
  const points = codePoints(line)
  if (points.length <= maxChars) return [line]
  const pieces: string[] = []
  let index = 0
  while (index < points.length) {
    let end = Math.min(index + maxChars, points.length)
    if (end < points.length) {
      const lastSpace = points.lastIndexOf(' ', end - 1)
      if (lastSpace > index + Math.floor(maxChars / 2)) end = lastSpace
    }
    pieces.push(points.slice(index, end).join(''))
    index = end
  }
  return pieces
}

/** Split one oversized source block into atomic blocks of at most `maxChars`. */
function splitOversized(block: SourceBlock, maxChars: number): AtomicBlock[] {
  const atomic: AtomicBlock[] = []
  const pushChain = (pieces: string[], separator: string) => {
    for (const [i, piece] of pieces.entries()) {
      if (piece === '') continue
      atomic.push({ render: piece, separatorAfter: i === pieces.length - 1 ? block.separatorAfter : separator })
    }
  }
  if (block.fence === undefined) {
    // Plain paragraph: pack whole lines first, hard-cut only a lone giant line.
    const linePieces: string[] = []
    let group: string[] = []
    for (const line of block.lines) {
      if (codePoints(line).length > maxChars) {
        if (group.length > 0) { linePieces.push(group.join('\n')); group = [] }
        linePieces.push(...hardCutLine(line, maxChars))
        continue
      }
      const candidate = [...group, line].join('\n')
      if (codePoints(candidate).length > maxChars && group.length > 0) {
        linePieces.push(group.join('\n'))
        group = [line]
      } else {
        group = [...group, line]
      }
    }
    if (group.length > 0) linePieces.push(group.join('\n'))
    pushChain(linePieces, '\n')
    return atomic
  }
  const { opener, closer } = block.fence
  const framing = codePoints(opener).length + codePoints(closer).length + 2
  const bodyBudget = maxChars - framing
  // Degenerate config where the fence framing alone exceeds the budget: emit
  // the opener/closer pair around at least one character rather than loop.
  const safeBudget = Math.max(bodyBudget, 1)
  const bodyPieces: string[] = []
  let group: string[] = []
  for (const line of block.lines) {
    if (codePoints(line).length > safeBudget) {
      if (group.length > 0) { bodyPieces.push(group.join('\n')); group = [] }
      bodyPieces.push(...hardCutLine(line, safeBudget))
      continue
    }
    const candidate = [...group, line].join('\n')
    if (codePoints(candidate).length > safeBudget && group.length > 0) {
      bodyPieces.push(group.join('\n'))
      group = [line]
    } else {
      group = [...group, line]
    }
  }
  if (group.length > 0) bodyPieces.push(group.join('\n'))
  pushChain(bodyPieces.map(piece => [opener, piece, closer].join('\n')), '\n')
  return atomic
}

/**
 * Slice markdown into ordered pieces of at most `maxChars` code points each.
 * Cuts prefer paragraph boundaries, then lines, then code points. A fenced
 * code block travels whole when it fits; an oversized one is split with the
 * fence closed and reopened (original info string kept) so no slice ever
 * carries an unbalanced fence.
 */
export function sliceMarkdown(text: string, maxChars: number): string[] {
  if (maxChars < 1) throw new TypeError('maxChars must be positive')
  const atomic: AtomicBlock[] = []
  for (const block of parseBlocks(text)) {
    const render = renderBlock(block)
    if (codePoints(render).length <= maxChars) {
      atomic.push({ render, separatorAfter: block.separatorAfter })
    } else {
      atomic.push(...splitOversized(block, maxChars))
    }
  }
  const slices: string[] = []
  let currentPoints: string[] = []
  for (const [index, block] of atomic.entries()) {
    const renderPoints = codePoints(block.render)
    // The separator between two atomic blocks packed into the same slice is
    // the one that separated them in the source; a slice boundary drops it.
    const sepPoints = index === 0 ? [] : codePoints(atomic[index - 1]!.separatorAfter)
    if (currentPoints.length > 0 && currentPoints.length + sepPoints.length + renderPoints.length > maxChars) {
      slices.push(currentPoints.join(''))
      currentPoints = renderPoints
    } else {
      currentPoints = [...currentPoints, ...sepPoints, ...renderPoints]
    }
  }
  if (currentPoints.length > 0) slices.push(currentPoints.join(''))
  return slices.length === 0 ? [''] : slices
}

/**
 * Send one reply text as ordered slices. Each slice failure is isolated: the
 * remaining slices still go out and the failure is logged; only a total
 * failure (every slice failed) rethrows so the caller's safe-error path runs.
 */
export async function sendReply(
  channel: SliceCapableChannel,
  chatId: string,
  text: string,
  options: { replyTo: string; replyInThread: boolean },
  policy: OutboundPolicy,
  logger: OutboundLogger,
): Promise<void> {
  const slices = sliceMarkdown(text, policy.maxChars)
  let failures = 0
  let lastError: unknown
  for (const slice of slices) {
    const payload = policy.plainText ? { text: slice } : { markdown: slice }
    try {
      await channel.send(chatId, payload, { replyTo: options.replyTo, replyInThread: options.replyInThread })
    } catch (error: unknown) {
      failures += 1
      lastError = error
      logger.error(`dsh-lark: reply slice ${failures}/${slices.length} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (failures === slices.length && slices.length > 0) throw lastError
  if (failures > 0) logger.warn(`dsh-lark: delivered ${slices.length - failures}/${slices.length} reply slices`)
}

/** Build the outbound policy from resolved plugin config. */
export function outboundPolicy(config: ResolvedConfig): OutboundPolicy {
  return { maxChars: config.maxReplyChars, plainText: config.plainTextReplies }
}
