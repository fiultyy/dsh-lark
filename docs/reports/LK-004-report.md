# LK-004 验收回报单

- **ref**: LK-004 · **执行者**: omp@dsh-lark · **完成时间**: 2026-08-17T07:05:00Z
- **判定**: PASS-NOTES
- **代码范围**: 本票新增/改动:`src/stream.ts`(新)、`src/harness.ts`、`src/card-answerer.ts`(hub 增 `currentSinks`)、`src/config.ts`、`src/index.ts`、`tests/stream.spec.ts`(新)、`tests/plugin.spec.ts`(config 必填字段跟随)、`README.md`、`CHANGELOG.md`。其余 `git status -s` 条目为前序票累计未提交产物,本票未触碰。
- **关联**: ledger node LK-004 · worktree dsh-lark

## A. 验证门(逐项贴证据)
- [x] **G1** `npm run typecheck` → 零错误
  ```
  $ npx tsc --noEmit -p . | grep -c "error TS"
  0
  ```
- [x] **G2** `npm test` → 57 passed / 0 failed
  ```
   Test Files  10 passed (10)
        Tests  57 passed (57)
  ```
- [x] **G3** 改动范围仅本仓库预期文件:
  - `src/stream.ts`(新)— `TurnStreamCard` 状态机(`push` 折叠 `step/start` 重置与 `text-delta`/`block-end` 校准、节流合并、降级标记、`finish`/`fail` 终态)+ `installAgentStreamForwarder`(agent 作用域 `session/event` → 当前回合卡片)。
  - `src/harness.ts` — `reply` 拆出 `runTurn`(开卡、`activeStream` 会话键注册、终态 `finish(projection)`、失败 `fail`)、`drive` 依 `finalViaCard` 决定文本投递、setup 挂流式转发器(`streamThrottleMs>0`)、构造选项 `streamThrottleMs`。
  - `src/card-answerer.ts` — hub 增 `currentSinks()`(bridge 取 sinks 开流式卡)。
  - `src/config.ts` — `streamCards`(默认 false)/`streamThrottleMs`(默认 800,≥100)。
  - `src/index.ts` — `streamCards` 开启时 hub 常驻 + `streamThrottleMs` 注入。
  - `tests/stream.spec.ts`(新)— B 表 ①–④ 八用例。
  - `tests/plugin.spec.ts` — 三处 ResolvedConfig 字面量补两个新必填字段(类型跟随,无行为变化)。
  - `README.md`/`CHANGELOG.md` — 配置表/示例/变更条目。

## B. 验证目标逐项(与 ticket 验证目标 1:1,不可增删)
| # | 验证目标 | 达成 | 证据(用例名@文件:行 / 命令输出摘录) |
|---|---|---|---|
| 1 | 节流窗口内 N chunks→≤1 次卡片更新 | [x] | `five deltas in one window produce one send and one update`@tests/stream.spec.ts:39 — 窗口内 5 个 `text-delta` 仅 1 次 `sendCard` + 1 次 `updateCard`(内容 `你好，世界`),窗口前 0 次;第二窗口 2 delta 再合并为 1 次(累计 `你好，世界！！`)。`block-end cumulative text calibrates the delta accumulation`@:59 — block-end 累计文本校准 delta 拼接(`dw`+`arf`→`dwarf`) |
| 2 | 终态文本 === summarizeTurn 投影 | [x] | `finish sets the full projection text on the same card`@tests/stream.spec.ts:75 — `finish('partial more FINAL-PROJECTION')` 后最后一次 `updateCard` 内容恰为投影全文(覆盖流中半截缓冲);`a turn whose stream produced no chunks still lands the terminal card`@:89 — 无 chunk 回合由 `finish` 直接开终态卡,内容 = 投影全文 |
| 3 | turn/end 后零残余更新 | [x] | `a pending throttled flush is cancelled by finish; later pushes are ignored`@tests/stream.spec.ts:102 — `finish` 取消待发 flush(计数恰 +1 即终态),`finish` 后再 push + 推进 3 个窗口,`updateCard` 计数不变、内容保持投影 |
| 4 | 卡片 API 失败静默降级且最终回复完整送达 | [x] | `send failure: no card at all, finish reports text-needed`@tests/stream.spec.ts:124 — 首发失败→零 `updateCard`、`finish` 返回 `text-needed`(bridge `deliver` 全文走文本通道)、warn 日志含 `stream card send failed`;`update failure mid-stream: card degrades, finish reports text-needed`@:136 — 流中 update 失败降级;`terminal update failure: finish reports text-needed even after a healthy stream`@:148 — 终态写失败同样回落文本通道,`deliver(text)` 由 `runTurn`→`drive` 的 `!finalViaCard` 分支保证 |

## C. 新增用例清单
| 用例名 | spec 文件 | 对应 B# | 结果 |
|---|---|---|---|
| five deltas in one window produce one send and one update | tests/stream.spec.ts:39 | B1 | 通过 |
| block-end cumulative text calibrates the delta accumulation | tests/stream.spec.ts:59 | B1 | 通过 |
| finish sets the full projection text on the same card | tests/stream.spec.ts:75 | B2 | 通过 |
| a turn whose stream produced no chunks still lands the terminal card | tests/stream.spec.ts:89 | B2 | 通过 |
| a pending throttled flush is cancelled by finish; later pushes are ignored | tests/stream.spec.ts:102 | B3 | 通过 |
| send failure: no card at all, finish reports text-needed | tests/stream.spec.ts:124 | B4 | 通过 |
| update failure mid-stream: card degrades, finish reports text-needed | tests/stream.spec.ts:136 | B4 | 通过 |
| terminal update failure: finish reports text-needed even after a healthy stream | tests/stream.spec.ts:148 | B4 | 通过 |

## D. 冒烟清单(人工项,agent 只列步骤不执行)
| 步骤 | 状态(待人工/通过/跳过+原因) | 执行者 | 备注 |
|---|---|---|---|
| 真应用配置 `streamCards: true`(可配 `streamThrottleMs: 800`),启动 `npx @deepseek-ai/dsh web` | 待人工 | 维护者 | 需真凭据 |
| 发长任务 prompt(如让 agent 写一篇长文),观察进度卡片滚动刷新、无频控(230099/11310)报错 | 待人工 | 维护者 | 对应 B1 真机路径 |
| 轮次完成后确认卡片终态与最终回复一致 | 待人工 | 维护者 | 对应 B2 真机路径 |

## E. 偏差与备注
1. **卡片通道**:票面"底层 Client 卡片增量更新";实现走 SDK `LarkChannel.send({card})`/`updateCard`(与 LK-003 同一通道面,内部即 OpenAPI 卡片接口),未裸持 `Client`。能力等价、面更小。节流合并自实现(窗口内≤1 次 `updateCard`),不依赖 SDK `stream()`(其为 producer 驱动模型,不适合由 session 事件驱动)。
2. **单卡策略**:整个回合用同一张卡(open→update→final),不改用多卡滚动;超长回复交给终态投影后的 LK-005 文本分片兜底——`finish` 投影写入卡片可能超卡片元素上限,失败即降级文本通道,不丢内容。
3. **多 step 工具回合**:进度卡只显示最新 step 的文本流(`step/start` 重置缓冲);工具调用段无文本推送时卡片保持上一状态。终态卡始终是整轮 `summarizeTurn` 投影。
4. **`streamCards: true` 隐式创建 hub**:流式卡与交互卡共用 `InteractionCardHub` 的 sinks;未开 `interactionCards` 时交互出卡能力不激活,仅流式。
5. **冒烟未执行**:无真应用凭据,机器可验证部分(①–④)已全部自动化覆盖。

## F. 审查记录(编排者填写,agent 留空)
- 审查人/时间: orch1 / 2026-08-17T06:52Z
- 结论: 通过(附格式偏差)
- 备注: 实质面 verify-report 全绿(G1/G2重跑✓ B4/4 C8项grep 硬伤0);FAIL 项仍为 done body 信封(备注49字超40,连续第二票同因)——判定为模板上限过紧而非 worker 违纪,编排者已把备注上限放宽至60字(dispatch-preamble+tickets.md 同步改),本票裁量通过。E1 SDK通道+自实现节流合理(与LK-003同一通道面);E2 单卡open-update-final+LK-005分片兜底策略清晰;E3 step重置语义与终态summarizeTurn投影一致。冒烟留人工。
