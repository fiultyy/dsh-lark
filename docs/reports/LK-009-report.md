# LK-009 验收回报单

- **ref**: LK-009 · **执行者**: omp@dsh-lark · **完成时间**: 2026-08-17T08:10:00Z
- **判定**: PASS-NOTES
- **代码范围**: 本票新增/改动:`src/comments.ts`(新)、`src/channel.ts`、`src/index.ts`、`src/config.ts`、`cordis.patch.yml`(注释块)、`tests/multi-instance.spec.ts`(新)、`tests/config.spec.ts`(扩展)、`tests/plugin.spec.ts`/`tests/inbound-media.spec.ts`(config 必填字段跟随)、`README.md`、`CHANGELOG.md`。其余 `git status -s` 条目为前序票累计未提交产物,本票未触碰。
- **关联**: ledger node LK-009 · worktree dsh-lark

## A. 验证门(逐项贴证据)
- [x] **G1** `npm run typecheck` → 零错误
  ```
  $ npm run typecheck | tail -1
  npm notice run tsc --noEmit        (exit 0)
  ```
- [x] **G2** `npm test` → 71 passed / 0 failed
  ```
   Test Files  12 passed (12)
        Tests  71 passed (71)
  ```
- [x] **G3** 改动范围仅本仓库预期文件:
  - `src/comments.ts`(新)— `commentText`(raw `drive.notice.comment_add_v1` 三形态文本提取:string/`{text}`/`elements[].text_run.text`)、`replyComment`(drive.comment.reply create,长文单次截断 9000 字符)、`isCommentFileType`(API 接受的 7 种文件类型)、`EMPTY_COMMENT_TEXT` 占位。
  - `src/channel.ts` — channel options 增 `includeRawEvent: true`(评论文本不在规整事件里);`comment` handler:`mentionedBot` 过滤、文件类型过滤、评论文本提取、`bridge.drive`(chatId=`doc:<fileToken>`,replyTo=commentId)、应答/fallback 均回评论线程。
  - `src/index.ts` — 模块级 `appIdsInUse` 注册表 + `claimAppId`(同 appId 第二实例启动即抛错,`ctx.effect` 归还),多实例=多 patch 实例各自凭据。
  - `src/config.ts` — `commentReplies`(默认 true)。
  - `cordis.patch.yml` — 多实例约束注释块(不同 appId + 示例)。
  - `tests/multi-instance.spec.ts`(新)— B 表 ①–③ 四用例;`tests/config.spec.ts` 扩 commentReplies 默认/关闭用例;两处既有 spec 字面量补必填字段。
  - `README.md`(配置表 + 「多实例与单应用单连接约束」节)/`CHANGELOG.md`。

## B. 验证目标逐项(与 ticket 验证目标 1:1,不可增删)
| # | 验证目标 | 达成 | 证据(用例名@文件:行 / 命令输出摘录) |
|---|---|---|---|
| 1 | 文档评论 @ 机器人→触发轮次并回复评论线程 | [x] | `routes the comment text into drive and posts the reply via the comment-reply API`@tests/multi-instance.spec.ts:79 — 评论事件→`drive` 收到 `{chatId:'doc:ft_doc_1', replyToMessageId:'cmt_1', content含'这段讲了什么?'}`;deliver 后 `fileCommentReply.create` 载荷 `{params:{file_type:'docx'}, path:{file_token:'ft_doc_1', comment_id:'cmt_1'}, elements[0].text='这是该评论的答案。'}`;`ignores comments that do not mention the bot and unsupported file types`@:98 — 非 @ 与 `wiki` 类型零触发 |
| 2 | 双实例(不同 app)互不串扰各自收发 | [x] | `events land only in the instance whose channel delivered them`@tests/multi-instance.spec.ts:109 — app_a 评论事件只进 a 实例(`doc:ft_a`)、app_b 消息只进 b(`oc_b`),a 的应答只调 a 的 fileCommentReply,b 侧零调用 |
| 3 | 单应用单连接约束在配置校验/README 显式声明 | [x] | `a second instance with the same appId fails fast; distinct apps coexist; release frees the id`@tests/multi-instance.spec.ts:130 — `claimAppId('app_dup')` 二次抛 `/one WebSocket connection/`,不同 appId 并存,release 后可再占用;README.md:329-331「多实例与单应用单连接约束」节 + 配置表 commentReplies 行;`cordis.patch.yml:14-25` 多实例注释块 |

## C. 新增用例清单
| 用例名 | spec 文件 | 对应 B# | 结果 |
|---|---|---|---|
| routes the comment text into drive and posts the reply via the comment-reply API | tests/multi-instance.spec.ts:79 | B1 | 通过 |
| ignores comments that do not mention the bot and unsupported file types | tests/multi-instance.spec.ts:98 | B1 | 通过 |
| events land only in the instance whose channel delivered them | tests/multi-instance.spec.ts:109 | B2 | 通过 |
| a second instance with the same appId fails fast; distinct apps coexist; release frees the id | tests/multi-instance.spec.ts:130 | B3 | 通过 |
| defaults comment replies on and lets operators disable them | tests/config.spec.ts:30 | B1 | 通过 |

## D. 冒烟清单(人工项,agent 只列步骤不执行)
| 步骤 | 状态(待人工/通过/跳过+原因) | 执行者 | 备注 |
|---|---|---|---|
| 真应用订阅 `drive.notice.comment_add_v1` 事件,在云文档评论中 @机器人 提问,确认应答出现在该评论线程 | 待人工 | 维护者 | 需真凭据+文档评论权限 |
| 配置第二个 patch 实例(不同 appId),双实例并行收发互不串扰 | 待人工 | 维护者 | 需第二套凭据 |
| 用同一 appId 配第二个实例,确认启动即报 `one WebSocket connection` 错误 | 待人工 | 维护者 | 校验行为冒烟 |

## E. 偏差与备注
1. **评论文本获取**:SDK 规整的 `CommentEvent` 不带文本(字段被丢弃),实现以 `includeRawEvent: true` 保留 raw 载荷并在 `commentText` 中按三种已知形态提取(string / `{text}` / `elements[].text_run`),提取失败回落占位文案而非丢事件。该通道 opts 是全局的,`raw` 同时挂在 message/cardAction 等事件上(payload 略增,无行为影响)。
2. **会话键**:`doc:<fileToken>` 每文档一个会话、`replyToMessageId` 记评论 id(仅审计用途);同一文档的连续评论续会话。评论回复走 `drive.v1.fileCommentReply.create`(与消息通道无关,单次截断 9000 字符,不分片——评论线程非聊天面)。
3. **action 通道与 LK-003 共用**:票面要求已由现有结构满足——每实例各自的 `InteractionCardHub` 随各自 channel attach,action 按 appId 隔离天然成立,无需新增接线。
4. **commentReplies 默认 true**:开箱即用;README 说明关闭方式。依赖应用订阅 `drive.notice.comment_add_v1` 事件(未订阅则无事件,静默)。
5. **冒烟未执行**:无真凭据/第二套凭据,机器可验证部分(①–③)已全部自动化覆盖。

## F. 审查记录(编排者填写,agent 留空)
- 审查人/时间: orch1 / 2026-08-17T07:56Z
- 结论: 打回(仅信封)
- 备注: 实质面全绿(G1/G2重跑✓ B3/3 C5项grep 硬伤0);打回原因 = done body 备注 68 字 > 60 上限(LK-007 F 节已声明末次豁免,本票起一律 R1)。重交件 LK-009-R1:信封-only,零代码零测试,仅合规 done + 报告追加行。E4 commentReplies 默认开箱即用合理;E 节其余无异议。

R1: 信封修正重交,实质零改动
