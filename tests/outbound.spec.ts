import { describe, expect, it, vi } from 'vitest'
import { sendReply, sliceMarkdown, type SliceCapableChannel } from '../src/outbound.ts'

type SendPayload = { markdown?: string; text?: string }
type SendOptions = { replyTo?: string; replyInThread?: boolean }
interface SendRecord { chatId: string; payload: SendPayload; options: SendOptions | undefined }
function fakeChannel(failAt?: () => number | undefined): SliceCapableChannel & { sends: SendRecord[] } {
  const sends: SendRecord[] = []
  const channel: SliceCapableChannel = {
    async send(chatId, payload, options) {
      const failIndex = failAt?.()
      if (failIndex !== undefined && sends.length === failIndex) throw new Error('slice rejected')
      sends.push({ chatId, payload, options })
      return { messageId: 'out' }
    },
  }
  return Object.assign(channel, { sends })
}

describe('sliceMarkdown', () => {
  it('delivers any length losslessly in order (CJK/emoji width)', () => {
    const paragraphs = [
      '第一段:中文回复,包含标点与全角字符。',
      'Second paragraph with ASCII words and punctuation, plus emoji 🎉👨‍👩‍👧‍👦 mixed in.',
      '短句三。',
    ]
    const repeated = Array.from({ length: 40 }, (_, i) => `${paragraphs[i % paragraphs.length]!} (序号 ${i})`).join('\n\n')
    const slices = sliceMarkdown(repeated, 400)
    expect(slices.length).toBeGreaterThan(2)
    for (const slice of slices) {
      expect([...slice].length).toBeLessThanOrEqual(400)
      expect(slice.length).toBeGreaterThan(0)
    }
    // Paragraph-boundary cuts reassemble exactly through the same separator.
    expect(slices.join('\n\n')).toBe(repeated)

    // A single giant CJK line with no spaces forces code-point hard cutting;
    // pieces concatenate (no inserted separator) back to the original.
    const giant = '中文无空格长行。'.repeat(200)
    const hardSlices = sliceMarkdown(giant, 400)
    expect(hardSlices.length).toBeGreaterThan(2)
    for (const slice of hardSlices) expect([...slice].length).toBeLessThanOrEqual(400)
    expect(hardSlices.join('')).toBe(giant)
    // Emoji survive as whole code points on every cut surface.
    expect(sliceMarkdown('🎉'.repeat(50), 40).join('')).toBe('🎉'.repeat(50))
  })

  it('never straddles a code fence and reopens oversized blocks with the original info', () => {
    const body = Array.from({ length: 60 }, (_, i) => `const value${i} = ${'x'.repeat(60)} // 中文注释`).join('\n')
    const text = `Intro paragraph.\n\n\`\`\`python\n${body}\n\`\`\`\n\nOutro paragraph.`
    const slices = sliceMarkdown(text, 400)
    expect(slices.length).toBeGreaterThan(1)
    for (const slice of slices) {
      // Balanced fences on every slice: no unpaired opener or closer survives.
      expect([...slice.matchAll(/^```/gm)].length % 2).toBe(0)
      // Reopened pieces carry the original info string in the same slice.
      if (slice.includes('const value')) expect(slice).toContain('```python')
    }
    // Code content stays in order across pieces.
    const joined = slices.join('\n')
    expect(joined.indexOf('const value0')).toBeLessThan(joined.indexOf('const value59'))
    // A small fence block travels whole inside one slice.
    const small = `before\n\n\`\`\`js\nconsole.log(1)\n\`\`\`\n\nafter ${'word '.repeat(120)}end`
    const fenceSlice = sliceMarkdown(small, 200).find(slice => slice.includes('console.log'))
    expect(fenceSlice).toBeDefined()
    expect(fenceSlice).toContain('```js\nconsole.log(1)\n```')
  })
})

describe('sendReply', () => {
  it('isolates a single slice failure to that slice only', async () => {
    const text = Array.from({ length: 60 }, (_, i) => `第 ${i} 段内容,保持段落结构。`).join('\n\n')
    const slices = sliceMarkdown(text, 400)
    expect(slices.length).toBeGreaterThanOrEqual(3)
    // Fail exactly the second outgoing slice: at call 2, sends.length is 1.
    let calls = 0
    const channel = fakeChannel(() => {
      calls += 1
      return calls === 2 ? 1 : undefined
    })
    const logger = { warn: vi.fn(), error: vi.fn() }
    await expect(sendReply(channel, 'oc_1', text, { replyTo: 'om_1', replyInThread: false }, { maxChars: 400, plainText: false }, logger)).resolves.toBeUndefined()
    expect(channel.sends.length).toBe(slices.length - 1)
    const delivered = channel.sends.map(entry => entry.payload.markdown ?? '')
    expect(delivered.join('\n\n')).toBe([slices[0]!, ...slices.slice(2)].join('\n\n'))
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('keeps the full content when the plain-text degradation switch is on', async () => {
    const text = `# 标题\n\n第一段中文内容。\n\n\`\`\`js\nconsole.log('hi')\n\`\`\`\n\nLast paragraph with emoji 🎉.`
    const channel = fakeChannel()
    const logger = { warn: vi.fn(), error: vi.fn() }
    await sendReply(channel, 'oc_1', text, { replyTo: 'om_1', replyInThread: true }, { maxChars: 40, plainText: true }, logger)
    expect(channel.sends.length).toBeGreaterThan(1)
    for (const entry of channel.sends) {
      expect(entry.payload).toHaveProperty('text')
      expect(entry.payload).not.toHaveProperty('markdown')
      expect(entry.options).toEqual({ replyTo: 'om_1', replyInThread: true })
    }
    const reassembled = channel.sends.map(entry => entry.payload.text ?? '').join('\n\n')
    expect(reassembled).toContain('第一段中文内容。')
    expect(reassembled).toContain('console.log(\'hi\')')
    expect(reassembled).toContain('Last paragraph with emoji 🎉.')
  })
})
