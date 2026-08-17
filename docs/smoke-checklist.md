# dsh-lark 冒烟手册(人工真机清单)

> 来源:八张验收回报单 D 表汇总(2026-08-17)。全部为机器不可验项(需真凭据/真机/真人点击)。
> 通过标准:每场景按"验证点"逐条目检;失败记录现象+时间,回票给编排者开 R 票。

## 0. 前置准备

- [ ] 飞书应用凭据(env:FEISHU_APP_ID/SECRET),插件 enabled
- [ ] 应用具备**发卡片**权限(LK-003/004/006 卡片场景依赖)
- [ ] 订阅事件:消息(`im.message.receive_v1`);云文档场景加订 `drive.notice.comment_add_v1`
- [ ] `npx @deepseek-ai/dsh web` 启动,终端无 collision/连接报错
- [ ] 可选配置开关按场景开启:`interactionCards` `streamCards` `interactionTimeoutMs` `streamThrottleMs` `plainTextReplies`

## 1. 会话延续(LK-001 · P0)

| 步骤 | 验证点 |
|---|---|
| 同一 chat 连发两轮 | 回复连续有上下文 |
| 重启 `dsh web` | 重启前无 collision 报错 |
| 同 chat 续聊 | **回复含前文上下文(非初次见面)** ← 本修复的原故障场景 |

## 2. 指令集 + 状态卡片(LK-006)

| 步骤 | 验证点 |
|---|---|
| 逐一发 7 指令 + 1 未知指令 | 各指令卡片/回复符合预期;未知→help |
| `/resume` 点选历史会话 | 续聊含上下文(卡片点击走 WS cardAction) |
| `/resume` 点选后重启 dsh web 再续聊 | 仍接所选会话(绑定文件 `storages/dsh-lark-bindings.json`) |
| 长任务运行中发 `/stop` | 回合中断,无错误回复刷屏 |
| 话题群普通消息 + `/resume` | 话题间独立互不串 |

## 3. 交互卡片:approval/ask(LK-002 兜底 + LK-003 卡片)

| 步骤 | 验证点 |
|---|---|
| `interactionPolicy: deny-all` + ask 类 preset 一轮 | 不挂死,回合 completed |
| 触发 approval(受限 bash 升权) | 手机收到允许/拒绝按钮卡;点"允许"→轮次继续执行 |
| 触发 ask options | 点选项按钮→回合以选择继续 |
| 卡片放置至超时 | 卡片标注超时,轮次由策略应答继续 |
| `interactionPolicy: off` 对照 | 行为与历史一致(ask 走 Web/悬置) |

## 4. 流式卡片(LK-004)

| 步骤 | 验证点 |
|---|---|
| `streamCards: true`(`streamThrottleMs: 800`)发长任务 prompt | 卡片滚动刷新,无频控报错(230099/11310) |
| 轮次完成 | 卡片终态 === 最终回复文本 |

## 5. 长回复分片(LK-005)

| 步骤 | 验证点 |
|---|---|
| 让 bot 产出 >4000 字含多代码块 | 分片按序到达,代码围栏完整不破形 |
| (可选)`plainTextReplies: true` 重发 | 纯文本且内容完整 |

## 6. 入站媒体 + sender(LK-007)

| 步骤 | 验证点 |
|---|---|
| 发一张 PNG | agent 能描述图片内容(多模态轮次完成) |
| 发 PDF/zip | 文件落 `storages/dsh-lark-files/<messageId>/`,agent 可读取总结 |
| 群内 @机器人 发消息 / 单聊 | 群聊带 `[sender]` 前缀;单聊默认无 |

## 7. 云文档评论 + 多 profile(LK-009)

| 步骤 | 验证点 |
|---|---|
| 云文档评论 @机器人 提问 | 应答出现在该评论线程 |
| 第二实例(不同 appId) | 双实例并行收发互不串扰 |
| 同 appId 配第二实例 | 启动即报 `one WebSocket connection` 错误(校验生效) |

---
*执行建议:按 1→2→3→4 顺序(1 是 P0;3 依赖卡片权限;5-7 独立可插队)。全过即 v0.2 发布就绪。*
