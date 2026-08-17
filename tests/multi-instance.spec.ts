import type { LarkChannel } from '@larksuiteoapi/node-sdk'
import { describe, expect, it, vi } from 'vitest'
import { startChannel } from '../src/channel.ts'
import type { InboundMessage } from '../src/harness.ts'
import { claimAppId } from '../src/index.ts'
import type { CommandDeps } from '../src/commands.ts'

interface FakeChannel {
  channel: LarkChannel
  handlers: Map<string, (payload: never) => unknown>
  driven: InboundMessage[]
  delivers: Array<(text: string) => Promise<void>>
  fileCommentReplyCreate: ReturnType<typeof vi.fn>
}

function fakeChannel(appId: string): FakeChannel {
  const handlers = new Map<string, (payload: never) => unknown>()
  const driven: InboundMessage[] = []
  const delivers: Array<(text: string) => Promise<void>> = []
  const fileCommentReplyCreate = vi.fn(async () => ({ code: 0, msg: 'ok' }))
  const channel = {
    rawClient: { drive: { v1: { fileCommentReply: { create: fileCommentReplyCreate } } } },
    send: vi.fn(async () => ({ messageId: `om_${appId}` })),
    updateCard: vi.fn(async () => undefined),
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    downloadResource: vi.fn(async () => Buffer.from([])),
    on: (name: string, handler: (payload: never) => unknown) => {
      handlers.set(name, handler)
      return () => undefined
    },
  }
  return { channel: channel as unknown as LarkChannel, handlers, driven, delivers, fileCommentReplyCreate }
}

function commandDeps(): CommandDeps {
  return {
    sessionQuery: { listSessions: vi.fn(async () => []) },
    llm: { listProviders: () => [], listModels: vi.fn(async () => []) },
    workspaces: { list: () => [] },
    presets: { list: vi.fn(async () => []) },
    controls: { rebind: vi.fn(), restart: vi.fn(), cancel: vi.fn(async () => false) },
    domain: 'feishu',
  }
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

async function startFake(fake: FakeChannel, appId: string): Promise<() => Promise<void>> {
  return startChannel({
    appId, appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
    groupAllowlist: [], dmAllowlist: [], errorMessage: 'safe error', maxReplyChars: 4000, plainTextReplies: false,
    interactionPolicy: 'off', interactionTimeoutMs: 0, interactionCards: false, cardInteractionTimeoutMs: 120000,
    streamCards: false, streamThrottleMs: 800, senderLabel: 'group', commentReplies: true,
  }, {
    drive: (async (message: InboundMessage, deliver: (text: string) => Promise<void>) => {
      fake.driven.push(message)
      fake.delivers.push(deliver)
    }) as never,
    dispose: vi.fn(async () => undefined),
  }, commandDeps(), () => fake.channel, logger)
}

function commentEvent(overrides: Partial<{ fileToken: string; fileType: string; commentId: string; mentionedBot: boolean; raw: unknown }> = {}) {
  return {
    fileToken: 'ft_doc_1',
    fileType: 'docx',
    commentId: 'cmt_1',
    replyId: undefined,
    operator: { openId: 'ou_1' },
    mentionedBot: true,
    timestamp: 1,
    raw: { content: { elements: [{ type: 'text_run', text_run: { text: '@bot 这段讲了什么?' } }] } },
    ...overrides,
  }
}

describe('① a document comment that @-mentions the bot drives a turn and replies in the thread', () => {
  it('routes the comment text into drive and posts the reply via the comment-reply API', async () => {
    const fake = fakeChannel('app_1')
    await startFake(fake, 'app_1')
    await fake.handlers.get('comment')!(commentEvent() as never)
    await vi.waitFor(() => { expect(fake.driven).toHaveLength(1) })
    const message = fake.driven[0]!
    expect(message.chatId).toBe('doc:ft_doc_1')
    expect(message.chatType).toBe('p2p')
    expect(message.replyToMessageId).toBe('cmt_1')
    expect(message.content).toContain('这段讲了什么?')
    await fake.delivers[0]!('这是该评论的答案。')
    expect(fake.fileCommentReplyCreate).toHaveBeenCalledWith(expect.objectContaining({
      params: { file_type: 'docx' },
      path: { file_token: 'ft_doc_1', comment_id: 'cmt_1' },
    }))
    const payload = fake.fileCommentReplyCreate.mock.calls[0]![0] as { data: { content: { elements: Array<{ text_run: { text: string } }> } } }
    expect(payload.data.content.elements[0]!.text_run.text).toBe('这是该评论的答案。')
  })

  it('ignores comments that do not mention the bot and unsupported file types', async () => {
    const fake = fakeChannel('app_2')
    await startFake(fake, 'app_2')
    await fake.handlers.get('comment')!(commentEvent({ mentionedBot: false }) as never)
    await fake.handlers.get('comment')!(commentEvent({ fileType: 'wiki' }) as never)
    expect(fake.driven).toHaveLength(0)
    expect(fake.fileCommentReplyCreate).not.toHaveBeenCalled()
  })
})

describe('② two instances with distinct apps stay isolated', () => {
  it('events land only in the instance whose channel delivered them', async () => {
    const a = fakeChannel('app_a')
    const b = fakeChannel('app_b')
    await startFake(a, 'app_a')
    await startFake(b, 'app_b')
    await a.handlers.get('comment')!(commentEvent({ fileToken: 'ft_a', commentId: 'cmt_a' }) as never)
    await b.handlers.get('message')!({ messageId: 'om_b', chatId: 'oc_b', chatType: 'p2p', content: 'hello' } as never)
    await vi.waitFor(() => { expect(a.driven).toHaveLength(1) })
    expect(a.driven[0]!.chatId).toBe('doc:ft_a')
    await vi.waitFor(() => { expect(b.driven).toHaveLength(1) })
    expect(b.driven[0]!.chatId).toBe('oc_b')
    // Cross check: nothing leaked between instances.
    expect(a.driven).toHaveLength(1)
    // A's reply goes to A's comment thread only.
    await a.delivers[0]!('answer for a')
    expect(a.fileCommentReplyCreate).toHaveBeenCalledTimes(1)
    expect(b.fileCommentReplyCreate).not.toHaveBeenCalled()
  })
})

describe('③ one app, one connection is enforced and documented', () => {
  it('a second instance with the same appId fails fast; distinct apps coexist; release frees the id', () => {
    const releaseA = claimAppId('app_dup')
    expect(() => claimAppId('app_dup')).toThrow(/one WebSocket connection/)
    const releaseB = claimAppId('app_other')
    releaseB()
    releaseA()
    // After release the id is claimable again.
    expect(() => claimAppId('app_dup')).not.toThrow()
  })
})
