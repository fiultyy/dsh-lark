# LK-002 验收回报单

- **ref**: LK-002 · **执行者**: omp@dsh-lark · **完成时间**: 2026-08-17T06:05:08Z
- **判定**: PASS-NOTES
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
  ?? tests/interaction-fallback.spec.ts
  ?? tests/outbound.spec.ts
  ```
  本票改动 = `src/harness.ts`(交互兜底机制)、`src/config.ts`(4 个新配置)、`src/index.ts`(policy 构造 + ask 包装安装)、`tests/interaction-fallback.spec.ts`(新)、`tests/plugin.spec.ts`(字面量补字段)、`README.md`、`CHANGELOG.md`、本报告;`package.json`/`package-lock.json` 增 devDep `dsh-user-approval`/`dsh-user-questions`/`dsh-system-prompt`(仅类型对齐)。其余 M/?? 为 LK-001/005/006 遗留,本票未触碰。DSH 本体与 lark-bridge 零改动。
- **关联**: ledger node LK-002 · worktree dsh-lark

## A. 验证门(逐项贴证据)
- [x] **G1** `pnpm typecheck` → 零错误
  ```
  npm notice run tsc --noEmit
  (无输出,exit 0)
  ```
- [x] **G2** `pnpm test` → 42 passed / 0 failed
  ```
   Test Files  8 passed (8)
       Tests  42 passed (42)
  ```
  (LK-006 后基线 35;本票 +7 = 42,存量零回归;`npm run build` 通过:36.14 kB)
- [x] **G3** 改动范围仅本仓库预期文件:
  - `src/harness.ts` — `InteractionPolicy`/`resolveInteractionPolicy`(策略对象);`askAnswerFor`(选项题取首项、自由题取策略文案);`approvalOutcomeFor`;`waitForFallbackWindow`(可被 abort 的等待窗);`installAgentInteractionFallback`(setup 内装 agent 作用域 prepend `approval/request` 监听 + `systemPrompt` 作用域引导段);`wrapUserQuestions`(条件包装共享 userQuestions 实例,按 `ownsAgent` 命中才拦截);service 增加 `liveAgents` WeakSet / `ownsAgent` / policy 存储,setup 门 @src/harness.ts:420
  - `src/config.ts` — `interactionPolicy`/`askAutoAnswer`/`approvalAllow`/`interactionTimeoutMs` 四字段(默认 off / 0ms)
  - `src/index.ts` — 非 off 时 `ctx.effect(() => wrapUserQuestions(...))` 安装 ask 兜底
  - `tests/interaction-fallback.spec.ts`(新)— ①–④ 用例(fake timers 覆盖超时/中止窗口)
  - `README.md`/`CHANGELOG.md` — 配置表 4 行 + Unreleased 条目

## B. 验证目标逐项(与 ticket 验证目标 1:1,不可增删)
| # | 验证目标 | 达成 | 证据(用例名@文件:行 / 命令输出摘录) |
|---|---|---|---|
| 1 | ask 类轮次被策略应答且正常 completed 不悬置 | [x] | `answers an options question with the first option and a free-text question with the policy text` @tests/interaction-fallback.spec.ts:64:选项题 `{selected:['pnpm']}`、自由题 `{custom:'按默认方案继续'}`(deny-all)与 `同意`(allow-all)逐条断言;`the wrapped service settles after the fallback window and passes foreign agents through` @:79(fake timers):owned agent 的 ask 在 5000ms 窗口后由策略 settle(不悬置在 provider 上),foreign agent 仍由 provider 原路应答,restore 后全量透传;实现 @src/harness.ts:133 wrapUserQuestions + @:51 askAnswerFor |
| 2 | approval 按 policy 放行/拒绝且可追溯 | [x] | `allow-all permits and deny-all rejects, after the window, without calling next` @tests/interaction-fallback.spec.ts:115(fake timers):allow-all→`allowed-once`(3000ms 窗口后,log 含 `auto-decided allowed-once`);deny-all→`rejected`;custom+approvalAllow true/false 两分支;`an aborted request settles cancelled instead of deciding` @:138:abort→`cancelled` 不误决。可追溯 = 宿主 `ApprovalService.request` 在 waterfall 前后自动写 `approval/asked`/`approval/decided` 审计对(源码证据:DSH `user-approval/src/index.ts:267-274`,本监听器只决定、不触碰审计,天然成对);决策另有 info 日志 |
| 3 | policy=off 与现状零差异 | [x] | `the wrapper delegates every ask to the original provider` @tests/interaction-fallback.spec.ts:150:off 包装下 ask 逐字透传 provider 结果;`off installs no approval listener and no prompt section` @:160:setup 门在 `kind !== 'off'` 才调用安装(@src/harness.ts:420-422),off 时不注册任何监听器/提示段/包装(构造默认即 off,plugin.spec 存量 3 用例经 off 路径零回归) |
| 4 | 引导语进入系统提示 | [x] | `registers a scoped section carrying the final-answer guidance` @tests/interaction-fallback.spec.ts:170:setup 上下文收到恰 1 个 section,`name='dsh-lark:interaction-policy'`、text 含 "final answer"、无未定义 `{{变量}}`;实现 @src/harness.ts:98-119(经 `agentCtx.get('systemPrompt').section()` 注册,agent 作用域分层,dispose 随 agent 撤销) |

## C. 新增用例清单
| 用例名 | spec 文件 | 对应 B# | 结果 |
|---|---|---|---|
| answers an options question with the first option and a free-text question with the policy text | tests/interaction-fallback.spec.ts:64 | 1 | 通过 |
| the wrapped service settles after the fallback window and passes foreign agents through | tests/interaction-fallback.spec.ts:79 | 1 | 通过 |
| allow-all permits and deny-all rejects, after the window, without calling next | tests/interaction-fallback.spec.ts:115 | 2 | 通过 |
| an aborted request settles cancelled instead of deciding | tests/interaction-fallback.spec.ts:138 | 2 | 通过 |
| the wrapper delegates every ask to the original provider | tests/interaction-fallback.spec.ts:150 | 3 | 通过 |
| off installs no approval listener and no prompt section | tests/interaction-fallback.spec.ts:160 | 3 | 通过 |
| registers a scoped section carrying the final-answer guidance | tests/interaction-fallback.spec.ts:170 | 4 | 通过 |

## D. 冒烟清单(人工项,agent 只列步骤不执行)
| 步骤 | 状态(待人工/通过/跳过+原因) | 执行者 | 备注 |
|---|---|---|---|
| `interactionPolicy: deny-all` + ask 类 preset(如带 plan-mode 的组合)跑一轮,确认不挂死、回合 completed | 待人工 | 人 | 需真凭据 |
| 同配置触发一次 approval(如 ask 权限模式 preset 跑 bash),确认工具被拒且回合继续 | 待人工 | 人 | 审计对在会话日志可见 |
| `interactionPolicy: off` 跑同 preset,确认行为与历史一致(ask 悬置/走 Web) | 待人工 | 人 | 对照 ③ |

## E. 偏差与备注(判定 PASS-NOTES 的原因)
1. **ask 兜底采用"包装共享服务实例"而非"注册第二个 provider"**:DSH `userQuestions` 每 context 仅一个 provider 槽,web profile 中已被 api-gateway 占用(`api-proxy.ts:1369`),再注册即 DUPLICATE_PROVIDER。插件在自身 `apply` 上下文内对服务实例的 `ask` 方法做条件包装:命中 `ownsAgent`(本插件创建且存活的 agent)才用策略应答,其余 ask 原样透传,Web 会话不受影响。代价:`ask` 方法被替换为普通函数,`ctx.effect` dispose 时恢复;这不是官方扩展点,若 DSH 未来把 provider 改为多槽/路由,应迁回正路(票面"仿 dsh-acp"在 apiproxy 占槽的 web 组合下不可直接照搬——acp 组合没有 api-gateway)。
2. **approval 用 agent 作用域 + prepend 监听器**:利用 cordis `on(..., {prepend})` 与 dsh-scope 的 agent 路由,飞书 agent 的 approval 请求先于 api-gateway 的全局监听器决定,Web 会话的 approval 不受影响。超时窗口(`interactionTimeoutMs`)即 LK-003 卡片 answerer 的让位窗口:卡片未实现前默认 0(立即应答)。
3. `custom` 策略的 ask 自由文本默认内置文案(allow/deny 各一条),`askAutoAnswer` 可覆盖;approval 默认拒绝(fail-closed)。
4. ② 的"可追溯"证据链:审计对由 DSH 宿主服务写(本票不改 DSH,报告引用其源码行为),插件侧另有 info 日志;自动测试断言的是决策与日志,审计对落在真宿主集成(冒烟)。

## F. 审查记录(编排者填写,agent 留空)
- 审查人/时间: orch1 / 2026-08-17T06:08Z
- 结论: 通过
- 备注: verify-report 全绿(G1/G2重跑✓ B4/4 C7项grep 硬伤0)。E1 架构决策人工深抽通过:provider 单槽被 apiproxy 占用属实(larkbiz-001 分析已证),包装共享服务是红线内唯一路径;harness.ts:139-150 亲验 —— original 保存/off+非ownsAgent 双条件透传(Web 零影响)/dispose 恢复完整;approval 用官方 prepend+agent-scope 机制(E2)优于 ask 包装,卡片 answerer(LK-003)有让位窗口(interactionTimeoutMs)。E4 审计对归属说明诚实。冒烟留人工。
