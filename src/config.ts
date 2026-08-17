import z from '@deepseek-ai/schemastery'
import type { SenderLabel } from './media.ts'

export type DomainName = 'feishu' | 'lark'
export type DirectMessageMode = 'open' | 'allowlist' | 'disabled'
export type InteractionPolicyKind = 'off' | 'allow-all' | 'deny-all' | 'custom'

export interface Config {
  appId: string
  appSecret: string
  domain?: DomainName
  requireMention?: boolean
  dmMode?: DirectMessageMode
  groupAllowlist?: string[]
  dmAllowlist?: string[]
  provider?: string
  model?: string
  workspace?: string
  agentPreset?: string
  errorMessage?: string
  maxReplyChars?: number
  plainTextReplies?: boolean
  interactionPolicy?: InteractionPolicyKind
  /** custom policy: text used to answer ask-style questions without options. */
  askAutoAnswer?: string
  /** custom policy: approval decision; absent defaults to deny. */
  approvalAllow?: boolean
  /** wait before the machine policy answers (ms); 0 answers immediately. */
  interactionTimeoutMs?: number
  /** answer ask/approval through interactive Feishu cards (LK-003). */
  interactionCards?: boolean
  /** card wait window before falling back to the policy answer (ms). */
  cardInteractionTimeoutMs?: number
  /** stream assistant chunks into a live progress card (LK-004). */
  streamCards?: boolean
  /** coalescing window for streaming card updates (ms). */
  streamThrottleMs?: number
  /** prefix user text with the sender identity (LK-007). */
  senderLabel?: SenderLabel
  /** answer @-mention cloud-document comments in their threads (LK-009). */
  commentReplies?: boolean
}

export interface ResolvedConfig extends Required<Pick<Config,
  'appId' | 'appSecret' | 'domain' | 'requireMention' | 'dmMode' | 'groupAllowlist' |
  'dmAllowlist' | 'errorMessage' | 'maxReplyChars' | 'plainTextReplies' |
  'interactionPolicy' | 'interactionTimeoutMs' | 'interactionCards' | 'cardInteractionTimeoutMs' |
  'streamCards' | 'streamThrottleMs' | 'senderLabel' | 'commentReplies'>> {
  provider?: string
  model?: string
  workspace?: string
  agentPreset?: string
  askAutoAnswer?: string
  approvalAllow?: boolean
}

export const ConfigSchema: z<Config> = z.object({
  appId: z.string().required().description('Feishu/Lark application ID'),
  appSecret: z.string().role('secret').required().description('Feishu/Lark application secret'),
  domain: z.union(['feishu', 'lark']).default('feishu'),
  requireMention: z.boolean().default(true),
  dmMode: z.union(['open', 'allowlist', 'disabled']).default('open'),
  groupAllowlist: z.array(z.string()).default([]),
  dmAllowlist: z.array(z.string()).default([]),
  provider: z.string(),
  model: z.string(),
  workspace: z.string(),
  agentPreset: z.string(),
  errorMessage: z.string().default('抱歉，处理这条消息时遇到了问题，请稍后重试。'),
  maxReplyChars: z.number().step(1).min(200).default(4000).description('Maximum code points per reply slice before sequential splitting'),
  plainTextReplies: z.boolean().default(false).description('Send replies as plain text instead of markdown'),
  interactionPolicy: z.union(['off', 'allow-all', 'deny-all', 'custom']).default('off').description('Machine answer policy for ask/approval when no human channel answers'),
  askAutoAnswer: z.string().description('Custom policy: free-text answer for ask questions without options'),
  approvalAllow: z.boolean().description('Custom policy: allow (true) or deny (false) approval requests; default deny'),
  interactionTimeoutMs: z.number().step(1).min(0).default(0).description('Wait this long before the machine policy answers, leaving room for a human/card answerer'),
  interactionCards: z.boolean().default(false).description('Answer ask/approval through interactive Feishu cards, falling back to the machine policy on timeout'),
  cardInteractionTimeoutMs: z.number().step(1).min(1000).default(120000).description('How long an interaction card waits for a button click before falling back (ms)'),
  streamCards: z.boolean().default(false).description('Stream assistant output into a live progress card; the final card equals the reply projection'),
  streamThrottleMs: z.number().step(1).min(100).default(800).description('Coalescing window for streaming card updates (ms)'),
  senderLabel: z.union(['group', 'always', 'off']).default('group').description('Prefix message text with the sender identity: group chats only, always, or never'),
  commentReplies: z.boolean().default(true).description('Drive an agent turn for @-mention cloud-document comments and reply in the comment thread'),
})

export function resolveConfig(config: Config): ResolvedConfig {
  if (config.appId.trim() === '') throw new TypeError('appId is required')
  if (config.appSecret.trim() === '') throw new TypeError('appSecret is required')
  const errorMessage = config.errorMessage ?? '抱歉，处理这条消息时遇到了问题，请稍后重试。'
  if (errorMessage.length > 500) throw new TypeError('errorMessage must not exceed 500 characters')
  const base = {
    appId: config.appId,
    appSecret: config.appSecret,
    domain: config.domain ?? 'feishu',
    requireMention: config.requireMention ?? true,
    dmMode: config.dmMode ?? 'open',
    groupAllowlist: config.groupAllowlist ?? [],
    dmAllowlist: config.dmAllowlist ?? [],
    errorMessage,
    maxReplyChars: config.maxReplyChars ?? 4000,
    plainTextReplies: config.plainTextReplies ?? false,
    interactionPolicy: config.interactionPolicy ?? 'off',
    interactionTimeoutMs: config.interactionTimeoutMs ?? 0,
    interactionCards: config.interactionCards ?? false,
    cardInteractionTimeoutMs: config.cardInteractionTimeoutMs ?? 120000,
    streamCards: config.streamCards ?? false,
    streamThrottleMs: config.streamThrottleMs ?? 800,
    senderLabel: config.senderLabel ?? 'group',
    commentReplies: config.commentReplies ?? true,
  } satisfies Omit<ResolvedConfig, 'provider' | 'model' | 'workspace' | 'agentPreset' | 'askAutoAnswer' | 'approvalAllow'>
  return {
    ...base,
    ...(config.provider === undefined ? {} : { provider: config.provider }),
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.workspace === undefined ? {} : { workspace: config.workspace }),
    ...(config.agentPreset === undefined ? {} : { agentPreset: config.agentPreset }),
    ...(config.askAutoAnswer === undefined ? {} : { askAutoAnswer: config.askAutoAnswer }),
    ...(config.approvalAllow === undefined ? {} : { approvalAllow: config.approvalAllow }),
  }
}
