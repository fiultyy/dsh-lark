# LK-003 验收回报单

- **ref**: LK-003 · **执行者**: omp@dsh-lark · **完成时间**: 2026-08-17T06:55:00Z
- **判定**: PASS-NOTES
- **代码范围**: 本票新增/改动:`src/card-answerer.ts`(新)、`src/harness.ts`、`src/channel.ts`、`src/config.ts`、`src/index.ts`、`tests/card-answerer.spec.ts`(新)、`tests/plugin.spec.ts`(config 必填字段跟随)、`README.md`、`CHANGELOG.md`。其余 `git status -s` 条目为前序票(LK-001/002/005/006)累计未提交产物,本票未触碰。
- **关联**: ledger node LK-003 · worktree dsh-lark

## A. 验证门(逐项贴证据)
- [x] **G1** `npm run typecheck` → 零错误
  ```
  npm notice run @sugarforever/dsh-lark@0.1.1 typecheck
  npm notice run tsc --noEmit
  EXIT=0
  ```
- [x] **G2** `npm test` → 49 passed / 0 failed
  ```
   Test Files  9 passed (9)
        Tests  49 passed (49)
  ```
- [x] **G3** 改动范围仅本仓库预期文件:
  - `src/card-answerer.ts`(新)— `InteractionCardHub`:approval/ask 出卡、按钮点击路由、超时/取消终态卡片标注、sinks attach、per-agent 路由表。
  - `src/harness.ts` — `installAgentCardAnswerer`(agent 作用域 `approval/request` 监听器,prepend 注册在 LK-002 兜底之后使卡片居 waterfall 首位)、`wrapUserQuestions` 增卡片路径(点击回填/超时混策略应答)、`reply` 绑定会话→chat 锚点、`dropHandle` 清理路由、构造选项 `cardHub/cardTimeoutMs`。
  - `src/channel.ts` — connect 后 `cardHub.attach({sendCard,updateCard})`、`cardAction` 事件先路由交互卡片(未命中再落指令卡)、teardown `cardHub.dispose()`。
  - `src/config.ts` — 新增 `interactionCards`(默认 false)/`cardInteractionTimeoutMs`(默认 120000)。
  - `src/index.ts` — `interactionCards` 开启时组装 hub 并注入 bridge/startChannel。
  - `tests/card-answerer.spec.ts`(新)— B 表 ①–⑤ 七用例。
  - `tests/plugin.spec.ts` — 三处 ResolvedConfig 字面量补两个新必填字段(类型跟随,无行为变化)。
  - `README.md`/`CHANGELOG.md` — 配置表/示例/变更条目。

## B. 验证目标逐项(与 ticket 验证目标 1:1,不可增删)
| # | 验证目标 | 达成 | 证据(用例名@文件:行 / 命令输出摘录) |
|---|---|---|---|
| 1 | approval→出现允许/拒绝按钮卡片 | [x] | `sends a card whose buttons decide allow-once/rejected`@tests/card-answerer.spec.ts:111 — 断言 `sendCard` 调用 `oc_1`/`replyTo: om_in_1`,按钮 value `o` 序列 `['allow','deny']`,卡片文本含工具名 `bash` 与原因 `rm -rf dist` |
| 2 | 点按钮→resolver 收到决议、轮次继续 | [x] | `allow and deny clicks both decide; the card is annotated afterwards`@tests/card-answerer.spec.ts:139 — `applyAction(allow)`→waterfall 决议 `allowed-once`,deny→`rejected`;决议后卡片 updateCard 标注操作者(含名字),按钮清空;杂散指令卡 value `{cmd,arg,ck}` 路由返回 false 不误触 |
| 3 | ask options→按钮组点选回填 | [x] | `clicking an option returns it as the answer; partial picks persist`@tests/card-answerer.spec.ts:170 — 双问题卡按钮标签 `['pnpm','npm','是','否']`;第一题点选后卡片即时标注已选项,第二题点选后 `ask` 以 `{q1:['pnpm'],q2:['是']}` resolve |
| 4 | 超时→回落 LK-002 policy 且卡片标注 | [x] | approval:`approval: card times out, machine policy behind it decides, card says so`@tests/card-answerer.spec.ts:210 — 卡片 1000ms 超时→waterfall 决议 `rejected`(deny-all),卡片标注含"超时"与策略名;ask:`ask: clicks win, the unclicked remainder is policy-answered; card annotated`@tests/card-answerer.spec.ts:228 — 已点选项保留、未点问题按策略应答,卡片含"超时"标注 |
| 5 | 非 lark 会话不受影响(per-agent 限定) | [x] | approval:`approval: a foreign agent delegates without any card traffic`@tests/card-answerer.spec.ts:260 — 外来 agent waterfall 直接落 `unavailable`,`sendCard` 零调用;ask:`ask: foreign agents still reach the original provider`@tests/card-answerer.spec.ts:271 — 外来 agent 透传原 provider,零卡片流量 |

## C. 新增用例清单
| 用例名 | spec 文件 | 对应 B# | 结果 |
|---|---|---|---|
| sends a card whose buttons decide allow-once/rejected | tests/card-answerer.spec.ts:111 | B1 | 通过 |
| allow and deny clicks both decide; the card is annotated afterwards | tests/card-answerer.spec.ts:139 | B2 | 通过 |
| clicking an option returns it as the answer; partial picks persist | tests/card-answerer.spec.ts:170 | B3 | 通过 |
| approval: card times out, machine policy behind it decides, card says so | tests/card-answerer.spec.ts:210 | B4 | 通过 |
| ask: clicks win, the unclicked remainder is policy-answered; card annotated | tests/card-answerer.spec.ts:228 | B4 | 通过 |
| approval: a foreign agent delegates without any card traffic | tests/card-answerer.spec.ts:260 | B5 | 通过 |
| ask: foreign agents still reach the original provider | tests/card-answerer.spec.ts:271 | B5 | 通过 |

## D. 冒烟清单(人工项,agent 只列步骤不执行)
| 步骤 | 状态(待人工/通过/跳过+原因) | 执行者 | 备注 |
|---|---|---|---|
| 真应用配置 `interactionCards: true` + `interactionPolicy: deny-all` + `interactionTimeoutMs` 留窗,启动 `npx @deepseek-ai/dsh web` | 待人工 | 维护者 | 需真凭据 |
| 触发一次 approval(如受限 bash 升权),手机/客户端收到允许/拒绝按钮卡,点"允许"→轮次继续执行该工具 | 待人工 | 维护者 | 对应 B1/B2 真机路径 |
| 触发一次 ask options(如 preset 含 ask_user_question),点选项按钮→回合以选择继续 | 待人工 | 维护者 | 对应 B3 真机路径 |
| 放置卡片至 `cardInteractionTimeoutMs` 超时→卡片标注超时与策略,轮次由策略应答继续 | 待人工 | 维护者 | 对应 B4 真机路径 |

## E. 偏差与备注
1. **卡片直发通道**:票面"卡片经底层 Client 直发";实现走 SDK `LarkChannel.send({card})`/`updateCard(messageId, card)`(内部即同一 OpenAPI,且自带回复关联与错误规整),不裸持 `Client`。能力等价、面更小。
2. **ask 卡片化仍受 LK-002 E1 约束**:`userQuestions` provider 单槽已被 apiproxy 占用(web 组合),ask 卡片继续走 `wrapUserQuestions` 包装路径(per-agent 命中拦截),非 `registerProvider`。
3. **ask 超时语义**:超时不丢弃已点选项——已点题保留人点结果,未点题按 `interactionPolicy` 应答(off 则整次 ask 失败闭合为错误,不悬挂)。
4. **`interactionPolicy: off` 语义边界**:`interactionCards: false`(默认)时 off 与历史零差异(LK-002 ③ 用例仍绿);开启卡片后 off 表示"仅人工卡、无机器兜底",卡片不可达/超时即 fail-closed,这是有意行为。
5. **注册顺序修复**:两监听器均 `prepend`,setup 内先注册 LK-002 兜底再注册卡片 answerer,使卡片在 waterfall 居首、兜底居次——测试 ④ 曾捕获顺序反转载获请求,已修(产品与测试双侧)。
6. **冒烟未执行**:无真应用凭据,机器可验证部分(①–⑤)已全部自动化覆盖。

## F. 审查记录(编排者填写,agent 留空)
- 审查人/时间: orch1 / 2026-08-17T06:40Z
- 结论: 通过(附格式偏差)
- 备注: 实质面 verify-report 全绿(G1/G2重跑✓ B5/5 C7项grep 硬伤0);唯一 FAIL 项为 done body 信封 —— 备注 82字超40字上限(worker 把 ack 补发说明粘入备注),报告文件本身合规,裁量不重交;下票起备注请守住 40 字。E1 SDK 卡片通道优于票面裸 Client 假设(面更小);E5 测试④真咬出 waterfall 顺序反转并双侧修复(测试有效性实证);E3 超时保留已点结果语义细致。迟到 ack 已对账(重启续接场景,54b1c2c4)。冒烟留人工。
