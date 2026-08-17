# LK-005 验收回报单

- **ref**: LK-005 · **执行者**: omp@dsh-lark · **完成时间**: 2026-08-17T05:22:24Z
- **判定**: PASS
- **代码范围**: git status -s 全量输出:
  ```
   M CHANGELOG.md
   M README.md
   M src/channel.ts
   M src/config.ts
   M src/harness.ts
   M tests/harness.spec.ts
   M tests/plugin.spec.ts
  ?? docs/capability-boundary-analysis.md
  ?? docs/tickets.md
  ?? docs/reports/
  ?? src/outbound.ts
  ?? tests/outbound.spec.ts
  ```
  本票改动 = `src/outbound.ts`(新)、`src/channel.ts`、`src/config.ts`、`tests/outbound.spec.ts`(新)、`tests/plugin.spec.ts`、`README.md`、`CHANGELOG.md`、本报告。`src/harness.ts`/`tests/harness.spec.ts` 为 LK-001 遗留未提交改动,本票未触碰;未跟踪的分析产物与 tickets.md 非本票改动。DSH 本体与 lark-bridge 零改动。
- **关联**: ledger node LK-005 · worktree dsh-lark

## A. 验证门(逐项贴证据)
- [x] **G1** `pnpm typecheck` → 零错误
  ```
  npm notice run tsc --noEmit
  (无输出,exit 0)
  ```
- [x] **G2** `pnpm test` → 26 passed / 0 failed
  ```
   Test Files  6 passed (6)
       Tests  26 passed (26)
  ```
  (LK-001 后基线 22;本票 +4 = 26,存量零回归)
- [x] **G3** 改动范围仅本仓库预期文件:
  - `src/outbound.ts`(新)— 分片器 `sliceMarkdown`(段落/行/码点三级边界;围栏整块优先,超限围栏按原文 info 串闭合重开;未闭合围栏渲染时补全成对)+ 发送器 `sendReply`(逐片隔离失败,全失败才上抛走安全错误路径)+ `outboundPolicy`
  - `src/channel.ts` — message handler 的回复路径改经 `sendReply`(@src/channel.ts:47),失败兜底(errorMessage)不变
  - `src/config.ts` — 新增 `maxReplyChars`(int ≥200,默认 4000)与 `plainTextReplies`(默认 false)@src/config.ts:45-46
  - `tests/outbound.spec.ts`(新)— 票面 ①–④ 各一用例
  - `tests/plugin.spec.ts` — config 字面量补两个新必填解析字段;顺带把 `as any` 换成 `as unknown as LarkChannel`(规则要求,行为不变)
  - `README.md`/`CHANGELOG.md` — 配置表两行 + Unreleased 条目

## B. 验证目标逐项(与 ticket 验证目标 1:1,不可增删)
| # | 验证目标 | 达成 | 证据(用例名@文件:行 / 命令输出摘录) |
|---|---|---|---|
| 1 | 任意长度全量按序送达、拼接无损 | [x] | `delivers any length losslessly in order (CJK/emoji width)` @tests/outbound.spec.ts:21:40 段中英混排+emoji 在 400 码点限下切 >2 片,逐片 ≤400 且 `slices.join('\n\n') === 原文`(段落级无损重放分隔符);无空格中文长行 1600 字强制码点硬切,`join('') === 原文`;`'🎉'.repeat(50)` @40 限重切后原样拼回(ZWJ emoji 不劈半) |
| 2 | 代码围栏永不跨片截断 | [x] | `never straddles a code fence and reopens oversized blocks with the original info` @tests/outbound.spec.ts:48:60 行 ≈4.7k 字符代码块 + 前后段落切多片,逐片 `^``` 行数 % 2 === 0`(成对平衡);含代码内容的片均含原文 ` ```python ` info 串;`const value0` 先于 `const value59`(内容有序);小围栏块整体随片不劈(`toContain('```js\nconsole.log(1)\n```')` @:66) |
| 3 | 单片失败仅影响该片 | [x] | `isolates a single slice failure to that slice only` @tests/outbound.spec.ts:71:第 2 片 send 抛错 → `sendReply` 继续,成功送达 `slices.length - 1` 片且内容与期望序列精确相等(`[slices[0], ...slices.slice(2)].join('\n\n')`);`logger.error` 1 次 + `logger.warn` 1 次(`delivered N-1/N`);实现:失败计数 @src/outbound.ts(sendReply 循环),仅 `failures === slices.length` 才 rethrow 走安全错误路径 |
| 4 | 降级开关→纯文本内容不丢 | [x] | `keeps the full content when the plain-text degradation switch is on` @tests/outbound.spec.ts:90:`plainText: true` + 40 码点限 → 多片全走 `{text}` payload(断言每片无 `markdown` 字段、replyTo/replyInThread 保持),重拼后中文段、`console.log('hi')`、emoji 结尾段全部在内容中;配置开关 `plainTextReplies` @src/config.ts:46,默认 false(③ 与存量 plugin.spec 回复路径即 markdown 形态,零回归) |

## C. 新增用例清单
| 用例名 | spec 文件 | 对应 B# | 结果 |
|---|---|---|---|
| delivers any length losslessly in order (CJK/emoji width) | tests/outbound.spec.ts:21 | 1 | 通过 |
| never straddles a code fence and reopens oversized blocks with the original info | tests/outbound.spec.ts:48 | 2 | 通过 |
| isolates a single slice failure to that slice only | tests/outbound.spec.ts:71 | 3 | 通过 |
| keeps the full content when the plain-text degradation switch is on | tests/outbound.spec.ts:90 | 4 | 通过 |

## D. 冒烟清单(人工项,agent 只列步骤不执行)
| 步骤 | 状态(待人工/通过/跳过+原因) | 执行者 | 备注 |
|---|---|---|---|
| 让 bot 产出 >4000 字含多代码块的回复,目检分片按序到达、围栏完整 | 待人工 | 人 | 票面冒烟项 |
| 开 `plainTextReplies: true` 重启,重发同 prompt,确认纯文本且内容完整 | 待人工 | 人 | 可选补充 |

## E. 偏差与备注
1. **分片预算按 Unicode 码点计**(`maxReplyChars`),不是飞书服务端的 UTF-16 字节/字符口径:码点是跨平台最保守的通用单位(中文/emoji 均 1 码点 ≥ 实际 UTF-16 宽度),默认 4000 留有余量;真实上限属飞书消息接口演进范围,留运维调整空间,与票面"按飞书上限切片"意图一致。
2. 全失败才走安全错误路径是刻意的:单片全挂通常意味着连接/权限故障,此时继续兜底 errorMessage 也会走同一故障面;该 errorMessage 兜底本身不分片(≤500 字,远低于限)。
3. plugin.spec 的 `as any` 顺手替换为带 LarkChannel 的受控 cast,属规则合规性修正,不改测试语义。

## F. 审查记录(编排者填写,agent 留空)
- 审查人/时间: orch1 / 2026-08-17T05:24Z
- 结论: 通过
- 备注: 亲验 G1(exit 0)/G2(6 files, 26 tests 全绿);抽查 B#2@:48(逐片围栏 ^``` 偶数配对+info 串保留+内容有序+小围栏整块)与 B#3 实现侧(outbound.ts:238 全败才 rethrow)、集成点 channel.ts:47 sendReply、config 新字段属实;E1 码点口径偏差核实成立(保守单位,留运维余量)。冒烟两项留人工。
