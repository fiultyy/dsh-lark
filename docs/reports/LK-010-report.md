# LK-010 验收回报单

- **ref**: LK-010 · **执行者**: omp@dsh-lark · **完成时间**: 2026-08-17T10:40:00Z
- **判定**: PASS-NOTES
- **代码范围**:
  ```
   M CHANGELOG.md
   M README.md
   M docs/tickets.md(编排者台账,非本票改动)
   M src/config.ts
   M src/harness.ts
   M src/index.ts
  ?? tests/hot-reload.spec.ts
  ```
- **关联**: ledger node LK-010 · worktree dsh-lark

## A. 验证门(逐项贴证据)
- [x] **G1** `pnpm typecheck` → 零错误
  ```
  > @sugarforever/dsh-lark@0.1.1 typecheck /home/yy/tools/dsh-lark
  > tsc --noEmit
  (无输出,退出码 0)
  ```
- [x] **G2** `pnpm test` → 81 passed / 0 failed
  ```
   Test Files  13 passed (13)
        Tests  81 passed (81)
  ```
- [x] **G3** 改动范围仅本仓库预期文件:
  - `src/config.ts` — 凭据字段改可选并新增 `appIdEnv`/`appSecretEnv`;新增 `resolveCredential`(非空字面量优先 → env 变量名 → fail-loud)
  - `src/harness.ts` — `wrapUserQuestions` 堆叠安全还原(仅当自身仍是安装的包装才回装 original;dead 层降级 passthrough);`HarnessConversationService.dispose()` 清空 chains/activeTurns/stopFlags/activeStream 零残留
  - `src/index.ts` — `apply` 把 `startChannel` 的 stop 挂上 `ctx.effect`(fiber dispose 兜底:async apply 期间 fiber 已卸载时手动 stop 再抛)
  - `tests/hot-reload.spec.ts` — 新增热载 spec(10 用例,见 C)
  - `README.md` — 「热载启用」章节(机制/字面量凭据/重载与失败回退)、配置表 4 行、FAQ 与安全说明更新
  - `CHANGELOG.md` — Unreleased 首条记录热载就绪改造

## B. 验证目标逐项(与 ticket 验证目标 1:1,不可增删)
| # | 验证目标 | 达成 | 证据(用例名@文件:行 / 命令输出摘录) |
|---|---|---|---|
| 1 | 双循环重载行为等价(测试断言) | [x] | `① two apply → dispose cycles reload with equivalent behavior > connects, answers, and tears down to zero residue in both cycles`@tests/hot-reload.spec.ts:170-203:两轮 apply→dispose 均 connect 1 次、`WebSocket connected` 日志、消息→`answer:ping`/`answer:pong` 回复、claim 占用→释放 |
| 2 | dispose 后零残留(全部资源计数归零) | [x] | 同上用例:`disconnect` 1 次、`handlers.size===0`(WS 退订)、包装还原且 ask 直通 provider、`claimAppId('cli_hot')` 不再抛(`activeEffects()` 为空数组);⑤ 用例 `chains/handles/activeTurns/stopFlags` 全 `size===0`@tests/hot-reload.spec.ts:366-369;cardHub pending 由 channel stop 内 `cardHub.dispose()` settle 清空(通道层既有路径,由 ① 的 0 残留覆盖) |
| 3 | 字面量凭据路径生效且 env 路径不回归 | [x] | `④ literal credentials win over env names; env path intact` 4 用例@tests/hot-reload.spec.ts:280-318:字面量优先(:293)、env 回退(:301)、缺失 fail-loud(:306)、纯字面量路径=host `!!js` 插值落点不回归(:315) |
| 4 | README 增加"热载启用"章节(patch 示例+字面量凭据+失败回退说明) | [x] | README.md:218-256:机制(watchUserPatches 双层监视与 web hmr 条目无关的判断依据)、字面量 patch 示例、字面量/env 并存优先级、重载语义(卸载资源清单+绑定保留)、配置被拒(旧树继续)/挂载失败(failed 状态)/卸载(disabled)三类回退、真机热载验证路径 |

## C. 新增用例清单
| 用例名 | spec 文件 | 对应 B# | 结果 |
|---|---|---|---|
| ① connects, answers, and tears down to zero residue in both cycles | tests/hot-reload.spec.ts | B1, B2 | PASS |
| ② keeps the previous instance connected and answering when the new config is invalid | tests/hot-reload.spec.ts | B4(失败回退) | PASS |
| ③ passes through after restore and never double-wraps on re-apply | tests/hot-reload.spec.ts | B2(包装还原) | PASS |
| ③ a reloaded layer never clobbers a sibling instance stacked on top | tests/hot-reload.spec.ts | B2(双实例堆叠) | PASS |
| ④ prefers non-empty literals when both are configured | tests/hot-reload.spec.ts | B3 | PASS |
| ④ falls back to the named env vars when literals are absent | tests/hot-reload.spec.ts | B3 | PASS |
| ④ fails loud when the named env var is missing, and when neither path is set | tests/hot-reload.spec.ts | B3 | PASS |
| ④ keeps the plain literal path (host `!!js` interpolation lands here) unchanged | tests/hot-reload.spec.ts | B3 | PASS |
| ⑤ clears per-key chains and handles on dispose, and a fresh instance restores persisted bindings | tests/hot-reload.spec.ts | B2(chains 清空/绑定保留) | PASS |
| ⑥ stops the freshly connected channel when effect registration is rejected | tests/hot-reload.spec.ts | B2(fiber 中途卸载兜底) | PASS |

## D. 冒烟清单(人工项,agent 只列步骤不执行)
| 步骤 | 状态(待人工/通过/跳过+原因) | 执行者 | 备注 |
|---|---|---|---|
| 装 fork 到 web profile(本地目录或 fork 包名) | 待人工 | orchestrator | |
| 运行中 host 写字面量 patch 启用 lark-channel,观察 `dsh-lark: WebSocket connected` | 待人工 | orchestrator | 热载挂载,host 不重启 |
| 飞书消息往返(发一条→收到回复) | 待人工 | orchestrator | |
| patch 改回 disabled/删除覆盖行,观察 `dsh-lark: WebSocket disconnected` | 待人工 | orchestrator | 热载卸载,资源全释放 |

## E. 偏差与备注
1. **env→字面量实现口径**:实现为 schema 级可选 `appId`/`appSecret` + 新增 `appIdEnv`/`appSecretEnv` 变量名字段,字面量优先;host 的 `!!js process.env.X` 插值落在字面量路径,**既有 env 插值用法零改动零回归**(B3 第 4 用例锁定)。未实现"字面量内嵌 `${VAR}` 展开嵌套 env"——两层间接没有必要,且热载语义下反而制造静默 undefined 风险。
2. **参照机制判断(票内要求验证)**:web bundle 的 `hmr` 条目(`disabled: true`,注释 "Re-enable shared HMR for Web after its reload lifecycle is tested")禁的是**共享 HMR(源码级热替换)**;而 dsh CLI 启动器(profile-boot)在 `ctx.get('hmr')===undefined` 时**另行挂载** `@deepseek-ai/cordis-plugin-hmr`(`config:{root:[]}`,仅供配置监视,不做源码 HMR),随后对 profile patch 与 home patch 两个文件调用 `watchUserPatches`。证据:`dsh/lib/profile-boot-DG5t9aNs.js:255-272`、`dsh-app-boot/lib/index.js:760-778`。结论:**插件侧改造不依赖 web bundle 的 hmr 条目**,patch 文件监视与共享 HMR 是两回事,判断成立。
3. **行为语义说明**:补齐缺口①的核心是 `apply` 结尾新增 `ctx.effect(() => stop, 'dsh-lark: channel teardown')`——fiber dispose(hot reload 的卸载半程)驱动完整资源树拆除;`ctx.effect` 抛 `INACTIVE_EFFECT`(async apply 期间 fiber 已被 dispose)时手动 `await stop()` 再抛,防泄漏(⑥ 用例锁定)。schemastery 可选字段带 `.default()` 才会填默认;凭据四字段全部无 default,`resolveConfig` 手动 fail-loud,appBoot 断言条件(`failed = fiber===undefined && !disabled`)不会被破坏。
4. **cardHub 资源审计结论**(票清单 1 的逐项对应):WS 连接+事件订阅→channel stop(`disconnect`+`unsubscribe` 全部);per-key chains→`dispose()` 清空;bindings 持久化→无监听(同步读+原子写,重载即重读,绑定保留);attachment 缓存→host 服务持有,插件无自有句柄;卡片 hub→`cardHub.dispose()` settle 全部 pending;userQuestions 包装→effect 还原(堆叠安全)。全模块无定时器/进程级监听(仅 TurnStreamCard/卡片等待的短命 setTimeout,随 turn/card 终态清理)。
5. 遗留:真机热载冒烟(D 表)留编排者;`docs/tickets.md` 的 M 为编排者台账变动,非本票改动。

## F. 审查记录(编排者填写,agent 留空)
- 审查人/时间:
- 结论: 通过(附格式备注)
- 备注: orch1 / 2026-08-17T10:35Z。初验 10 项 C 表 grep 假 FAIL:worker 在用名列加了 ①②③ B# 映射前缀,工具按原文 grep 全 miss;人工核对 it() @:171-380 全部真实存在 → 实质零造假。根因双修:①verify-report 已升级(grep 前剥离圈号/序号前缀,三面同步+selftest 19/19);②复验全绿(G1/G2重跑✓ B4/4 C10项 硬伤0)。后续票 C 表用名列请写 it() 原文,B# 映射放专列。真机热载冒烟(装fork→字面量patch→挂载/回退)转编排者执行。
