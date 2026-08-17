import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk'
import { describe, expect, it, vi } from 'vitest'
import { startChannel } from '../src/channel.ts'
import type { CommandDeps } from '../src/commands.ts'

function fakeChannel() {
  const handlers = new Map<string, (event: never) => unknown>()
  return {
    handlers,
    connect: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined),
    send: vi.fn(async () => ({ messageId: 'out' })),
    on: vi.fn((name: string, handler: (event: never) => unknown) => { handlers.set(name, handler); return () => handlers.delete(name) }),
  }
}

function commandDeps(): CommandDeps {
  return {
    sessionQuery: { listSessions: vi.fn(async () => []) },
    llm: { listProviders: vi.fn(() => []), listModels: vi.fn(async () => []) },
    workspaces: { list: vi.fn(() => []) },
    presets: { list: vi.fn(async () => []) },
    controls: { rebind: vi.fn(async () => undefined), restart: vi.fn(async () => undefined), cancel: vi.fn(async () => false) },
    domain: 'feishu' as const,
  }
}

function driveBridge(reply: (message: NormalizedMessage) => Promise<string>) {
  return {
    drive: vi.fn((message: NormalizedMessage, deliver: (text: string) => Promise<void>) =>
      reply(message).then(deliver, () => undefined)),
    dispose: vi.fn(async () => undefined),
  }
}

describe('startChannel', () => {
  it('uses WebSocket policy defaults and replies to the inbound message', async () => {
    const channel = fakeChannel()
    const factory = vi.fn(() => channel as unknown as LarkChannel)
    const bridge = driveBridge(async () => 'Hello **Lark**')
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const stop = await startChannel({
      appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open',
      groupAllowlist: [], dmAllowlist: [], workspace: '/work', errorMessage: 'safe error',
      maxReplyChars: 4000, plainTextReplies: false, interactionPolicy: 'off', interactionTimeoutMs: 0, interactionCards: false, cardInteractionTimeoutMs: 120000, streamCards: false, streamThrottleMs: 800, senderLabel: 'group', commentReplies: true,
    }, bridge, commandDeps(), factory, logger)
    expect(logger.info).toHaveBeenCalledWith('dsh-lark: WebSocket connected')
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ transport: 'websocket', policy: expect.objectContaining({ requireMention: true, dmMode: 'open' }) }))
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', content: 'hi' } as never)
    await vi.waitFor(() => { expect(channel.send).toHaveBeenCalledWith('oc_1', { markdown: 'Hello **Lark**' }, { replyTo: 'om_1', replyInThread: false }) })
    await stop()
    expect(channel.disconnect).toHaveBeenCalledOnce()
    expect(bridge.dispose).toHaveBeenCalledOnce()
    expect(logger.info).toHaveBeenCalledWith('dsh-lark: WebSocket disconnected')
  })

  it('sends a safe fallback when the Harness turn fails', async () => {
    const channel = fakeChannel()
    const deliver: Array<(text: string) => Promise<void>> = []
    const bridge = {
      drive: vi.fn((_message: NormalizedMessage, _deliver: (text: string) => Promise<void>, fail: (error: unknown) => Promise<void>) => {
        deliver.push(_deliver)
        return fail(new Error('secret stack'))
      }),
      dispose: vi.fn(async () => undefined),
    }
    await startChannel({ appId: 'id', appSecret: 'secret', domain: 'lark', requireMention: true, dmMode: 'open', groupAllowlist: [], dmAllowlist: [], workspace: '/work', errorMessage: 'safe error', maxReplyChars: 4000, plainTextReplies: false, interactionPolicy: 'off', interactionTimeoutMs: 0, interactionCards: false, cardInteractionTimeoutMs: 120000, streamCards: false, streamThrottleMs: 800, senderLabel: 'group', commentReplies: true }, bridge, commandDeps(), () => channel as unknown as LarkChannel, { info: vi.fn(), warn: vi.fn(), error: vi.fn() })
    await channel.handlers.get('message')!({ messageId: 'om_1', chatId: 'oc_1', chatType: 'group', threadId: 'omt_1', content: 'hi' } as never)
    await vi.waitFor(() => { expect(channel.send).toHaveBeenCalledWith('oc_1', { text: 'safe error' }, { replyTo: 'om_1', replyInThread: true }) })
  })

  it('routes slash commands to the command surface instead of the agent', async () => {
    const channel = fakeChannel()
    const deps = commandDeps()
    deps.controls.cancel = vi.fn(async () => true)
    const bridge = driveBridge(async () => 'unused')
    await startChannel({ appId: 'id', appSecret: 'secret', domain: 'feishu', requireMention: true, dmMode: 'open', groupAllowlist: [], dmAllowlist: [], workspace: '/work', errorMessage: 'safe error', maxReplyChars: 4000, plainTextReplies: false, interactionPolicy: 'off', interactionTimeoutMs: 0, interactionCards: false, cardInteractionTimeoutMs: 120000, streamCards: false, streamThrottleMs: 800, senderLabel: 'group', commentReplies: true }, bridge, deps, () => channel as unknown as LarkChannel, { info: vi.fn(), warn: vi.fn(), error: vi.fn() })
    await channel.handlers.get('message')!({ messageId: 'om_9', chatId: 'oc_1', chatType: 'p2p', content: '/stop' } as never)
    await vi.waitFor(() => { expect(channel.send).toHaveBeenCalledWith('oc_1', { markdown: '已停止当前任务。' }, { replyTo: 'om_9', replyInThread: false }) })
    expect(deps.controls.cancel).toHaveBeenCalledWith('chat:oc_1')
    expect(bridge.drive).not.toHaveBeenCalled()
  })
})
