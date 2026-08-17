import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { describe, expect, it, vi } from 'vitest'
import { startChannel } from '../src/channel.ts'
import { collectMedia, composeUserText, detectImageMediaType, sanitizeFileName } from '../src/media.ts'
import type { AttachmentsLike } from '../src/media.ts'
import { HarnessConversationService } from '../src/harness.ts'
import type { HarnessDependencies, InboundMessage } from '../src/harness.ts'
import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function imageRef(name?: string): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
    mediaType: 'image/png',
    bytes: 8,
    width: 1,
    height: 1,
    ...(name === undefined ? {} : { name }),
  }
}

describe('① an image lands as an agent-visible image block and the turn completes', () => {
  it('collectMedia downloads the image and saves it through the attachments service', async () => {
    const saveImage = vi.fn(async () => imageRef('photo.png'))
    const attachments: AttachmentsLike = { saveImage }
    const downloadResource = vi.fn(async () => PNG_MAGIC)
    const media = await collectMedia('om_1', [{ type: 'image', fileKey: 'fk_img', fileName: 'photo.png' }], {
      downloadResource,
      attachments,
      filesDir: join(tmpdir(), 'unused'),
    })
    expect(downloadResource).toHaveBeenCalledWith('fk_img', 'image')
    expect(saveImage).toHaveBeenCalledWith(expect.objectContaining({ mediaType: 'image/png', name: 'photo.png' }))
    expect(media.images).toHaveLength(1)
    expect(media.files).toHaveLength(0)
  })

  it('the bridge turn sends image blocks plus text and completes', async () => {
    const followup = vi.fn()
    let seq = 0
    const events: Array<{ seq: number; type: string; data: Record<string, unknown> }> = []
    followup.mockImplementation(() => {
      events.push({ seq: seq++, type: 'turn/start', data: {} })
      events.push({ seq: seq++, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'saw image' }] } } })
      events.push({ seq: seq++, type: 'turn/end', data: { reason: { kind: 'completed' } } })
    })
    const agent = {
      session: { id: 's1', get seq() { return seq }, events },
      status: 'idle' as const,
      whenIdle: vi.fn(async () => undefined),
      followup,
      cancel: vi.fn(),
    }
    const deps = {
      agents: {
        create: vi.fn(async () => ({ agent, dispose: vi.fn(async () => undefined) })),
        resume: vi.fn(async () => { throw new Error('session "x" not found') }),
      },
      sessions: { flush: vi.fn(async () => undefined) },
      selection: () => ({ provider: 'p', model: 'm' }),
      agentPresets: { resolve: vi.fn(async () => ({ id: 'default' })), mount: vi.fn(async () => undefined) },
      workspaceRegistry: { list: () => [], resolveByPath: vi.fn(async () => undefined) },
    } as unknown as HarnessDependencies
    const service = new HarnessConversationService(deps, { domain: 'feishu' })
    const message: InboundMessage = {
      chatId: 'oc_1', chatType: 'p2p', content: 'describe this', images: [imageRef()],
    }
    await expect(service.reply(message)).resolves.toBe('saw image')
    const payload = followup.mock.calls[0]![0] as { content: Array<{ type: string; attachment?: ImageAttachmentRef; text?: string }> }
    expect(payload.content[0]).toEqual({ type: 'image', attachment: imageRef() })
    expect(payload.content[1]).toEqual({ type: 'text', text: 'describe this' })
  })
})

describe('② a file lands locally and is referenced by path', () => {
  it('collectMedia writes the file under the message directory', async () => {
    const filesDir = await mkdtemp(join(tmpdir(), 'dsh-lark-media-'))
    const downloadResource = vi.fn(async () => Buffer.from('spec-bytes'))
    const media = await collectMedia('om_2', [{ type: 'file', fileKey: 'fk_file', fileName: 'spec.pdf' }], {
      downloadResource,
      filesDir,
    })
    expect(downloadResource).toHaveBeenCalledWith('fk_file', 'file')
    expect(media.images).toHaveLength(0)
    expect(media.files).toHaveLength(1)
    const saved = media.files[0]!
    expect(saved.name).toBe('spec.pdf')
    expect(await readFile(saved.path, 'utf8')).toBe('spec-bytes')
    expect((await readdir(join(filesDir, 'om_2'))).length).toBe(1)
  })

  it('composeUserText appends a reference line the agent can cite', () => {
    const text = composeUserText('看下这个文档', { images: [], files: [{ name: 'spec.pdf', path: '/tmp/x/spec.pdf', bytes: 10 }] }, { chatType: 'p2p' }, 'group')
    expect(text).toContain('[附件] spec.pdf 已保存到 /tmp/x/spec.pdf(10 字节)')
    expect(text.startsWith('看下这个文档')).toBe(true)
  })

  it('traversal-unsafe names are sanitized inside the message directory', () => {
    expect(sanitizeFileName('../../etc/passwd', 'fallback.bin')).toBe('passwd')
    expect(sanitizeFileName('', 'fallback.bin')).toBe('fallback.bin')
  })
})

describe('③ sender identity prefixes per configuration', () => {
  it('group prefixes group chats only; always prefixes both; off never', () => {
    const group = { chatType: 'group' as const, senderName: '张三', senderId: 'ou_1' }
    const dm = { chatType: 'p2p' as const, senderName: '张三', senderId: 'ou_1' }
    expect(composeUserText('hi', undefined, group, 'group')).toBe('[张三] hi')
    expect(composeUserText('hi', undefined, dm, 'group')).toBe('hi')
    expect(composeUserText('hi', undefined, dm, 'always')).toBe('[张三] hi')
    expect(composeUserText('hi', undefined, group, 'off')).toBe('hi')
    // Name missing falls back to the open id.
    expect(composeUserText('hi', undefined, { chatType: 'group', senderId: 'ou_9' }, 'group')).toBe('[ou_9] hi')
  })
})

describe('④ plain text keeps the exact historical shape', () => {
  it('no media and default label: one text block, no prefix in p2p', async () => {
    const followup = vi.fn()
    let seq = 0
    const events: Array<{ seq: number; type: string; data: Record<string, unknown> }> = []
    followup.mockImplementation(() => {
      events.push({ seq: seq++, type: 'turn/start', data: {} })
      events.push({ seq: seq++, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ok' }] } } })
      events.push({ seq: seq++, type: 'turn/end', data: { reason: { kind: 'completed' } } })
    })
    const agent = {
      session: { id: 's2', get seq() { return seq }, events },
      status: 'idle' as const,
      whenIdle: vi.fn(async () => undefined),
      followup,
      cancel: vi.fn(),
    }
    const deps = {
      agents: {
        create: vi.fn(async () => ({ agent, dispose: vi.fn(async () => undefined) })),
        resume: vi.fn(async () => { throw new Error('session "y" not found') }),
      },
      sessions: { flush: vi.fn(async () => undefined) },
      selection: () => ({ provider: 'p', model: 'm' }),
      agentPresets: { resolve: vi.fn(async () => ({ id: 'default' })), mount: vi.fn(async () => undefined) },
      workspaceRegistry: { list: () => [], resolveByPath: vi.fn(async () => undefined) },
    } as unknown as HarnessDependencies
    const service = new HarnessConversationService(deps, { domain: 'feishu' })
    await expect(service.reply({ chatId: 'oc_2', chatType: 'p2p', content: 'plain question' })).resolves.toBe('ok')
    const payload = followup.mock.calls[0]![0] as { content: Array<{ type: string; text?: string }> }
    expect(payload.content).toEqual([{ type: 'text', text: 'plain question' }])
  })

  it('the channel routes resource-bearing messages through media collection before the turn', async () => {
    const handlers = new Map<string, (payload: never) => unknown>()
    const downloadResource = vi.fn(async () => PNG_MAGIC)
    const saveImage = vi.fn(async () => imageRef())
    const driven: InboundMessage[] = []
    const channel = {
      send: vi.fn(async () => ({ messageId: 'om_out' })),
      updateCard: vi.fn(async () => undefined),
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      downloadResource,
      on: (name: string, handler: (payload: never) => unknown) => {
        handlers.set(name, handler)
        return () => undefined
      },
    }
    const stop = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', maxReplyChars: 4000, plainTextReplies: false,
      interactionPolicy: 'off', interactionTimeoutMs: 0, interactionCards: false, cardInteractionTimeoutMs: 120000,
      streamCards: false, streamThrottleMs: 800, senderLabel: 'group', commentReplies: true,
    }, {
      drive: (async (message: InboundMessage) => { driven.push(message) }) as never,
      dispose: vi.fn(async () => undefined),
    }, {
      sessionQuery: { listSessions: vi.fn(async () => []) },
      llm: { listProviders: () => [], listModels: vi.fn(async () => []) },
      workspaces: { list: () => [] },
      presets: { list: vi.fn(async () => []) },
      controls: { rebind: vi.fn(), restart: vi.fn(), cancel: vi.fn(async () => false) },
      domain: 'feishu',
    }, () => channel as unknown as LarkChannel, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, undefined, {
      attachments: { saveImage },
      filesDir: await mkdtemp(join(tmpdir(), 'dsh-lark-media-')),
    })
    const message = {
      messageId: 'om_9', chatId: 'oc_1', chatType: 'group', senderId: 'ou_2', senderName: '李四',
      content: 'check', rawContentType: 'image', resources: [{ type: 'image', fileKey: 'fk_9', fileName: 'shot.png' }],
      mentions: [], mentionAll: false, mentionedBot: true, createTime: 1,
    } as unknown as NormalizedMessage
    await handlers.get('message')!(message as never)
    await vi.waitFor(() => { expect(driven).toHaveLength(1) })
    expect(driven[0]!.images).toEqual([imageRef()])
    // The channel passes sender identity through; the bridge prefixes it
    // at turn time (covered in ①/③ through runTurn and composeUserText).
    expect(driven[0]!.senderName).toBe('李四')
    expect(driven[0]!.content).toBe('check')
    await stop()
  })
})

describe('media type detection', () => {
  it('recognizes the four accepted formats and rejects others', () => {
    expect(detectImageMediaType(PNG_MAGIC)).toBe('image/png')
    expect(detectImageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(detectImageMediaType(Buffer.from('GIF89a'))).toBe('image/gif')
    expect(detectImageMediaType(Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp')
    expect(detectImageMediaType(Buffer.from('not an image'))).toBeUndefined()
  })
})
