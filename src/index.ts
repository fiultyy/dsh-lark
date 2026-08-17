import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-workspace'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createLarkChannel } from '@larksuiteoapi/node-sdk'
import { ConfigSchema, resolveConfig } from './config.ts'
import type { Config as PluginConfig } from './config.ts'
import { HarnessConversationService, resolveInteractionPolicy, wrapUserQuestions } from './harness.ts'
import { InteractionCardHub } from './card-answerer.ts'
import { startChannel } from './channel.ts'
import type { CommandDeps } from './commands.ts'
export const name = 'lark-channel'
export const inject = ['agents', 'sessions', 'agentDefaultModel', 'agentPresets', 'workspaceRegistry', 'sessionQuery', 'llm']
export const Config = ConfigSchema
export type { PluginConfig }
export { ConfigSchema } from './config.ts'

/** App ids currently served in this host process (one WS connection per app). */
const appIdsInUse = new Set<string>()

/**
 * Claim one Feishu app id for this host process. A Feishu app allows a
 * single long-connection consumer; a second instance with the same id
 * would fight over events, so it fails fast with an explicit message.
 * Returns the release for the claiming instance's effect cleanup.
 */
export function claimAppId(appId: string): () => void {
  if (appIdsInUse.has(appId)) {
    throw new Error(
      `dsh-lark: appId ${appId} is already served by another instance in this host process. `
      + 'A Feishu/Lark app allows exactly one WebSocket connection — give the second instance its own app credentials.',
    )
  }
  appIdsInUse.add(appId)
  return () => { appIdsInUse.delete(appId) }
}
export async function apply(ctx: Context, rawConfig: PluginConfig): Promise<void> {
  const config = resolveConfig(rawConfig)
  ctx.effect(() => claimAppId(config.appId), 'dsh-lark: app id claim')
  const agents = ctx.get('agents')
  const sessions = ctx.get('sessions')
  const defaultModel = ctx.get('agentDefaultModel')
  const agentPresets = ctx.get('agentPresets')
  const workspaceRegistry = ctx.get('workspaceRegistry')
  const sessionQuery = ctx.get('sessionQuery')
  const llm = ctx.get('llm')
  if (agents === undefined || sessions === undefined || defaultModel === undefined || agentPresets === undefined
    || workspaceRegistry === undefined || sessionQuery === undefined || llm === undefined) {
    throw new Error('dsh-lark requires agents, sessions, agentDefaultModel, agentPresets, workspaceRegistry, sessionQuery, and llm services')
  }
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const interactionPolicy = resolveInteractionPolicy(config)
  const cardHub = config.interactionCards || config.streamCards ? new InteractionCardHub(ctx.logger) : undefined
  const bridge = new HarnessConversationService({
    agents,
    sessions,
    selection: () => defaultModel.currentSelection(),
    agentPresets,
    workspaceRegistry,
  }, config, {
    persistPath: join(dshHome, 'storages', 'dsh-lark-bindings.json'),
    logger: ctx.logger,
    interactionPolicy,
    ...(cardHub === undefined ? {} : { cardHub }),
    ...(cardHub === undefined ? {} : { cardTimeoutMs: config.cardInteractionTimeoutMs }),
    ...(config.streamCards ? { streamThrottleMs: config.streamThrottleMs } : {}),
    senderLabel: config.senderLabel,
  })
  const attachments = ctx.get('attachments')
  if (interactionPolicy.kind !== 'off' || cardHub !== undefined) {
    const userQuestions = ctx.get('userQuestions')
    if (userQuestions !== undefined) {
      ctx.effect(() => wrapUserQuestions(userQuestions, interactionPolicy, agent => bridge.ownsAgent(agent), ctx.logger,
        cardHub === undefined ? undefined : { hub: cardHub, timeoutMs: config.cardInteractionTimeoutMs }), 'dsh-lark: ask fallback')
    }
  }
  const commandDeps: CommandDeps = {
    sessionQuery,
    llm,
    workspaces: workspaceRegistry,
    presets: agentPresets,
    controls: bridge,
    domain: config.domain,
  }
  const stop = await startChannel(config, bridge, commandDeps, createLarkChannel, ctx.logger, cardHub, {
    ...(attachments === undefined ? {} : { attachments }),
    filesDir: join(dshHome, 'storages', 'dsh-lark-files'),
  })
  // Hot-reload readiness: the whole non-cordis resource tree (WS channel,
  // card hub, bridge) hangs off this one disposer, so entry reload/unload
  // tears it down in LIFO order — channel first, then the userQuestions
  // unwrap, then the appId release.
  try {
    ctx.effect(() => stop, 'dsh-lark: channel teardown')
  } catch (error) {
    // The fiber was unloaded while apply awaited the connection: nothing
    // will run this disposer, so tear the channel down here and let the
    // rejection surface on the (already disposing) fiber.
    await stop()
    throw error
  }
}
