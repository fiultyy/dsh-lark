import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ImageAttachmentRef, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'

/**
 * Inbound media handling (LK-007): normalized `resources` on an inbound
 * message download through the SDK channel and land where the agent can
 * use them — images through the durable `attachments` service as image
 * blocks, other files in a local directory referenced by path. Sender
 * identity prefixes group text so multi-user chats stay readable.
 */

/** Attachment-store face media collection needs. */
export interface AttachmentsLike {
  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>
}

/** Resource descriptors the SDK channel already normalized. */
export interface InboundResource {
  type: 'image' | 'file' | 'audio' | 'video' | 'sticker'
  fileKey: string
  fileName?: string
}

/** One non-image file saved for path-based reference. */
export interface InboundFileNote {
  name: string
  path: string
  bytes: number
}

/** Media outcomes attached to one inbound message. */
export interface InboundMedia {
  images: ImageAttachmentRef[]
  files: InboundFileNote[]
}

export interface MediaDeps {
  downloadResource(fileKey: string, type: 'image' | 'file'): Promise<Buffer>
  attachments?: AttachmentsLike
  /** Root below which per-message file directories are created. */
  filesDir: string
}

type MediaLogger = { warn?(message: string): unknown }

/** Magic-byte detection for the four media types the attachment path accepts. */
export function detectImageMediaType(bytes: Uint8Array): ImageMediaType | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg'
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  // RIFF....WEBP
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return undefined
}

/** Keep one file name inside its directory: no separators, no traversal. */
export function sanitizeFileName(name: string | undefined, fallback: string): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? ''
  const cleaned = base.replace(/[\u0000-\u001f]/g, '').trim()
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return fallback
  return cleaned.slice(0, 190)
}

/**
 * Download one message's resources and persist them: images (including
 * stickers) through the durable attachment store, everything else as a
 * local file. Each resource degrades independently — a failed download
 * never drops the text.
 */
export async function collectMedia(
  messageId: string,
  resources: readonly InboundResource[],
  deps: MediaDeps,
  logger?: MediaLogger,
): Promise<InboundMedia> {
  const media: InboundMedia = { images: [], files: [] }
  for (const resource of resources) {
    try {
      const asImage = resource.type === 'image' || resource.type === 'sticker'
      const buffer = await deps.downloadResource(resource.fileKey, asImage ? 'image' : 'file')
      if (asImage) {
        if (deps.attachments === undefined) {
          logger?.warn?.(`dsh-lark: image ${resource.fileKey} dropped: no attachments service composed`)
          continue
        }
        const mediaType = detectImageMediaType(buffer)
        if (mediaType === undefined) {
          logger?.warn?.(`dsh-lark: image ${resource.fileKey} dropped: undetectable media type`)
          continue
        }
        const input: SaveImageAttachment = {
          data: new Uint8Array(buffer),
          mediaType,
          ...(resource.fileName === undefined ? {} : { name: sanitizeFileName(resource.fileName, 'image') }),
        }
        media.images.push(await deps.attachments.saveImage(input))
      } else {
        const name = sanitizeFileName(resource.fileName, `${resource.type}-${resource.fileKey}`)
        const dir = join(deps.filesDir, messageId)
        await mkdir(dir, { recursive: true })
        const path = join(dir, name)
        await writeFile(path, buffer)
        media.files.push({ name, path, bytes: buffer.byteLength })
      }
    } catch (error: unknown) {
      logger?.warn?.(`dsh-lark: media ${resource.fileKey} (${resource.type}) failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return media
}

export type SenderLabel = 'group' | 'always' | 'off'

/**
 * Compose the user-visible text: sender prefix per {@link SenderLabel}
 * (`group` prefixes only group chats) and file reference lines appended
 * after the caption so the agent can cite the saved paths.
 */
export function composeUserText(
  content: string,
  media: InboundMedia | undefined,
  identity: { chatType: 'p2p' | 'group'; senderName?: string; senderId?: string },
  label: SenderLabel,
): string {
  const name = identity.senderName?.trim()
  const sender = name !== undefined && name !== '' ? name : identity.senderId
  const prefixed = label !== 'off' && sender !== undefined && sender !== ''
    && (label === 'always' || (label === 'group' && identity.chatType === 'group'))
    ? `[${sender}] ${content}`
    : content
  const lines = media?.files.map(file => `[附件] ${file.name} 已保存到 ${file.path}(${file.bytes} 字节),可通过该路径读取。`) ?? []
  return lines.length === 0 ? prefixed : `${prefixed}\n${lines.join('\n')}`
}
