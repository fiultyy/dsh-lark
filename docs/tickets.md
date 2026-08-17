# dsh-lark 接飞书 · Ticket List(v4,回报模板规范化)

> 来源:`docs/capability-boundary-analysis.md`(larkbiz-001)+ 用户审核 2026-08-17(三轮)。
> 状态:☐ 待派 → ◐ 进行中 → ☑ 完成(审查通过)。工作量:小 ≤1 天 / 中 1–3 天 / 大 >3 天(单人,含测试)。

## 设计原则(审核拍板)

1. **红线:不动 DSH 本体**;全部能力在插件层实现。
2. **飞书卡片/交互是一等公民**:card 能力比 DSH 当前原生边界强,作为主要交互载体。
3. **单应用多 session + 有记录可续**:`/` 指令集 + 基于本体状态数据构建 card 选择做转译对接;lark-bridge 是直接参考。

## 全局验证门(每票 Done 必要条件)

- **G1**:`pnpm typecheck` 零错误。
- **G2**:`pnpm test` 全绿(存量用例零回归 + 新增全过)。
- **G3**:改动只落在本仓库;DSH 本体与 lark-bridge 只读。
- **G4**:按「验收回报规范」交回报告,不按模板 = 直接打回。

---

## 验收回报规范(每票必须按此模板交回)

### ① 回报物(两件,缺一打回)

1. **报告文件**:agent 创建 `docs/reports/LK-00X-report.md`,按下方模板逐项填写(证据必须真实可查:用例名+文件:行号 / 命令输出原文摘录,禁止"已通过"式空话);
2. **done 回调**(≤300 字符,固定格式):
   ```
   <判定>;报告:docs/reports/LK-00X-report.md;测试:+<新增数>/<总数>全绿;备注:<≤60字>
   ```
   判定 ∈ `PASS`(B 表全 [x] 且 G1–G3 绿)/ `PASS-NOTES`(达成但有偏差,E 节说明)/ `FAIL`。

### ② 报告模板(canonical,各票 B 表已在票内预填)

```markdown
# LK-00X 验收回报单

- **ref**: LK-00X · **执行者**: omp@dsh-lark · **完成时间**: <ISO 8601>
- **判定**: PASS / PASS-NOTES / FAIL
- **代码范围**: <git status -s 全量输出>
- **关联**: ledger node <node_id> · worktree dsh-lark

## A. 验证门(逐项贴证据)
- [ ] **G1** `pnpm typecheck` → 零错误
  ```
  <输出尾行原文>
  ```
- [ ] **G2** `pnpm test` → <N> passed / 0 failed
  ```
  <Test Files / Tests 汇总行原文>
  ```
- [ ] **G3** 改动范围仅本仓库预期文件:<逐文件一句话说明用途>

## B. 验证目标逐项(与 ticket 验证目标 1:1,不可增删)
| # | 验证目标 | 达成 | 证据(用例名@文件:行 / 命令输出摘录) |
|---|---|---|---|
| 1 | <票内预填> | [x]/[ ] | <具体证据> |

## C. 新增用例清单
| 用例名 | spec 文件 | 对应 B# | 结果 |

## D. 冒烟清单(人工项,agent 只列步骤不执行)
| 步骤 | 状态(待人工/通过/跳过+原因) | 执行者 | 备注 |

## E. 偏差与备注
<与 ticket 方案的偏离 / 已知遗留 / 风险;无则写"无">

## F. 审查记录(编排者填写,agent 留空)
- 审查人/时间:
- 结论: 通过 / 打回(打回原因)
- 备注:
```

### ③ 审查流程(orch1 执行,agent 勿动)

done 到达 → 核验报告文件与 done body 一致 → 抽查 B 表证据(至少 2 项,重跑对应单测或 grep 断言存在)→ 填 F 节 → ledger 记 `reviewed` 事件 → 票打 ☑;打回则 F 写明原因,以新 ref(`LK-00X-R1`)重派。

---

## P0 · 正确性底座

### LK-001 重启会话延续(resume-first)☑

- **目标/方案**:`getOrCreate` 对有持久日志的 SessionId 先 `ctx.agents.resume({sessionId, meta, agentOptions, setup})` 回退 `agents.create`,消除重启后 id collision 致会话永久失效;兼作 `/resume` 指令 API 底座。
- **路径**:`src/harness.ts`。
- **验证目标**:①有日志 session:resume 先行且 create 零调用(不再 collision reject);②无日志:resume 静默回退 create;③resume 路径 setup 同样完成 preset mount + 模型路由;④resume 失败但日志存在:回安全错误,不静默新建空会话顶替旧 id。
- **验证形式**:自动 = 扩展 `tests/harness.spec.ts`(①–④ 各一用例,mock agents 断言调用序与 options);冒烟 = 同一 chat 两轮 → 重启 `dsh web` → 续聊含上下文。
- **量**:中 · **依赖**:无
- **回报物**:`docs/reports/LK-001-report.md` · B 表预填:①resume 先行/create 零调用 ②无日志回退 create ③resume 带 setup 生效 ④日志在/resume 败→安全错误
- **done body**:`<判定>;报告:docs/reports/LK-001-report.md;测试:+<N>/<总数>全绿;备注:<≤60字>`

### LK-002 ask/approval 自动应答兜底 ☑

- **目标/方案**:setup 内注册机器应答策略(仿 `packages/acp/acp` 自动化,policy: allow-all/deny-all/configurable/off),系统提示注入"以最终答复代替中途提问";定位 = 卡片 answerer 不可用/超时的 fallback。
- **路径**:`src/harness.ts` + `src/config.ts`。
- **验证目标**:①ask 类轮次被策略应答且正常 completed 不悬置;②approval 按 policy 放行/拒绝且可追溯;③policy=off 与现状零差异;④引导语进入系统提示。
- **验证形式**:自动 = 新增 `tests/interaction-fallback.spec.ts`(①–④,fake timers 覆盖超时);冒烟 = ask 类 preset 跑一轮不挂死。
- **量**:中 · **依赖**:无
- **回报物**:`docs/reports/LK-002-report.md` · B 表预填:①ask 被应答且 completed ②approval policy 两分支 ③off=零回归 ④引导语入系统提示
- **done body**:`<判定>;报告:docs/reports/LK-002-report.md;测试:+<N>/<总数>全绿;备注:<≤60字>`

### LK-003 飞书卡片交互 answerer(approval + ask 全卡片化)☑

- **目标/方案**:`approval/request` waterfall 监听器(`packages/interaction/user-approval`,per-agent 限定)注册飞书卡片 answerer;卡片经 `@larksuiteoapi/node-sdk` 底层 Client 直发;按钮 action 回调→resolver;超时回落 LK-002。参考 lark-bridge `src/card/`。
- **路径**:`src/card-answerer.ts`(新)+ `src/harness.ts`。
- **验证目标**:①approval→出现允许/拒绝按钮卡片;②点按钮→resolver 收到决议、轮次继续;③ask options→按钮组点选回填;④超时→回落 LK-002 policy 且卡片标注;⑤非 lark 会话不受影响(per-agent 限定)。
- **验证形式**:自动 = 新增 `tests/card-answerer.spec.ts`(①–⑤,mock Client+action 回调);冒烟 = 真应用触发 approval 手机点按钮。
- **量**:大 · **依赖**:LK-002 · **参考**:lark-bridge `src/card/`
- **回报物**:`docs/reports/LK-003-report.md` · B 表预填:①approval 出卡 ②按钮→resolver→续轮 ③ask 按钮组回填 ④超时回落+卡片标注 ⑤非 lark 会话隔离
- **done body**:`<判定>;报告:docs/reports/LK-003-report.md;测试:+<N>/<总数>全绿;备注:<≤60字>`

### LK-004 流式/进度回流(卡片流式刷新)☑

- **目标/方案**:订阅 agent 作用域事件(`assistant/chunk` 等)节流聚合,底层 Client 卡片增量更新;失败回落 LK-005 文本通道。参考 lark-bridge `src/card/`。
- **路径**:`src/stream.ts`(新)+ `src/channel.ts`。
- **验证目标**:①节流窗口内 N chunks→≤1 次卡片更新;②终态文本 === summarizeTurn 投影;③turn/end 后零残余更新;④卡片 API 失败静默降级且最终回复完整送达。
- **验证形式**:自动 = 新增 `tests/stream.spec.ts`(①–④,fake timers+mock Client);冒烟 = 长任务 prompt 观察卡片滚动无频控报错。
- **量**:中–大 · **依赖**:建议 LK-005 后 · **参考**:lark-bridge `src/card/`
- **回报物**:`docs/reports/LK-004-report.md` · B 表预填:①节流合并 ②终态=投影 ③轮末零残余 ④失败降级不丢回复
- **done body**:`<判定>;报告:docs/reports/LK-004-report.md;测试:+<N>/<总数>全绿;备注:<≤60字>`

### LK-005 长回复分片 + markdown 降级 ☑

- **目标/方案**:出站按飞书上限切片(段落/代码块边界优先)顺序发送;降级开关。
- **路径**:`src/outbound.ts`(新)+ `src/channel.ts`。
- **验证目标**:①任意长度全量按序送达、拼接无损;②代码围栏永不跨片截断;③单片失败仅影响该片;④降级开关→纯文本内容不丢。
- **验证形式**:自动 = 新增 `tests/outbound.spec.ts`(①–④,含中文/emoji 宽度);冒烟 =>4000 字含代码块目检。
- **量**:小 · **依赖**:无
- **回报物**:`docs/reports/LK-005-report.md` · B 表预填:①切片无损 ②围栏配对 ③单片失败隔离 ④降级不丢内容
- **done body**:`<判定>;报告:docs/reports/LK-005-report.md;测试:+<N>/<总数>全绿;备注:<≤60字>`

### LK-006 `/` 指令集 + 本体状态数据卡片选择 ☑ ← 审核重点③

- **目标/方案**:`/resume`(`/ctx.sessionQuery` 真实数据→会话选择卡片→选中 resume+绑定切换)、`/model`(宿主模型列表→选择卡片)、`/cd`(workspace 列表→选择卡片)、`/new`(可选 preset 卡片)、`/stop`(`agent.cancel()`)、`/help`;未知指令→help。参考 lark-bridge `src/commands/`。
- **路径**:`src/commands.ts`(新)+ `src/channel.ts` + `src/harness.ts`。
- **验证目标**:①七指令可达且普通 `/x` 前缀消息不误触发;②/resume 卡片选项来自 sessionQuery 真实数据,选中后绑定切到所选 session 且续聊(跨重启亦然);③/model /cd 选中下一轮生效;④/stop 取消并确认;⑤未知→/help;⑥chat 与 thread 键均正确。
- **验证形式**:自动 = 新增 `tests/commands.spec.ts`(①–⑥,mock sessionQuery/agents/Client);冒烟 = 真聊天跑 7 指令 + /resume 选中跨重启续聊。
- **量**:中–大 · **依赖**:LK-001、LK-005 · **参考**:lark-bridge `src/commands/`
- **回报物**:`docs/reports/LK-006-report.md` · B 表预填:①七指令+无误触发 ②resume 卡片真数据+绑定切换+跨重启 ③model/cd 生效 ④stop 确认 ⑤未知→help ⑥thread 键
- **done body**:`<判定>;报告:docs/reports/LK-006-report.md;测试:+<N>/<总数>全绿;备注:<≤60字>`

## P2 · 按需取用

### LK-007 入站媒体 + 发送者身份(合并单)☑

- **目标/方案**:订阅原始 `im.message.receive_v1`:image/file→im 资源下载→`attachment-local`+image block;sender 前拼 `[sender]`(群聊,可配置)。参考 lark-bridge `src/media/`。
- **路径**:`src/channel.ts` / `src/harness.ts` / `src/conversation.ts`。
- **验证目标**:①发图→agent 收 image block 且多模态轮次完成;②发文件→落 attachment-local 可引用;③群聊 content 带 [sender]、单聊按配置;④纯文本零回归。
- **验证形式**:自动 = 新增 `tests/inbound-media.spec.ts`(①–④,mock SDK 事件+下载);冒烟 = 发图+群 @ 各一。
- **量**:中–大 · **依赖**:无 · **参考**:lark-bridge `src/media/`
- **回报物**:`docs/reports/LK-007-report.md` · B 表预填:①图片入上下文 ②文件入 attachment-local ③sender 注入 ④纯文本回归
- **done body**:`<判定>;报告:docs/reports/LK-007-report.md;测试:+<N>/<总数>全绿;备注:<≤60字>`

### LK-008 per-user 权限降级 + 操作审计 ✂裁撤(2026-08-17 用户拍板:单人自用 lark,无 per-user 场景)

- **目标/方案**:白名单用户→策略映射(per-user agent 实例或提示词约束,设计先行入报告);审计读 `session/event` 出操作视图(先日志形态)。
- **路径**:`src/permissions.ts`(新)+ `src/harness.ts`。
- **验证目标**:①不同用户各自命中策略,降级用户越权工具被拒;②审计能答"谁何时让 agent 做了什么"(工具调用级);③无策略用户默认最严。
- **验证形式**:自动 = 新增 `tests/permissions.spec.ts`(①–③);冒烟 = 双账号同群对比工具集。
- **量**:中 · **依赖**:建议 LK-007 后(复用 sender)
- **回报物**:`docs/reports/LK-008-report.md` · B 表预填:①per-user 策略生效 ②审计视图 ③默认最严
- **done body**:`<判定>;报告:docs/reports/LK-008-report.md;测试:+<N>/<总数>全绿;备注:<≤60字>`

### LK-009 云文档评论 + 多 profile ☑(R1 信封重交通过)

- **目标/方案**:评论事件订阅→agent 应答回评论线程;多 profile = 多 patch 实例(唯一 id+各自凭据);action 通道与 LK-003 共用。
- **路径**:`src/index.ts` / `cordis.patch.yml` / `src/config.ts`。
- **验证目标**:①文档评论 @ 机器人→触发轮次并回复评论线程;②双实例(不同 app)互不串扰各自收发;③单应用单连接约束在配置校验/README 显式声明。
- **验证形式**:自动 = 扩展 `tests/config.spec.ts` + 新增 `tests/multi-instance.spec.ts`(①–③,mock);冒烟 = 双实例并行收发(需第二套凭据)。
- **量**:中 · **依赖**:LK-003
- **回报物**:`docs/reports/LK-009-report.md` · B 表预填:①评论触发+回线程 ②双实例隔离 ③约束声明
- **done body**:`<判定>;报告:docs/reports/LK-009-report.md;测试:+<N>/<总数>全绿;备注:<≤60字>`

## 不修(平台硬约束)

- **单飞书应用单长连接消费者**:多实例事件分发丢消息;多 app 可绕。维持运维约束。

---

## 派发批次与契约

| 批次 | 内容 | 理由 |
|---|---|---|
| Wave 1 | LK-001 | P0 正确性 + /resume API 底座 |
| Wave 2 | LK-005 + LK-006 | 分片先行;指令集+状态卡片依赖 LK-001 |
| Wave 3 | LK-002 + LK-003 + LK-004 | 交互回流三层,卡片出站通道复用 |
| 按需 | LK-007 / LK-008 / LK-009 | P2 取用 |

**派发契约**:每单 prompt 嵌入该票「验证目标 + 验证形式 + 回报物」三块原文;agent 首动作 ack、完成按 ①格式 done;报告不符合模板(G4)直接打回重交,不算完成。ledger 逐单落账(dispatched→running→done→reviewed)。

**所有权**:`docs/tickets.md` 对 agent **只读**(编排者维护,含票状态标记);报告由 agent 以 `cp docs/reports/TEMPLATE.md docs/reports/LK-00X-report.md` 起草;审查(F 节)由编排者填写。

### LK-009-R1 信封重交(LK-009 打回件)☑

- **背景**:LK-009 实质审查已全绿(B3/3、C5 项 grep、G1/G2 重跑✓,见 LK-009-report.md F 节),唯一打回原因 = done body 备注 68 字 > 60 上限(豁免政策已于 LK-007 F 节声明终止)。
- **任务**:①零代码/零测试改动,`git status -s` 必须与 LK-009 已审状态一致;②重新发送**合规 done body**(ref 用 LK-009-R1,判定/报告路径/测试段不变,备注 ≤60 字:建议"评论includeRawEvent自提取;claimAppId快速失败;action复用LK-003");③在 docs/reports/LK-009-report.md 末尾追加一行"R1: 信封修正重交,实质零改动"。
- **验证目标**:①done body 校验通过(≤60 字);②git status 与已审一致(无新 diff);③报告追加行存在。
- **回报物**:done body 本身 + 报告追加行(无新报告文件)。

### COMMIT-001 按票分 commit 并 push(LK 系收官件)◐

- **任务**:把工作树全部改动按票分 commit 并 push 到 origin/main:①代码 commit 依各回报单"代码范围"节的归属,按 LK-001→002→003→004→005→006→007→009 时间序,一票一 commit(feat(LK-XXX): 主题);CHANGELOG 若已含各票条目则随对应票提交;②一个收尾 docs commit:docs/(capability-boundary-analysis/tickets/smoke-checklist/reports/TEMPLATE);③`git push origin main`;④push 后 `git status` 全清(无未跟踪残留,__pycache__ 类应被 ignore)。
- **验证目标**:①commit 数 = 8 代码 + 1 docs(或 CHANGELOG 拆分说明);②每 commit 的文件集与其票报告"代码范围"一致(抽查 LK-001/LK-006);③push 成功且 `git status` 清零;④origin/main HEAD == 本地 HEAD。
- **验证形式**:git log --oneline + git status + ls-remote 对照(A 节贴原文)。
- **回报物**:docs/reports/COMMIT-001-report.md · done body:`<判定>;报告:docs/reports/COMMIT-001-report.md;测试:git清零+N commits;备注:<≤60字>`

### COMMIT-001-R1 报告B表勾选+done格式修正 ◐

- **背景**:COMMIT-001 实质全达成(9 commits、fork 推送 014a598、git 清零、71/71 绿,编排者亲验),打回原因仅:①报告 B#3/B#4 仍 [ ] 未勾(与判定 PASS-NOTES 矛盾,G 节文字声明不能替代 B 表);②done body 测试段未按票面格式("git清零+9commits+fork推送"应为"git清零+9commits+fork推送"→ 按票面 done body 模板"测试:git清零+N commits"写)。
- **任务**:①把 COMMIT-001-report.md 的 B#3/B#4 勾为 [x] 并补证据列(fork ls-remote 哈希 014a5980fd61ac6cf94ea6dfc0d956fec25e9b60 / 本地 HEAD 对照);②修 G 节措辞与新 B 表一致;③重发合规 done(备注 ≤60 字);④除报告编辑外零改动,改完 git status 若因此出现报告 diff,amend 进 43e4884 或新 commit 均可(说明即可)。
- **验证目标**:①B#1–B#4 全 [x] 且判定无矛盾;②done body 四段格式合规;③git 终态说明清楚。
- **回报物**:done body + 修订后报告(无新报告文件)。

### LK-010 热载就绪改造(cordis 原则,免重启进当前主进程)☑

- **背景/目标**:当前启用路径要求重启 host(patch 变更后 README 口径"改配置需重启")。目标:把插件改造为**热载就绪**——在运行中的 web profile 主进程里,通过用户 patch 层(watchUserPatches 事务性重组)免重启挂载/重载/卸载 lark-channel 实例,且挂载失败不伤 host(保留上一可用树)。
- **参照机制**(app-boot 源读,只读):`watchUserPatches` 对 profile cordis.patch.yml 事务重组;候选被拒时旧树继续;`ctx.effect`/fiber dispose 语义;web bundle 内 `hmr` 条目被 `disabled: true`(注释:Web 的 reload 生命周期未测)——**插件侧改造不依赖该条目,patch 文件监视与共享 HMR 是两回事,需在票内验证此判断**。
- **任务清单**:
  1. **审计现有生命周期**(src/index.ts apply/stop 路径):列出全部非 cordis 托管资源(WS 连接、per-key chains、bindings 持久化监听、attachment 缓存、卡片 hub、userQuestions 包装)→ 逐项给出 dispose 挂钩(ctx.effect / fiber.onDispose);目标:Loader 重载/卸载该条目时零残留。
  2. **userQuestions 包装的热载安全**:LK-002 E1 的条件包装(shared service 实例方法替换)在条目重载时必须先还原再重包(否则双包/旧闭包泄漏);包装注册与还原必须挂 effect。
  3. **重载等价性**:dispose→apply 循环后行为等价(WS 重连、绑定文件重读、chains 清空但绑定保留);写 test 模拟两次 apply/dispose 循环断言无状态泄漏(Map 长度、监听器数、包装计数)。
  4. **env→字面量凭据降级**:config schema 增加直接凭据字段(appId/appSecret 字面量),与 env 插值并存(字面量优先);README 注明热载场景用字面量(运行中进程 env 注入不可行)。
  5. **自测脚本**:`tests/hot-reload.spec.ts` — apply→dispose→apply 双循环、dispose 后资源零残留计数、包装还原、config 字面量优先级。
- **验证目标**:①双循环重载行为等价(测试断言);②dispose 后零残留(全部资源计数归零);③字面量凭据路径生效且 env 路径不回归;④README 增加"热载启用"章节(patch 示例+字面量凭据+失败回退说明)。
- **验证形式**:自动 = 新 spec(①–③)+ 全量回归;冒烟(留编排者/orchestrator) = 真机热载实验:装 fork→写字面量 patch→观察挂载日志/飞书消息往返→patch 回退观察卸载——host 不重启。
- **路径**:src/index.ts(为主)+ src/harness.ts + src/config.ts + README.zh.md + tests/hot-reload.spec.ts。
- **量**:中–大 · **依赖**:无 · **红线**:DSH 本体零改动;只读参照 app-boot 源码。
- **回报物**:docs/reports/LK-010-report.md · B 表预填:①双循环等价 ②零残留 ③字面量优先/env不回归 ④README热载章节
- **done body**:`<判定>;报告:docs/reports/LK-010-report.md;测试:+<N>/<总数>全绿;备注:<≤60字>`
