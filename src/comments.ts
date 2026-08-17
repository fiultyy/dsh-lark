/**
 * Cloud-document comment answering (LK-009): a comment that @-mentions the
 * bot drives one agent turn whose reply posts back into the comment thread
 * through the Feishu drive comment-reply API. Comment text is not part of
 * the SDK's normalized `CommentEvent`, so the channel keeps `raw` events
 * and extraction happens here.
 */

/** Face of the SDK raw client the comment reply path needs. */
export interface CommentReplyClient {
  drive: {
    v1: {
      fileCommentReply: {
        create(payload: {
          data: { content: { elements: Array<{ type: 'text_run'; text_run: { text: string } }> } }
          params: { file_type: CommentFileType }
          path: { file_token: string; comment_id: string }
        }): Promise<{ code?: number; msg?: string }>
      }
    }
  }
}

/** File types the drive comment-reply API accepts. */
const COMMENT_FILE_TYPES: ReadonlySet<string> = new Set(['doc', 'docx', 'sheet', 'file', 'slides', 'bitable', 'apps'])

export function isCommentFileType(value: string): boolean {
  return COMMENT_FILE_TYPES.has(value)
}

/** Feishu caps a single comment reply's text; keep a generous safety cut. */
const MAX_REPLY_CHARS = 9000

/**
 * Extract the comment's plain text from the raw `drive.notice.comment_add_v1`
 * payload. The exact field shape varies across payload revisions, so the
 * known locations are probed in order; `undefined` means the caller should
 * fall back to a placeholder.
 */
export function commentText(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const candidates: unknown[] = [
    record.content,
    (record.comment as Record<string, unknown> | undefined)?.content,
  ]
  for (const candidate of candidates) {
    const text = textFromContent(candidate)
    if (text !== undefined && text !== '') return text
  }
  return undefined
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (typeof content !== 'object' || content === null) return undefined
  const record = content as Record<string, unknown>
  if (typeof record.text === 'string') return record.text
  const elements = record.elements
  if (Array.isArray(elements)) {
    const parts: string[] = []
    for (const element of elements) {
      if (typeof element !== 'object' || element === null) continue
      const textRun = (element as Record<string, unknown>).text_run
      if (typeof textRun === 'object' && textRun !== null) {
        const text = (textRun as Record<string, unknown>).text
        if (typeof text === 'string') parts.push(text)
      }
    }
    if (parts.length > 0) return parts.join('')
  }
  return undefined
}

/** The placeholder shown when a mention carries no extractable text. */
export const EMPTY_COMMENT_TEXT = '(评论内容无法解析,请在评论中@机器人并附上问题。)'

/**
 * Reply inside one comment thread. Long replies are cut once at the API's
 * practical text limit rather than split (comment threads are not a chat
 * surface).
 */
export async function replyComment(
  client: CommentReplyClient,
  target: { fileToken: string; fileType: string; commentId: string },
  text: string,
): Promise<void> {
  const clipped = text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}…` : text
  const response = await client.drive.v1.fileCommentReply.create({
    data: { content: { elements: [{ type: 'text_run', text_run: { text: clipped } }] } },
    params: { file_type: target.fileType as CommentFileType },
    path: { file_token: target.fileToken, comment_id: target.commentId },
  })
  if (response.code !== undefined && response.code !== 0) {
    throw new Error(`comment reply failed: ${response.code} ${response.msg ?? ''}`)
  }
}

type CommentFileType = 'doc' | 'docx' | 'sheet' | 'file' | 'slides' | 'bitable' | 'apps'
