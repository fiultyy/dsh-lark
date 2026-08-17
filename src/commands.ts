import type { LlmModelInfo, LlmProviderInfo } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRecord } from '@deepseek-ai/dsh-session-query'
import { conversationKey } from './conversation.ts'
import type { ConversationMessage } from './conversation.ts'
import type { ConversationControls, ConversationOverrides } from './harness.ts'
import type { DomainName } from './config.ts'

export type CommandName = 'resume' | 'model' | 'cd' | 'new' | 'stop' | 'help'

export interface ParsedCommand { name: CommandName; arg: string }

const COMMAND_NAMES: ReadonlySet<string> = new Set(['resume', 'model', 'cd', 'new', 'stop', 'help'])

/**
 * Recognize a leading slash command. The first whitespace token must be
 * exactly `/name` (ASCII letters only) for the message to be a command
 * attempt: paths like `/src/main.ts` and prose keep flowing to the agent.
 * Unknown names resolve to help.
 */
export function parseCommand(content: string): ParsedCommand | undefined {
  const trimmed = content.trim()
  const firstToken = trimmed.split(/\s+/)[0] ?? ''
  const match = /^\/([a-zA-Z]+)$/.exec(firstToken)
  if (match === null) return undefined
  const token = match[1]!.toLowerCase()
  const arg = trimmed.slice(firstToken.length).trim()
  return { name: COMMAND_NAMES.has(token) ? token as CommandName : 'help', arg }
}

export type OutboundPayload = { markdown: string } | { text: string } | { card: object }
export type OutboundSender = (payload: OutboundPayload, options?: { replyTo?: string; replyInThread?: boolean }) => Promise<unknown>

/** Host state sources the cards are built from, plus conversation controls. */
export interface CommandDeps {
  sessionQuery: { listSessions(signal?: AbortSignal): Promise<SessionRecord[]> }
  llm: { listProviders(): LlmProviderInfo[]; listModels(provider: string): Promise<LlmModelInfo[]> }
  workspaces: { list(): Array<{ path: string }> }
  presets: { list(): Promise<Array<{ id: string; broken?: string }>> }
  controls: ConversationControls
  domain: DomainName
}

export interface CardActionLike {
  chatId: string
  action: { value: unknown }
}

interface CardActionValue { cmd: string; arg: string; ck: string }

const HELP_TEXT = [
  '可用指令:',
  '- /resume — 列出可恢复的会话,点选后本聊天切换到该会话续聊',
  '- /model — 从宿主模型列表选择本聊天使用的模型',
  '- /cd — 从已注册 Workspace 列表选择工作目录(开启新会话)',
  '- /new — 开启新会话(可选择 Agent Preset)',
  '- /stop — 停止当前正在运行的任务',
  '- /help — 显示本帮助',
].join('\n')

const MAX_CARD_OPTIONS = 8

function choiceCard(title: string, bodyText: string, actions: Array<{ label: string; value: CardActionValue }>): object {
  // Feishu action rows hold at most a handful of buttons; chunk into rows.
  const rows: Array<Array<{ label: string; value: CardActionValue }>> = []
  for (let index = 0; index < actions.length; index += 3) rows.push(actions.slice(index, index + 3))
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: title } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: bodyText } },
      ...rows.map(row => ({
        tag: 'action',
        actions: row.map(option => ({
          tag: 'button',
          text: { tag: 'plain_text', content: option.label },
          type: 'default',
          value: option.value,
        })),
      })),
    ],
  }
}

function formatDate(epochMs: number): string {
  const date = new Date(epochMs)
  return Number.isNaN(date.getTime()) ? String(epochMs) : date.toISOString().slice(0, 16).replace('T', ' ')
}

function sessionLabel(record: SessionRecord): string {
  const cwd = record.header.cwd ?? '(无工作目录)'
  return `${cwd} · ${formatDate(record.header.createdAt)}`
}

function sendText(send: OutboundSender, text: string, options: { replyTo?: string; replyInThread?: boolean }): Promise<unknown> {
  return send({ markdown: text }, options)
}

async function listModelChoices(deps: CommandDeps): Promise<Array<{ provider: string; id: string; name: string }>> {
  const choices: Array<{ provider: string; id: string; name: string }> = []
  for (const provider of deps.llm.listProviders()) {
    const models = await deps.llm.listModels(provider.id)
    for (const model of models) choices.push({ provider: provider.id, id: model.id, name: model.name })
  }
  return choices.slice(0, MAX_CARD_OPTIONS)
}

export interface CommandMessage extends ConversationMessage { messageId: string }

/**
 * Handle one parsed command for an inbound message. Returns true when the
 * message was a command (the agent turn must be skipped); the reply — text or
 * choice card — has already been sent through `send`.
 */
export async function handleCommand(
  deps: CommandDeps,
  message: CommandMessage,
  command: ParsedCommand,
  send: OutboundSender,
): Promise<true> {
  const key = conversationKey(message)
  const options: { replyTo?: string; replyInThread?: boolean } = { replyTo: message.messageId, replyInThread: message.threadId !== undefined }
  if (command.name === 'help') {
    await sendText(send, HELP_TEXT, options)
    return true
  }
  if (command.name === 'stop') {
    const stopped = await deps.controls.cancel(key)
    await sendText(send, stopped ? '已停止当前任务。' : '当前没有正在运行的任务。', options)
    return true
  }
  if (command.name === 'resume') {
    const sessions = (await deps.sessionQuery.listSessions()).slice(0, MAX_CARD_OPTIONS)
    if (sessions.length === 0) {
      await sendText(send, '没有找到可恢复的会话。', options)
      return true
    }
    const actions = sessions.map(record => ({
      label: sessionLabel(record),
      value: { cmd: 'resume', arg: String(record.header.id), ck: key } satisfies CardActionValue,
    }))
    await send({ card: choiceCard('选择要恢复的会话', '点击下方按钮切换本聊天到该会话(最近优先):', actions) }, options)
    return true
  }
  if (command.name === 'model') {
    const choices = await listModelChoices(deps)
    if (choices.length === 0) {
      await sendText(send, '宿主没有登记可选模型。', options)
      return true
    }
    const actions = choices.map(choice => ({
      label: `${choice.provider}/${choice.id}`,
      value: { cmd: 'model', arg: `${choice.provider}/${choice.id}`, ck: key } satisfies CardActionValue,
    }))
    await send({ card: choiceCard('选择模型', '本聊天接下来的轮次将使用所选模型:', actions) }, options)
    return true
  }
  if (command.name === 'cd') {
    const workspaces = deps.workspaces.list().slice(0, MAX_CARD_OPTIONS)
    if (workspaces.length === 0) {
      await sendText(send, '宿主没有已注册的 Workspace。', options)
      return true
    }
    const actions = workspaces.map(workspace => ({
      label: workspace.path,
      value: { cmd: 'cd', arg: workspace.path, ck: key } satisfies CardActionValue,
    }))
    await send({ card: choiceCard('选择工作目录', '切换目录会开启一个新会话:', actions) }, options)
    return true
  }
  // '/new': fresh session, preset choice card.
  const presets = (await deps.presets.list()).filter(preset => preset.broken === undefined).slice(0, MAX_CARD_OPTIONS)
  const actions = presets.map(preset => ({
    label: preset.id,
    value: { cmd: 'new', arg: preset.id, ck: key } satisfies CardActionValue,
  }))
  await send({ card: choiceCard('开启新会话', '选择新会话使用的 Agent Preset:', actions) }, options)
  return true
}

function parseCardValue(value: unknown): CardActionValue | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as Partial<CardActionValue>
  if (typeof candidate.cmd !== 'string' || typeof candidate.arg !== 'string' || typeof candidate.ck !== 'string') return undefined
  return { cmd: candidate.cmd, arg: candidate.arg, ck: candidate.ck }
}

/**
 * Apply one choice-card button action: route by the conversation key embedded
 * in the card value (cards built for a thread carry the thread key), then
 * confirm in the chat. Unknown or malformed values are ignored.
 */
export async function applyCardAction(
  deps: CommandDeps,
  event: CardActionLike,
  send: OutboundSender,
): Promise<void> {
  const value = parseCardValue(event.action.value)
  if (value === undefined) return
  if (value.cmd === 'resume') {
    await deps.controls.rebind(value.ck, SessionId(value.arg))
    await sendText(send, `已切换到会话 \`${value.arg}\`,继续对话即可接上上下文。`, {})
  } else if (value.cmd === 'model') {
    const separator = value.arg.indexOf('/')
    if (separator <= 0) return
    const patch: ConversationOverrides = { provider: value.arg.slice(0, separator), model: value.arg.slice(separator + 1) }
    await deps.controls.restart(value.ck, patch, { fresh: false, clear: false })
    await sendText(send, `下一轮起使用 \`${patch.provider}/${patch.model}\`。`, {})
  } else if (value.cmd === 'cd') {
    await deps.controls.restart(value.ck, { workspace: value.arg }, { fresh: true, clear: true })
    await sendText(send, `已切换工作目录到 \`${value.arg}\` 并开启新会话。`, {})
  } else if (value.cmd === 'new') {
    await deps.controls.restart(value.ck, { agentPreset: value.arg }, { fresh: true, clear: true })
    await sendText(send, `已开启新会话,使用 preset \`${value.arg}\`。`, {})
  }
}
