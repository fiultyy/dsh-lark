# dsh-lark × DSH 飞书接入能力边界分析(v0.1.1)

> 分析日期:2026-08-17。分析对象:`@sugarforever/dsh-lark` v0.1.1(本仓库),参照 DSH 本体 `/home/yy/tools/deepseek-harness`(只读)与 `lark-coding-agent-bridge`(只读,ACP 对照路线)。基础通道(app 注册/事件订阅/WebSocket 长连接)不在本文范围。

## 0. 核心结论

dsh-lark 以 cordis 组合包(bundle patch)形态挂进 DSH Host 进程,当前实现了一条**最小可用的"飞书文本进出 DSH Agent"通道**:入站纯文本 → 会话映射 → preset 组装的 in-process Agent 回合 → 回流单条 markdown 回复。宿主能力面(会话/回合驱动、消息注入、preset 工具组装、workspace 归属、模型路由)已经全部打通且**无需动 DSH 本体即可继续扩展**;真正的边界不在挂载层,而在四件事上:

1. **跨进程重启的会话延续是断的**(create-only,同 SessionId 重启后撞持久化 id collision)——最大正确性缺口;
2. **交互回流缺失**(ask_user_question / approval 会路由到 Web 客户端或 fail-closed 拒绝,飞书用户无法作答);
3. **渠道 UX 层缺失**(无流式卡片、无斜杠命令、无多媒体、无 /stop);
4. **水平扩展受飞书单应用单长连接消费者限制**(平台约束,插件无解)。

除第 2 项可能需要动 `dsh-apiproxy` 的路由策略外,其余缺口全部可以在插件层补齐。

---

## 1. 插件挂载与宿主能力面

### 1.1 挂载机制:四层组合

| 层 | 载体 | dsh-lark 侧 |
|---|---|---|
| 组合包层 | npm 包 `package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml` | 声明一个 `insert` 的 `lark-channel` 实例,**默认 `disabled: true`**(无凭据不连接) |
| Profile 层 | `$DSH_HOME/profiles/web/package.json` 的 `dsh.profile.bundles`(base + web-app)+ profile 自己的 `cordis.patch.yml` | `dsh plugin --profile web add` 后,用户 patch 按 **id 覆盖**(非 insert)启用实例、注入 `!!js process.env.FEISHU_APP_ID` 等凭据 |
| Home 层 | `$DSH_HOME/cordis.patch.yml` | 用户级全局覆盖,优先级最高(当前实例只用来路由模型/webserver) |
| 装载 | `@deepseek-ai/dsh-app-boot`:`loadProfile` → `composeEntries`(include 的 `applyEntryPatches` 逐层应用)→ `boot()` 挂载 Loader 并断言所有条目 loaded + activated | 插件与宿主同一 Cordis 树、同一进程;失败会 dispose 整棵树后 fail-loud |

关键语义(patch 机制,来自 `app-boot` README):按 id 定位的 patch **替换目标行整个 config**(不深度合并),`!!js` 表达式在挂载时插值;patch 指到不存在的 id 会告警。dsh-lark 的 README 中"`duplicate loader entry id: lark-channel`"报错正是用户误用 `insert` 与组合包自带实例撞 id 所致。

### 1.2 插件形状与生命周期

插件入口 `src/index.ts`:

```ts
export const name = 'lark-channel'
export const inject = ['agents', 'sessions', 'agentDefaultModel', 'agentPresets', 'workspaceRegistry']
export const Config = ConfigSchema   // @deepseek-ai/schemastery
export async function apply(ctx, rawConfig) { ... }
```

- **注入声明**:5 个宿主服务;任一缺失(如装到无 workspace 服务的 headless bundle)则 `apply` 抛错,Loader 结算为启动失败——这是插件对宿主组合的硬性要求。
- **初始化**:`resolveConfig`(校验凭据非空、errorMessage ≤500)→ 构造 `HarnessConversationService` → `startChannel`(构造官方 SDK Channel、注册 4 类监听、`channel.connect()`;连接失败则摘除监听 + dispose bridge 后抛出)→ `ctx.effect(() => stop, 'dsh-lark: channel')` 把停止函数挂进 Cordis 生命周期。
- **销毁**(cordis disposal):摘监听 → `channel.disconnect()` → `bridge.dispose()`(等全部 agent handle dispose——停轮次、注销 agent、从存储移除会话、撤销 agent 作用域)。已完成轮次在每轮结束时就 `sessions.flush` 过,销毁无额外落盘步骤。
- **热重载**:profile `cordis.patch.yml` 被 `watchUserPatches` 持续监视,变更会事务性重组合并触发条目重载;但 dsh-lark README 明确要求改配置后重启(WS 连接与凭据持有在实例上,重载等价于 dispose+重建,文档口径从简)。

### 1.3 实际能触达的宿主能力面

插件与 DSH Web Profile 同进程同树,**理论上 `ctx.get` 可达 web profile 组合的全部服务**;实际只注入 5 个。按"已用 / 可用未用 / 结构性错位"分三档:

**已用(实现于 src/)**

| 能力 | API | 用途 |
|---|---|---|
| 会话/回合驱动 | `ctx.agents.create({sessionId, meta, agentOptions, setup})`、`agent.followup()`、`agent.whenIdle()` | 每个 conversation key 懒创建一个 AgentHandle,消息经 inbox 驱动轮次 |
| 模型路由 | `ctx.agentDefaultModel.currentSelection()` + `installModelSelection(agentCtx, …)`(setup 内) | 渠道级 provider/model 覆盖,否则继承宿主默认 |
| Agent Preset 组装 | `ctx.agentPresets.resolve(id?)` / `.mount(agentCtx, id)`(setup 内,唯一受支持调用点) | 会话获得该 preset 的全部工具/提示词/委派后端(maestro、standard 等一视同仁) |
| 会话持久化 | `ctx.sessions.flush(session)` | 每轮结束刷新 jsonl 落盘 |
| Workspace 归属 | `ctx.workspaceRegistry.list()/resolveByPath()` + `workspace.attachSession(sessionId)` | 决定 cwd 并让会话出现在 Web 工作区分组里 |
| 消息注入 | `createUserMessage({content:[text], source:{kind:'user'}})` → `followup` | 入站文本成为普通用户消息 |

**可用未用(插件层加代码即得,无需动本体)**

- `agent.steer()/inject()/cancel()`(中途引导、不打断注入、停轮次——/stop 命令的现成底座);`agents.resume()`(持久会话恢复——§4 缺口 #1 的关键);`agent.ctx` 作用域注册(给飞书会话挂专属工具/提示段);`session/event`、`agent/*` 实时事件(流式回流的底座);`ctx.sessionQuery`(会话检索/列表);`ctx.logger`;timer/web 等。
- 经 preset 间接获得的全量 agent 工具面(bash/fs/subagent/terminal/todo/goal/workflow/skill…)——飞书会话与 Web 会话共享同一 preset 注册,能力无差。

**结构性错位(用了也到不了飞书用户)**

- `ctx.userQuestions`:web profile 中 provider 由 **api-gateway(apiproxy)** 注册(`packages/host/apiproxy/src/api-proxy.ts:1369`),按 `agent.id` 把问题转发给持有该会话的**浏览器客户端**。飞书会话没有浏览器连接 → ask 无法回流飞书。且 provider 每 context 仅一个,插件再注册即 `DUPLICATE_PROVIDER`。
- `ctx.approval`:同样由 Web 通道应答;无应答者时**fail-closed**(`unavailable` → 工具被拒)。当前部署 `permission.defaultPreset: danger-full-access`(approval `never`)掩盖了这一点;换 ask 模式 preset 时飞书会话会大量工具被拒。

---

## 2. 业务层链路

### 2.1 入站

```
飞书/Lark ──im.message.receive_v1──▶ 官方 SDK Channel(WS 长连接)
  policy: requireMention(群默认 @)、dmMode(open/allowlist/disabled)、groupAllowlist/dmAllowlist
  safety: 同 chat 串行队列(chatQueue)、去重(ttl 10min/万条)、过期事件丢弃(>5min)
       │ NormalizedMessage { chatId, chatType: p2p|group, threadId?, messageId, content /* 纯文本 string */ }
       ▼
channel.on('message') → bridge.reply(message)
```

安全边界全部下沉给官方 SDK;插件不碰原始事件、不落消息日志。**入站只有文本**——`NormalizedMessage.content` 是 string,图片/文件/富文本 post 消息当前不进入链路(SDK 层被丢弃或不触发)。

### 2.2 会话映射与 Agent 生命周期

`src/conversation.ts` + `src/harness.ts`:

- **键**:`chat:<chat_id>`(单聊/普通群)或 `thread:<chat_id>:<thread_id>`(话题);`replyToMessageId` 不影响键(群内普通回复共享会话)。
- **SessionId**:`lark-v2-` + sha256(`domain\0key`) 截 40 hex——确定性、不含原始 chat_id、按 feishu/lark 域隔离;`-v2-` 前缀把带 preset/workspace 组装的会话与旧版未组装会话隔离。
- **Agent 懒创建**(`Map<key, Promise<handle>>`,失败即摘除防竞态):
  1. 模型:config.provider/model ?? `agentDefaultModel.currentSelection()`;
  2. cwd:config.workspace(经 `resolveByPath`,不存在则报错)?? 第一个注册 Workspace ?? `process.cwd()`;
  3. preset:`agentPresets.resolve(config.agentPreset ?? default)`——名字不存在时创建失败,飞书收到安全错误提示;
  4. `agents.create({sessionId, meta:{cwd, agentPreset}, agentOptions, setup})`,setup 里 `installModelSelection` + `presets.mount`(在 agent 未发布时完成组装,失败整体回滚);
  5. `workspace.attachSession(sessionId)` 失败则 dispose handle 回滚。

### 2.3 回合驱动与回复投影

`HarnessConversationService.reply()`(src/harness.ts:49-64):

```
whenIdle() → firstSeq = session.seq
followup(createUserMessage(text))          // 排队 next-turn 消息并唤醒驱动器
whenIdle()                                  // 等整个 agent 完全停稳(含替代工作)
sessions.flush(session)                     // 持久化检查点
summarizeTurn(events, firstSeq)             // 只认 firstSeq 之后的事件
```

`summarizeTurn` 的投影规则(conversation.ts:33-51):取 firstSeq 之后**最后一条非空 assistant/message 文本**(多条拼接取最终),轮次必须以 `turn/end reason.kind === 'completed'` 收尾;`error`/`cancelled`/空文本 → `ok:false` → 抛错(内部细节不外泄)→ 飞书收到 `errorMessage`。这保证:回复不会误发上一轮答案、失败不泄堆栈、被取消的轮次不会被当成成功。

### 2.4 回流

`channel.send(chatId, { markdown: text }, { replyTo: messageId, replyInThread })`——引用回复原消息;话题消息保持在原线程。失败兜底:`{ text: errorMessage }` 二次尝试,再失败仅记日志。**每轮恰好一条出站消息**,回合期间零反馈。

### 2.5 消息形态映射现状

| 形态 | 现状 |
|---|---|
| 入站文本 | 原样成为一条 user message(不含发送者身份/群名片等上下文) |
| 出站 | 单条 markdown(SDK 负责格式转换与发送);代码块/表格等 markdown 子集能否渲染取决于 SDK→飞书卡片/文本的映射,插件层无控制点 |
| 长回复分片 | 插件无分片逻辑;超长文本行为未验证(风险:发送失败回落 errorMessage) |
| 卡片/图片/文件 | 均无 |

### 2.6 并发与隔离

- 同一会话:SDK chatQueue 串行 + `reply()` 内 whenIdle 先后夹逼——同一聊天不会有两个并发轮次改同一 session。
- 跨会话:每 key 独立 Agent,同进程真并发(agent loop 各自驱动器);互不串扰(inbox/session 按 agent 分键)。
- 会话隔离粒度:chat 级 / thread 级;不同群、不同话题、单聊全部独立。
- 单实例单应用:同一飞书应用只能跑一个长连接消费者(平台在多连接间分发事件),多实例部署会丢消息——运维约束。

### 2.7 鉴权与安全

- 应用凭据仅经环境变量 → patch `!!js` 表达式;`appSecret` 在 schema 上 `role('secret')`,插件不记录。
- 用户侧:dmMode/白名单(open_id/chat_id);群默认必须 @。
- 数据侧:SessionId 哈希化;内部错误只回 bounded errorMessage;测试覆盖"不暴露 secret stack"。
- Agent 侧:会话权限模式继承宿主 `permission` 设置(当前 danger-full-access)——飞书入口的每个用户实际共享同一 agent 权限面,**没有 per-user 权限降级**。

---

## 3. 与 ACP 路线对照

### 3.1 lark-coding-agent-bridge 形态

独立守护进程(systemd/launchd/任务计划),按 profile spawn 本机 agent CLI 子进程:`claude`(stream-json)/`codex`/`pi`(spawn|rpc 持久池|**acp** 模式:JSON-RPC 2.0 ndjson over stdio,`initialize → session/new → session/prompt → session/update`)。渠道 UX 完整:流式卡片、斜杠命令(/new /cd /ws /stop /invite…)、图片文件、访问控制(owner/admin/user/group 名单)、云文档评论、多 profile、idle 探活。

### 3.2 本质差异

| 维度 | dsh-lark(插件进宿主) | bridge(独立进程 + ACP/spawn) |
|---|---|---|
| 进程模型 | 与 DSH 同进程,零新增进程 | bridge daemon + 每会话/每连接 agent 子进程 |
| 能力获取 | 直取宿主对象:`agents`/`sessions`/preset/workspace/事件流,无协议裁剪 | 只能取协议面:ACP 客户端能力协商 + `session/update` 通知 |
| 流式 | 可订阅 `assistant/chunk`/`agent/*`(未做) | 协议原生 `agent_message_chunk`(已做,卡片实时刷) |
| 工具面 | preset 全量(bash/fs/subagent/terminal/workflow/skill…),与 Web 会话同源 | 子进程 CLI 自带工具;DSH 经 ACP 仅暴露基线(见下) |
| 会话持久化 | 直接写 DSH session 日志,Web UI 可见同一会话 | bridge 自管 sessions.json + agent 自身历史,两套账 |
| 状态一致性 | 进程内强一致(同一 SessionStore/Registry) | 跨进程最终一致,靠协议事件重建视图 |
| 部署 | 随 `dsh web` 启动,无 daemon 管理 | 自带 daemon/profile/锁/进程注册表 |
| agent 无关性 | 绑死 DSH | 一份 bridge 接任意 ACP/CLI agent |

**DSH 的 ACP 服务器现状**(`packages/acp/acp`):仅自动化基线——`initialize` 只公布基线提示词(**无图像/音频/嵌入**);`session/new` 拒绝非空 `additionalDirectories`/`mcpServers`;**仅新会话**(无 load/list/resume/fork);输出**仅已提交 assistant 文本**(无实时推理/工具活动/计划/标题);权限仅一次性 allow/deny。所以 bridge 直连 DSH 必须自写 adapter 且能力被协议面砍到基线以下——这正是"ACP 路线只做对照"的结构性原因。

### 3.3 插件路线的独有优势与硬缺口

**独有优势(ACP 路线拿不到或要绕)**:

1. 免 adapter、免协议损耗:preset 组装的完整工具面原样可达;
2. 直取宿主状态:`sessions.flush`、workspace 归属、sessionQuery、subagent registry、storage 域——飞书会话是宿主"一等公民"会话,Web UI 里可见可续;
3. `setup(agentCtx)` 受信组合窗口:可为飞书渠道定制 per-agent 工具/提示段/模型路由;
4. 生命周期与宿主同寿:courdis disposal 语义保证连接、agent、落盘的有序收尾。

**硬缺口(bridge 已有、插件路线当前没有)**:流式卡片、斜杠命令、媒体收发、交互按钮(/stop)、daemon 化与多 profile、云文档评论、idle 探活——全部是渠道 UX 层,DSH 宿主没有对应现成件,得在插件里自建(飞书卡片/按钮 API 层面)或等本体补交互路由。

---

## 4. 能力边界结论(核心产出)

### 4.1 v0.1.1 已实现清单(逐条,附证据)

| # | 能力 | 实现位置 |
|---|---|---|
| 1 | cordis 组合包挂载 + 默认禁用实例 + id 覆盖启用 | `package.json dsh.bundle.patch`、`cordis.patch.yml`、`src/index.ts apply` |
| 2 | 官方 SDK WS 长连接收发(重连/去重/过期/串行/policy) | `src/channel.ts` factory options |
| 3 | chat/thread → 确定性哈希 SessionId(v2,域隔离) | `src/conversation.ts toSessionId` |
| 4 | Agent 懒创建/复用/失败回滚,per-key 隔离 | `src/harness.ts getOrCreate/createAgent` |
| 5 | preset 解析 + mount + workspace 归属 + 模型路由(渠道覆盖或宿主默认) | `src/harness.ts createAgent` |
| 6 | whenIdle 夹逼的单轮驱动 + flush + 本轮文本投影 | `src/harness.ts reply`、`summarizeTurn` |
| 7 | 引用回复/话题回流 + 安全错误兜底(≤500 字,不泄内部) | `src/channel.ts message handler` |
| 8 | 访问控制(mention/dmMode/双向白名单)与凭据环境变量化 | `src/config.ts` schema + SDK policy |
| 9 | 有序销毁(监听→连接→agent 全量 dispose) | `src/channel.ts stop`、`src/harness.ts dispose` |
| 10 | 测试:键映射/投影/桥接生命周期/配置/发布元数据 | `tests/*.spec.ts`(全部可跑,vitest) |

### 4.2 缺口清单(逐条:归属 / 路径 / 工作量)

工作量:小 ≤1 天,中 1–3 天,大 >3 天(单人,含测试)。

| # | 缺口 | 归属 | 修法与路径 | 量 |
|---|---|---|---|---|
| 1 | **重启后会话延续断裂**:只调 `agents.create`,同 SessionId 重启后持久化后端判 collision(`session-persistence` coordinator:非空已存日志不是空 seed 的前缀 → reject;"load/resume it instead")→ 既有聊天首条消息必失败,且该会话永久不可用 | 插件层 | `getOrCreate` 先 `ctx.agents.resume({sessionId, meta, agentOptions, setup})`(`ResumeAgentOptions` 同样支持 setup 挂 preset),无持久日志时回退 create;`src/harness.ts` | 中 |
| 2 | **交互回流缺失**:ask_user/approval 由 apiproxy 的 provider 按 sessionId 转发浏览器;飞书会话无浏览器连接 → 提问悬置/失败,审批 fail-closed 拒绝 | 插件层为主,可能动本体 | 轻方案:插件侧为飞书轮次提供自动应答策略(仿 dsh-acp 的机器策略)+ 系统提示告知"用最终答复代替中途提问";重方案:飞书卡片问答 + `approval/request` waterfall 监听器(`packages/interaction/user-approval`,监听器可 per-agent 限定,插件可注册飞书 answerer——比 userQuestions 好补);userQuestions 多通道路由若要做需动 `packages/host/apiproxy/src/api-proxy.ts`(按 agent 来源选 provider)或 `packages/interaction/user-questions`(provider 仲裁) | 中–大 |
| 3 | **流式/进度回流**:整轮静默,长任务零反馈 | 插件层 | 订阅 agent 作用域事件(`agent/inbox/*`、`session/event` 的 `assistant/chunk`)节流聚合;出站用飞书卡片流式更新(需走 im 卡片 API,官方 Channel 抽象仅 text/markdown——`@larksuiteoapi/node-sdk` 底层 Client 有卡片消息,插件可绕过 Channel 直用);`src/channel.ts` 出站路径 | 中–大 |
| 4 | **入站仅文本**:图片/文件/富文本丢弃 | 插件层 | 订阅原始 `im.message.receive_v1`(SDK 事件面)识别 image/file 消息 → im 资源下载 API 拉取 → 走 DSH `attachment-local`(内容寻址)+ `createUserMessage` image block;`src/channel.ts`/`src/harness.ts` | 中–大 |
| 5 | 长回复分片与 markdown 降级 | 插件层 | reply 后按飞书消息上限切片顺序发送,代码块保形;`src/channel.ts` | 小 |
| 6 | 会话管理命令(/new /stop /model /cd) | 插件层 | 文本前缀解析;`agent.cancel()`(接口现成)、dispose 重建、改 agentOptions 需重建 handle | 小–中 |
| 7 | 入站无发送者身份:群聊多人共享会话但模型不知道谁在说 | 插件层 | content 前拼 `[sender]`(SDK NormalizedMessage 需暴露 sender open_id;不暴露则订原始事件,与 #4 合并做) | 小 |
| 8 | 渠道内权限/审计:飞书用户共享宿主 agent 权限面(danger-full-access),无 per-user 降级、无操作审计视图 | 插件层 | 白名单已有;per-user 需 per-user agent 实例或提示词约束 + 会话事件审计读 `session/event` | 中 |
| 9 | 云文档评论、交互卡片按钮、daemon 化、多 profile(bridge 已有) | 插件层 | 分别为:评论事件订阅、卡片 action 回调(需公网回调或长连接 action 通道)、随宿主进程天然常驻(无需 daemon,多 profile = 多 patch 实例多 app 凭据,注意 #10) | 中 |
| 10 | 水平扩展:单应用单长连接消费者(平台限制) | 平台约束 | 插件无解;多实例需多 app 或接受事件分发;README 已声明,维持运维约束 | — |

**必须动 DSH 本体的点:仅 #2 的 userQuestions 多通道路由**(且可用"飞书 answerer + 自动应答策略"绕开);其余 9 项全部插件层可补。这是插件模型能力面足够宽的直接结论。

### 4.3 优先级建议

1. **P0 #1(重启延续)**:正确性缺口,会随每次宿主重启把全部存量飞书会话打成永久失败;resume-first 改造小而准。
2. **P1 #2(交互回流)**:决定飞书会话能不能跑 ask 类 preset/权限模式;至少先做 approval 飞书 answerer + ask 自动降级策略。
3. **P1 #3(流式)+ #5(分片)**:体验下限;没有它长任务在飞书侧像死机。
4. **P2 其余**:按使用方需求取用。

---

## 附:证据索引

- dsh-lark:`src/index.ts`(inject/apply)、`src/channel.ts`(SDK options/收发/销毁)、`src/harness.ts`(reply/createAgent)、`src/conversation.ts`(键/SessionId/summarizeTurn)、`src/config.ts`(schema)、`cordis.patch.yml`、`tests/*.spec.ts`、`docs/architecture.md`
- DSH:`packages/boot/app-boot/README.zh.md`(profile/patch/装载/HMR)、`packages/bundle/base|web-app/cordis.patch.yml`(宿主服务面全量)、`packages/core/agent/README.zh.md`(agents.create/followup/whenIdle/steer/cancel/resume、setup 受信组合)、`packages/core/agent/src/index.ts`(CreateAgentOptions/ResumeAgentOptions)、`packages/core/session/README.zh.md`(SessionStore/flush)、`packages/session/session-persistence-jsonl/src/index.ts` + `session-persistence/src/coordinator.ts`(同 id collision:refusing to materialize / adoptLivePrefix 前缀校验)、`packages/preset/agent-presets/README.zh.md`(resolve/mount/recompose、setup 唯一调用点)、`packages/workspace/workspace/README.zh.md`(attachSession)、`packages/interaction/user-approval|user-questions/README.zh.md`(fail-closed、单 provider)、`packages/host/apiproxy/src/api-proxy.ts:1369`(web provider 按 agent 路由)、`packages/acp/acp/README.zh.md`(ACP 基线限制)
- bridge:`README.zh.md`(功能/命令/访问控制/数据目录)、`src/`(card/commands/media/daemon/acp 目录结构)、`local:/acp-handoff.md`(ACP 模式设计)
