import { Domain, LoggerLevel, createLarkChannel } from '@larksuiteoapi/node-sdk'
import type { LarkChannel, LarkChannelOptions, NormalizedMessage } from '@larksuiteoapi/node-sdk'
import type { ResolvedConfig } from './config.ts'
import type { HarnessConversationService, InboundMessage } from './harness.ts'
import { sendReply } from './outbound.ts'
import { applyCardAction, handleCommand, parseCommand } from './commands.ts'
import type { CommandDeps } from './commands.ts'
import type { InteractionCardHub } from './card-answerer.ts'
import { collectMedia } from './media.ts'
import type { AttachmentsLike, InboundResource } from './media.ts'
import type { CommentEvent } from '@larksuiteoapi/node-sdk'
import { EMPTY_COMMENT_TEXT, commentText, isCommentFileType, replyComment } from './comments.ts'
import type { CommentReplyClient } from './comments.ts'
export type ChannelFactory = (options: LarkChannelOptions) => LarkChannel
export interface PluginLogger {
  info(message: string): unknown
  warn(message: string): unknown
  error(message: string): unknown
}

export interface ChannelMediaDeps {
  /** Durable attachment store; absent means images drop with a warning. */
  attachments?: AttachmentsLike
  /** Root for per-message file saves. */
  filesDir: string
}

export async function startChannel(
  config: ResolvedConfig,
  bridge: Pick<HarnessConversationService, 'drive' | 'dispose'>,
  commandDeps: CommandDeps,
  factory: ChannelFactory = createLarkChannel,
  logger: PluginLogger = console,
  cardHub?: InteractionCardHub,
  media?: ChannelMediaDeps,
): Promise<() => Promise<void>> {
  const channel = factory({
    appId: config.appId,
    appSecret: config.appSecret,
    transport: 'websocket',
    domain: config.domain === 'lark' ? Domain.Lark : Domain.Feishu,
    source: 'dsh-lark',
    loggerLevel: LoggerLevel.info,
    handshakeTimeoutMs: 15_000,
    // Comment text is not part of the normalized CommentEvent (LK-009);
    // keep the raw payload so extraction can read it.
    includeRawEvent: true,
    policy: {
      requireMention: config.requireMention,
      dmMode: config.dmMode,
      groupAllowlist: config.groupAllowlist,
      dmAllowlist: config.dmAllowlist,
      respondToMentionAll: false,
    },
    safety: {
      chatQueue: { enabled: true },
      staleMessageWindowMs: 5 * 60_000,
      dedup: { ttl: 10 * 60_000, maxEntries: 10_000 },
    },
  })

  const unsubscribers = [
    channel.on('message', async (message: NormalizedMessage) => {
      const replyInThread = message.threadId !== undefined
      const options = { replyTo: message.messageId, replyInThread }
      const parsed = parseCommand(message.content)
      if (parsed !== undefined) {
        try {
          await handleCommand(commandDeps, message, parsed, (payload, override) =>
            channel.send(message.chatId, payload, override ?? options))
        } catch (error: unknown) {
          logger.error(`dsh-lark: command handling failed: ${error instanceof Error ? error.message : String(error)}`)
          await channel.send(message.chatId, { text: config.errorMessage }, options).catch((sendError: unknown) => {
            logger.error(`dsh-lark: fallback reply failed: ${sendError instanceof Error ? sendError.message : String(sendError)}`)
          })
        }
        return
      }
      // Inbound media (LK-007): download before the turn starts so the
      // agent receives image blocks and file paths with the prompt.
      let inbound: InboundMessage = message
      if ((message.resources?.length ?? 0) > 0 && media !== undefined) {
        const collected = await collectMedia(message.messageId, message.resources as InboundResource[], {
          downloadResource: (fileKey, type) => channel.downloadResource(fileKey, type),
          ...(media.attachments === undefined ? {} : { attachments: media.attachments }),
          filesDir: media.filesDir,
        }, logger)
        if (collected.images.length > 0 || collected.files.length > 0) {
          inbound = {
            ...message,
            ...(collected.images.length === 0 ? {} : { images: collected.images }),
            ...(collected.files.length === 0 ? {} : { files: collected.files }),
          }
        }
      }
      // Agent turns run detached from the SDK's per-chat queue: /stop and
      // card clicks must reach the conversation while a turn is in flight.
      // Per-conversation serialization lives in the bridge (drive chains).
      void bridge.drive(
        inbound,
        async text => sendReply(channel, message.chatId, text, {
          replyTo: message.messageId,
          replyInThread,
        }, {
          maxChars: config.maxReplyChars,
          plainText: config.plainTextReplies,
        }, logger),
        async error => {
          logger.error(`dsh-lark: message handling failed: ${error instanceof Error ? error.message : String(error)}`)
          await channel.send(message.chatId, { text: config.errorMessage }, options).catch((sendError: unknown) => {
            logger.error(`dsh-lark: fallback reply failed: ${sendError instanceof Error ? sendError.message : String(sendError)}`)
          })
        },
      )
    }),
    channel.on('cardAction', event => {
      // Interaction-card clicks carry { ia, ... } values; command choice
      // cards carry { cmd, arg, ck }. Route interactions first, then
      // command cards; unknown values are ignored.
      void cardHub?.applyAction(event.action.value, event.operator.name ?? event.operator.openId)
        .then(handled => (handled ? undefined : applyCardAction(commandDeps, event, payload => channel.send(event.chatId, payload))))
        .catch((error: unknown) => {
          logger.error(`dsh-lark: card action failed: ${error instanceof Error ? error.message : String(error)}`)
        })
    }),
    channel.on('reconnecting', () => { logger.warn('dsh-lark: WebSocket reconnecting') }),
    channel.on('reconnected', () => { logger.info('dsh-lark: WebSocket reconnected') }),
    channel.on('comment', event => {
      if (!config.commentReplies) return
      void handleComment(event)
        .catch((error: unknown) => {
          logger.error(`dsh-lark: comment handling failed: ${error instanceof Error ? error.message : String(error)}`)
        })
    }),
  ]

  /** One @-mention comment drives a turn whose reply posts into the thread. */
  function handleComment(event: CommentEvent): Promise<void> {
    if (!event.mentionedBot) return Promise.resolve()
    if (!isCommentFileType(event.fileType)) {
      logger.warn(`dsh-lark: comment on unsupported file type ${event.fileType} ignored`)
      return Promise.resolve()
    }
    const text = commentText(event.raw) ?? EMPTY_COMMENT_TEXT
    const client = channel.rawClient as unknown as CommentReplyClient
    const target = { fileToken: event.fileToken, fileType: event.fileType, commentId: event.commentId }
    void bridge.drive(
      {
        chatId: `doc:${event.fileToken}`,
        chatType: 'p2p',
        replyToMessageId: event.commentId,
        senderId: event.operator.openId,
        content: text,
      },
      async reply => {
        await replyComment(client, target, reply)
      },
      async error => {
        logger.error(`dsh-lark: comment turn failed: ${error instanceof Error ? error.message : String(error)}`)
        await replyComment(client, target, config.errorMessage).catch((sendError: unknown) => {
          logger.error(`dsh-lark: comment fallback reply failed: ${sendError instanceof Error ? sendError.message : String(sendError)}`)
        })
      },
    )
    return Promise.resolve()
  }
  try {
    await channel.connect()
  } catch (error) {
    for (const unsubscribe of unsubscribers) unsubscribe()
    await bridge.dispose()
    throw error
  }
  logger.info('dsh-lark: WebSocket connected')
  if (cardHub !== undefined) {
    cardHub.attach({
      sendCard: async (to, card, options) => channel.send(to, { card }, options),
      updateCard: (messageId, card) => channel.updateCard(messageId, card),
    })
  }

  return async () => {
    for (const unsubscribe of unsubscribers) unsubscribe()
    await channel.disconnect()
    logger.info('dsh-lark: WebSocket disconnected')
    await cardHub?.dispose()
    await bridge.dispose()
  }
}
