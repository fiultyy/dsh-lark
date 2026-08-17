import { createHash } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { DomainName } from './config.ts'

export interface ConversationMessage {
  chatId: string
  chatType: 'p2p' | 'group'
  threadId?: string
  replyToMessageId?: string
  /** Sender display name for identity prefixing (LK-007). */
  senderName?: string
  /** Sender open id, the prefix fallback when no name is available. */
  senderId?: string
}

export function conversationKey(message: ConversationMessage): string {
  return message.threadId === undefined
    ? `chat:${message.chatId}`
    : `thread:${message.chatId}:${message.threadId}`
}

export function toSessionId(domain: DomainName, key: string, nonce?: string): SessionId {
  // `/new` and `/cd` deliberately start a fresh session under the same
  // conversation key; the nonce keeps each generation's id distinct while
  // staying opaque. v2 sessions include the Harness workspace and
  // agent-preset composition; keep them separate from older sessions.
  const material = nonce === undefined ? `${domain}\0${key}` : `${domain}\0${key}\0${nonce}`
  const digest = createHash('sha256').update(material).digest('hex').slice(0, 40)
  return SessionId(`lark-v2-${digest}`)
}

interface EventLike {
  seq: number
  type: string
  data: Record<string, unknown>
}

export interface TurnSummary { text: string; ok: boolean }

export function summarizeTurn(events: readonly EventLike[], firstSeq: number): TurnSummary {
  let text = ''
  let completed = false
  let failed = false
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'assistant/message') {
      const message = event.data.message as { content?: Array<{ type: string; text?: string }> } | undefined
      const next = message?.content?.filter(block => block.type === 'text').map(block => block.text ?? '').join('') ?? ''
      if (next !== '') text = next
    }
    if (event.type === 'turn/end') {
      const reason = event.data.reason as { kind?: string } | undefined
      completed = reason?.kind === 'completed'
      failed = reason?.kind === 'error' || reason?.kind === 'cancelled'
    }
  }
  return { text, ok: completed && !failed && text !== '' }
}
