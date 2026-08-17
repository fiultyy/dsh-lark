# LK-001 验收回报单

- **ref**: LK-001 · **执行者**: omp@dsh-lark · **完成时间**: 2026-08-17T05:13:20Z
- **判定**: PASS
- **代码范围**: git status -s 全量输出:
  ```
   M CHANGELOG.md
   M src/harness.ts
   M tests/harness.spec.ts
  ?? docs/capability-boundary-analysis.md
  ?? docs/tickets.md
  ?? docs/reports/
  ```
  前三行为本票改动;未跟踪三者为编排者此前的分析产物/tickets.md(非本票改动,保持原样未动)。DSH 本体与 lark-coding-agent-bridge 零改动。
- **关联**: ledger node LK-001 · worktree dsh-lark

## A. 验证门(逐项贴证据)
- [x] **G1** `pnpm typecheck` → 零错误
  ```
  npm notice run tsc --noEmit
  (无输出,exit 0)
  ```
- [x] **G2** `pnpm test` → 22 passed / 0 failed
  ```
   Test Files  5 passed (5)
       Tests  22 passed (22)
  ```
- [x] **G3** 改动范围仅本仓库预期文件:
  - `src/harness.ts` — deps 面新增 `agents.resume`;`createAgent` 重构为 resume-first 的 `acquireAgent`(miss 判定 + 回退 create + attach 回滚),新增 `isResumeMiss`
  - `tests/harness.spec.ts` — fixture 增加 persisted 日志表与 resume mock;新增 4 用例;存量 6 用例断言适配(fixture 重构)
  - `CHANGELOG.md` — Unreleased 条目记录行为变化
  - `docs/reports/LK-001-report.md` — 本回报

## B. 验证目标逐项(与 ticket 验证目标 1:1,不可增删)
| # | 验证目标 | 达成 | 证据(用例名@文件:行 / 命令输出摘录) |
|---|---|---|---|
| 1 | 有日志 session:resume 先行/create 零调用(不再 collision reject) | [x] | `resumes the persisted session and never calls create` @tests/harness.spec.ts:155:断言 `f.resume` 1 次 + `f.create` 零调用 + 恢复的 agent 事件含 `prior answer`(种子轮存续);实现侧 `agents.resume` 先行 @src/harness.ts:138,仅 miss 才 create @src/harness.ts:140-141 |
| 2 | 无日志:resume 静默回退 create | [x] | `falls back to create when no persisted session exists` @tests/harness.spec.ts:172:resume mock 抛 `session "<id>" not found` → create 恰 1 次且调用序 `resume < create`(`invocationCallOrder` 断言 @:179),meta/agentOptions 与原行为一致;存量用例 `lazily creates and reuses…` @:82 经同一回退路径零回归 |
| 3 | resume 路径 setup 同样完成 preset mount + 模型路由 | [x] | `mounts the preset and model route through the resume setup call` @tests/harness.spec.ts:185:`agentOptions={provider:'custom',model:'model'}` + `resolve('coding')` + 调用 `call.setup(agentCtx)` 后 `mount(agentCtx,'coding')`;setup 闭包含 `installModelSelection` 与 `presets.mount` @src/harness.ts:133-136,resume 调用携带该 setup @src/harness.ts:138 |
| 4 | resume 失败但日志存在:回安全错误,不静默新建空会话顶替旧 id | [x] | `surfaces a resume failure instead of replacing the persisted session` @tests/harness.spec.ts:201:resume 抛 `…was written by a newer harness`(非 miss)→ `reply()` rejects 该错误(channel 层转既定安全 errorMessage,已由 `sends a safe fallback…` @tests/plugin.spec.ts:35 覆盖)+ `create` 零调用;miss 判定白名单 @src/harness.ts:109-113 仅认 `not found` / `session persistence is not configured` |

## C. 新增用例清单
| 用例名 | spec 文件 | 对应 B# | 结果 |
|---|---|---|---|
| resumes the persisted session and never calls create | tests/harness.spec.ts:155 | 1 | 通过 |
| falls back to create when no persisted session exists | tests/harness.spec.ts:172 | 2 | 通过 |
| mounts the preset and model route through the resume setup call | tests/harness.spec.ts:185 | 3 | 通过 |
| surfaces a resume failure instead of replacing the persisted session | tests/harness.spec.ts:201 | 4 | 通过 |

## D. 冒烟清单(人工项,agent 只列步骤不执行)
| 步骤 | 状态(待人工/通过/跳过+原因) | 执行者 | 备注 |
|---|---|---|---|
| 同一 chat 连发两轮,确认回复连续 | 待人工 | 人 | 需真凭据 + dsh web 运行 |
| 重启 `npx @deepseek-ai/dsh web` | 待人工 | 人 | 重启前确认终端无 collision 报错 |
| 同一 chat 续聊,回复含前文上下文(非"初次见面") | 待人工 | 人 | 即本票修复的原故障场景:重启后首条消息不再报错 |

## E. 偏差与备注
1. **miss 判定基于错误文本匹配**(`not found` / `session persistence is not configured`,@src/harness.ts:109-113):peerDep 固定 `@deepseek-ai/dsh-agent@0.1.0-rc.6`,其 resume 对无日志 session 的拒绝无错误码,只有上述固定文本;且即使误判为 miss,后续 create 会被 DSH 持久层的 id collision 守卫兜底拒绝(`refusing to materialize … a log already exists`),不会静默顶替旧 id——双重保险,④ 的不变量不依赖文本匹配的精确性。
2. resume 成功后仍调用 `workspace.attachSession`(与 create 路径一致):会话头部 cwd 来自持久日志,若重启期间 `workspace` 配置被改指向别处,attach 校验失败 → 安全错误(不静默换绑)。属票外边界的保守行为。
3. 冒烟三项需真实飞书凭据与真机重启,列 D 表待人工;自动用例已按票面形式覆盖 ①–④。

## F. 审查记录(编排者填写,agent 留空)
- 审查人/时间: orch1 / 2026-08-17T05:15Z
- 结论: 通过
- 备注: 亲验 G1(exit 0)/G2(5 files, 22 tests 全绿,与报告一致);抽查 B#1@:155(resume 1 次+create 零调用+prior answer 存续断言真实)、B#4@:201(newer-harness rejects+persisted 保留)、实现侧 src/harness.ts isResumeMiss 白名单+resume-first 主线,E1 偏差核实成立(peerDep rc.6 无错误码,DSH 持久层 collision 守卫为第二道防线,不变量不依赖文本匹配)。冒烟三项留待人工(D 表)。
