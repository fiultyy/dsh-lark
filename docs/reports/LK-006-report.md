# LK-006 验收回报单

- **ref**: LK-006 · **执行者**: omp@dsh-lark · **完成时间**: 2026-08-17T05:41:42Z
- **判定**: PASS
- **代码范围**: git status -s 全量输出:
  ```
   M CHANGELOG.md
   M README.md
   M package-lock.json
   M package.json
   M src/channel.ts
   M src/config.ts
   M src/conversation.ts
   M src/harness.ts
   M src/index.ts
   M tests/harness.spec.ts
   M tests/plugin.spec.ts
  ?? docs/capability-boundary-analysis.md
  ?? docs/tickets.md
  ?? docs/reports/
  ?? src/commands.ts
  ?? src/outbound.ts
  ?? tests/commands.spec.ts
  ?? tests/outbound.spec.ts
  ```
  本票改动 = `src/commands.ts`(新)、`src/channel.ts`、`src/harness.ts`、`src/conversation.ts`、`src/index.ts`、`package.json`/`package-lock.json`(新增 devDep `@deepseek-ai/dsh-session-query`)、`tests/commands.spec.ts`(新)、`tests/plugin.spec.ts`、`README.md`、`CHANGELOG.md`、本报告。`src/outbound.ts`/`tests/outbound.spec.ts`/`src/config.ts` 为 LK-005 遗留,本票未改;`src/harness.ts`/`tests/harness.spec.ts` 在 LK-001 基础上继续演进(见 G3)。DSH 本体与 lark-bridge 零改动。
- **关联**: ledger node LK-006 · worktree dsh-lark

## A. 验证门(逐项贴证据)
- [x] **G1** `pnpm typecheck` → 零错误
  ```
  npm notice run tsc --noEmit
  (无输出,exit 0)
  ```
- [x] **G2** `pnpm test` → 35 passed / 0 failed
  ```
   Test Files  7 passed (7)
       Tests  35 passed (35)
  ```
  (LK-005 后基线 26;本票 +8 新用例 + 1 个 plugin.spec 新用例 = 35,存量零回归;`npm run build` 亦通过:29.85 kB)
- [x] **G3** 改动范围仅本仓库预期文件:
  - `src/commands.ts`(新)— 指令解析(`parseCommand`:首词整词 `/字母` 匹配,路径/正文不误触)、六指令 handler、选择卡片构造(飞书 card JSON,按钮 value 内嵌会话键)、`applyCardAction` 按卡片 value 路由
  - `src/harness.ts` — 新增 `ConversationControls`(`rebind`/`restart`/`cancel`)、per-key 绑定与 overrides、原子持久化 JSON(`$DSH_HOME/storages/dsh-lark-bindings.json`,启动恢复)、`drive()` per-key 串行后台回合链 + cancel 后抑制错误回复
  - `src/conversation.ts` — `toSessionId` 可选 nonce 参数(/new、/cd 生成代际新 id)
  - `src/channel.ts` — 消息先过 `parseCommand` 拦截;agent 回合改 `bridge.drive` 脱离 SDK chat 队列;新增 `cardAction` 监听走 WS 回调
  - `src/index.ts` — inject 增 `sessionQuery`、`llm`;构造 CommandDeps 与持久化路径
  - `package.json` — devDep `@deepseek-ai/dsh-session-query@^0.1.0-rc.6`(类型对齐 peer 世代)
  - `tests/commands.spec.ts`(新)— ①–⑥ 用例;`tests/plugin.spec.ts` — 适配 drive 契约 + 新增指令路由用例
  - `README.md`/`CHANGELOG.md` — 指令文档与 Unreleased 条目

## B. 验证目标逐项(与 ticket 验证目标 1:1,不可增删)
| # | 验证目标 | 达成 | 证据(用例名@文件:行 / 命令输出摘录) |
|---|---|---|---|
| 1 | 七指令可达且普通 `/x` 前缀消息不误触发 | [x] | `recognizes the six commands and never misfires on ordinary /x-prefixed prose` @tests/commands.spec.ts:135:六指令逐一 `parseCommand` 命中(`/resume`/`/model glm`/`/cd /ws/one`/`/new`/`/stop`/`/help`);反例全部不触发:`/src/main.ts 请修复这个文件`、`看看 /resume 这个词…`、`/规范说明开头`、`/stop/`、`普通消息` → `undefined`(交给 agent);handler 层六指令各发恰 1 条回复;实现 = 首词整词正则 `/^\/([a-zA-Z]+)$/` @src/commands.ts:21-29 |
| 2 | /resume 卡片选项来自 sessionQuery 真实数据,选中后绑定切到所选 session 且续聊(跨重启亦然) | [x] | `builds the card from real sessionQuery records and rebinds to the chosen session` @tests/commands.spec.ts:168:卡片按钮 value 含 mock sessionQuery 返回的两条真实记录 `{cmd:'resume',arg:'s_recent',ck:'chat:oc_1'}`/`s_older`;点选 → `rebind('chat:oc_1', SessionId('s_recent'))`。`a restarted process resumes the bound session and keeps its context` @:182:进程 A rebind → 新 service 实例(同 persistPath)读到绑定,resume 该 session 且 `create` 零调用、回复正常 = 跨重启续聊;数据源 `sessionQuery.listSessions()` @src/commands.ts:133 |
| 3 | /model /cd 选中下一轮生效 | [x] | `model selection flows into the next agent options` @tests/commands.spec.ts:196:卡片 value=`zhipu/glm-5.3`(来自 llm.listProviders/listModels mock)→ applyCardAction → 下一轮 `agents.create` 收到 `agentOptions:{provider:'zhipu',model:'glm-5.3'}`。`cd switches the workspace and starts a fresh session id` @:209:cd 卡片 `/ws/one` → 下一轮 `meta.cwd==='/ws/one'` 且 sessionId ≠ 默认键派生 id(新代际);实现:overrides 叠加 @src/harness.ts restart + acquireAgent |
| 4 | /stop 取消并确认 | [x] | `cancels a running agent, suppresses the error reply, and reports idle on repeat` @tests/commands.spec.ts:226:慢 agent 回合 in-flight(slow fixture)→ /stop 发 `已停止当前任务。`、`cancel({kind:'user'})` 被调;回合以 aborted 结束后 drive 链既无 deliver 也无 fail(错误回复被抑制);再次 /stop → `当前没有正在运行的任务。`;前提改动:回合从 SDK chat 队列脱开改为插件内 per-key 链 @src/channel.ts:59-76、@src/harness.ts drive,否则 /stop 会排在运行中回合之后永远取不到消 |
| 5 | 未知→/help | [x] | `an unknown command resolves to the help text` @tests/commands.spec.ts:158:`/giveup` → 回复 markdown 含 `/resume`(帮助文本);路由在 `parseCommand` 内 @src/commands.ts:29(未知 token 归一为 help) |
| 6 | chat 与 thread 键均正确 | [x] | `thread cards carry the thread key and rebind only that thread` @tests/commands.spec.ts:252:话题群消息(chatId `oc_g`+threadId `omt_9`)→ 卡片 value `ck==='thread:oc_g:omt_9'`,点选仅 rebind 该 thread;chat 级在 ①②③④ 各用例均为 `chat:oc_1`;plugin.spec `routes slash commands…` 验证单聊 `/stop` → `cancel('chat:oc_1')` @tests/plugin.spec.ts:77-83 |

## C. 新增用例清单
| 用例名 | spec 文件 | 对应 B# | 结果 |
|---|---|---|---|
| recognizes the six commands and never misfires on ordinary /x-prefixed prose | tests/commands.spec.ts:135 | 1 | 通过 |
| an unknown command resolves to the help text | tests/commands.spec.ts:158 | 5 | 通过 |
| builds the card from real sessionQuery records and rebinds to the chosen session | tests/commands.spec.ts:168 | 2 | 通过 |
| a restarted process resumes the bound session and keeps its context | tests/commands.spec.ts:182 | 2 | 通过 |
| model selection flows into the next agent options | tests/commands.spec.ts:196 | 3 | 通过 |
| cd switches the workspace and starts a fresh session id | tests/commands.spec.ts:209 | 3 | 通过 |
| cancels a running agent, suppresses the error reply, and reports idle on repeat | tests/commands.spec.ts:226 | 4 | 通过 |
| thread cards carry the thread key and rebind only that thread | tests/commands.spec.ts:252 | 6 | 通过 |
| routes slash commands to the command surface instead of the agent | tests/plugin.spec.ts:77 | 1 | 通过 |

## D. 冒烟清单(人工项,agent 只列步骤不执行)
| 步骤 | 状态(待人工/通过/跳过+原因) | 执行者 | 备注 |
|---|---|---|---|
| 真聊天逐一发送 7 指令(含未知指令),确认卡片/回复符合预期 | 待人工 | 人 | 需真凭据;注意应用需具备发卡片权限 |
| /resume 点选一条历史会话 → 续聊确认含上下文 | 待人工 | 人 | 卡片按钮点击走 WS cardAction 回调 |
| /resume 点选后重启 `dsh web` → 再续聊确认仍接所选会话 | 待人工 | 人 | 绑定持久化文件 `$DSH_HOME/storages/dsh-lark-bindings.json` |
| 长任务运行中发 /stop,确认回合中断且无错误回复刷屏 | 待人工 | 人 | 对应 ④ 场景 |
| 话题群内各发一条普通消息与 /resume,确认话题独立 | 待人工 | 人 | 对应 ⑥ 场景 |

## E. 偏差与备注
1. **回合驱动脱离 SDK chat 队列**(④ 的前置):原实现 agent 回合在 SDK per-chat 串行队列内执行,/stop 会被排在运行中回合之后。现 channel 层 `void bridge.drive(...)` 立即返回,串行化移入插件 per-key 链(@src/harness.ts drive)。语义变化:同 chat 连发两条普通消息不再被 SDK 合并批处理(bridge 自身仍严格串行、先后有序);SDK 的去重/过期/policy 门完全保留。
2. **/resume 会话目录标签**为 `cwd · 创建时间`(SessionRecord 轻量记录无标题字段;`readTitleSnapshots` 需逐会话 fold,票面未要求,未引入)。列表取最近 8 条,超出部分不翻页(后续可加 `/resume more`)。
3. `/model` 列表 = `llm.listProviders()` × `listModels()` 的前 8 项,未含 settings 中休眠 provider 的可配置目录(`listConfigurableProviders`);未配置的 provider 点选后会在创建时以 adapter 拒绝形式报安全错误。
4. 卡片按钮 value 内嵌明文会话键(含 chat_id 哈希前不可能——键是原始 chat_id/thread_id)。飞书卡片对用户可见性有限,但严格讲 value 会随卡片分发到聊天内所有成员;影响 = 其他成员可转发 value 触发同键 rebind(同 chat 内本就同会话,无提权面)。thread 键含 thread_id,仅在该话题有效。
5. 持久化文件为 JSON 原子写(tmp+rename);进程崩溃最坏丢失最后一次绑定变更,不影响 DSH 会话日志本身。

## F. 审查记录(编排者填写,agent 留空)
- 审查人/时间: orch1 / 2026-08-17T05:45Z
- 结论: 通过
- 备注: verify-report 实战首审(SI-001 D1 冒烟):G1/G2 重跑✓、B行6/6、C用例9项grep全中、done body 校验✓、硬伤0。人工深抽 E1 架构偏差:channel.ts:63 `void bridge.drive` 脱 SDK 队列(注释明示 /stop 可达性动机)、harness.ts:117 per-key chains 串行(:162 链式接续,:210 allSettled 销毁)——设计正确有据。E4 卡片 value 明文键的提权面分析成立(同 chat 同会话无越权)。冒烟五项留人工(D 表,含真卡片点击与跨重启绑定)。
