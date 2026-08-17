# LK-007 验收回报单

- **ref**: LK-007 · **执行者**: omp@dsh-lark · **完成时间**: 2026-08-17T07:45:00Z
- **判定**: PASS-NOTES
- **代码范围**: 本票新增/改动:`src/media.ts`(新)、`src/channel.ts`、`src/harness.ts`、`src/conversation.ts`、`src/config.ts`、`src/index.ts`、`package.json`(+peer/dev `@deepseek-ai/dsh-attachment`)、`tests/inbound-media.spec.ts`(新)、`tests/plugin.spec.ts`(config 必填字段跟随)、`README.md`、`CHANGELOG.md`。其余 `git status -s` 条目为前序票累计未提交产物,本票未触碰。
- **关联**: ledger node LK-007 · worktree dsh-lark

## A. 验证门(逐项贴证据)
- [x] **G1** `npm run typecheck` → 零错误
  ```
  $ npx tsc --noEmit -p . | grep -c "error TS"
  0
  ```
- [x] **G2** `npm test` → 66 passed / 0 failed
  ```
   Test Files  11 passed (11)
        Tests  66 passed (66)
  ```
- [x] **G3** 改动范围仅本仓库预期文件:
  - `src/media.ts`(新)— `collectMedia`(下载→图片走 attachments/文件落本地,单资源失败独立降级)、`composeUserText`(sender 前缀+附件路径行)、`detectImageMediaType`(魔数)、`sanitizeFileName`(目录穿越防护)。
  - `src/channel.ts` — message handler 在回合前收集媒体(`resources`→`collectMedia`→`inbound.images/files` 透传 bridge),`startChannel` 增 `media?: {attachments?, filesDir}` 参数,`resources` 缺省防御。
  - `src/harness.ts` — `InboundMessage` 增 `images?/files?`,`runTurn` followup 内容 = image blocks + `composeUserText`(sender 前缀+附件引用),构造选项 `senderLabel`。
  - `src/conversation.ts` — `ConversationMessage` 增 `senderName?/senderId?`。
  - `src/config.ts` — `senderLabel`(`group` 默认/`always`/`off`)。
  - `src/index.ts` — `attachments` 服务可选注入,文件根 `$DSH_HOME/storages/dsh-lark-files`。
  - `package.json` — `@deepseek-ai/dsh-attachment@^0.1.0-rc.6` 入 peer+dev(attachments 为可选服务,缺省时图片丢弃并告警)。
  - `tests/inbound-media.spec.ts`(新)— B 表 ①–④ 九用例。
  - `tests/plugin.spec.ts` — 三处 ResolvedConfig 字面量补 `senderLabel`(类型跟随,无行为变化)。
  - `README.md`/`CHANGELOG.md` — 配置表/变更条目。

## B. 验证目标逐项(与 ticket 验证目标 1:1,不可增删)
| # | 验证目标 | 达成 | 证据(用例名@文件:行 / 命令输出摘录) |
|---|---|---|---|
| 1 | 发图→agent 收 image block 且多模态轮次完成 | [x] | `collectMedia downloads the image and saves it through the attachments service`@tests/inbound-media.spec.ts:28 — `downloadResource('fk_img','image')`→`saveImage({mediaType:'image/png',name:'photo.png'})`;`the bridge turn sends image blocks plus text and completes`@:43 — bridge 回合 followup 内容 = `[{type:'image',attachment:ref},{type:'text',text:'describe this'}]` 且轮次 `completed` resolve `'saw image'` |
| 2 | 发文件→落 attachment-local 可引用 | [x] | `collectMedia writes the file under the message directory`@tests/inbound-media.spec.ts:81 — 文件字节写 `filesDir/om_2/spec.pdf` 且读回一致;`composeUserText appends a reference line the agent can cite`@:97 — 正文尾附 `[附件] spec.pdf 已保存到 <path>(10 字节)`;`traversal-unsafe names are sanitized inside the message directory`@:103 — `../../etc/passwd`→`passwd`、空名→fallback,目录不可逃逸 |
| 3 | 群聊 content 带 [sender]、单聊按配置 | [x] | `group prefixes group chats only; always prefixes both; off never`@tests/inbound-media.spec.ts:110 — group+p2p × group/always/off 全组合:群聊 `[张三] hi`、单聊默认无前缀、`always` 单聊也拼、`off` 永不拼、无名回落 `[ou_9]`;channel 侧 `the channel routes resource-bearing messages through media collection before the turn`@:155 — `senderName` 随消息透传 bridge(前缀在 runTurn 应用,①用例已证 content 形态) |
| 4 | 纯文本零回归 | [x] | `no media and default label: one text block, no prefix in p2p`@tests/inbound-media.spec.ts:123 — 无媒体 p2p followup 内容严格等于 `[{type:'text',text:'plain question'}]`(与历史形态逐字一致);全量 66/66 中 57 个前序用例零回归 |

## C. 新增用例清单
| 用例名 | spec 文件 | 对应 B# | 结果 |
|---|---|---|---|
| collectMedia downloads the image and saves it through the attachments service | tests/inbound-media.spec.ts:28 | B1 | 通过 |
| the bridge turn sends image blocks plus text and completes | tests/inbound-media.spec.ts:43 | B1 | 通过 |
| collectMedia writes the file under the message directory | tests/inbound-media.spec.ts:81 | B2 | 通过 |
| composeUserText appends a reference line the agent can cite | tests/inbound-media.spec.ts:97 | B2 | 通过 |
| traversal-unsafe names are sanitized inside the message directory | tests/inbound-media.spec.ts:103 | B2 | 通过 |
| group prefixes group chats only; always prefixes both; off never | tests/inbound-media.spec.ts:110 | B3 | 通过 |
| no media and default label: one text block, no prefix in p2p | tests/inbound-media.spec.ts:123 | B4 | 通过 |
| the channel routes resource-bearing messages through media collection before the turn | tests/inbound-media.spec.ts:155 | B3/B4 | 通过 |
| recognizes the four accepted formats and rejects others | tests/inbound-media.spec.ts:207 | B1 | 通过 |

## D. 冒烟清单(人工项,agent 只列步骤不执行)
| 步骤 | 状态(待人工/通过/跳过+原因) | 执行者 | 备注 |
|---|---|---|---|
| 真应用(web profile 组合含 attachment-local)发一张 PNG,确认 agent 能描述图片内容 | 待人工 | 维护者 | 对应 B1 真机路径 |
| 发一个 PDF/zip 文件,让 agent 读 `$DSH_HOME/storages/dsh-lark-files/<messageId>/` 下文件并总结 | 待人工 | 维护者 | 对应 B2 真机路径 |
| 群内 @机器人 发消息,确认回复上下文中带 `[sender]` 前缀;单聊确认默认无前缀 | 待人工 | 维护者 | 对应 B3 真机路径 |

## E. 偏差与备注
1. **订阅方式**:票面"订阅原始 `im.message.receive_v1`";实现沿用 SDK Channel 的 normalized `message` 事件 — 它已携带 `resources: ResourceDescriptor[]`(类型/文件键/文件名)与 `senderName/senderId`,无需自订 EventDispatcher 重复解析原始事件。下载走同通道的 `downloadResource`(内部即 im 资源 API)。
2. **文件落地**:DSH `AttachmentStore` 当前仅定义 image 词汇表(`saveImage/readImage`),无通用文件 API;故文件按票面"attachment-local 可引用"落 `$DSH_HOME/storages/dsh-lark-files/<messageId>/<安全文件名>` 并在正文附路径行供 agent 工具读取(与 attachment-local 同根 DSH_HOME 下,作用等价)。路径穿越经 `sanitizeFileName` 防护。
3. **attachments 服务可选**:`@deepseek-ai/dsh-attachment` 为新增 peer 依赖;组合缺该服务时图片丢弃并 warn,文本轮次不受影响。媒体类型靠魔数检测(png/jpeg/gif/webp),非四类图片丢弃告警(不透传不可信声明)。
4. **测试期修复**:`composeUserText` 在 `senderName === undefined` 时误判空名不回落 `senderId`(B3 用例捕获),已修。
5. **冒烟未执行**:无真应用凭据,机器可验证部分(①–④)已全部自动化覆盖。

## F. 审查记录(编排者填写,agent 留空)
- 审查人/时间: orch1 / 2026-08-17T07:47Z
- 结论: 通过(附格式偏差,末次豁免)
- 备注: 实质面全绿(G1/G2重跑✓ B4/4 C9项grep 硬伤0)。信封:备注63字>60(票面已标≤60),裁量通过但为**末次豁免**——LK-009 起信封超限一律 R1 重交。另:编排者补齐了 verify-report 上限根因修复(40→60 三面齐平,maestro-preset 4f0e76a)。E1 normalized resources 优于票面原始事件假设(SDK 已携带 descriptors+sender);E2 文件落 DSH_HOME 同根+sanitize 防穿越;E4 测试又咬出真 bug(composeUserText 空名回落)并修。冒烟留人工。
