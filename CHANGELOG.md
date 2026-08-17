# Changelog


## Unreleased

- Make the plugin hot-reload ready: mounting, reloading, and unmounting a `lark-channel` entry through the user patch layer no longer requires a host restart. Entry teardown now disposes the whole non-cordis resource tree (WebSocket channel, card hub, per-conversation chains, userQuestions wrap, appId claim) with zero residue, the `userQuestions` wrapper restore is stacking-safe (a reloading entry never clobbers a sibling instance's wrapper or leaks dead closures), and an entry failing validation leaves the previously running tree untouched. Credentials gain literal-first resolution: non-empty `appId`/`appSecret` literals win over the new `appIdEnv`/`appSecretEnv` variable names (a running process cannot see environment variables injected after launch, so literals are the reliable hot-reload path); `!!js` env interpolation keeps working unchanged.
- Add cloud-document comment answering and multi-profile support (`commentReplies`, default on): a comment that @-mentions the bot drives an agent turn scoped to that document (`doc:<fileToken>`) and posts the reply back into the comment thread via the drive comment-reply API; comment text is extracted from the raw event the channel now retains. Multiple instances with distinct app credentials run side by side, and a same-appId second instance fails fast at startup because a Feishu app allows exactly one WebSocket connection.
- Add inbound media and sender identity (`senderLabel`): image (and sticker) messages download through the SDK channel, persist via the durable `attachments` service, and enter the turn as image blocks beside the caption; other files save under `$DSH_HOME/storages/dsh-lark-files/<messageId>/` with a path reference line the agent can read. Group-chat text gains a `[sender]` prefix (`group` default, `always`, `off`), each resource degrades independently on failure, and plain-text turns keep their exact historical shape.
- Add streaming progress cards (`streamCards`, `streamThrottleMs`): assistant chunks stream into a live card with at-most-one update per throttle window, the terminal card carries the exact `summarizeTurn` projection (opening one on chunkless turns), pending updates are cancelled at turn end, and any card API failure degrades silently so the full text reply still delivers through the LK-005 channel.
- Add interactive-card answering for ask/approval (`interactionCards`): approvals surface an allow/deny button card and ask questions surface per-question option button groups in the triggering chat, clicks decide/settle the underlying request via the agent-scoped `approval/request` waterfall and the wrapped `userQuestions.ask`, and every terminal state (decision, timeout, cancellation) annotates the card. On timeout the LK-002 machine policy answers behind the card; foreign agents are untouched (per-agent routing).
- Add the ask/approval machine-answer fallback: `interactionPolicy` (`off` default, `allow-all`, `deny-all`, `custom` with `askAutoAnswer`/`approvalAllow`) answers ask-style questions and decides approvals for Lark-owned agents after an optional `interactionTimeoutMs` window, and injects a scoped system-prompt section telling the model to prefer a complete final answer over mid-turn questions. With `off`, nothing is registered and behavior is unchanged.
- Add the in-chat `/` command surface: `/resume`, `/model`, `/cd`, `/new`, `/stop`, and `/help` (unknown commands resolve to help). Choice cards are built from real host state (session query, provider model catalog, registered workspaces, agent presets) and answered over the WebSocket card-action channel; conversation bindings and per-chat model/workspace/preset overrides persist across restarts in `$DSH_HOME/storages/dsh-lark-bindings.json`. Agent turns now run detached from the SDK chat queue with per-conversation serialization so `/stop` reaches an in-flight turn.
- Split long outbound replies into sequential slices at Feishu-friendly boundaries (paragraph, then line, then code points), keeping code fences balanced by closing and reopening them; oversized single replies no longer fail the whole send. A failing slice no longer drops the remaining slices, and `plainTextReplies` degrades markdown to plain text without losing content.
- Resume the persisted session for a known Lark conversation before creating a new one, so restarting the Harness no longer collides with the durable session log; only conversations without a persisted log fall back to a fresh create, and a resume failure with an existing log surfaces as a safe error instead of replacing the session.

## 0.1.1

- Mount the Harness default or configured Agent Preset for Lark sessions.
- Associate Lark sessions with an explicit Workspace or the first registered Workspace.
- Start corrected sessions with a v2 identity so legacy uncomposed sessions are not reused.

## 0.1.0

- Initial Feishu/Lark WebSocket Channel integration for DeepSeek Harness.
- Stable chat/thread to Harness Session mapping.
- Official SDK policy, deduplication, stale-event filtering, and per-chat queue reuse.
